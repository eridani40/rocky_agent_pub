/**
 * ChannelManager —— channel EP 的消费方 + config/binding 管家 + 组合器（主文件）
 * 参考: specs/tech/channel/[P0]channel_manager.md §2/§3
 *       specs/tech/version_logs/v0.0.206/change_plan.md 模块四（组合器 + scope 门）
 *
 * v0.0.206 组合器模型：
 *   - 无状态 impl 由 pluginManager.getExtensionImpls(ChannelPoint, 'default') 直供
 *     （scope 门物化点：impl 未在 default.yaml 激活 → map miss → resolveImpl throw）
 *   - 按 channel_config 逐份 impl.connect(config, backend) 组合出 per-config ChannelHandle
 *   - gate 在 retry 之外（确定性失败不重试）：gate 失败 → config 转 connection='error' 不崩 server
 *
 * 不变约束：channel D6 binding 双向唯一（SESSION_ALREADY_BOUND）/ 运行时不写 policy /
 * connect fire-and-forget 不阻塞 server。
 * 拆出兄弟文件：channel-accumulator.ts（outbound 累积）+ channel-retry.ts（重连 3 次 × 5s）。
 */
import type { Message } from '../message/types';
import type { Session } from '../agent/session-store-types';
import type { AgentEvent } from '../agent/agent-event-types';
import type { Registry } from '../plugin/registry';
import type { PluginManager } from '../plugin/plugin-manager';
import type { ExtensionPoint } from '../plugin/extension-point';
import { ChannelPoint } from '../plugin/extension-point';
import type { Channel, ChannelHandle, ChannelConfig, ChannelState, ChannelBoundBy } from './types';
import { ChannelBindingError } from './types';
import type { ChannelManagerBackend } from './channel-base';
import { ChannelConfigService } from './channel-config-service';
import { ChannelBindingStore } from './channel-binding-store';
import { runChannelAccumulator, type AccumulatorController } from './channel-accumulator';
import { connectChannelWithRetry, type RetryController } from './channel-retry';

/** ChannelManager 公开接口（便于 UT mock，与 impl 分离） */
export interface ChannelManager extends ChannelManagerBackend {
  bootstrap(): Promise<void>;
  /** 落内存 configs/runtime；enabled=true → spawnConnect（fire-and-forget） */
  registerConfig(config: ChannelConfig): Promise<void>;
  unregisterConfig(configId: string): Promise<void>;
  setEnabled(configId: string, enabled: boolean): Promise<void>;
  /** 同步内存 configs Map（name/config/enabled）—— PUT 更新落盘后调，保持 GET 内存态与落盘一致 */
  updateConfig(configId: string, patch: { name?: string; config?: Record<string, unknown>; enabled?: boolean }): void;
  getAllStates(): ChannelState[];
  getState(configId: string): ChannelState | undefined;
  deleteBindingsBySession(sessionId: string): Promise<void>;
  deleteBindingsByInstance(configId: string): Promise<void>;
  subscribeOutbound(sessionId: string, handle: ChannelHandle): void;
  unsubscribeOutbound(sessionId: string, handle: ChannelHandle): void;
  /** 当前 scope 'default' 激活的 channel impl 列表（impl-types 端点 + POST 激活校验消费） */
  listActiveImpls(): Channel[];
  listSessions(opts?: { biz?: string; role?: string }): Promise<Session[]>;
  deliverTo(sessionId: string, message: Message): Promise<unknown>;
}

/** per-config 运行时态（内存） */
export interface RuntimeState {
  /** connect 成功的连接句柄（connect 成功前 undefined——gate 失败/未连时无句柄） */
  handle?: ChannelHandle;
  connection: 'disconnected' | 'connecting' | 'connected' | 'error';
  errorDetail?: string;
  lastConnectedAt?: string;
  /** 当前重试计数（off→on 重置为 0） */
  retryCount: number;
  /** connect retry 的 abort 控制器（toggle off 用） */
  retry?: RetryController;
}

/**
 * ChannelManagerImpl 构造参数。
 * pluginManager：无状态 impl 供给源（getExtensionImpls 走 scope 解析单源）。
 * registry：管理面保留（configSchema 校验 + impl-types label 反查），不用于取实现。
 */
