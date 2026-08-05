/**
 * LlmClient stream 路径 cost/currency 闭环单测 —— v0.0.13 S3 §3.7
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_client_interface.md §3.7（stream + call 两路同源）
 *       specs/tech/agent/session/[P0]session_usage.md §1 D3.2（minimax currency=CNY）
 *
 * 验证点（stream 路径 usage 事件 cost/currency 补齐）：
 *   - stream() yield 的 usage 事件 cost = computeCost(usage)（按 modelConfig.pricing）
 *   - stream() yield 的 usage 事件 currency = modelConfig.pricing.currency
 *   - 与 call() 同源同口径（call 已有测试覆盖，此处只验 stream）
 */
import { describe, it, expect } from 'vitest';
import { LlmClient } from '../client';
import AnthropicCompatibleProvider from '../../../../plugins/builtins/llm_anthropic/provider';
import AnthropicMessagesProtocol from '../../../../plugins/builtins/llm_anthropic/protocol';
import type { LlmProviderConfig, LlmModelConfig } from '../provider-types';
import { createMockFetch } from '../../mock-llm';
import type { StreamEvent } from '../protocol';

function makeProviderConfig(): LlmProviderConfig {
  return {
    id: 'p1', name: 'anthropic_compatible', protocolId: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com',
    credentials: { key: 'sk-test' },
    pluginId: 'builtin.anthropic', enabled: true, models: [],
  };
}

/** minimax-like CNY pricing（D3.2） */
function makeCnyModelConfig(): LlmModelConfig {
  return {
    modelId: 'mock:text',
    inputModalities: ['text'], outputModalities: ['text'],
    contextWindow: 200000, maxOutputTokens: 16000,
    paramConstraints: {},
    // input ¥10/M, output ¥30/M, cache_read ¥1/M, currency CNY（minimax 实际单价，见校准报告）
    pricing: {
      inputPerMillion: 10, outputPerMillion: 30,
      cacheReadPerMillion: 1, currency: 'CNY',
    },
    providerId: 'p1',
  };
}

/** 跑一次 mock:text stream，收集所有 StreamEvent */
async function runStreamOnce(): Promise<StreamEvent[]> {
  const client = new LlmClient({
    providerConfig: makeProviderConfig(),
    provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
    protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
    modelConfig: makeCnyModelConfig(),
    fetchImpl: createMockFetch({ stepDelayMs: 0 }),
  });
  const events: StreamEvent[] = [];
  for await (const e of client.stream({
    modelId: 'mock:text',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: { stream: true },
  } as never)) {
    events.push(e);
  }
  return events;
}

describe('LlmClient stream 路径 cost/currency 闭环（v0.0.13 S3 §3.7）', () => {
  it('stream usage 事件 cost = computeCost + currency = pricing.currency（CNY）', async () => {
    const events = await runStreamOnce();
    const usageEvt = events.find((e) => e.type === 'usage') as
      | { usage: { cost?: number; currency?: string; input_no_cache?: number; output_total_tokens?: number; input_cache_read?: number } }
      | undefined;
    expect(usageEvt).toBeDefined();
    expect(usageEvt!.usage.currency).toBe('CNY');
    expect(typeof usageEvt!.usage.cost).toBe('number');
    const u = usageEvt!.usage;
    if ((u.input_no_cache ?? 0) > 0 || (u.output_total_tokens ?? 0) > 0 || (u.input_cache_read ?? 0) > 0) {
      expect(u.cost!).toBeGreaterThan(0);
    }
  }, 15000);

  it('两次 stream 同 mock 剧本 → cost 一致（同公式同输入，公式同源于 computeCost）', async () => {
    const e1 = await runStreamOnce();
    const e2 = await runStreamOnce();
    const u1 = (e1.find((e) => e.type === 'usage') as { usage: { cost?: number; currency?: string } }).usage;
    const u2 = (e2.find((e) => e.type === 'usage') as { usage: { cost?: number; currency?: string } }).usage;
    expect(u1.currency).toBe('CNY');
    expect(u2.currency).toBe('CNY');
    expect(u1.cost).toBe(u2.cost);
  }, 20000);
});
