/**
 * StreamConsumer usage char 字段单测（白盒）—— v0.0.13 S3 D3.1
 * 参考: specs/tech/agent/session/[P0]session_usage.md §1 D3.1（outputCharCount=纯 TextBlock 字符数）
 *       specs/tech/agent/providers_and_models/[P0]llm_client_interface.md §3.7（stream cost/currency 闭环）
 *
 * 验证点：
 *   - outputCharCount 仅累加 text_delta.text 字符数（不含 reasoning/tool_call）
 *   - inputCharCount 从构造期注入（snapshot.inputCharCount）→ handleUsage 写入 usage
 *   - handleUsage 产 usage_block 事件含 outputCharCount + inputCharCount
 */
import { describe, it, expect } from 'vitest';
import { StreamConsumer } from '../agent-loop-stream';
import type { AgentEvent } from '../agent-event-types';

describe('StreamConsumer — usage char 字段（v0.0.13 S3 D3.1）', () => {
  it('outputCharCount 累加纯 text_delta 字符数（UTF-16 code unit = .length）', () => {
    const events: AgentEvent[] = [];
    const consumer = new StreamConsumer({
      sessionId: 's1', runId: 'r1', messageId: 'm1',
      emit: (e) => events.push(e),
    });
    // 三段 text + 一段 reasoning + 一段 tool_call delta
    consumer.consume({ type: 'text_delta', text: '你好' }); // 2 chars（中文 BMP 内 .length=2）
    consumer.consume({ type: 'text_delta', text: 'world' }); // 5 chars
    consumer.consume({ type: 'thinking_delta', thinking: '应被忽略' }); // reasoning 不计入
    consumer.consume({
      type: 'tool_call_delta', toolCallId: 'tc1', name: 'tool',
      argumentsDelta: '{"a":1}', // tool arguments 不计入
    });
    // 触发 usage 事件 → handleUsage 把累积 outputCharCount 写入 usage
    consumer.consume({ type: 'usage', usage: { output_response: 10 } });
    const usageEvt = events.find((e) => e.type === 'usage_block') as
      | { usage: { outputCharCount?: number } } | undefined;
    expect(usageEvt).toBeDefined();
    // 你好(2) + world(5) = 7；reasoning/tool_call 不计
    expect(usageEvt!.usage.outputCharCount).toBe(7);
  });

  it('inputCharCount 从构造期注入 → handleUsage 写入 usage', () => {
    const events: AgentEvent[] = [];
    const consumer = new StreamConsumer({
      sessionId: 's1', runId: 'r1', messageId: 'm1',
      emit: (e) => events.push(e),
      inputCharCount: 339,
    });
    consumer.consume({ type: 'text_delta', text: 'hi' });
    consumer.consume({ type: 'usage', usage: { output_response: 5 } });
    const usageEvt = events.find((e) => e.type === 'usage_block') as
      | { usage: { inputCharCount?: number; outputCharCount?: number } } | undefined;
    expect(usageEvt).toBeDefined();
    expect(usageEvt!.usage.inputCharCount).toBe(339);
    expect(usageEvt!.usage.outputCharCount).toBe(2); // 'hi'
  });

  it('未注入 inputCharCount → usage 不含 inputCharCount（向后兼容）', () => {
    const events: AgentEvent[] = [];
    const consumer = new StreamConsumer({
      sessionId: 's1', runId: 'r1', messageId: 'm1',
      emit: (e) => events.push(e),
      // 不传 inputCharCount
    });
    consumer.consume({ type: 'usage', usage: { output_response: 5 } });
    const usageEvt = events.find((e) => e.type === 'usage_block') as
      | { usage: { inputCharCount?: number } } | undefined;
    expect(usageEvt).toBeDefined();
    expect(usageEvt!.usage.inputCharCount).toBeUndefined();
  });

  it('多轮 usage 事件（ReAct 多轮）每次写当前累积 outputCharCount', () => {
    const events: AgentEvent[] = [];
    const consumer = new StreamConsumer({
      sessionId: 's1', runId: 'r1', messageId: 'm1',
      emit: (e) => events.push(e),
    });
    consumer.consume({ type: 'text_delta', text: 'aaa' }); // 3
    consumer.consume({ type: 'usage', usage: { output_response: 3 } });
    consumer.consume({ type: 'text_delta', text: 'bb' }); // +2 = 5
    consumer.consume({ type: 'usage', usage: { output_response: 2 } });
    const usageEvts = events.filter((e) => e.type === 'usage_block') as
      { usage: { outputCharCount?: number } }[];
    expect(usageEvts).toHaveLength(2);
    expect(usageEvts[0]!.usage.outputCharCount).toBe(3);
    expect(usageEvts[1]!.usage.outputCharCount).toBe(5);
  });

  it('getLastUsage 返回最后写入的 usage（含 char 字段）', () => {
    const consumer = new StreamConsumer({
      sessionId: 's1', runId: 'r1', messageId: 'm1',
      emit: () => {},
      inputCharCount: 100,
    });
    consumer.consume({ type: 'text_delta', text: 'hello' });
    consumer.consume({ type: 'usage', usage: { output_response: 5 } });
    const u = consumer.getLastUsage();
    expect(u).toMatchObject({
      output_response: 5,
      outputCharCount: 5,
      inputCharCount: 100,
    });
  });
});
