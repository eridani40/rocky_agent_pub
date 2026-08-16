/**
 * 错误归一化模块单测
 * 参考: specs/tech/agent/llm_caller/[P0]error_normalization.md §3 §4 §6
 *       states/v0.0.25/verify/test-plan.md §3（error_normalization 行）
 *
 * 覆盖：
 *   1. Anthropic adapter 全映射（§4.1 HTTP status+error.type / §4.2 流内 error / §4.3 stop_reason /
 *      §4.4 message 正则 / §4.5 Retry-After cap）
 *   2. ErrorActionHints 计算（§3 computeHints 各 category）
 *   3. STREAM_INCOMPLETE vs MAX_TOKENS_EXCEEDED 严格区分（§6.3 hermes 教训）
 *   4. classify 主入口派发 + ClassifiedLlmError 组装
 *   5. CONTENT_FILTERED NO_RETRY（§6.4 合规）
 *
 * 测试方式：stubbed 错误对象注入（标准单测，非 mock-LLM）。rawError 用鸭子类型探测，
 * 构造 WireResponse / StreamError / StopReason / fetch throw 四种形态验证分类逻辑。
 */
import { describe, it, expect } from 'vitest';
import {
  LlmErrorCategory,
  type ClassifiedLlmError,
} from '../error_types';
import { classify, computeHints, fallbackByHttpStatus } from '../error_classify';
import {
  AnthropicErrorClassifier,
  parseRetryAfter,
  isToolUseComplete,
  CAP_RETRY_AFTER_S,
} from '../adapters/anthropic';

// ── 测试用 stub 构造器（确定性错误对象，非 mock-LLM） ──

/** 构造 HTTP WireResponse stub（非 2xx） */
function wire(status: number, errorType?: string, message?: string, headers?: Record<string, string>): unknown {
  const body = errorType || message
    ? { type: 'error', error: { type: errorType ?? 'api_error', message: message ?? '' } }
    : undefined;
  return { status, body, headers };
}

/** 构造流内 error 事件 stub */
function streamError(errorType: string, message: string): unknown {
  return { type: 'error', error: { type: errorType, message } };
}

/** 构造 stop_reason stub */
function stopReason(reason: string, partial?: { message?: unknown }): unknown {
  return { stopReason: reason, partial };
}

