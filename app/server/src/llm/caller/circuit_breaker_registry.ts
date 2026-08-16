/**
 * circuit_breaker_registry —— 方案级三态熔断注册表（进程内存，DI 注入单例）
 * 参考: specs/tech/agent/providers_and_models/[P0]model_routing.md §6（D5/D6/D16 三态熔断）
 *       specs/prd/model-routing-PRD-2026-08-14.md §2.7（UC-18/19/20 状态机）
 *
 * 状态机：
 *   Closed ──(连续失败 ≥ failureThreshold 或 (total ≥ minRequests 且 errorRate ≥ errorRateThreshold)
 *              或 directOpen(AUTH))──▶ Open
 *     ▲                                    │
 *     │ ◄──── HalfOpen ◄──(timeoutSeconds 到期)──┤
 *     │        (半开连续成功 ≥ successThreshold)  │ 限流 1 探测请求；探测失败 → 立即回 Open
 *
 * key = (planId, providerId, modelId) 三维：方案间隔离（方案 A 熔断 ≠ 方案 B 熔断）；
 * 同一方案多处挂载共享熔断状态；session 显式合成模型（priority 0）也用 planId 作键。
 *
 * 默认参数（cc-switch 官方默认）：failureThreshold=4 / successThreshold=2 / timeoutSeconds=60 /
 * errorRateThreshold=0.6 / minRequests=10 / windowSize=20（方案级 circuit 覆盖，UI 高级区）。
 * 不持久化（重启丢失可接受）；与 ProviderHealthRegistry 分层共存（先查方案熔断再走 session health）。
 *
 * [v0.0.347 T5] 错误率滑动窗口（老板 20:51 拍板，决策⑱-㉔）：
 *   错误率轨道从「终身累计」改「滑动窗口（最近 windowSize 次请求）」——每 key 环形 buffer 记每结果；
 *   窗口有效样本 ≥ minRequests 且窗口失败率 ≥ errorRateThreshold → Open（与连续失败轨道 OR 并行）；
 *   终身计数 totalRequests/totalFailures 保留（snapshot 呈现历史总量）；状态转换全程不清窗口。
 */
import type { CircuitConfig } from '../../services/model-routing-validation';
import { fillCircuitDefaults, DEFAULT_CIRCUIT_CONFIG } from '../../services/model-routing-validation';
import type { CircuitSnapshotEntry, CircuitState } from '../../handlers/model-routing-status';

/** 熔断条目运行时状态 */
export type CircuitRuntimeState = CircuitState;

/** 注册表快照条目（与 status 端点 CircuitSnapshotEntry 对齐；供 snapshot() 输出） */
export type { CircuitSnapshotEntry };

/** 熔断条目（key = planId|providerId|modelId 三维） */
interface CircuitEntry {
  state: CircuitRuntimeState;
  /** 生效熔断参数（默认值填充后） */
  cfg: Required<CircuitConfig>;
  /** 连续失败计数（Closed 累计；Open/HalfOpen 保持） */
  consecutiveFailures: number;
  /** 半开连续成功计数（HalfOpen 探测成功累计；回 Closed 清零） */
  consecutiveSuccesses: number;
  /** 总请求数（终身累计；snapshot 呈现） */
  totalRequests: number;
  /** 总失败数（终身累计；snapshot 呈现） */
  totalFailures: number;
  /** 进入 Open 的时刻（epoch ms；Open 到期 → HalfOpen 用） */
  openedAt: number;
  /** HalfOpen 探测进行中标记（限流 1 并发；permit 归还后清） */
  probing: boolean;
  // [v0.0.347 T5] 错误率滑动窗口（决策⑱⑲㉒）：环形 buffer 记最近 windowSize 次请求结果
  /** 环形窗口（长度 = 生效 cfg.windowSize；true=失败 false=成功；entry 新建/方案编辑改 windowSize 时重建） */
  window: boolean[];
  /** 环形写指针（下一个写入槽位） */
  windowPos: number;
  /** 已填样本数（≤ windowSize；未满时 = 已记请求数） */
  windowCount: number;
  /** 窗口内失败数（= window 中 true 的个数；O(1) 维护） */
  windowFailures: number;
}

