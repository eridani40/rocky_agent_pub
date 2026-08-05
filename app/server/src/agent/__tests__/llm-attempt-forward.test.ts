/**
 * v0.0.144 需求3 后端 — forwardEvent 透传 llm_attempt 的 maxAttempts + message UT
 * 参考: specs/tech/version_logs/v0.0.144/change_plan.md「需求 3 后端」forwardEvent 行
 *       specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3.1（llm_attempt → AgentEvent）
 *
 * 覆盖：callLLMViaInvoker 的 onEvent 转发器（forwardEvent）拦截 type='llm_attempt' 的
 * StreamEvent，转成 LlmAttemptEvent AgentEvent emit 到 bus 时，透传新增字段 maxAttempts + message。
 *
 * 测试方式：stub llmCaller.invoke 在其内部调 ctx.onEvent 发一条 llm_attempt StreamEvent，
 * 捕获 input.emit 收到的 AgentEvent，断言 maxAttempts/message 已透传。
 */
import { describe, it, expect, vi } from 'vitest';
import { callLLMViaInvoker } from '../agent-loop-call-via-invoker';
import type { CallLLMInput } from '../agent-loop-base';
import type { StreamConsumer } from '../agent-loop-stream';
import type { AgentEvent, LlmAttemptEvent } from '../agent-event-types';
import type { InvokeContext, InvokeResponse } from '../../llm/caller/llm_caller';
import type { CanonicalRequest } from '../../llm/protocol';
import { LlmErrorCategory } from '../../llm/caller/error_types';
import type { Message } from '../../message/types';

/** 最小 StreamConsumer stub（consume noop；buildMessage 返累积 assistant message 形态；getLastUsage 兜底）。 */
function makeConsumer(): StreamConsumer {
  return {
    consume: vi.fn(),
    buildMessage: (sessionId: string): Message =>
      ({ id: 'a1', sessionId, role: 'assistant', content: [] } as unknown as Message),
    getLastUsage: () => null,
  } as unknown as StreamConsumer;
}

describe('[v0.0.144 需求3] forwardEvent 透传 llm_attempt 的 maxAttempts + message', () => {
  it('llm_attempt StreamEvent → 出站 LlmAttemptEvent 携带 maxAttempts + message', async () => {
    const emitted: AgentEvent[] = [];
    // stub llmCaller：invoke 内部经 ctx.onEvent 发一条 llm_attempt StreamEvent
    const stubLlmCaller = {
      invoke: async (_req: CanonicalRequest, ctx: InvokeContext): Promise<InvokeResponse> => {
        ctx.onEvent?.({
          type: 'llm_attempt',
          category: LlmErrorCategory.PROVIDER_OVERLOADED,
          providerId: 'p1',
          modelId: 'm1',
          keyRef: 'default',
          attempt: 2,
          maxAttempts: 3,
          action: 'FALLBACK',
          message: '服务商过载，请稍后重试',
        });
        return { message: { id: 'x', role: 'assistant', content: [] } as never, usage: null, stopReason: 'stop' };
      },
    };

    const input = {
      sessionId: 'sess-fwd',
      runId: 'run-fwd',
      runKind: 'main',
      client: { stream: async function* () { /* 不实际调用 */ } },
      modelId: 'm1',
      messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      controller: { runId: 'run-fwd', aborted: false },
      emit: (e: AgentEvent) => emitted.push(e),
      messageId: 'a1',
      inputCharCount: 0,
      maxOutputTokens: 1024,
      llmCaller: stubLlmCaller,
      runState: { llmErrorState: {} },
    } as unknown as CallLLMInput;

    await callLLMViaInvoker(input, makeConsumer());

    const evt = emitted.find((e) => e.type === 'llm_attempt') as LlmAttemptEvent | undefined;
    expect(evt).toBeDefined();
    expect(evt!.type).toBe('llm_attempt');
    expect(evt!.category).toBe(LlmErrorCategory.PROVIDER_OVERLOADED);
    expect(evt!.attempt).toBe(2);
    expect(evt!.action).toBe('FALLBACK');
    // 本版本新增字段：maxAttempts + message 已透传
    expect(evt!.maxAttempts).toBe(3);
    expect(evt!.message).toBe('服务商过载，请稍后重试');
  });
});
