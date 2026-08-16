/**
 * 错误归一化 — 主入口（classify 派发 + computeHints + fallbackByHttpStatus）
 * 参考: specs/tech/agent/llm_caller/[P0]error_normalization.md §3 §5
 *
 * 核心原则（hermes 模式）：classify 只产 hint，decide 读 hint。
 *   - classify(rawError, provider) 按 provider 派发到对应 adapter 的 classifyProviderError，
 *     再调通用 computeHints(category, ctx) 算 hints，组装成 ClassifiedLlmError。
 *   - computeHints 不进 adapter（adapter 改映射列时 hints 计算不动）。
 *   - fallbackByHttpStatus 是 OpenAI/GLM 占位 adapter 的兜底。
 *
 * decide（读 hints 产最终 action）见 decide_action.ts（spec llm_caller_overview §3）。
 */
import {
  LlmErrorCategory,
  type ClassifiedLlmError,
  type ComputeHintsContext,
  type ErrorActionHints,
  type ProviderClassifyResult,
  type ProviderErrorClassifier,
  type ProviderRef,
} from './error_types';
import { AnthropicErrorClassifier } from './adapters/anthropic';
import { OpenAIErrorClassifier } from './adapters/openai';
import { GLMErrorClassifier } from './adapters/glm';

/**
 * provider → classifier 单例缓存（无状态，跨调用复用）。
 * [v0.0.350] Partial：ProviderName +4 native coding plan（anthropic wire）无独立 adapter——
 * 缺省 undefined 走下方 ?? 兜底 = anthropic classifier（四渠道错误形态同 anthropic 域，实测背书）。
 */
const CLASSIFIERS: Partial<Record<ProviderRef, ProviderErrorClassifier>> = {
  anthropic_compatible: new AnthropicErrorClassifier(),
  openai_compatible: new OpenAIErrorClassifier(),
  glm: new GLMErrorClassifier(),
};

/**
 * 把 provider 原始错误归一化为 ClassifiedLlmError（含 hints）。
 * 参考: error_normalization.md §3
 *
 * @param rawError provider 抛出的原始错误（HTTP WireResponse / fetch throw / 流内 error 事件 / stop_reason）
 * @param provider provider 标识（anthropic_compatible / openai_compatible / glm）
 * @param ctx hints 计算上下文（hasMultipleKeys / attempt）；默认 { hasMultipleKeys:false, attempt:1 }
 * @returns ClassifiedLlmError（带 hints，decide 读）
 */
export function classify(
  rawError: unknown,
  provider: ProviderRef,
  ctx: ComputeHintsContext = { hasMultipleKeys: false, attempt: 1 },
): ClassifiedLlmError {
  const classifier = CLASSIFIERS[provider] ?? CLASSIFIERS.anthropic_compatible!;
  const result: ProviderClassifyResult = classifier.classifyProviderError(rawError);
  const hints = computeHints(result.category, ctx);
  return makeClassifiedError(result, hints, rawError);
}

/**
 * 通用 hints 计算（不进 adapter）。
 * 参考: error_normalization.md §3 computeHints
 *
 * @param category 错误分类
 * @param ctx hasMultipleKeys（决定 AUTH 是否 ROTATE_KEY）/ attempt（决定瞬时错误是否考虑 fallback）
 */
export function computeHints(category: LlmErrorCategory, ctx: ComputeHintsContext): ErrorActionHints {
  switch (category) {
    // 可重试-瞬时：第二次起考虑 fallback（decide 综合健康表）。
    // 注：spec §3 字面写 `attempt >= 1`，但与该行注释"第二次起"及 §1 "连续 N 次升级"语义矛盾
    // （attempt=1 即首次调用，首次瞬时错误应先重试而非立即 fallback）。
    // 此处按设计意图实现 `attempt >= 2`（attempt 从 1 起算，第二次重试 = attempt 2）。
    case LlmErrorCategory.RATE_LIMITED:
    case LlmErrorCategory.PROVIDER_OVERLOADED:
    case LlmErrorCategory.SERVER_ERROR:
    case LlmErrorCategory.NETWORK:
    case LlmErrorCategory.STREAM_INCOMPLETE:
    case LlmErrorCategory.MAX_TOKENS_TOO_HIGH:
      // TOO_HIGH 归「可重试-瞬时」组：retryable=true，attempt≥2 shouldFallbackProvider。
      // 注：降 maxTokens ×0.7 不在 hints——buildRequest 读 recentErrors 派生（spec §3 末尾 / §6.6）
      // 方向相反于 MAX_TOKENS_EXCEEDED（升），二者严格区分不可混用（§6.6）
    case LlmErrorCategory.EMPTY_RESPONSE:
      // 空响应归「可重试-瞬时」组：纯重试不改参（不降 maxTokens、不压缩、不 bump）
      return {
        retryable: true,
        shouldRotateKey: false,
        shouldFallbackProvider: ctx.attempt >= 2,
        shouldCompressContext: false,
        shouldBumpMaxTokens: false,
      };
    // 超时：丢 partial 重试，不 fallback（看门狗触发，单次行为）
    case LlmErrorCategory.TIMEOUT_FIRST_CHUNK:
    case LlmErrorCategory.TIMEOUT_INTER_CHUNK:
      return {
        retryable: true,
        shouldRotateKey: false,
        shouldFallbackProvider: false,
        shouldCompressContext: false,
        shouldBumpMaxTokens: false,
      };
    // 凭证：有多 key 则 ROTATE_KEY，否则 FALLBACK
    case LlmErrorCategory.AUTH_INVALID:
    case LlmErrorCategory.AUTH_FORBIDDEN:
      return {
        retryable: false,
        shouldRotateKey: ctx.hasMultipleKeys,
        shouldFallbackProvider: !ctx.hasMultipleKeys,
        shouldCompressContext: false,
        shouldBumpMaxTokens: false,
      };
    // 请求-CONTEXT_LENGTH：压缩后重试
    case LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED:
      return {
        retryable: false,
        shouldRotateKey: false,
        shouldFallbackProvider: false,
        shouldCompressContext: true,
        shouldBumpMaxTokens: false,
      };
    // 请求-MAX_TOKENS：bump 或 prefill
    case LlmErrorCategory.MAX_TOKENS_EXCEEDED:
      return {
        retryable: false,
        shouldRotateKey: false,
        shouldFallbackProvider: false,
        shouldCompressContext: false,
        shouldBumpMaxTokens: true,
      };
    // 默认（CONTENT_FILTERED / MODEL_NOT_FOUND / MALFORMED_TOOL_CALL / BAD_REQUEST_OTHER / ABORTED_BY_USER）：NO_RETRY
    default:
      return {
        retryable: false,
        shouldRotateKey: false,
        shouldFallbackProvider: false,
        shouldCompressContext: false,
        shouldBumpMaxTokens: false,
      };
  }
}

