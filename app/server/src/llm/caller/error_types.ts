/**
 * 错误归一化 — 类型定义（LlmErrorCategory 枚举 + ClassifiedLlmError + ErrorActionHints）
 * 参考: specs/tech/agent/llm_caller/[P0]error_normalization.md §1 §2
 *
 * 设计（hermes 模式）：
 *   - classify 只产 hint（bool 能力位），decide 读 hint 产最终 action。
 *   - hints 是「错误特性」与「当前上下文决策」解耦：一个错误可能同时 retryable=true
 *     且 shouldFallbackProvider=true（瞬时错误但已连续 N 次），decide 综合考虑后选最终 action。
 *   - 反例（claude-code）：字符串 category + 决策散落，扩展时多处改。
 *
 * 本文件只含类型与枚举定义，无运行时逻辑。
 */
import type { ProviderName } from '../provider-types';
import type { Message, Usage } from '../../message/types';

/**
 * LLM 错误分类（按恢复语义分组）。
 * 参考: error_normalization.md §1
 *
 * 分组恢复语义（decide 读 hints 后映射）：
 *   - 可重试-瞬时 → RETRY_BACKOFF（同 provider 同 key 退避重试）
 *   - 超时 → RETRY_BACKOFF（丢 partial 重试）
 *   - 凭证 → ROTATE_KEY（首次）/ FALLBACK（连续 N 次 key 全 dead）
 *   - 请求-CONTEXT_LENGTH → FIX_AND_RETRY（压缩）
 *   - 请求-MAX_TOKENS → FIX_AND_RETRY（bump 或 prefill）
 *   - 请求-CONTENT_FILTERED/MODEL_NOT_FOUND/MALFORMED/BAD_REQUEST_OTHER → NO_RETRY
 *   - ABORTED_BY_USER → 不进 attemptLoop catch，invoke 直接 return（保留 partial）
 */
export enum LlmErrorCategory {
  // ── 可重试-瞬时（同 provider 内退避重试，不改参） ──
  /** 429（per-key 或 per-account quota） */
  RATE_LIMITED = 'RATE_LIMITED',
  /** 529 / overloaded（provider 容量） */
  PROVIDER_OVERLOADED = 'PROVIDER_OVERLOADED',
  /** 500 / 502 / 503（非 overload） */
  SERVER_ERROR = 'SERVER_ERROR',
  /** fetch throw（DNS / TCP / TLS，无 HTTP 响应） */
  NETWORK = 'NETWORK',
  /** 流断 / 无 stop_reason / tool args 未完成（非 length） */
  STREAM_INCOMPLETE = 'STREAM_INCOMPLETE',
  /** 请求 maxTokens 越界 / provider 400 max_tokens 拒 → 降 maxTokens ×0.7 重试（≠ MAX_TOKENS_EXCEEDED 升） */
  MAX_TOKENS_TOO_HIGH = 'MAX_TOKENS_TOO_HIGH',
  /** 流正常 finish 但无 text 且无 tool_call → 纯重试（不改参） */
  EMPTY_RESPONSE = 'EMPTY_RESPONSE',

  // ── 超时（看门狗触发，进重试丢 partial） ──
  /** TTFB 超 45s */
  TIMEOUT_FIRST_CHUNK = 'TIMEOUT_FIRST_CHUNK',
  /** chunk 间 stall 超（answer 30 / think 30 / tool 120）；wall_max abort 也归此类 */
  TIMEOUT_INTER_CHUNK = 'TIMEOUT_INTER_CHUNK',

  // ── 凭证（不重试同 key，换 key 或上抛） ──
  /** 401（key 失效 / 错） */
  AUTH_INVALID = 'AUTH_INVALID',
  /** 403（key 无权限 / 地域禁） */
  AUTH_FORBIDDEN = 'AUTH_FORBIDDEN',

  // ── 请求（参数 / 内容问题，NO_RETRY 或 FIX_AND_RETRY） ──
  /** 输入超 context window（→ 压缩） */
  CONTEXT_LENGTH_EXCEEDED = 'CONTEXT_LENGTH_EXCEEDED',
  /** 输出触顶 stop_reason=length（→ bump / prefill） */
  MAX_TOKENS_EXCEEDED = 'MAX_TOKENS_EXCEEDED',
  /** 内容被审核拒绝（NO_RETRY，合规） */
  CONTENT_FILTERED = 'CONTENT_FILTERED',
  /** 模型 id 不存在（NO_RETRY） */
  MODEL_NOT_FOUND = 'MODEL_NOT_FOUND',
  /** tool_use args 解析失败（NO_RETRY 或修参） */
  MALFORMED_TOOL_CALL = 'MALFORMED_TOOL_CALL',
  /** 400 其他（NO_RETRY） */
  BAD_REQUEST_OTHER = 'BAD_REQUEST_OTHER',

