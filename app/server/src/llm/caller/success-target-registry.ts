/**
 * success-target-registry —— 进程级「调用成功 target」注册表
 * 参考: specs/tech/version_logs/v0.0.359/change_plan.md §1.1-§1.2（squad 用量统计归属修复）
 *       circuit_breaker_registry.ts（globalThis 单例范式同源）
 *
 * 职责：记录每个 session「最近一次 LLM 调用成功那一下」的物理 target
 *   （providerId / providerName / modelId），供 squad token usage subscriber
 *   在解析 model 归属时优先消费——统计口径对齐「实际命中 physical model」，
 *   不再依赖 session/squad 配置侧三级 fallback 推测。
 *
 * 写入点（change_plan §1.2，恰好 = 调用成功那一下）：
 *   - llm_caller.ts invokeCore 内层 attemptLoop ok 分支（无方案路径）
 *   - routing_loop.ts routingAttemptLoop 候选链 ok 分支（有方案路径）
 * 只在成功点写：失败/abort/max_tokens 不写（保持上一次成功值——
 *   usage 只在成功后累计，语义自洽）。
 *
 * 不变量（change_plan §1.4）：
 *   - 纯内存运行态，不落盘、不持久化（重启即清 → subscriber 回退旧三级 fallback）
 *   - 不挂 ObservabilityPort（usage 统计是业务正路数据，不寄生旁路观测）
 *   - 无淘汰（每 session ~100B，进程生命周期；与 lastSeen 同命运）
 *   - subagent 成功 target 记在 subagent sid 键下，不污染 parent 归属
 */
import type { ProviderName } from '../provider-types';

/** 成功 target 快照（写入与消费共享形状；at 仅诊断用） */
export interface SuccessTargetEntry {
  providerId: string;
  /** 接入方标识（provider.name；registry 存档用，不进 stat 维度） */
  providerName?: ProviderName;
  modelId: string;
  /** 写入时刻（epoch ms；诊断用） */
  at: number;
}

/** 写入参数（at 由 registry 内部盖时间戳） */
export type SuccessTargetInput = Omit<SuccessTargetEntry, 'at'>;

/** 单例挂载 key（globalThis，进程级共享；与 CircuitBreakerRegistry 同模式） */
const REGISTRY_GLOBAL_KEY = '__successTargetRegistry';

interface GlobalWithRegistry {
  [REGISTRY_GLOBAL_KEY]?: SuccessTargetRegistry;
}

/**
 * SuccessTargetRegistry —— session → 最近一次成功 target（进程内存 Map）。
 *
 * 用法（生产）：getSuccessTargetRegistry() 单例，写入点/消费点共用；
 * UT 用 __resetSuccessTargetRegistryForTest() 隔离（每例独立 registry）。
 * recordSuccessTarget 同步 Map.set 无异常面（fire-and-forget，不包 try）。
 */
export class SuccessTargetRegistry {
  private readonly entries = new Map<string, SuccessTargetEntry>();
  private readonly now: () => number;

  constructor(now?: () => number) {
    this.now = now ?? Date.now;
  }

  /** 记录 session 最近一次调用成功的 target（覆盖式：跨模型 failover 后记最后成功者） */
  recordSuccessTarget(sessionId: string, target: SuccessTargetInput): void {
    this.entries.set(sessionId, { ...target, at: this.now() });
  }

  /** 读取 session 最近一次成功 target（无记录 → undefined；纯同步 Map.get 不抛） */
  getSuccessTarget(sessionId: string): SuccessTargetEntry | undefined {
    return this.entries.get(sessionId);
  }
}

/**
 * 记录 session 最近一次调用成功的 target（进程级单例便捷入口）。
 * 写入点（llm_caller ok 分支 / routing_loop ok 分支）直接调本函数；
 * sessionId 为空（未注入）时不写——subscriber 按 sid 精确查，空键无消费方。
 */
export function recordSuccessTarget(sessionId: string, target: SuccessTargetInput): void {
  if (!sessionId) return;
  getSuccessTargetRegistry().recordSuccessTarget(sessionId, target);
}

/**
 * 读取 session 最近一次成功 target（进程级单例便捷入口）。
 * 消费方：token-usage-subscriber model 归属解析最高优先级。
 */
export function getSuccessTarget(sessionId: string): SuccessTargetEntry | undefined {
  return getSuccessTargetRegistry().getSuccessTarget(sessionId);
}

/**
 * 获取/创建进程级单例（globalThis 挂载；生产路径用）。
 * 与 CircuitBreakerRegistry / ProviderHealthRegistry 同模式：
 * 实例进程级共享，重启丢失可接受（不持久化）。
 */
export function getSuccessTargetRegistry(): SuccessTargetRegistry {
  const g = globalThis as unknown as GlobalWithRegistry;
  if (!g[REGISTRY_GLOBAL_KEY]) {
    g[REGISTRY_GLOBAL_KEY] = new SuccessTargetRegistry();
  }
  return g[REGISTRY_GLOBAL_KEY]!;
}

/**
 * 重置单例（仅 UT 用，生产代码勿调）。
 * subscriber/llm_caller/routing_loop 三面 UT 每例 afterEach 清理。
 */
export function __resetSuccessTargetRegistryForTest(): void {
  const g = globalThis as unknown as GlobalWithRegistry;
  delete g[REGISTRY_GLOBAL_KEY];
}
