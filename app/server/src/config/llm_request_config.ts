/**
 * LlmRequestConfig — llm_request app_config group 的 schema + 默认值 + service
 * 参考: specs/tech/agent/llm_caller/[P0]llm_request_config.md §1-§2
 *       specs/tech/config/[P0]app_config.md §3.4（llm_request group）
 *       specs/api/version_logs/v0.0.25/change_log.md §1.3（GET/PUT 端点）
 *
 * 设计要点（§5.1-§5.3）：
 *   - llm_request 是独立 app_config group（key="default" 单实例），不塞 providers
 *   - 缺省回退 DEFAULT_LLM_REQUEST_CONFIG（与 AppConfigService 不回退语义不同，
 *     llm_request 是调优参数，不配应能用合理默认；providers 是权威值，不配=没配）
 *   - fallback_chain 空时用调用方传入的单一 provider（向后兼容，无 fallback 但有 retry）
 *
 * 不含：
 *   - resolveTarget 完整逻辑（归 LlmCaller；本文件只提供 key 选择 helper）
 *   - LlmErrorState 完整 schema（归 RunState；本文件只导出 spec §2 的类型供复用）
 */
import type { AppConfigService } from './app-config-service';

// ──────────────────────────────────────────────────────────────────────────
// §1.2 schema 类型
// ──────────────────────────────────────────────────────────────────────────

/** TTFB / stall / wall-clock 超时配置（[P0]retry_and_timeout.md §2）。 */
export interface TimeoutConfig {
  ttfb_s: number;
  stall_answer_s: number;
  stall_think_s: number;
  stall_tool_s: number;
  wall_max_s: number;
}

/** 退避 + 重试次数（[P0]retry_and_timeout.md §1）。 */
export interface RetryConfig {
  max_attempts: number;
  backoff_base_s: number;
  backoff_cap_s: number;
  jitter: boolean;
}

/** 降级配置（[P0]provider_health_registry.md §3.1 escalate 阈值）。 */
export interface DegradationConfig {
  cooldown_s: number;
  consecutive_to_degrade: number;
  respect_retry_after: boolean;
}

/** MAX_TOKENS 触顶处理策略（[P0]length_handling.md §6）。 */
export type MaxTokensBumpStrategy = 'continue' | 'increase' | 'none';

/** length 处理配置（[P0]length_handling.md §3 / §6）。 */
export interface LengthConfig {
  auto_compress: boolean;
  precompress_threshold_ratio: number;
  max_tokens_bump_strategy: MaxTokensBumpStrategy;
}

/** fallback_chain 一项（[P0]llm_request_config.md §1.2）。 */
export interface FallbackChainItem {
  /** → app_config providers 组某 provider 实例 id（LlmProviderConfig.id = data.id） */
  providerId: string;
  /** → 该 provider credentials 中的 keyRef（"default" / "backup" / ...） */
  keyRef: string;
  /** → 该 provider models[] 中的一条（LlmModelConfig.modelId） */
  modelId: string;
}

/** llm_request group 完整 config（[P0]llm_request_config.md §1.2）。 */
export interface LlmRequestConfig {
  timeout: TimeoutConfig;
  retry: RetryConfig;
  degradation: DegradationConfig;
  length: LengthConfig;
  /** snake_case 持久化，camelCase 暴露给 TS（GET 响应按持久化形态返 fallback_chain） */
  fallbackChain: FallbackChainItem[];
}

// ──────────────────────────────────────────────────────────────────────────
// §1.3 默认值（spec 权威）
// ──────────────────────────────────────────────────────────────────────────

/**
 * DEFAULT_LLM_REQUEST_CONFIG（spec §1.3）。
 * record 不存在时 get() 返回此值（缺省回退，区别于 AppConfigService 不回退）。
 */