export interface ChannelManagerOptions {
  dataDir: string;
  agentManager: {
    deliverTo(sessionId: string, message: Message): Promise<unknown>;
    subscribe(sessionId: string, runKind?: string): AsyncIterable<AgentEvent>;
  };
  sessionStore: { listSessions(opts?: { biz?: string; role?: string }): Promise<Session[]> };
  registry: Registry;
  pluginManager: PluginManager;
}

/** ChannelManagerImpl —— ChannelManager interface 的真实实现（持 configs/runtime/accumulators/impls Map）。 */
export class ChannelManagerImpl implements ChannelManager {
  private readonly configs = new Map<string, ChannelConfig>();
  private readonly runtime = new Map<string, RuntimeState>();
  /** per-session accumulator abort 集合（binding 双向唯一下实际 ≤1 handle/session） */
  private readonly accumulators = new Map<string, Set<AccumulatorController>>();
  /** lazy 物化的无状态 impl map（implId → Channel；yaml 静态，缓存安全） */
  private impls?: Map<string, Channel>;
  private readonly opts: ChannelManagerOptions;
  private readonly configService: ChannelConfigService;
  private readonly bindingStore: ChannelBindingStore;

  constructor(opts: ChannelManagerOptions) {
    this.opts = opts;
    this.configService = new ChannelConfigService({ root: opts.dataDir });
    this.bindingStore = new ChannelBindingStore({ root: opts.dataDir });
  }

  /** 启动恢复：扫盘 channel_config → 重建 binding → enabled=true 则 spawnConnect（fire-and-forget） */
  async bootstrap(): Promise<void> {
    this.bindingStore.rebuildReverseIndex();
    this.ensureImpls();
    for (const redacted of this.configService.list()) {
      const cfg = this.configService.getRaw(redacted.id);
      if (!cfg) continue;
      this.configs.set(cfg.id, cfg);
      this.runtime.set(cfg.id, { connection: 'disconnected', retryCount: 0 });
      if (cfg.enabled) void this.spawnConnect(cfg).catch(() => {});
    }
  }

  /** 落内存 configs/runtime；若 config.enabled → spawnConnect（fire-and-forget） */
  async registerConfig(config: ChannelConfig): Promise<void> {
    this.configs.set(config.id, config);
    this.runtime.set(config.id, { connection: 'disconnected', retryCount: 0 });
    if (config.enabled) void this.spawnConnect(config).catch(() => {});
  }

  /** 注销 config：disconnect + 删 binding + unsubscribe 被清 sid + 落盘删 */
  async unregisterConfig(configId: string): Promise<void> {
    const rt = this.runtime.get(configId);
    if (rt?.handle) {
      try { await rt.handle.disconnect(); } catch { /* idempotent */ }
    }
    const cleared = this.bindingStore.deleteByInstance(configId);
    for (const sid of cleared) if (rt?.handle) this.unsubscribeOutbound(sid, rt.handle);
    this.runtime.delete(configId);
    this.configs.delete(configId);
    this.configService.delete(configId);
  }

  /** toggle intent：true→spawnConnect（fresh handle，gate 重过）；false→abort retry + disconnect + unsubscribe */
  async setEnabled(configId: string, enabled: boolean): Promise<void> {
    const cfg = this.configs.get(configId);
    const rt = this.runtime.get(configId);
    if (!cfg || !rt) return;
    this.configService.setEnabled(configId, enabled);
    cfg.enabled = enabled;
    if (enabled) {
      void this.spawnConnect(cfg).catch(() => {});
      return;
    }
    if (rt.retry) rt.retry.aborted = true;
    // off 路径对 handle undefined 安全（gate 失败的 config toggle off 不崩）
    const h = rt.handle;
    if (h) {
      try { await h.disconnect(); } catch { /* graceful */ }
      for (const b of this.bindingStore.listByInstance(configId)) {
        this.unsubscribeOutbound(b.sessionId, h);
      }
    }
    rt.connection = 'disconnected';
  }

  /** 同步内存 configs Map（name/config/enabled）—— PUT 落盘后调；mutate 同一 config 引用（运行中 handle 见新值），不触发 connect/disconnect */
  updateConfig(configId: string, patch: { name?: string; config?: Record<string, unknown>; enabled?: boolean }): void {
    const cfg = this.configs.get(configId);
    if (!cfg) return; // 不存在则 no-op（bootstrap 未恢复 / 已删）
    if (patch.name !== undefined) cfg.name = patch.name;
    if (patch.config !== undefined) cfg.config = patch.config;
    if (patch.enabled !== undefined) cfg.enabled = patch.enabled;
  }