// ============================================================
// 1. Anthropic adapter — HTTP status + error.type 映射（§4.1）
// ============================================================
describe('AnthropicErrorClassifier §4.1 HTTP status 映射', () => {
  const c = new AnthropicErrorClassifier();

  it('429 + rate_limit_error → RATE_LIMITED', () => {
    const r = c.classifyProviderError(wire(429, 'rate_limit_error', 'rate limited', { 'retry-after': '30' }));
    expect(r.category).toBe(LlmErrorCategory.RATE_LIMITED);
    expect(r.retryAfter).toBe(30);
  });

  it('429 无 error.type + message 含 overloaded → PROVIDER_OVERLOADED（spec §4.1: 仅无 type 时按 message 判 overloaded）', () => {
    // spec §4.1 表：rate_limit_error type 优先 → RATE_LIMITED；
    // 仅 "无 error.type 且 message 含 overloaded" 时才 PROVIDER_OVERLOADED
    const r = c.classifyProviderError(wire(429, '', 'server overloaded, retry later'));
    expect(r.category).toBe(LlmErrorCategory.PROVIDER_OVERLOADED);
  });

  it('429 + rate_limit_error type 即使 message 含 overloaded 仍 → RATE_LIMITED（type 优先）', () => {
    const r = c.classifyProviderError(wire(429, 'rate_limit_error', 'server overloaded'));
    expect(r.category).toBe(LlmErrorCategory.RATE_LIMITED);
  });

  it('429 无 error.type 默认 → RATE_LIMITED', () => {
    const r = c.classifyProviderError(wire(429, '', 'too many requests'));
    expect(r.category).toBe(LlmErrorCategory.RATE_LIMITED);
  });

  it('529 + overloaded_error → PROVIDER_OVERLOADED', () => {
    const r = c.classifyProviderError(wire(529, 'overloaded_error', 'overloaded'));
    expect(r.category).toBe(LlmErrorCategory.PROVIDER_OVERLOADED);
  });

  it('401 → AUTH_INVALID', () => {
    const r = c.classifyProviderError(wire(401, 'authentication_error', 'invalid x-api-key'));
    expect(r.category).toBe(LlmErrorCategory.AUTH_INVALID);
  });

  it('403 + permission_error → AUTH_FORBIDDEN', () => {
    const r = c.classifyProviderError(wire(403, 'permission_error', 'key lacks permission'));
    expect(r.category).toBe(LlmErrorCategory.AUTH_FORBIDDEN);
  });

  it('403 无 error.type → AUTH_FORBIDDEN', () => {
    const r = c.classifyProviderError(wire(403, '', ''));
    expect(r.category).toBe(LlmErrorCategory.AUTH_FORBIDDEN);
  });

  it('400 + prompt too long → CONTEXT_LENGTH_EXCEEDED 且解析 reportedContextWindow', () => {
    const r = c.classifyProviderError(wire(400, 'invalid_request_error', 'prompt is too long: 1234 tokens > 200000 max context window'));
    expect(r.category).toBe(LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED);
    expect(r.reportedContextWindow).toBe(200000);
  });

  it('400 + "input length and max_tokens exceed" → CONTEXT_LENGTH_EXCEEDED', () => {
    const r = c.classifyProviderError(wire(400, 'invalid_request_error', 'input length and max_tokens, 1234, exceed context window: 100000'));
    expect(r.category).toBe(LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED);
    expect(r.reportedContextWindow).toBe(100000);
  });

  it('[v0.0.25] 400 + max_tokens 字样（请求越界，非流式触顶） → MAX_TOKENS_TOO_HIGH（改判）', () => {
    // spec §4.1 / §6.6：请求 maxTokens 越界 → 降 ×0.7 重试（原 BAD_REQUEST_OTHER NO_RETRY 会让 misconfig 白失败）
    // ≠ MAX_TOKENS_EXCEEDED（流式 stop_reason=length 输出触顶，升）
    const r = c.classifyProviderError(wire(400, 'invalid_request_error', 'max_tokens must be <= 8192'));
    expect(r.category).toBe(LlmErrorCategory.MAX_TOKENS_TOO_HIGH);
    expect(r.category).not.toBe(LlmErrorCategory.MAX_TOKENS_EXCEEDED); // 方向相反不可混用
    expect(r.category).not.toBe(LlmErrorCategory.BAD_REQUEST_OTHER);
  });

  it('[v0.0.25] 400 + output exceed 字样 → MAX_TOKENS_TOO_HIGH（MAX_TOKENS_BAD_PARAM_PATTERNS output 分支）', () => {
    const r = c.classifyProviderError(wire(400, 'invalid_request_error', 'output size exceeds maximum'));
    expect(r.category).toBe(LlmErrorCategory.MAX_TOKENS_TOO_HIGH);
  });

  it('400 + model not found → MODEL_NOT_FOUND', () => {
    const r = c.classifyProviderError(wire(400, 'invalid_request_error', 'model: claude-xxx does not exist'));
    expect(r.category).toBe(LlmErrorCategory.MODEL_NOT_FOUND);
  });

  it('400 其他 → BAD_REQUEST_OTHER', () => {
    const r = c.classifyProviderError(wire(400, 'invalid_request_error', 'some other 400 error'));
    expect(r.category).toBe(LlmErrorCategory.BAD_REQUEST_OTHER);
  });

  it('404 + model → MODEL_NOT_FOUND', () => {
    const r = c.classifyProviderError(wire(404, 'not_found_error', 'model not found: foo'));
    expect(r.category).toBe(LlmErrorCategory.MODEL_NOT_FOUND);
  });

  it('404 其他 → BAD_REQUEST_OTHER', () => {
    const r = c.classifyProviderError(wire(404, 'not_found_error', 'resource gone'));
    expect(r.category).toBe(LlmErrorCategory.BAD_REQUEST_OTHER);
  });

  it('413 → CONTEXT_LENGTH_EXCEEDED', () => {
    const r = c.classifyProviderError(wire(413, 'request_too_large', 'request too large'));
    expect(r.category).toBe(LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED);
  });

  it('500 + api_error → SERVER_ERROR', () => {
    const r = c.classifyProviderError(wire(500, 'api_error', 'internal error'));
    expect(r.category).toBe(LlmErrorCategory.SERVER_ERROR);
  });

  it('502/503/504 → SERVER_ERROR', () => {
    for (const s of [502, 503, 504]) {
      const r = c.classifyProviderError(wire(s, '', 'gateway timeout'));
      expect(r.category).toBe(LlmErrorCategory.SERVER_ERROR);
    }
  });

  it('其他 4xx（如 418）→ BAD_REQUEST_OTHER 兜底', () => {
    const r = c.classifyProviderError(wire(418, '', "I'm a teapot"));
    expect(r.category).toBe(LlmErrorCategory.BAD_REQUEST_OTHER);
  });
});

