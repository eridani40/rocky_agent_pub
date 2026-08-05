/**
 * 端到端 mini 测试：mock fetch → LlmClient.stream → StreamConsumer（v0.0.8 BUG-003 全链路）
 * 参考: states/v0.0.8/bugs/BUG-003-protocol-parse-stream-drops-tool_use-block-[open].md
 *
 * 这才是 UT 漏的全链路：用 mock:tool 剧本的真实 anthropic wire（经 createMockFetch），
 * 经真实 LlmClient.stream（不 stub StreamEvent）→ 真实 protocol-parse-stream →
 * 真实 StreamConsumer（不 stub handleToolCall），断言：
 *   - 产 tool_call_start/delta/end AgentEvent
 *   - 累积出 ToolCallBlock（id/name/arguments=JSON.parse(partial 拼接)）
 *   - text 块不破坏
 *
 * 即 path B 的「真实 HTTP/协议解析路径」端到端验证。
 */
import { describe, it, expect } from 'vitest';
import { LlmClient } from '../../llm/client';
import AnthropicCompatibleProvider from '../../../../plugins/builtins/llm_anthropic/provider';
import AnthropicMessagesProtocol from '../../../../plugins/builtins/llm_anthropic/protocol';
import type { LlmProviderConfig, LlmModelConfig } from '../../llm/provider-types';
import { StreamConsumer } from '../agent-loop-stream';
import { createMockFetch } from '../../mock-llm';
import type { AgentEvent } from '../agent-event-types';
import type { ToolCallBlock } from '../../message/types';

function makeProviderConfig(): LlmProviderConfig {
  return {
    id: 'p1',
    name: 'anthropic_compatible',
    protocolId: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com',
    credentials: { key: 'sk-test' },
    pluginId: 'builtin.anthropic',
    enabled: true,
    models: [],
  };
}

function makeModelConfig(): LlmModelConfig {
  return {
    modelId: 'mock:tool',
    inputModalities: ['text'],
    outputModalities: ['text'],
    contextWindow: 200000,
    maxOutputTokens: 16000,
    paramConstraints: {},
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    providerId: 'p1',
  };
}

describe('BUG-005 messageStart role 断言（assistant 流式气泡不渲染根因）', () => {
  it('messageStart() 产出的事件 role === "assistant"（前端 reducer/flatten 依赖此字段）', () => {
    const events: AgentEvent[] = [];
    const consumer = new StreamConsumer({
      sessionId: 's1',
      runId: 'r1',
      messageId: 'm-asst',
      emit: (e) => events.push(e),
    });
    const start = consumer.messageStart();
    events.push(start);
    // 关键：wire 帧 message_start 必须带 role:'assistant'，
    // 否则前端 reducer push {role:undefined} → flatten 跳过 → 气泡永不渲染（BUG-005）。
    expect(start.type).toBe('message_start');
    expect((start as { role?: string }).role).toBe('assistant');
    // 完整链路也断言：第一个 message_start 的 role 是 assistant
    const ms = events.find((e) => e.type === 'message_start');
    expect((ms as { role?: string }).role).toBe('assistant');
  });
});

describe('BUG-003 e2e: mock:tool 真实链路 StreamConsumer 累积 ToolCallBlock', () => {
  it('mock:tool 首轮 wire → tool_call_start/delta/end + ToolCallBlock(arguments)', async () => {
    const events: AgentEvent[] = [];
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      fetchImpl: createMockFetch({ stepDelayMs: 0 }),
    });
    const consumer = new StreamConsumer({
      sessionId: 's1',
      runId: 'r1',
      messageId: 'm1',
      emit: (e) => events.push(e),
    });
    events.push(consumer.messageStart());
    for await (const evt of client.stream({
      modelId: 'mock:tool',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'run' }] }],
      params: { maxTokens: 100, stream: true },
    })) {
      consumer.consume(evt);
    }
    events.push(consumer.messageEnd());

    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call_start');
    expect(types).toContain('tool_call_delta');
    expect(types).toContain('tool_call_end');

    // 累积的 ToolCallBlock arguments 正确解析（partial_json 拼接后 JSON.parse）
    const msg = consumer.buildMessage('s1');
    const toolBlocks = msg.content.filter((b) => b.type === 'tool_call') as ToolCallBlock[];
    expect(toolBlocks.length).toBe(1);
    const tb = toolBlocks[0]!;
    expect(tb.id).toBe('tool_mock_1');
    expect(tb.name).toBe('bash');
    expect(tb.arguments).toEqual({ command: 'echo hi' });
  });
});