  getAllStates(): ChannelState[] {
    return [...this.configs.keys()]
      .map((id) => this.getState(id))
      .filter((s): s is ChannelState => !!s);
  }

  getState(configId: string): ChannelState | undefined {
    const cfg = this.configs.get(configId);
    const rt = this.runtime.get(configId);
    if (!cfg || !rt) return undefined;
    return {
      id: configId, implId: cfg.implId, name: cfg.name, switch: cfg.enabled ? 'on' : 'off',
      connection: rt.connection, errorDetail: rt.errorDetail, lastConnectedAt: rt.lastConnectedAt,
      bindingCount: this.bindingStore.countByInstance(configId),
    };
  }

  // ===== scope 门（组合器核心）=====

  /**
   * lazy 物化 impl map：getExtensionImpls(ChannelPoint, 'default') 是唯一供给源
   * （scope 解析单源；yaml 静态 → 缓存安全）。MUST NOT 裸查 registry 取实现。
   */
  private ensureImpls(): Map<string, Channel> {
    this.impls ??= new Map(
      this.opts.pluginManager
        .getExtensionImpls<Channel>(ChannelPoint as ExtensionPoint<Channel>, 'default')
        .map((c) => [c.type, c]),
    );
    return this.impls;
  }

  /**
   * scope 门物化：implId 未在 scope 'default' 激活 → throw（确定性失败，不重试）。
   * 文案含「未激活」便于排障。
   */
  private resolveImpl(implId: string): Channel {
    const impl = this.ensureImpls().get(implId);
    if (!impl) {
      throw new Error(
        `ChannelManager: implId "${implId}" 未在 scope 'default' 激活（default.yaml 未配置 channel impl）`,
      );
    }
    return impl;
  }

  /** 当前激活的 channel impl 列表（impl-types 端点 + POST 激活校验消费） */
  listActiveImpls(): Channel[] {
    return [...this.ensureImpls().values()];
  }

  // ===== binding（channel D6 双向唯一）=====
  async getBinding(configId: string, conversationId: string): Promise<string | null> {
    const b = this.bindingStore.get(configId, conversationId);
    return b?.sessionId ?? null;
  }

  /** bind：双向唯一检查 → upsert → 旧 sid unsubscribe → 新 sid subscribe。@throws SESSION_ALREADY_BOUND */
  async bind(configId: string, conversationId: string, sessionId: string, by: ChannelBoundBy): Promise<void> {
    const reverse = this.bindingStore.findBySession(sessionId);
    if (reverse && !(reverse.configId === configId && reverse.conversationId === conversationId)) {
      throw new ChannelBindingError(
        'SESSION_ALREADY_BOUND',
        `session ${sessionId} 已被 config=${reverse.configId} conversation=${reverse.conversationId} 绑定`,
      );
    }
    const old = this.bindingStore.get(configId, conversationId);
    if (old && old.sessionId !== sessionId) this.unsubscribeChannel(configId, old.sessionId);
    this.bindingStore.upsert({ id: `${configId}__${conversationId}`, configId, conversationId, sessionId, boundBy: by, boundAt: Date.now() });
    this.subscribeChannel(configId, sessionId);
  }

  async unbind(configId: string, conversationId: string): Promise<void> {
    const b = this.bindingStore.get(configId, conversationId);
    if (b) this.unsubscribeChannel(configId, b.sessionId);
    this.bindingStore.delete(configId, conversationId);
  }

  /** 通过 sessionId 反查 conversationId（限定本 config，防互窜） */
  async findConversationBySession(configId: string, sessionId: string): Promise<string | null> {
    const b = this.bindingStore.findBySession(sessionId);
    if (!b || b.configId !== configId) return null;
    return b.conversationId;
  }

  async deleteBindingsBySession(sessionId: string): Promise<void> {
    for (const { configId } of this.bindingStore.deleteBySession(sessionId))
      this.unsubscribeChannel(configId, sessionId);
  }