// ============================================================
// 2. Anthropic adapter — 流内 error 事件（§4.2）
// ============================================================
describe('AnthropicErrorClassifier §4.2 流内 error 事件', () => {
  const c = new AnthropicErrorClassifier();

  it('overloaded_error → PROVIDER_OVERLOADED', () => {
    const r = c.classifyProviderError(streamError('overloaded_error', 'overloaded'));
    expect(r.category).toBe(LlmErrorCategory.PROVIDER_OVERLOADED);
  });

  it('rate_limit_error → RATE_LIMITED', () => {
    const r = c.classifyProviderError(streamError('rate_limit_error', 'slow down'));
    expect(r.category).toBe(LlmErrorCategory.RATE_LIMITED);
  });

  it('invalid_request_error + content filter → CONTENT_FILTERED', () => {
    const r = c.classifyProviderError(streamError('invalid_request_error', 'content policy violation'));
    expect(r.category).toBe(LlmErrorCategory.CONTENT_FILTERED);
  });

  it('invalid_request_error + safety → CONTENT_FILTERED', () => {
    const r = c.classifyProviderError(streamError('invalid_request_error', 'safety filter triggered'));
    expect(r.category).toBe(LlmErrorCategory.CONTENT_FILTERED);
  });

  it('invalid_request_error 其他 → BAD_REQUEST_OTHER', () => {
    const r = c.classifyProviderError(streamError('invalid_request_error', 'some request issue'));
    expect(r.category).toBe(LlmErrorCategory.BAD_REQUEST_OTHER);
  });

  it('其他流内 error → STREAM_INCOMPLETE', () => {
    const r = c.classifyProviderError(streamError('api_error', 'something broke mid-stream'));
    expect(r.category).toBe(LlmErrorCategory.STREAM_INCOMPLETE);
  });
});