/** 熔断参数（方案级覆盖；缺省用默认） */
export type CircuitBreakerConfig = CircuitConfig;

/** 单例挂载 key（globalThis，进程级共享；与 ProviderHealthRegistry 同模式） */
const REGISTRY_GLOBAL_KEY = '__circuitBreakerRegistry';

interface GlobalWithRegistry {
  [REGISTRY_GLOBAL_KEY]?: CircuitBreakerRegistry;
}

/**
 * CircuitBreakerRegistry —— 三维熔断状态机（进程内存 Map）。
 *
 * 用法（生产）：getCircuitBreakerRegistry() 单例；UT 用 createCircuitBreakerRegistry() 隔离。
 * recordFailure(category) 按差异化策略直通：directOpen（AUTH）→ 立即 Open；
 * 其余计失败（连续失败 ≥ failureThreshold 或 total ≥ minRequests 且 errorRate ≥ errorRateThreshold → Open）。
 * getState 内部做「到期 Open→HalfOpen」惰性转换（限流 1 并发探测，permit 归还）。
 */
export class CircuitBreakerRegistry {
  private readonly entries = new Map<string, CircuitEntry>();
  private readonly now: () => number;

  /** 默认参数（导出供 status/UT 对齐） */
  static readonly DEFAULTS = DEFAULT_CIRCUIT_CONFIG;

  constructor(config?: CircuitConfig, now?: () => number) {
    this.now = now ?? Date.now;
    // 全局默认参数（未注入 config 时 entries 各自用方案级 circuit 覆盖）
    void config;
  }

  /** 三维 key 序列化（planId|providerId|modelId） */
  private keyOf(planId: string, providerId: string, modelId: string): string {
    return `${planId}|${providerId}|${modelId}`;
  }

  /** 取条目（不存在 → 按 cfg 创建；已存在且传入 cfg → 同步更新生效参数，方案编辑后新调用即生效） */
  private entry(planId: string, providerId: string, modelId: string, cfg?: CircuitConfig): CircuitEntry {
    const key = this.keyOf(planId, providerId, modelId);
    let e = this.entries.get(key);
    if (!e) {
      e = {
        state: 'closed',
        cfg: fillCircuitDefaults(cfg),
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalRequests: 0,
        totalFailures: 0,
        openedAt: 0,
        probing: false,
        // [v0.0.347 T5] 新条目：空窗口（长度 = 生效 windowSize；决策⑱㉒）
        window: new Array<boolean>(fillCircuitDefaults(cfg).windowSize).fill(false),
        windowPos: 0,
        windowCount: 0,
        windowFailures: 0,
      };
      this.entries.set(key, e);
    } else if (cfg !== undefined) {
      // 已存在：同步方案级覆盖（调用方每次传当前生效 cfg；熔断计数保留，参数即时生效）
      const prev = e.cfg;
      e.cfg = fillCircuitDefaults(cfg);
      // [v0.0.347 T5] 生效 windowSize 变化 → 重建窗口（清空四值；终身计数与 consecutiveFailures 保留）。
      //   口径一致性优先（决策㉒）：编辑罕见，短暂样本不足由连续失败轨道兜底。
      if (e.cfg.windowSize !== prev.windowSize) {
        e.window = new Array<boolean>(e.cfg.windowSize).fill(false);
        e.windowPos = 0;
        e.windowCount = 0;
        e.windowFailures = 0;
      }
    }
    return e;
  }

  /**
   * [v0.0.347 T5] 环形写入窗口（决策⑱）：槽满覆盖最旧值并修正 windowFailures/windowCount；O(1)。
   * 纯操作 entry 无副作用（不触发状态转换）。
   */
  private pushWindow(e: CircuitEntry, failed: boolean): void {
    const size = e.window.length;
    if (size === 0) return; // 防御（windowSize 恒 ≥1，校验保证）
    // 覆盖最旧值（槽满时）：先把旧值从 windowFailures 扣掉
    if (e.windowCount === size && e.window[e.windowPos]) {
      e.windowFailures--;
    }
    e.window[e.windowPos] = failed;
    if (failed) e.windowFailures++;
    e.windowPos = (e.windowPos + 1) % size;
    if (e.windowCount < size) e.windowCount++;
  }

