/**
 * Anthropic 错误分类 adapter — anthropic_compatible provider 专属映射列
 * 参考: specs/tech/agent/llm_caller/[P0]error_normalization.md §4（完整映射表）
 *
 * 覆盖 5 个错误来源：
 *   §4.1 HTTP status + error.type（非 2xx 响应）
 *   §4.2 流内 error 事件（SSE 中途 event:error）
 *   §4.3 stop_reason（流正常结束但需 length 处理）
 *   §4.4 message 正则（CONTEXT_LENGTH_EXCEEDED 判定 + reportedContextWindow 解析）
 *   §4.5 Retry-After header 解析（cap 600s）
 *
 * 关键避坑（§6.3）：STREAM_INCOMPLETE ≠ MAX_TOKENS_EXCEEDED。
 *   - stop_reason=length 且 tool args 完成 → MAX_TOKENS_EXCEEDED（bump/prefill）
 *   - stop_reason=length 且 tool args 未完成 → STREAM_INCOMPLETE（不 bump，hermes 教训）
 *   - 无 stop_reason（流断）→ STREAM_INCOMPLETE
 *
 * 形态探测（rawError unknown → 结构化）见 ../error_shape.ts。
 */
import {
  LlmErrorCategory,
  type ProviderClassifyResult,
  type ProviderErrorClassifier,
} from '../error_types';
import {
  asStopReasonInfo,
  asStreamError,
  asWireResponse,
  errMsg,
  extractAnthropicErrorBody,
  matchAny,
  type WireResponse,
  type StreamErrorShape,
  type StopReasonInfo,
} from '../error_shape';

/** Retry-After 绝对上限（秒）。claude-code PERSISTENT_RESET_CAP_MS=6h 启发，更保守取 10min */
export const CAP_RETRY_AFTER_S = 600;

/**
 * anthropic 在 error.message 中给具体超长信息的正则模式集。
 * 参考: error_normalization.md §4.4
 */
const CONTEXT_LENGTH_PATTERNS = [
  /input length and max_tokens.+exceed/i,
  /prompt is too long/i,
  /context.{0,20}exceed/i,
  /request too large/i,
];

/** max_tokens 客户端设错的正则（非触顶，触顶走流式 stop_reason） */
const MAX_TOKENS_BAD_PARAM_PATTERNS = [/max_tokens|output.{0,10}exceed/i];

/** model not found 正则 */
const MODEL_NOT_FOUND_PATTERNS = [/model.{0,20}(not found|does not exist)/i];

/** content filter 正则（流内 invalid_request_error 中判定） */
const CONTENT_FILTER_PATTERNS = [/content.{0,20}(filter|policy|violation)|safety/i];

/**
 * 从 message 抽取 provider 报告的 context window 上限。
 * 参考: error_normalization.md §4.4（hermes 教训：不永久调窗口，仅本次降 max_tokens）
 *
 * 匹配策略：抽 message 中所有 4-8 位数字（token 量级），取最大值。
 * context window 通常远大于 input token count（如 200000 vs 1234），取最大即 window。
 * @returns 解析出的 token 上限；解析失败返回 undefined
 */
function parseReportedContextWindow(message: string): number | undefined {
  const matches = message.match(/\d{4,8}/g);
  if (!matches || matches.length === 0) return undefined;
  let max = 0;
  for (const s of matches) {
    const n = Number(s);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? max : undefined;
}

/**
 * 解析 HTTP Retry-After header（秒），cap 到 CAP_RETRY_AFTER_S。
 * 参考: error_normalization.md §4.5
 *
 * 仅支持数字秒格式（anthropic 不用 HTTP-date）；病态值（如 6h=21600）被 cap 防卡死重试。
 * @param headers HTTP 响应头（大小写 key 都试）
 */
export function parseRetryAfter(headers: Record<string, string>): number | undefined {
  const v = headers['retry-after'] ?? headers['Retry-After'];
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isNaN(n) && n >= 0) return Math.min(n, CAP_RETRY_AFTER_S);
  // HTTP-date 格式暂不支持（anthropic 不用）
  return undefined;
}

/**
 * 判定 partial 中的 tool_use 是否完整（用于 §4.3 STREAM_INCOMPLETE vs MAX_TOKENS 区分）。
 *
 * hermes 教训（§6.3）：stop_reason=length 但 tool args 未完成（input_json_delta 中断，
 * 无 closing `}`）→ STREAM_INCOMPLETE，不进 bump 路径（3 次无效 bump 浪费配额）。
 *
 * @param partial 本次流累积的 partial 结果
 * @returns true=所有 tool_use 的 input JSON 完整；false=有未完成 tool_use
 */
export function isToolUseComplete(partial?: { message?: unknown }): boolean {
  if (!partial?.message) return true; // 无 partial 或无 message 视为完整（无 tool_use）
  const msg = partial.message as { content?: Array<{ type: string; input?: unknown }> };
  if (!Array.isArray(msg.content)) return true;
  for (const block of msg.content) {
    if (block.type === 'tool_use') {
      if (block.input === undefined) return false;
      if (typeof block.input === 'string') {
        const trimmed = block.input.trim();
        if (trimmed === '') return false;
        // JSON 对象需以 } 收尾才视为完整（input_json_delta 中断时无闭合）
        if (trimmed.startsWith('{') && !trimmed.endsWith('}')) return false;
      }
    }
  }
  return true;
}

/**
 * Anthropic 错误分类器（ProviderErrorClassifier 实现）。
 *
 * 处理顺序：HTTP WireResponse → 流内 error 事件 → stop_reason → fetch throw。
 * rawError 形态由调用方（LlmClient.stream/call 抛错处）决定；本 adapter 用鸭子类型探测。
 */