  // ── 用户中断（不重试，保留 partial） ──
  ABORTED_BY_USER = 'ABORTED_BY_USER',

  // ── 客户端内部错误（编程错误 / 不变量违反，非 provider 错） ──
  /**
   * invoke() 外层 catch 捕获到非 ClassifiedLlmError 异常
   * （invokeCore 内部漏出的 programming error / invariant 违反）。
   * 与 provider/network 错误正交：本类专指「我们自己的代码出 bug」。
   * 用于 langfuse endGenerationError 闭环（spec llm_caller.md §2.1 line 65 不变量）。
   */
  INTERNAL = 'INTERNAL',
}

/**
 * action hints（decide 读这组 bool 决定最终 action，不重读 category）。
 * 参考: error_normalization.md §2
 *
 * 为什么是 bool 而非 enum action：decide 的最终 action 是五选一
 * （RETRY_BACKOFF / ROTATE_KEY / FIX_AND_RETRY / FALLBACK / NO_RETRY），
 * 但 hints 是「能力位」——一个错误可能同时 retryable=true 且 shouldFallbackProvider=true，
 * decide 综合上下文（attempt 计数 / 健康状态）后选最终 action。
 */
export interface ErrorActionHints {
  /** 可退避重试（同 provider 同 key） */
  retryable: boolean;
  /** 应换 key（同 provider 内轮换 credential）—— AUTH 类且 provider 有多 key */
  shouldRotateKey: boolean;
  /** 应换 provider（fallback chain 下一项）—— 连续 overload / key 全 dead */
  shouldFallbackProvider: boolean;
  /** 应压缩输入后重试 —— CONTEXT_LENGTH_EXCEEDED */
  shouldCompressContext: boolean;
  /** 应 bump max_tokens 或 prefill 续写 —— MAX_TOKENS_EXCEEDED */
  shouldBumpMaxTokens: boolean;
}

/**
 * 归一化后的 LLM 错误（携 category + action hints）。
 * 参考: error_normalization.md §2
 *
 * decide 读 hints 产最终 action；rawError/retryAfter/reportedContextWindow/partial
 * 供 decide / langfuse metadata / prefill 决策消费。
 */
export interface ClassifiedLlmError extends Error {
  /** 错误分类（恢复语义） */
  category: LlmErrorCategory;
  /** provider 原始错误（debug / langfuse metadata） */
  rawError?: { status?: number; body?: unknown; message?: string };
  /** HTTP Retry-After header（秒），归一化算法读它优先；已 cap 到 CAP_RETRY_AFTER_S */
  retryAfter?: number;
  /** provider 报告的可用 context window（仅 CONTEXT_LENGTH_EXCEEDED 可能带，用于本次降 max_tokens） */
  reportedContextWindow?: number;
  /** partial 结果（仅 MAX_TOKENS_EXCEEDED / STREAM_INCOMPLETE 可能带，供 prefill 决策） */
  partial?: { message: Message; usage?: Usage };
  /** 分类时计算的 action hints（decide 读这组 bool，不重读 category） */
  hints: ErrorActionHints;
}

/**
 * classify 的 provider 标识入参。
 *
 * 用最小契约的 ProviderName union（而非完整 LlmProvider 接口）：classify 只需 provider 名
 * 派发到对应 adapter，不需要 provider 的其他能力。调用方传 providerConfig.name。
 */
export type ProviderRef = ProviderName;

/**
 * provider adapter 产出的分类结果（不含 hints，hints 由通用 computeHints 计算）。
 * 参考: error_normalization.md §3 ProviderErrorClassifier
 */
export interface ProviderClassifyResult {
  category: LlmErrorCategory;
  retryAfter?: number;
  reportedContextWindow?: number;
  message?: string;
}

/**
 * provider 专属错误分类器 adapter 接口。
 * 参考: error_normalization.md §3
 *
 * 每个 provider 实现自己的映射列（HTTP status / error.type / 流内 error / stop_reason / 正则），
 * 主逻辑（classify / computeHints）不认 provider 细节，只认 category。
 * adapter 改映射列时主逻辑不动（hermes 模式核心收益）。
 */
export interface ProviderErrorClassifier {
  /** provider 专属映射列：rawError → { category, retryAfter?, reportedContextWindow? } */
  classifyProviderError(rawError: unknown): ProviderClassifyResult;
}

/** computeHints 的上下文（decide 综合考虑的输入） */
export interface ComputeHintsContext {
  /** provider 是否配了多 key（决定 AUTH 类是否 ROTATE_KEY） */
  hasMultipleKeys: boolean;
  /** 当前 attempt 序号（1 起算；决定瞬时错误是否开始考虑 fallback） */
  attempt: number;
}