  /**
   * 查询熔断状态（惰性：Open 到期 → HalfOpen，限流 1 并发探测）。
   * @returns 'closed' | 'open' | 'half_open'
   */
  getState(planId: string, providerId: string, modelId: string, cfg?: CircuitConfig): CircuitState {
    const key = this.keyOf(planId, providerId, modelId);
    const e = this.entries.get(key);
    if (!e) return 'closed';
    // 到期 Open → HalfOpen（限流 1 并发：probing=true 时已有探测在途，返回 half_open 但不重复放行）
    if (e.state === 'open' && this.now() - e.openedAt >= e.cfg.timeoutSeconds * 1000) {
      e.state = 'half_open';
      e.consecutiveSuccesses = 0;
      e.probing = false;
    }
    return e.state;
  }

  /**
   * 记录一次调用开始（HalfOpen 探测并发限流判定）。
   * 调用方（routing_loop）在发起 attemptLoop 前调 tryAcquirePermit：
   *   - HalfOpen 且 probing=true（已有探测在途）→ 返回 false（本次调用应跳过该模型，不消耗尝试）
   *   - 其余状态 → true（放行），HalfOpen 时置 probing=true
   */
  tryAcquirePermit(planId: string, providerId: string, modelId: string, cfg?: CircuitConfig): boolean {
    const key = this.keyOf(planId, providerId, modelId);
    const e = this.entry(planId, providerId, modelId, cfg);
    // 先做到期转换（HalfOpen 才可能限流）
    if (e.state === 'open' && this.now() - e.openedAt >= e.cfg.timeoutSeconds * 1000) {
      e.state = 'half_open';
      e.consecutiveSuccesses = 0;
      e.probing = false;
    }
    if (e.state === 'half_open' && e.probing) return false; // 已有探测在途，限流
    if (e.state === 'half_open') e.probing = true; // 本次调用成为探测请求
    return true;
  }

  /**
   * 归还 HalfOpen 探测 permit（探测结束无论成败都归还，防卡死）。
   * 对齐 cc-switch release_half_open_permit（change_plan 风险 5）。
   */
  releasePermit(planId: string, providerId: string, modelId: string): void {
    const key = this.keyOf(planId, providerId, modelId);
    const e = this.entries.get(key);
    if (e) e.probing = false;
  }

  /**
   * 记录失败（所有失败都计入熔断；ABORTED_BY_USER 由调用方处理不调本方法）。
   * @param directOpen AUTH 类直接熔断（跳过阈值判定，立即 Open）
   */
  recordFailure(
    planId: string,
    providerId: string,
    modelId: string,
    cfg?: CircuitConfig,
    directOpen = false,
  ): void {
    const key = this.keyOf(planId, providerId, modelId);
    const e = this.entry(planId, providerId, modelId, cfg);
    e.totalRequests++;
    e.totalFailures++;
    e.consecutiveSuccesses = 0;
    // [v0.0.347 T5] 失败记入滑动窗口（directOpen 分支也记；决策⑱㉓——窗口反映真实请求结果）
    this.pushWindow(e, true);

    if (directOpen) {
      // AUTH 直接 Open（key 失效短期不恢复）
      e.state = 'open';
      e.openedAt = this.now();
      e.consecutiveFailures = 0; // directOpen 语义：不计连续失败（阈值已绕过）
      return;
    }

    if (e.state === 'half_open') {
      // 半开探测失败 → 立即回 Open（无需达阈值；tech §6.1「探测失败 → 立即回 Open」）
      e.state = 'open';
      e.openedAt = this.now();
      e.consecutiveFailures = 0;
      return;
    }

    e.consecutiveFailures++;
    // [v0.0.347 T5] Closed 判定两轨道 OR 并行（决策⑲㉓）：
    //   ① 连续失败 ≥ failureThreshold（原样）
    //   ② 窗口有效样本 ≥ minRequests 且窗口失败率 ≥ errorRateThreshold（滑动窗口口径；
    //      样本不足 → 错误率轨道沉默，靠连续失败轨道兜底）
    const windowRate = e.windowCount > 0 ? e.windowFailures / e.windowCount : 0;
    const windowTrip =
      e.windowCount >= e.cfg.minRequests && windowRate >= e.cfg.errorRateThreshold;
    if (e.consecutiveFailures >= e.cfg.failureThreshold || windowTrip) {
      e.state = 'open';
      e.openedAt = this.now();
      e.consecutiveFailures = 0;
    }
  }