// ============================================================
// 3. Anthropic adapter — stop_reason（§4.3 STREAM_INCOMPLETE vs MAX_TOKENS）
// ============================================================
describe('AnthropicErrorClassifier §4.3 stop_reason 映射（STREAM_INCOMPLETE vs MAX_TOKENS 严格区分）', () => {
  const c = new AnthropicErrorClassifier();

  it('stop_reason=max_tokens 且无 tool_use → MAX_TOKENS_EXCEEDED', () => {
    const partial = { message: { content: [{ type: 'text', text: 'hello' }] } };
    const r = c.classifyProviderError(stopReason('max_tokens', partial));
    expect(r.category).toBe(LlmErrorCategory.MAX_TOKENS_EXCEEDED);
  });

  it('stop_reason=max_tokens 且 tool_use input 完整 → MAX_TOKENS_EXCEEDED', () => {
    const partial = {
      message: {
        content: [
          { type: 'text', text: 'calling tool' },
          { type: 'tool_use', name: 'foo', input: { arg: 1 } },
        ],
      },
    };
    const r = c.classifyProviderError(stopReason('max_tokens', partial));
    expect(r.category).toBe(LlmErrorCategory.MAX_TOKENS_EXCEEDED);
  });

  it('§6.3 关键避坑：stop_reason=max_tokens 且 tool_use input 未完成（无闭合}）→ STREAM_INCOMPLETE', () => {
    const partial = {
      message: {
        content: [
          { type: 'tool_use', name: 'foo', input: '{"arg":' }, // 残缺 JSON
        ],
      },
    };
    const r = c.classifyProviderError(stopReason('max_tokens', partial));
    expect(r.category).toBe(LlmErrorCategory.STREAM_INCOMPLETE);
    // 确保 NOT MAX_TOKENS（避免 hermes 3 次无效 bump 教训）
    expect(r.category).not.toBe(LlmErrorCategory.MAX_TOKENS_EXCEEDED);
  });

  it('§6.3：stop_reason=max_tokens 且 tool_use input 为 undefined → STREAM_INCOMPLETE', () => {
    const partial = {
      message: { content: [{ type: 'tool_use', name: 'foo', input: undefined }] },
    };
    const r = c.classifyProviderError(stopReason('max_tokens', partial));
    expect(r.category).toBe(LlmErrorCategory.STREAM_INCOMPLETE);
  });

  it('§6.3：stop_reason=max_tokens 且 tool_use input 为空串 → STREAM_INCOMPLETE', () => {
    const partial = {
      message: { content: [{ type: 'tool_use', name: 'foo', input: '  ' }] },
    };
    const r = c.classifyProviderError(stopReason('max_tokens', partial));
    expect(r.category).toBe(LlmErrorCategory.STREAM_INCOMPLETE);
  });

  it('无 partial 的 stop_reason=max_tokens 视为完整 → MAX_TOKENS_EXCEEDED', () => {
    const r = c.classifyProviderError(stopReason('max_tokens', undefined));
    expect(r.category).toBe(LlmErrorCategory.MAX_TOKENS_EXCEEDED);
  });

  it('非 max_tokens 的 stop_reason（end_turn）兜底 → SERVER_ERROR', () => {
    const r = c.classifyProviderError(stopReason('end_turn'));
    expect(r.category).toBe(LlmErrorCategory.SERVER_ERROR);
  });
});

// ============================================================
// 4. Anthropic adapter — fetch throw / NETWORK
// ============================================================
describe('AnthropicErrorClassifier fetch throw → NETWORK', () => {
  const c = new AnthropicErrorClassifier();

  it('普通 Error 对象 → NETWORK', () => {
    const r = c.classifyProviderError(new Error('fetch failed: ECONNREFUSED'));
    expect(r.category).toBe(LlmErrorCategory.NETWORK);
    expect(r.message).toContain('ECONNREFUSED');
  });

  it('字符串错误 → NETWORK', () => {
    const r = c.classifyProviderError('fetch throw');
    expect(r.category).toBe(LlmErrorCategory.NETWORK);
  });

  it('null/undefined → NETWORK', () => {
    expect(c.classifyProviderError(null).category).toBe(LlmErrorCategory.NETWORK);
    expect(c.classifyProviderError(undefined).category).toBe(LlmErrorCategory.NETWORK);
  });
});

