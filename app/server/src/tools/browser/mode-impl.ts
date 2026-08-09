/**
 * mode-impl —— ActionExecutor registry 协议层
 * 参考: specs/tech/version_logs/v0.0.266/change_plan.md Delta（老板拍板：registry 重构）
 *
 * 抽象泄漏修复：tool.ts 的 attach 分叉是抽象泄漏——「启动之后，任何 action 不该跟 mode 有关系」。
 * 本文件定义 protocol：BrowserHandle（manager 句柄表条目）+ ModeImpl（无状态策略集）+
 * ModeImplEnv（manager 提供给 impl 的环境）+ SnapshotSink（截图落盘抽象）+ ModeImplRegistry。
 *
 * 职责边界：
 *   - manager = key 计算 + 句柄表 + registry 分发 + 状态机，**不读 handle 私有字段**
 *   - impl = 无状态策略集（不持有实例表，只持只读配置/工厂），worker/session/userDataDir
 *     等资源操作全在 impl 内部经 handle 私有扩展完成
 *   - state 字段共享：manager 状态机读、impl 崩溃/失活置 dead（manager 见 dead → closeInstance 兜底）
 *   - usedPorts 分配表归 manager（经 env.allocatePort/releasePort 暴露给 impl）
 */
import type {
  BrowserActionParams,
  BrowserExecuteResult,
  BrowserLaunchOptions,
  BrowserMode,
  PersistedInstanceRecord,
} from './types';
import type { ChromeMcpDriver } from './chrome-mcp-driver';

/** manager 句柄表条目（impl 扩展私有字段 WorkerHandle/AttachHandle，manager 不读） */
export interface BrowserHandle {
  /** `${sessionId}:${mode}[:${profileName}]`（owner 天然隔离） */
  key: string;
  mode: BrowserMode;
  state: 'starting' | 'ready' | 'closing' | 'dead';
  createdAt: number;
  /** idle timeout 判定（manager execute 时 lazy check） */
  lastUsedAt: number;
}

/** 轻量执行上下文（manager 不 import ToolCtx，避免 tool 层循环依赖） */
export interface ExecuteCtx {
  signal?: AbortSignal;
  /** 截图落盘 sink（tool.ts 用 saveSnapshot 构造闭包注入） */
  snapshot?: SnapshotSink;
}

/** screenshot 落盘抽象（INV-157 单一出口；tool.ts 构造时绑定 workdir/toolCallId） */
export interface SnapshotSink {
  save(data: Buffer | string, mediaType: string): Promise<{ relPath: string }>;
}

/** launch 结果（impl 返回 handle；manager 剥掉 handle 后对外暴露 BrowserExecuteResult） */
export type LaunchResult =
  | { ok: true; handle: BrowserHandle; text: string }
  | { ok: false; error: { kind?: string; message: string } };

/** manager 提供给 impl 的环境（usedPorts 分配表归 manager；attach 依赖经 env 透传） */
export interface ModeImplEnv {
  dataDir: string;
  now(): number;
  /** 分配一个未占用 CDP 端口（段内首个；port_exhausted 抛错由 impl 转 error） */
  allocatePort(): Promise<number>;
  /** 释放端口（close/失败路径必达；幂等） */
  releasePort(port: number): void;
  /** attach 驱动（ChromeMcpDriver 单例，bootstrap 注入；缺省 → attach launch fail-closed） */
  attachDriver?: ChromeMcpDriver;
  /** attach switch 门禁（读 connectorManager.getState switch；缺省 → attach launch fail-closed） */
  isAttachEnabled?(): boolean;
}

/** ModeImpl —— 无状态策略集（launch/execute/close/cleanupOrphan?） */
export interface ModeImpl {
  /**
   * 启动实例并返回 handle。key 由 manager 计算传入（instanceKey 保留在 manager）；
   * manager 负责复用/清理旧实例（幂等语义在 manager 状态机），impl.launch 总是「新启动」。
   * 失败 → error（含门禁/连接/端口等 kind）。
   */
  launch(key: string, opts: BrowserLaunchOptions, env: ModeImplEnv): Promise<LaunchResult>;
  /** 执行 action（handle 由 manager 传 ready 实例）。崩溃/失活 → handle.state='dead' + error */
  execute(
    handle: BrowserHandle,
    action: string,
    params: BrowserActionParams,
    ctx: ExecuteCtx,
  ): Promise<BrowserExecuteResult>;
  /** 关闭实例（幂等：多次 no-op）。资源清理（kill/rm/端口/记录）全在 impl */
  close(handle: BrowserHandle, env: ModeImplEnv): Promise<void>;
  /** 孤儿清理（开机自检按 rec.mode 分发；attach 不持久化 → 无此方法） */
  cleanupOrphan?(rec: PersistedInstanceRecord, env: ModeImplEnv): void;
}

/** mode → impl 路由（代替一切 mode switch） */
export interface ModeImplRegistry {
  get(mode: BrowserMode): ModeImpl;
  has(mode: BrowserMode): boolean;
}

/**
 * 内存 registry：headless + managed-profile 注册同一 WorkerModeImpl 实例两键，
 * attach 注册 AttachModeImpl。构造时 entries 数组显式声明键（避免 map 默认行为歧义）。
 */
export class InMemoryModeImplRegistry implements ModeImplRegistry {
  private readonly map: Map<BrowserMode, ModeImpl>;
  constructor(entries: Array<[BrowserMode, ModeImpl]>) {
    this.map = new Map(entries);
  }
  get(mode: BrowserMode): ModeImpl {
    const impl = this.map.get(mode);
    if (!impl) throw new Error(`无 ${mode} ModeImpl 注册`);
    return impl;
  }
  has(mode: BrowserMode): boolean {
    return this.map.has(mode);
  }
}