  /**
   * 记录成功（Closed 态清失败计数；HalfOpen 探测成功累计 → ≥ successThreshold 回 Closed）。
   * [v0.0.347 T5] 成功记入滑动窗口；回 Closed **不清窗口**（决策㉒——旧失败随新请求自然滚出）。
   */
  recordSuccess(planId: string, providerId: string, modelId: string, cfg?: CircuitConfig): void {
    const key = this.keyOf(planId, providerId, modelId);
    const e = this.entry(planId, providerId, modelId, cfg);
    e.totalRequests++;
    // [v0.0.347 T5] 成功推入窗口（false）
    this.pushWindow(e, false);
    if (e.state === 'half_open') {
      e.consecutiveSuccesses++;
      if (e.consecutiveSuccesses >= e.cfg.successThreshold) {
        e.state = 'closed';
        e.consecutiveSuccesses = 0;
        e.consecutiveFailures = 0;
        // 窗口保留（决策㉒：不清窗；旧失败继续留在窗口，由后续成功自然滚出）
      }
    } else {
      e.consecutiveFailures = 0;
    }
  }

  /**
   * 内存快照（status 端点消费；只读）。
   * @returns CircuitSnapshotEntry[]（全量；status handler 按 planId 过滤）
   */
  snapshot(): CircuitSnapshotEntry[] {
    const now = this.now();
    const out: CircuitSnapshotEntry[] = [];
    for (const [key, e] of this.entries) {
      const [planId, providerId, modelId] = key.split('|');
      if (!planId || !providerId || !modelId) continue;
      // 快照前先做到期转换（Open 到期 → HalfOpen；呈现映射读最新态）
      if (e.state === 'open' && now - e.openedAt >= e.cfg.timeoutSeconds * 1000) {
        e.state = 'half_open';
        e.consecutiveSuccesses = 0;
        e.probing = false;
      }
      const entry: CircuitSnapshotEntry = {
        planId,
        providerId,
        modelId,
        state: e.state,
        // [v0.0.347 T5] failureCount/totalRequests 保留终身口径（snapshot 呈现历史总量）
        failureCount: e.totalFailures,
        totalRequests: e.totalRequests,
        // [v0.0.347 T5] errorRate 改窗口口径（最近 windowSize 次；样本 0 → 0；决策㉑）
        errorRate: e.windowCount > 0 ? e.windowFailures / e.windowCount : 0,
      };
      if (e.state === 'open') {
        entry.remainingSeconds = Math.max(0, Math.ceil((e.openedAt + e.cfg.timeoutSeconds * 1000 - now) / 1000));
      }
      out.push(entry);
    }
    return out;
  }
}

/**
 * 获取/创建进程级单例（globalThis 挂载；生产路径用）。
 * 与 ProviderHealthRegistry 同模式：实例进程级共享，重启丢失可接受（不持久化）。
 */
export function getCircuitBreakerRegistry(): CircuitBreakerRegistry {
  const g = globalThis as unknown as GlobalWithRegistry;
  if (!g[REGISTRY_GLOBAL_KEY]) {
    g[REGISTRY_GLOBAL_KEY] = new CircuitBreakerRegistry();
  }
  return g[REGISTRY_GLOBAL_KEY]!;
}

/**
 * 重置单例（仅 UT 用，生产代码勿调）。
 */
export function __resetCircuitBreakerRegistryForTest(): void {
  const g = globalThis as unknown as GlobalWithRegistry;
  delete g[REGISTRY_GLOBAL_KEY];
}

/**
 * 创建独立 registry 实例（不挂 globalThis）。
 * UT 用（隔离 globalThis 污染）；生产用 getCircuitBreakerRegistry 单例。
 * @param now 时钟注入（UT 控制 Open 到期）
 */
export function createCircuitBreakerRegistry(now?: () => number): CircuitBreakerRegistry {
  return new CircuitBreakerRegistry(undefined, now);
}
