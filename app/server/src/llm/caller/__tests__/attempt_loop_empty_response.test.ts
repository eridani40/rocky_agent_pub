/**
 * attemptLoop — EMPTY_RESPONSE 检测单测（T12）
 * 参考: specs/tech/agent/llm_caller/[P0]error_normalization.md §4.3 + §6.7（EMPTY_RESPONSE）
 *       specs/tech/agent/llm_caller/[P0]length_handling.md §4（STREAM_INCOMPLETE 区分）
 *
 * [T12] 覆盖：
 *   - 流正常 finish（stop_reason=stop）+ content 空（无 text 无 tool_call）→ EMPTY_RESPONSE
 *   - 纯 tool_call 响应（无 text 但有 tool_call）→ 不空（正常 ok，stopReason=tool_use）
 *   - 有非空 text → 不空（正常 ok）
 *   - 纯空白 text（text.trim()=''）→ 空（EMPTY_RESPONSE）
 *   - 有 thinking 但无 text 无 tool_call → 空（aggregator 不收集 thinking block）
 *   - stop_reason=max_tokens 不进 EMPTY_RESPONSE 路径（走 max_tokens_finish）
 *
 * 测试方式：直接调 attemptLoop（stub LlmClient 产可控 stream）。
 * 单文件 ≤300 行。
 */
import { describe, it, expect } from 'vitest';
import { attemptLoop } from '../attempt_loop';
import { LlmErrorCategory } from '../error_types';
import type { LlmClient } from '../../client';
import type { StreamEvent } from '../../protocol';
import type { TimeoutConfig } from '../../../config/llm_request_config';

// ──────────────────────────────────────────────────────────────────────────
// stub 构造
// ──────────────────────────────────────────────────────────────────────────

/** 未中止的 userController（AbortControllerHandle inline，与现有测试一致）。 */
function userController(): { runId: string; aborted: boolean } {
  return { runId: 'r1', aborted: false };
}

/** 默认超时配置（足够大，不触发 watchdog）。 */
function timeoutConfig(): TimeoutConfig {
  return {
    ttfb_s: 60,
    stall_answer_s: 60,
    stall_think_s: 60,
    stall_tool_s: 60,
    wall_max_s: 300,
  };
}

/** 构造 LlmClient stub：stream 为固定 AsyncIterable。 */
function clientWith(stream: AsyncIterable<StreamEvent>): LlmClient {
  return {
    stream: async function* (_req: unknown, _signal?: AbortSignal): AsyncGenerator<StreamEvent> {
      for await (const evt of stream) yield evt;
    },
    getInfo: () => ({
      providerId: 'p1',
      providerName: 'anthropic_compatible' as const,
      modelId: 'm1',
      maxOutputTokens: 8192,
      capabilities: { maxOutputTokens: 8192, supportsPrefill: true, supportsThinking: true },
    }),
  } as unknown as LlmClient;
}

/** 空 baseReq（不参与 EMPTY_RESPONSE 判定，仅占位）。 */
function baseReq() {
  return {
    modelId: 'm1',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
    params: { maxTokens: 4096 },
  };
}

// ─── stream 构造器 ───

/** 流正常 finish（reason=stop）但无任何 content delta（空响应）。 */
async function* emptyStopStream(): AsyncGenerator<StreamEvent> {
  yield { type: 'usage', usage: { output_total_tokens: 0, input_total_tokens: 5 } as never };
  yield { type: 'finish', reason: 'stop' };
}

/** 流含非空 text，正常 finish（reason=stop）。 */
async function* textStopStream(text: string): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', text };
  yield { type: 'finish', reason: 'stop' };
}

/** 流含纯空白 text（text.trim()=''），正常 finish。 */
async function* whitespaceTextStream(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', text: '   \n\t  ' }; // 仅空白
  yield { type: 'finish', reason: 'stop' };
}

/** 流含 tool_call_delta + finish reason=tool_use（纯 tool_call 响应）。 */
async function* toolUseStream(): AsyncGenerator<StreamEvent> {
  yield {
    type: 'tool_call_delta',
    toolCallId: 'tc_1',
    name: 'search',
    argumentsDelta: JSON.stringify({ query: 'foo' }),
  };
  yield { type: 'finish', reason: 'tool_use' };
}