// ============================================================
// 5. Retry-After 解析（§4.5 cap）
// ============================================================
describe('parseRetryAfter §4.5 Retry-After cap', () => {
  it('正常值原样返回', () => {
    expect(parseRetryAfter({ 'retry-after': '30' })).toBe(30);
  });

  it('超过 CAP_RETRY_AFTER_S 被 cap 到 600', () => {
    expect(parseRetryAfter({ 'retry-after': '21600' })).toBe(CAP_RETRY_AFTER_S);
    expect(CAP_RETRY_AFTER_S).toBe(600);
  });

  it('大小写 header 兼容', () => {
    expect(parseRetryAfter({ 'Retry-After': '60' })).toBe(60);
  });

  it('无 header 返回 undefined', () => {
    expect(parseRetryAfter({})).toBeUndefined();
    expect(parseRetryAfter({ 'content-type': 'application/json' })).toBeUndefined();
  });

  it('非数字（HTTP-date）返回 undefined', () => {
    expect(parseRetryAfter({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })).toBeUndefined();
  });

  it('负数返回 undefined', () => {
    expect(parseRetryAfter({ 'retry-after': '-5' })).toBeUndefined();
  });

  it('429 cap 流程：21600s retry-after 经 adapter 后变 600', () => {
    const c = new AnthropicErrorClassifier();
    const r = c.classifyProviderError(wire(429, 'rate_limit_error', 'rate limited', { 'retry-after': '21600' }));
    expect(r.retryAfter).toBe(600);
  });
});

// ============================================================
// 6. isToolUseComplete 辅助函数
// ============================================================
describe('isToolUseComplete', () => {
  it('无 partial 视为完整', () => {
    expect(isToolUseComplete(undefined)).toBe(true);
    expect(isToolUseComplete({})).toBe(true);
  });

  it('无 message 视为完整', () => {
    expect(isToolUseComplete({ message: undefined })).toBe(true);
  });

  it('content 非 array 视为完整', () => {
    expect(isToolUseComplete({ message: { content: 'not array' } })).toBe(true);
  });

  it('tool_use input 完整对象 → true', () => {
    expect(isToolUseComplete({ message: { content: [{ type: 'tool_use', input: { a: 1 } }] } })).toBe(true);
  });

  it('tool_use input 残缺 JSON 串 → false', () => {
    expect(isToolUseComplete({ message: { content: [{ type: 'tool_use', input: '{"a":' }] } })).toBe(false);
  });

  it('text block 不影响判定', () => {
    expect(isToolUseComplete({ message: { content: [{ type: 'text', text: 'hi' }] } })).toBe(true);
  });
});

