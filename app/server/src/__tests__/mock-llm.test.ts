/**
 * mock-llm 单测 — ROCKY_TEST_MOCK_LLM=1 时注入假 fetch（不真调 Anthropic）
 * 参考: states/v0.0.3/verify/test-plan.md §1（mock 策略）
 *       specs/research/v0.0.3-anthropic-protocol.md §3/§4（anthropic SSE wire 格式）
 *
 * mock 返回 anthropic wire SSE（content_block_delta 等），由 protocol.parseStream
 * 解析为 canonical StreamEvent。本测断言 wire 内容（thinking_delta / text_delta delta
 * + message_stop），并通过 LlmClient.stream 端到端验证 canonical 序列。
 */
import { describe, it, expect } from 'vitest';
import { createMockFetch } from '../mock-llm';
import { LlmClient } from '../llm';
import AnthropicMessagesProtocol from '../../../plugins/builtins/llm_anthropic/protocol';
import AnthropicCompatibleProvider from '../../../plugins/builtins/llm_anthropic/provider';

describe('mock-llm.createMockFetch', () => {
  it('返回 Response，body 含 anthropic wire 事件（thinking/text delta + message_stop）', async () => {
    // 单元测试传 stepDelayMs:0 避免 testTimeout 超时（默认 1000ms 是 e2e D3 用的）
    const fetchImpl = createMockFetch({ stepDelayMs: 0 });
    const resp = await fetchImpl('https://example.com', { method: 'POST' });
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/event-stream');
    const text = await resp.text();
    expect(text).toContain('"type":"thinking_delta"');
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain('"type":"message_stop"');
  });

  it('经 LlmClient.stream 解析为 canonical StreamEvent 序列（thinking+text+usage+finish）', async () => {
    const client = new LlmClient({
      providerConfig: {
        id: 'mock', name: 'anthropic_compatible', protocolId: 'anthropic_messages', baseUrl: 'https://x',
        credentials: { key: 'sk-mock' }, pluginId: 'p', enabled: true, models: [],
      },
      provider: new AnthropicCompatibleProvider('anthropic_compatible'),
      protocol: new AnthropicMessagesProtocol('anthropic_messages'),
      modelConfig: {
        modelId: 'claude-mock-1', inputModalities: ['text'], outputModalities: ['text'],
        contextWindow: 200000, maxOutputTokens: 4096, paramConstraints: {},
        pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
        providerId: 'mock',
      },
      fetchImpl: createMockFetch({ stepDelayMs: 0 }),
    });
    const events = [];
    for await (const e of client.stream({
      modelId: 'claude-mock-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }],
      params: { stream: true },
    })) {
      events.push(e.type);
    }
    expect(events).toContain('thinking_delta');
    expect(events).toContain('text_delta');
    expect(events).toContain('usage');
    expect(events[events.length - 1]).toBe('finish');
  });
});