export const DEFAULT_LLM_REQUEST_CONFIG: LlmRequestConfig = {
  timeout: {
    ttfb_s: 45,
    stall_answer_s: 30,
    stall_think_s: 30,
    stall_tool_s: 120,
    wall_max_s: 600,
  },
  retry: { max_attempts: 3, backoff_base_s: 2, backoff_cap_s: 30, jitter: true },
  degradation: {
    cooldown_s: 300,
    consecutive_to_degrade: 3,
    respect_retry_after: true,
  },
  length: {
    auto_compress: true,
    precompress_threshold_ratio: 0.8,
    max_tokens_bump_strategy: 'continue',
  },
  fallbackChain: [], // 空 chain = 只用调用方传入的单一 provider，无 fallback
};

/** llm_request group 名（app_config 固定分片键）。 */
export const LLM_REQUEST_GROUP = 'llm_request';

/** llm_request group 内的唯一 key（单实例配置）。 */
export const LLM_REQUEST_KEY = 'default';

// ──────────────────────────────────────────────────────────────────────────
// LlmRequestConfigService（§1.3 缺省回退）
// ──────────────────────────────────────────────────────────────────────────

/**
 * llm_request config 逻辑服务。
 *
 * 与 AppConfigService 的关键差异（spec §5.2）：record 不存在时返回 DEFAULT
 * （llm_request 是调优参数，不配应能用默认；providers 是权威值，不配=未配置）。
 *
 * 底层仍委托 AppConfigService 落 app_config group shard（与 providers/appearance 同构）。
 */
export class LlmRequestConfigService {
  constructor(private readonly appConfig: AppConfigService) {}

  /**
   * 取 llm_request config；record 不存在返回 DEFAULT_LLM_REQUEST_CONFIG。
   *
   * 注意：持久化用 snake_case（fallback_chain），TS 暴露 camelCase（fallbackChain）。
   * 这里读出 raw data 后做字段名映射，确保对外形态稳定。
   */
  get(): LlmRequestConfig {
    const raw = this.appConfig.get(
      LLM_REQUEST_GROUP,
      LLM_REQUEST_KEY,
    ) as LlmRequestConfigRaw | undefined;
    if (!raw) return { ...DEFAULT_LLM_REQUEST_CONFIG };
    return normalizeRawConfig(raw);
  }

  /**
   * 整体替换 llm_request config（落 app_config group shard）。
   *
   * 缺字段会用 DEFAULT 补全（向后兼容：PUT 部分字段时落盘完整形态）。
   */
  set(config: LlmRequestConfig): void {
    // 先转 raw（camelCase → snake_case），再用 normalizeRawConfig 补默认字段
    const partial: LlmRequestConfigRaw = {
      timeout: config.timeout,
      retry: config.retry,
      degradation: config.degradation,
      length: config.length,
      fallback_chain: config.fallbackChain,
    };
    const normalized = normalizeRawConfig(partial);
    const raw: LlmRequestConfigRaw = {
      timeout: normalized.timeout,
      retry: normalized.retry,
      degradation: normalized.degradation,
      length: normalized.length,
      fallback_chain: normalized.fallbackChain,
    };
    this.appConfig.set(LLM_REQUEST_GROUP, LLM_REQUEST_KEY, raw);
  }
}

/** 持久化形态（snake_case，对齐 api spec §1.3 GET 响应 JSON）。 */
interface LlmRequestConfigRaw {
  timeout: TimeoutConfig;
  retry: RetryConfig;
  degradation: DegradationConfig;
  length: LengthConfig;
  fallback_chain: FallbackChainItem[];
}

/**
 * 把持久化 raw（snake_case）归一化为对外 LlmRequestConfig（camelCase）。
 * 同时补默认字段（旧 record 可能缺字段 → 用 DEFAULT 兜底）。
 */
function normalizeRawConfig(raw: Partial<LlmRequestConfigRaw>): LlmRequestConfig {
  const d = DEFAULT_LLM_REQUEST_CONFIG;
  return {
    timeout: { ...d.timeout, ...(raw.timeout ?? {}) },
    retry: { ...d.retry, ...(raw.retry ?? {}) },
    degradation: { ...d.degradation, ...(raw.degradation ?? {}) },
    length: { ...d.length, ...(raw.length ?? {}) },
    fallbackChain: Array.isArray(raw.fallback_chain) ? raw.fallback_chain : [],
  };
}
