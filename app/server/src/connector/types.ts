/**
 * Connector 共享类型（唯一源）—— 连接器治理骨架（当前仅 browser）
 * 参考: specs/tech/config/[P1]connectors.md §3.1（ConnectorState/owner）+ §5（ConnectorManager 调用面）
 *
 * 背景：v0.0.46 connector 治理模型原生于 tools/browser/connector-types.ts（browser 独占）。
 * 为让治理骨架（switch/connection 双状态机 + owner 全局唯一锁 + lazy connect 门禁）可被复用，
 * 把与 SessionT 无关的类型提取到本文件为唯一源，用 `ConnectorManager<SessionT>` /
 * `ConnectForToolRunResult<SessionT>` 泛型化。
 *
 * 注（v0.0.105）：computer use 已 pivot 到「主进程注入 ComputerNativePort」模式（去连接器语义，
 * 无 toggle/owner/connect），不再是连接器；故本文件回退为 browser-only。
 *
 * tools/browser/connector-types.ts 改为 thin re-export（保外部 import 路径零改动）。
 */

/** 连接器类型 id（当前仅 browser） */
export type ConnectorId = 'browser';

/** 连接器 switch 状态（持久化 intent；feature flag，与 connection 解耦） */
export type ConnectorSwitch = 'on' | 'off';

/** 连接器 connection 运行时态（不持久化） */
export type ConnectorConnection =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

/** 连接器实时状态（tech spec §3.1；owner 独立走 getOwner()） */
export interface ConnectorState {
  id: ConnectorId;
  /** 用户已启用此功能（feature flag）；与 connection 解耦 */
  switch: ConnectorSwitch;
  /** 运行时连接实况 */
  connection: ConnectorConnection;
  /** connection=error 时的原因 */
  errorDetail?: string;
  /** 上次 connected 时间（可观测/UI 展示） */
  lastConnectedAt?: number;
}

/** 资源占用引用（sessionId 粒度全局唯一：一机一鼠 / 一浏览器一 attach） */
export type OwnerRef = { sessionId: string; connectedAt: number } | null;

/**
 * connectForToolRun 失败 kind（tool 层依据 kind 生成引导文案）。
 *   - not_enabled       switch=off（用户未开启连接器）
 *   - in_use_by_other   被其他 session 占用（error.ownerSessionId 携带 owner）
 *   - connect_failed    driver.connect 失败（error.message 携带底层原因）
 */
export type ConnectForToolRunErrorKind =
  | 'not_enabled'
  | 'in_use_by_other'
  | 'connect_failed';

/**
 * connectForToolRun 结果（泛型化 by SessionT，当前特化 browser→BrowserSession）。
 * tool 层依据 error.kind + ownerSessionId 生成面向 LLM 的引导文案。
 */
export type ConnectForToolRunResult<SessionT> =
  | { ok: true; session: SessionT }
  | {
      ok: false;
      error: {
        kind: ConnectForToolRunErrorKind;
        message: string;
        /** in_use_by_other 时给 LLM 参考的 owner session */
        ownerSessionId?: string;
      };
    };

/**
 * ConnectorManager 调用面（tech spec §5）—— 泛型化共享接口，每 manager 各实现一份。
 * 只读：isReady/getAttachSession/getState/getAll/getOwner
 * 意图：enable（仅 intent，不 connect）/ disable（intent + 若 connected 则断开）
 * 生命周期：bootstrap（仅 intent 恢复 UI 态，不 connect）
 * 连接：connectForToolRun（LLM 首次用触发 lazy connect + 门禁）/ disconnect（idempotent 释放）
 *
 * 注：方法名沿用 browser 既有 `getAttachSession`（非 spec 建议的 getSession），保 browser 零改动。
 */
export interface ConnectorManager<SessionT> {
  isReady(id: ConnectorId): boolean;
  getAttachSession(id: ConnectorId): SessionT | undefined;
  getAll?(): ConnectorState[];
  getState?(id: ConnectorId): ConnectorState;
  /** 当前资源占用者（空 = 未占用） */
  getOwner?(id: ConnectorId): OwnerRef;

  /** 仅持久化 intent + state.switch='on'，不 connect */
  enable?(id: ConnectorId): Promise<void>;
  /** intent=off + 若 connected 则断开 + owner=null */
  disable?(id: ConnectorId): Promise<void>;
  /** 仅读 intent 恢复 state.switch，不 connect */
  bootstrap?(): Promise<void>;

  /** LLM 首次用连接器时触发 lazy connect（含门禁分层） */
  connectForToolRun?(id: ConnectorId, sessionId: string): Promise<ConnectForToolRunResult<SessionT>>;
  /** LLM disconnect action / session DELETE 兜底；idempotent */
  disconnect?(id: ConnectorId, sessionId?: string): Promise<void>;
}
