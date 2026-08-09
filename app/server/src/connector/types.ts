/**
 * Connector 共享类型（唯一源）—— 连接器治理骨架（当前仅 browser）
 * 参考: specs/tech/config/[P1]connectors.md §3.1（ConnectorState）+ §5（ConnectorManager 调用面）
 *
 * 背景：v0.0.46 connector 治理模型原生于 tools/browser/connector-types.ts（browser 独占）。
 * 为让治理骨架（switch/connection 双状态机）可被复用，把与 SessionT 无关的类型提取到本文件
 * 为唯一源，用 `ConnectorManager` 接口泛化。
 *
 * v0.0.105：computer use 已 pivot 到「主进程注入 ComputerNativePort」模式（去连接器语义），
 * 不再是连接器；故本文件回退为 browser-only。
 *
 * v0.0.266：attach 生命周期迁入 BrowserInstanceManager（launch → 操作 → close 三模式统一），
 * ConnectorManager 瘦身为「switch 门禁 + UI 状态」——删 connectForToolRun/getAttachSession/
 * disconnect/getOwner（attach session 职责归 InstanceManager）；保留 enable/disable/bootstrap/
 * getState/getAll/isReady。
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

/** 连接器实时状态（tech spec §3.1） */
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

/**
 * ConnectorManager 调用面（tech spec §5）—— 泛型化共享接口，每 manager 各实现一份。
 * 只读：isReady/getState/getAll
 * 意图：enable（仅 intent，不 connect）/ disable（仅 intent，不 connect——attach session 归 InstanceManager）
 * 生命周期：bootstrap（仅 intent 恢复 UI 态，不 connect）
 *
 * v0.0.266 起：connectForToolRun/disconnect/getOwner/getAttachSession 删除——attach 的
 * launch/操作/close 全由 BrowserInstanceManager 承担（经 attachDriver + isAttachEnabled 注入）。
 */
export interface ConnectorManager {
  isReady(id: ConnectorId): boolean;
  getAll?(): ConnectorState[];
  getState?(id: ConnectorId): ConnectorState;

  /** 仅持久化 intent + state.switch='on'，不 connect */
  enable?(id: ConnectorId): Promise<void>;
  /** intent=off + state.switch='off'（attach session 由 InstanceManager close 释放） */
  disable?(id: ConnectorId): Promise<void>;
  /** 仅读 intent 恢复 state.switch，不 connect */
  bootstrap?(): Promise<void>;
}