/**
 * HTTP status 兜底分类（OpenAI/GLM 占位 adapter 用）。
 * 参考: error_normalization.md §5
 *
 * @param status HTTP status code
 * @param body 响应 body（仅用于抽 message）
 */
export function fallbackByHttpStatus(status: number, body?: unknown): ProviderClassifyResult {
  const message = typeof body === 'string' ? body : extractMessageFromBody(body);
  if (status === 401 || status === 407) {
    return { category: LlmErrorCategory.AUTH_INVALID, message };
  }
  if (status === 403) {
    return { category: LlmErrorCategory.AUTH_FORBIDDEN, message };
  }
  if (status === 404) {
    return { category: LlmErrorCategory.MODEL_NOT_FOUND, message };
  }
  if (status === 408) {
    return { category: LlmErrorCategory.NETWORK, message };
  }
  if (status === 429) {
    return { category: LlmErrorCategory.RATE_LIMITED, message };
  }
  if (status >= 500) {
    return { category: LlmErrorCategory.SERVER_ERROR, message };
  }
  if (status >= 400) {
    return { category: LlmErrorCategory.BAD_REQUEST_OTHER, message };
  }
  // 2xx 不该进 classify（调用方误传），兜底 SERVER_ERROR
  return { category: LlmErrorCategory.SERVER_ERROR, message };
}

/** 从 provider 分类结果 + hints 组装 ClassifiedLlmError（Error 子类形态） */
function makeClassifiedError(
  result: ProviderClassifyResult,
  hints: ErrorActionHints,
  rawError: unknown,
): ClassifiedLlmError {
  const message = result.message ?? defaultMessageForCategory(result.category, rawError);
  const err = new Error(message) as ClassifiedLlmError;
  err.category = result.category;
  err.hints = hints;
  err.retryAfter = result.retryAfter;
  err.reportedContextWindow = result.reportedContextWindow;
  // rawError 保留原始结构（debug / langfuse metadata 用）
  err.rawError = normalizeRawError(rawError);
  // 保留 Error 标准 stack（便于 debug；不上抛时 langfuse 记录）
  if (typeof Error.captureStackTrace === 'function') {
    Error.captureStackTrace(err, classify);
  }
  return err;
}

/** 把 unknown rawError 归一为 { status?, body?, message? }（langfuse metadata 用） */
function normalizeRawError(rawError: unknown): { status?: number; body?: unknown; message?: string } {
  if (typeof rawError === 'string') return { message: rawError };
  if (typeof rawError === 'object' && rawError !== null) {
    const obj = rawError as Record<string, unknown>;
    return {
      status: typeof obj['status'] === 'number' ? obj['status'] : undefined,
      body: obj['body'],
      message: typeof obj['message'] === 'string' ? obj['message'] : undefined,
    };
  }
  return {};
}

/** 从 body 抽 message（兼容 {error:{message}} / {message} / 裸字符串） */
function extractMessageFromBody(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;
  const err = obj['error'];
  if (typeof err === 'object' && err !== null) {
    const ie = err as Record<string, unknown>;
    if (typeof ie['message'] === 'string') return ie['message'];
  }
  if (typeof obj['message'] === 'string') return obj['message'];
  return undefined;
}

/** category 默认 message（result.message 缺省时用） */
function defaultMessageForCategory(category: LlmErrorCategory, rawError: unknown): string {
  const raw = typeof rawError === 'string' ? rawError : (rawError as Error)?.message ?? '';
  return raw ? `${category}: ${raw}` : category;
}