// ============================================================
// 7. ErrorActionHints 计算（§3 computeHints）
// ============================================================
describe('computeHints §3 各 category 的 hints', () => {
  const ctxSingle = { hasMultipleKeys: false, attempt: 1 };
  const ctxMulti = { hasMultipleKeys: true, attempt: 1 };
  const ctxAttempt2 = { hasMultipleKeys: false, attempt: 2 };

  it('RATE_LIMITED attempt=1 → retryable + 不 fallback', () => {
    const h = computeHints(LlmErrorCategory.RATE_LIMITED, ctxSingle);
    expect(h).toEqual({
      retryable: true,
      shouldRotateKey: false,
      shouldFallbackProvider: false,
      shouldCompressContext: false,
      shouldBumpMaxTokens: false,
    });
  });

  it('RATE_LIMITED attempt>=2 → shouldFallbackProvider=true', () => {
    const h = computeHints(LlmErrorCategory.RATE_LIMITED, ctxAttempt2);
    expect(h.shouldFallbackProvider).toBe(true);
    expect(h.retryable).toBe(true);
  });

  it('PROVIDER_OVERLOADED / SERVER_ERROR / NETWORK / STREAM_INCOMPLETE 同 RATE_LIMITED 瞬时语义', () => {
    for (const cat of [
      LlmErrorCategory.PROVIDER_OVERLOADED,
      LlmErrorCategory.SERVER_ERROR,
      LlmErrorCategory.NETWORK,
      LlmErrorCategory.STREAM_INCOMPLETE,
    ]) {
      const h = computeHints(cat, ctxSingle);
      expect(h.retryable).toBe(true);
      expect(h.shouldFallbackProvider).toBe(false); // attempt=1
      expect(h.shouldRotateKey).toBe(false);
    }
  });

  it('[v0.0.25] MAX_TOKENS_TOO_HIGH 同瞬时组：attempt=1 retryable + 不 fallback', () => {
    // spec §3 / §6.6：归「可重试-瞬时」组；降 ×0.7 在 buildRequest 派生，不在 hints
    const h = computeHints(LlmErrorCategory.MAX_TOKENS_TOO_HIGH, ctxSingle);
    expect(h).toEqual({
      retryable: true,
      shouldRotateKey: false,
      shouldFallbackProvider: false, // attempt=1 先重试
      shouldCompressContext: false,
      shouldBumpMaxTokens: false, // ← 关键：不 bump（方向相反于 EXCEEDED 升，§6.6）
    });
  });

  it('[v0.0.25] MAX_TOKENS_TOO_HIGH attempt>=2 → shouldFallbackProvider=true', () => {
    const h = computeHints(LlmErrorCategory.MAX_TOKENS_TOO_HIGH, ctxAttempt2);
    expect(h.retryable).toBe(true);
    expect(h.shouldFallbackProvider).toBe(true);
    expect(h.shouldBumpMaxTokens).toBe(false); // 仍然不 bump
  });

  it('[v0.0.25] MAX_TOKENS_TOO_HIGH ≠ MAX_TOKENS_EXCEEDED hints（方向相反验证）', () => {
    // TOO_HIGH（降）：retryable=true, shouldBumpMaxTokens=false
    // EXCEEDED（升）：retryable=false, shouldBumpMaxTokens=true
    const tooHigh = computeHints(LlmErrorCategory.MAX_TOKENS_TOO_HIGH, ctxSingle);
    const exceeded = computeHints(LlmErrorCategory.MAX_TOKENS_EXCEEDED, ctxSingle);
    expect(tooHigh.shouldBumpMaxTokens).toBe(false);
    expect(tooHigh.retryable).toBe(true);
    expect(exceeded.shouldBumpMaxTokens).toBe(true);
    expect(exceeded.retryable).toBe(false);
  });

  it('[v0.0.25] EMPTY_RESPONSE 同瞬时组：attempt=1 retryable + 不改参', () => {
    // spec §3 / §6.7：纯重试（不降 maxTokens、不压缩 context、不 bump）
    const h = computeHints(LlmErrorCategory.EMPTY_RESPONSE, ctxSingle);
    expect(h).toEqual({
      retryable: true,
      shouldRotateKey: false,
      shouldFallbackProvider: false, // attempt=1
      shouldCompressContext: false,
      shouldBumpMaxTokens: false,
    });
  });

  it('[v0.0.25] EMPTY_RESPONSE attempt>=2 → shouldFallbackProvider=true（连续 N 次升级）', () => {
    const h = computeHints(LlmErrorCategory.EMPTY_RESPONSE, ctxAttempt2);
    expect(h.retryable).toBe(true);
    expect(h.shouldFallbackProvider).toBe(true);
  });

  it('TIMEOUT_FIRST_CHUNK / TIMEOUT_INTER_CHUNK → retryable 但不 fallback', () => {
    for (const cat of [LlmErrorCategory.TIMEOUT_FIRST_CHUNK, LlmErrorCategory.TIMEOUT_INTER_CHUNK]) {
      const h = computeHints(cat, ctxAttempt2); // 即使 attempt=2 也不 fallback
      expect(h.retryable).toBe(true);
      expect(h.shouldFallbackProvider).toBe(false);
    }
  });

  it('AUTH_INVALID 单 key → shouldFallbackProvider（无 key 可换）', () => {
    const h = computeHints(LlmErrorCategory.AUTH_INVALID, ctxSingle);
    expect(h).toEqual({
      retryable: false,
      shouldRotateKey: false,
      shouldFallbackProvider: true,
      shouldCompressContext: false,
      shouldBumpMaxTokens: false,
    });
  });

  it('AUTH_INVALID 多 key → shouldRotateKey=true', () => {
    const h = computeHints(LlmErrorCategory.AUTH_INVALID, ctxMulti);
    expect(h.shouldRotateKey).toBe(true);
    expect(h.shouldFallbackProvider).toBe(false);
  });

  it('AUTH_FORBIDDEN 同 AUTH_INVALID 凭证语义', () => {
    expect(computeHints(LlmErrorCategory.AUTH_FORBIDDEN, ctxMulti).shouldRotateKey).toBe(true);
    expect(computeHints(LlmErrorCategory.AUTH_FORBIDDEN, ctxSingle).shouldFallbackProvider).toBe(true);
  });

  it('CONTEXT_LENGTH_EXCEEDED → shouldCompressContext', () => {
    const h = computeHints(LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED, ctxSingle);
    expect(h.shouldCompressContext).toBe(true);
    expect(h.retryable).toBe(false);
  });

  it('MAX_TOKENS_EXCEEDED → shouldBumpMaxTokens', () => {
    const h = computeHints(LlmErrorCategory.MAX_TOKENS_EXCEEDED, ctxSingle);
    expect(h.shouldBumpMaxTokens).toBe(true);
    expect(h.retryable).toBe(false);
  });

  it('§6.4 CONTENT_FILTERED → 全 false（NO_RETRY 合规）', () => {
    const h = computeHints(LlmErrorCategory.CONTENT_FILTERED, ctxSingle);
    expect(h).toEqual({
      retryable: false,
      shouldRotateKey: false,
      shouldFallbackProvider: false,
      shouldCompressContext: false,
      shouldBumpMaxTokens: false,
    });
  });

  it('MODEL_NOT_FOUND / MALFORMED_TOOL_CALL / BAD_REQUEST_OTHER / ABORTED_BY_USER → 全 false', () => {
    for (const cat of [
      LlmErrorCategory.MODEL_NOT_FOUND,
      LlmErrorCategory.MALFORMED_TOOL_CALL,
      LlmErrorCategory.BAD_REQUEST_OTHER,
      LlmErrorCategory.ABORTED_BY_USER,
    ]) {
      const h = computeHints(cat, ctxSingle);
      expect(h.retryable).toBe(false);
      expect(h.shouldRotateKey).toBe(false);
      expect(h.shouldFallbackProvider).toBe(false);
      expect(h.shouldCompressContext).toBe(false);
      expect(h.shouldBumpMaxTokens).toBe(false);
    }
  });
});