/** 流含 thinking_delta（aggregator 不收集）但无 text 无 tool_call，正常 finish。 */
async function* thinkingOnlyStream(): AsyncGenerator<StreamEvent> {
  yield { type: 'thinking_delta', thinking: 'let me think...' };
  yield { type: 'finish', reason: 'stop' };
}

/** 流 finish reason=max_tokens + partial text（不进 EMPTY_RESPONSE 路径）。 */
async function* maxTokensStream(): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', text: 'partial' };
  yield { type: 'usage', usage: { output_total_tokens: 4096, input_total_tokens: 5 } as never };
  yield { type: 'finish', reason: 'max_tokens' };
}

// ──────────────────────────────────────────────────────────────────────────
// EMPTY_RESPONSE 检测
// ──────────────────────────────────────────────────────────────────────────

describe('attemptLoop EMPTY_RESPONSE 检测（T12 / spec §6.7）', () => {
  it('流 finish（stop）+ 无 text 无 tool_call → EMPTY_RESPONSE', async () => {
    const result = await attemptLoop({
      client: clientWith(emptyStopStream()),
      req: baseReq(),
      providerName: 'anthropic_compatible',
      userController: userController(),
      timeoutConfig: timeoutConfig(),
      hasMultipleKeys: false,
      attempt: 1,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.err.category).toBe(LlmErrorCategory.EMPTY_RESPONSE);
      // EMPTY_RESPONSE 是可重试瞬时（spec §6.7）
      expect(result.err.hints.retryable).toBe(true);
      expect(result.err.hints.shouldBumpMaxTokens).toBe(false);
      expect(result.err.hints.shouldCompressContext).toBe(false);
    }
  });

  it('纯空白 text（text.trim()=""）→ EMPTY_RESPONSE（spec §6.7 trim 后无实质内容）', async () => {
    const result = await attemptLoop({
      client: clientWith(whitespaceTextStream()),
      req: baseReq(),
      providerName: 'anthropic_compatible',
      userController: userController(),
      timeoutConfig: timeoutConfig(),
      hasMultipleKeys: false,
      attempt: 1,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.err.category).toBe(LlmErrorCategory.EMPTY_RESPONSE);
    }
  });

  it('有 thinking 但无 text 无 tool_call → EMPTY_RESPONSE（aggregator 不收集 thinking block）', async () => {
    const result = await attemptLoop({
      client: clientWith(thinkingOnlyStream()),
      req: baseReq(),
      providerName: 'anthropic_compatible',
      userController: userController(),
      timeoutConfig: timeoutConfig(),
      hasMultipleKeys: false,
      attempt: 1,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.err.category).toBe(LlmErrorCategory.EMPTY_RESPONSE);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// 非空响应（不触发 EMPTY_RESPONSE）
// ──────────────────────────────────────────────────────────────────────────

describe('attemptLoop 非空响应（不触发 EMPTY_RESPONSE）', () => {
  it('有非空 text → 正常 ok（不空）', async () => {
    const result = await attemptLoop({
      client: clientWith(textStopStream('hello world')),
      req: baseReq(),
      providerName: 'anthropic_compatible',
      userController: userController(),
      timeoutConfig: timeoutConfig(),
      hasMultipleKeys: false,
      attempt: 1,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.stopReason).toBe('stop');
    }
  });

  it('纯 tool_call 响应（无 text 但有 tool_call）→ 正常 ok stopReason=tool_use（不空）', async () => {
    const result = await attemptLoop({
      client: clientWith(toolUseStream()),
      req: baseReq(),
      providerName: 'anthropic_compatible',
      userController: userController(),
      timeoutConfig: timeoutConfig(),
      hasMultipleKeys: false,
      attempt: 1,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.stopReason).toBe('tool_use');
    }
  });

  it('stop_reason=max_tokens（有 partial）→ 走 max_tokens_finish，不进 EMPTY_RESPONSE 路径', async () => {
    const result = await attemptLoop({
      client: clientWith(maxTokensStream()),
      req: baseReq(),
      providerName: 'anthropic_compatible',
      userController: userController(),
      timeoutConfig: timeoutConfig(),
      hasMultipleKeys: false,
      attempt: 1,
    });
    // max_tokens finish 路径（spec §4.3 / length_handling §2），非 EMPTY_RESPONSE
    expect(result.kind).toBe('max_tokens_finish');
  });
});