export class AnthropicErrorClassifier implements ProviderErrorClassifier {
  /**
   * 把 anthropic 原始错误归一化为 { category, retryAfter?, reportedContextWindow? }。
   * 不计算 hints（hints 由通用 computeHints 计算，不进 adapter）。
   */
  classifyProviderError(rawError: unknown): ProviderClassifyResult {
    // 1) WireResponse 形态（HTTP 非 2xx）：{ status, body, headers? }
    const wire = asWireResponse(rawError);
    if (wire) return this.classifyWire(wire);
    // 2) 流内 error 事件：{ type:'error', error:{ type, message } }
    const streamErr = asStreamError(rawError);
    if (streamErr) return this.classifyStreamError(streamErr);
    // 3) stop_reason 形态：{ stopReason:'max_tokens', partial? }
    const stopInfo = asStopReasonInfo(rawError);
    if (stopInfo) return this.classifyStopReason(stopInfo);
    // 4) fetch throw（无 HTTP 响应，DNS/TCP/TLS/abort）
    return { category: LlmErrorCategory.NETWORK, message: errMsg(rawError) };
  }

  /** §4.1 HTTP status + error.type 映射 */
  private classifyWire(wire: WireResponse): ProviderClassifyResult {
    const { status, body, headers } = wire;
    const errBody = extractAnthropicErrorBody(body);
    const message = errBody?.message ?? '';
    const errorType = errBody?.type;
    const retryAfter = headers ? parseRetryAfter(headers) : undefined;

    if (status === 400) {
      if (matchAny(message, CONTEXT_LENGTH_PATTERNS)) {
        return {
          category: LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED,
          reportedContextWindow: parseReportedContextWindow(message),
          message,
        };
      }
      if (matchAny(message, MAX_TOKENS_BAD_PARAM_PATTERNS)) {
        // 判 MAX_TOKENS_TOO_HIGH 而非 BAD_REQUEST_OTHER：后者 NO_RETRY 会让 maxTokens misconfig 白失败。
        // 请求 maxTokens 越界（provider 400 拒）→ 降 maxTokens ×0.7 重试（buildRequest 派生，spec §4.1 / §6.6）。
        // 注意：这是请求**越界**（TOO_HIGH，降），≠ 流式 stop_reason=length 的输出**触顶**（EXCEEDED，升）。
        return { category: LlmErrorCategory.MAX_TOKENS_TOO_HIGH, message };
      }
      if (matchAny(message, MODEL_NOT_FOUND_PATTERNS)) {
        return { category: LlmErrorCategory.MODEL_NOT_FOUND, message };
      }
      return { category: LlmErrorCategory.BAD_REQUEST_OTHER, message };
    }
    if (status === 401) return { category: LlmErrorCategory.AUTH_INVALID, message };
    if (status === 403) return { category: LlmErrorCategory.AUTH_FORBIDDEN, message };
    if (status === 404) {
      return matchAny(message, MODEL_NOT_FOUND_PATTERNS)
        ? { category: LlmErrorCategory.MODEL_NOT_FOUND, message }
        : { category: LlmErrorCategory.BAD_REQUEST_OTHER, message };
    }
    if (status === 413) {
      return {
        category: LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED,
        reportedContextWindow: parseReportedContextWindow(message),
        message,
      };
    }
    if (status === 429) {
      if (errorType === 'rate_limit_error') {
        return { category: LlmErrorCategory.RATE_LIMITED, retryAfter, message };
      }
      if (/overloaded/i.test(message)) {
        return { category: LlmErrorCategory.PROVIDER_OVERLOADED, retryAfter, message };
      }
      return { category: LlmErrorCategory.RATE_LIMITED, retryAfter, message };
    }
    if (status === 529) {
      return { category: LlmErrorCategory.PROVIDER_OVERLOADED, retryAfter, message };
    }
    if (status >= 500) return { category: LlmErrorCategory.SERVER_ERROR, message };
    if (status >= 400) return { category: LlmErrorCategory.BAD_REQUEST_OTHER, message };
    return { category: LlmErrorCategory.SERVER_ERROR, message };
  }

  /** §4.2 流内 error 事件映射 */
  private classifyStreamError(err: StreamErrorShape): ProviderClassifyResult {
    const { type, message } = err;
    if (type === 'overloaded_error') {
      return { category: LlmErrorCategory.PROVIDER_OVERLOADED, message };
    }
    if (type === 'rate_limit_error') {
      return { category: LlmErrorCategory.RATE_LIMITED, message };
    }
    if (type === 'invalid_request_error' && matchAny(message, CONTENT_FILTER_PATTERNS)) {
      return { category: LlmErrorCategory.CONTENT_FILTERED, message };
    }
    if (type === 'invalid_request_error') {
      return { category: LlmErrorCategory.BAD_REQUEST_OTHER, message };
    }
    return { category: LlmErrorCategory.STREAM_INCOMPLETE, message };
  }

  /** §4.3 stop_reason 映射（STREAM_INCOMPLETE vs MAX_TOKENS_EXCEEDED 严格区分） */
  private classifyStopReason(info: StopReasonInfo): ProviderClassifyResult {
    if (info.stopReason === 'max_tokens') {
      // 关键避坑（§6.3）：tool args 未完成 → STREAM_INCOMPLETE（不 bump）
      if (!isToolUseComplete(info.partial)) {
        return { category: LlmErrorCategory.STREAM_INCOMPLETE };
      }
      return { category: LlmErrorCategory.MAX_TOKENS_EXCEEDED };
    }
    // 其他 stop_reason（end_turn/tool_use/stop_sequence）不归本 adapter 处理；
    // 到这里说明调用方误传，兜底 SERVER_ERROR
    return { category: LlmErrorCategory.SERVER_ERROR };
  }
}