// ============================================================
// 8. classify 主入口派发 + ClassifiedLlmError 组装
// ============================================================
describe('classify 主入口 + ClassifiedLlmError 组装', () => {
  it('anthropic_compatible provider 派发到 AnthropicErrorClassifier', () => {
    const err = classify(wire(429, 'rate_limit_error', 'rate limited', { 'retry-after': '10' }), 'anthropic_compatible');
    expect(err.category).toBe(LlmErrorCategory.RATE_LIMITED);
    expect(err.retryAfter).toBe(10);
    expect(err.hints.retryable).toBe(true);
    expect(err.rawError?.status).toBe(429);
  });

  it('ClassifiedLlmError 是 Error 子类形态（有 message + stack）', () => {
    const err = classify(wire(500, 'api_error', 'boom'), 'anthropic_compatible');
    expect(err).toBeInstanceOf(Error);
    expect(typeof err.message).toBe('string');
    expect(err.message).toContain('boom');
    expect(err.hints).toBeDefined();
  });

  it('openai_compatible provider 派发到 OpenAIErrorClassifier（占位 HTTP 兜底）', () => {
    const err = classify(wire(401, '', 'bad key'), 'openai_compatible');
    expect(err.category).toBe(LlmErrorCategory.AUTH_INVALID);
  });

  it('glm provider 派发到 GLMErrorClassifier（占位 HTTP 兜底）', () => {
    const err = classify(wire(429, '', 'slow down'), 'glm');
    expect(err.category).toBe(LlmErrorCategory.RATE_LIMITED);
  });

  it('未知 provider 兜底用 anthropic adapter', () => {
    const err = classify(wire(429, 'rate_limit_error', 'rate limited'), 'unknown_provider' as never);
    expect(err.category).toBe(LlmErrorCategory.RATE_LIMITED);
  });

  it('[v0.0.350] 4 native coding plan 无独立 classifier → ?? 兜底 anthropic adapter（Partial 化零行为变化）', () => {
    // 探针 = anthropic 专有映射 529→PROVIDER_OVERLOADED（仅 AnthropicErrorClassifier 有）；
    // 若 Partial 化引入回归（undefined 调用崩溃 / 兜底错 adapter），此处必红。
    for (const name of ['kimi_coding_plan', 'glm_coding_plan', 'minimax_coding_plan', 'deepseek_api'] as const) {
      const err = classify(wire(529, 'overloaded_error', 'overloaded'), name);
      expect(err.category, `provider=${name}`).toBe(LlmErrorCategory.PROVIDER_OVERLOADED);
    }
  });

  it('ctx.hasMultipleKeys 传递到 hints（AUTH 多 key rotate）', () => {
    const err = classify(wire(401, 'authentication_error', 'bad key'), 'anthropic_compatible', {
      hasMultipleKeys: true,
      attempt: 1,
    });
    expect(err.hints.shouldRotateKey).toBe(true);
  });

  it('partial 字段在 MAX_TOKENS_EXCEEDED 时不被 classify 注入（由调用方提供）', () => {
    // classify 本身不构造 partial；partial 由 LlmCaller 在流处理时填入 ClassifiedLlmError
    const err = classify(stopReason('max_tokens', { message: { content: [] } }), 'anthropic_compatible');
    expect(err.category).toBe(LlmErrorCategory.MAX_TOKENS_EXCEEDED);
    expect(err.partial).toBeUndefined(); // classify 不自动搬 partial
  });
});

