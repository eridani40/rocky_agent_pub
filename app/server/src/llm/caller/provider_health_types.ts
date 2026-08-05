/**
 * ProviderHealthRegistry 类型/常量定义
 * 参考: specs/tech/agent/llm_caller/[P0]provider_health_registry.md (权威 spec)
 *
 * 本文件只含类型 + 常量(纯声明,无运行时实现);实现在 provider_health_registry.ts。
 * 外部应从 './provider_health_registry' import(provider_health_registry.ts re-export 此文件符号),
 * 不直接 import 此文件。
 */

/**
 * escalate 关心的错误分类子集(字符串字面量联合)。
 * 不直接 import LlmErrorCategory(模块循环风险);本模块只关心 4 个升级相关 category。
 */
export type HealthRelevantCategory =
  | 'PROVIDER_OVERLOADED'
  | 'RATE_LIMITED'
  | 'AUTH_INVALID'
  | 'AUTH_FORBIDDEN';

/**
 * per (sessionId, providerId, keyRef, modelId) 的健康状态 — discriminated union(spec §2)。
 *
 * cooled_down/degraded 携带 until(epoch ms,到期阈值);dead 携带 reason + at。
 * healthy/cooled_down/degraded 都带 consecutive 计数(overload/rate_limit/auth 拆三);
 * dead 是终态,不带 consecutive(本 session 生命周期内不再用,spec §3.1/§6.1)。
 */
export type ProviderHealthState =
  | { status: 'healthy'; consecutive: HealthCounters }
  | { status: 'cooled_down'; until: number; consecutive: HealthCounters }
  | { status: 'degraded'; until: number; consecutive: HealthCounters }
  | { status: 'dead'; reason: string; at: number };

/** consecutive 计数三元组(overload/rate_limit/auth 各自累计,spec §6.4)。 */
export interface HealthCounters {
  overload: number;
  rate_limit: number;
  auth: number;
}

/** 单条健康记录(spec §2 HealthEntry)。 */
export interface HealthEntry {
  /** session 标识(session-scoped 存储分区键;session 结束 cleanupSession 清理)。 */
  sessionId: string;
  /** app_config provider 实例 id(LlmProviderConfig.id = data.id)。 */
  providerId: string;
  /** credential key 引用(多 key 时区分;单 key = "default")。 */
  keyRef: string;
  /** model 标识(per-model 隔离;同 provider 不同 model 独立 cooldown)。 */
  modelId: string;
  state: ProviderHealthState;
}

/**
 * 降级配置(spec §3.1 escalate 引用)。
 *
 * - consecutiveToDegrade: 连续失败几次后升级到下一态(AUTH 连续达此值 → dead key)。
 * - cooldownS: cooled_down 基准冷却秒数;degraded = 2 倍(spec §3.1)。
 */
export interface DegradationConfig {
  consecutiveToDegrade: number;
  cooldownS: number;
}

/** spec 默认值: 3 次连续 / 30s 基准冷却(见 [P0]llm_request_config.md §1.3 DEFAULT)。 */
export const DEFAULT_DEGRADATION_CONFIG: DegradationConfig = {
  consecutiveToDegrade: 3,
  cooldownS: 30,
};

/** isPreferred / isAvailable 返回的 tier 字面量(spec §2)。 */
export type HealthTier = 'healthy' | 'degraded' | 'cooled_down' | 'dead';

/** isPreferred / isAvailable 返回(isAvailable 同形态,只是命中 tier 集不同)。 */
export type HealthProbe =
  | { ok: true; tier: 'healthy' | 'degraded' }
  | { ok: false; tier: 'cooled_down' | 'dead' | 'degraded'; reason: string; until?: number };

/**
 * session-scoped Registry 接口(spec §2 v2.0)。
 *
 * 所有方法的第一参数都是 sessionId(per-session × per-model 双隔离 key 的一部分);
 * 存储实例本身进程级共享(globalThis),但状态按 session 分区。
 */
export interface ProviderHealthRegistry {
  /** 查询某 (session, provider, key, model) 当前健康状态(已 refresh 到期)。 */
  getState(
    sessionId: string,
    providerId: string,
    keyRef: string,
    modelId: string,
    now: number,
  ): ProviderHealthState;
  /**
   * [resolveTarget 第 1 遍用] 是否「优先选」——healthy 才 ok=true(spec §2)。
   * degraded/cooled_down/dead 都返 false + tier + reason。
   */
  isPreferred(
    sessionId: string,
    providerId: string,
    keyRef: string,
    modelId: string,
    now: number,
  ): HealthProbe;
  /**
   * [resolveTarget 第 2 遍用] 是否「可兜底」——healthy 或 degraded 才 ok=true(spec §2)。
   * cooled_down(未到期)/dead 返 false。
   */
  isAvailable(
    sessionId: string,
    providerId: string,
    keyRef: string,
    modelId: string,
    now: number,
  ): HealthProbe;
  /** 记录失败,升级状态(spec §3.1)。契约: 仅在「该 (provider,key) 本次确实失败」时调(§5)。 */
  escalate(
    sessionId: string,
    providerId: string,
    keyRef: string,
    modelId: string,
    category: HealthRelevantCategory,
    now: number,
  ): void;
  /** 记录成功,清 overload/rate_limit 计数 + 降级恢复(spec §3.3)。 */
  recordSuccess(sessionId: string, providerId: string, keyRef: string, modelId: string): void;
  /** 显式标 (session, provider, key, model) dead(连续 AUTH 或 ROTATE_KEY 决策,spec §2/§3.1)。 */
  markDead(
    sessionId: string,
    providerId: string,
    keyRef: string,
    modelId: string,
    reason: string,
    now: number,
  ): void;
  /** session 结束时清理对应分区(释放内存,防 stale cooldown 累积)。 */
  cleanupSession(sessionId: string): void;
  /** 列举某 session 所有条目快照(debug / langfuse,深拷贝,spec §2)。 */
  snapshot(sessionId: string): HealthEntry[];
}