  async deleteBindingsByInstance(configId: string): Promise<void> {
    for (const sid of this.bindingStore.deleteByInstance(configId))
      this.unsubscribeChannel(configId, sid);
  }

  /** 内部 helper：unsubscribe/subscribe + 安全检查 handle 存在 */
  private unsubscribeChannel(configId: string, sessionId: string): void {
    const h = this.runtime.get(configId)?.handle;
    if (h) this.unsubscribeOutbound(sessionId, h);
  }
  private subscribeChannel(configId: string, sessionId: string): void {
    const h = this.runtime.get(configId)?.handle;
    if (h) this.subscribeOutbound(sessionId, h);
  }

  // ===== outbound 累积 =====

  subscribeOutbound(sessionId: string, handle: ChannelHandle): void {
    // 幂等：该 session 已有活跃 accumulator 则跳过，避免重复 loop 泄漏
    const existing = this.accumulators.get(sessionId);
    if (existing && existing.size > 0) return;
    const controller: AccumulatorController = { aborted: false };
    const set = this.accumulators.get(sessionId) ?? new Set();
    this.accumulators.set(sessionId, set);
    set.add(controller);
    void runChannelAccumulator(sessionId, handle, controller, (sid) =>
      this.opts.agentManager.subscribe(sid, 'main'),
    ).catch((e) => {
      console.error('[channel][accumulator] loop 异常 sessionId=%s', sessionId, e);
    }).finally(() => {
      // loop 结束（正常/异常）→ 从 Map 摘除此 controller，防死亡尸体阻塞后续幂等检查
      const s = this.accumulators.get(sessionId);
      if (s) { s.delete(controller); if (s.size === 0) this.accumulators.delete(sessionId); }
      // 非 abort 退出 + binding 仍存在 → 5s 后自动重建（死亡自愈）
      if (!controller.aborted && this.bindingStore.findBySession(sessionId)) {
        const rt = [...this.runtime.values()].find((r) => r.handle === handle);
        if (rt?.connection === 'connected') {
          const timer = setTimeout(() => { this.subscribeOutbound(sessionId, handle); }, 5000);
          console.log('[channel][accumulator] 将在 5s 后重建 sessionId=%s', sessionId);
          timer.unref?.();
        }
      }
    });
  }

  unsubscribeOutbound(sessionId: string, _handle: ChannelHandle): void {
    const set = this.accumulators.get(sessionId);
    if (!set) return;
    for (const ctrl of set) ctrl.aborted = true;
    set.clear();
    this.accumulators.delete(sessionId);
  }

  // ===== 通用 helper（句柄经 ChannelHandleBase 调）=====

  async deliverTo(sessionId: string, message: Message): Promise<unknown> {
    return this.opts.agentManager.deliverTo(sessionId, message);
  }

  async listSessions(opts?: { biz?: string; role?: string }): Promise<Session[]> {
    return this.opts.sessionStore.listSessions(opts);
  }

  // ===== 私有 helper（组合 + connect）=====

  /**
   * 按 config 组合 impl 并 connect（fire-and-forget 由调用方 void；失败转 connection='error' 不崩）。
   * gate（resolveImpl）在 retry 之外——scope 门失败是确定性失败，重试无意义，直接 error 态。
   */
  private async spawnConnect(cfg: ChannelConfig): Promise<void> {
    const rt = this.runtime.get(cfg.id);
    try {
      const impl = this.resolveImpl(cfg.implId);
      await this.connectWithRetry(cfg.id, () => impl.connect(cfg, this));
    } catch (e) {
      if (rt) { rt.connection = 'error'; rt.errorDetail = e instanceof Error ? e.message : String(e); }
    }
  }

  /** connect with retry 委托（channel-retry.ts 实现）；成功后重建已有 binding 的 accumulator */
  private async connectWithRetry(configId: string, connectFn: () => Promise<ChannelHandle>): Promise<void> {
    const rt = this.runtime.get(configId);
    if (!rt) return;
    rt.retry = { aborted: false };
    rt.errorDetail = undefined;
    await connectChannelWithRetry(rt, rt.retry, connectFn);
    if (rt.connection === 'connected') {
      for (const b of this.bindingStore.listByInstance(configId)) this.subscribeChannel(configId, b.sessionId);
    }
  }
}