// ============================================================
// 9. fallbackByHttpStatus（OpenAI/GLM 占位用）
// ============================================================
describe('fallbackByHttpStatus §5 OpenAI/GLM 兜底', () => {
  it('401 → AUTH_INVALID', () => {
    expect(fallbackByHttpStatus(401).category).toBe(LlmErrorCategory.AUTH_INVALID);
  });

  it('403 → AUTH_FORBIDDEN', () => {
    expect(fallbackByHttpStatus(403).category).toBe(LlmErrorCategory.AUTH_FORBIDDEN);
  });

  it('404 → MODEL_NOT_FOUND', () => {
    expect(fallbackByHttpStatus(404).category).toBe(LlmErrorCategory.MODEL_NOT_FOUND);
  });

  it('429 → RATE_LIMITED', () => {
    expect(fallbackByHttpStatus(429).category).toBe(LlmErrorCategory.RATE_LIMITED);
  });

  it('500/502/503 → SERVER_ERROR', () => {
    expect(fallbackByHttpStatus(500).category).toBe(LlmErrorCategory.SERVER_ERROR);
    expect(fallbackByHttpStatus(503).category).toBe(LlmErrorCategory.SERVER_ERROR);
  });

  it('其他 4xx → BAD_REQUEST_OTHER', () => {
    expect(fallbackByHttpStatus(418).category).toBe(LlmErrorCategory.BAD_REQUEST_OTHER);
  });

  it('从 body 抽 message（{error:{message}} 形态）', () => {
    const r = fallbackByHttpStatus(429, { error: { message: 'too many requests' } });
    expect(r.message).toBe('too many requests');
  });

  it('从 body 抽 message（裸 {message} 形态）', () => {
    const r = fallbackByHttpStatus(500, { message: 'internal error' });
    expect(r.message).toBe('internal error');
  });
});
