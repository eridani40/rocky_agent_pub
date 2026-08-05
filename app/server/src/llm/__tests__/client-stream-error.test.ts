/**
 * LlmClient.stream HTTP status 检查集成测试（v0.0.8 BUG-004 回归）
 * 参考: states/v0.0.8/bugs/BUG-004-llm-client-ignores-http-error-status-[open].md
 *
 * 关键：经真实 LlmClient（mock fetch 返 500 + error SSE body）→ 断言 stream() 抛错。
 * 不用 stub client 绕过。同时验证：
 *   - 非错误剧本（200）不受影响
 *   - error SSE body 里的 message 被透出
 *   - client.call 非 2xx 同样抛错
 */
import { describe, it, expect } from 'vitest';
import { LlmClient } from '../client';
import AnthropicCompatibleProvider from '../../../../plugins/builtins/llm_anthropic/provider';
import AnthropicMessagesProtocol from '../../../../plugins/builtins/llm_anthropic/protocol';
import type { LlmProviderConfig, LlmModelConfig } from '../provider-types';
import type { CanonicalRequest } from '../protocol';
import { buildErrorSse } from '../../mock-llm-scenarios';

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
    modelId: 'claude-sonnet-4-6',
    inputModalities: ['text'],
    outputModalities: ['text'],
    contextWindow: 200000,
    maxOutputTokens: 16000,
    paramConstraints: {},
    pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
    providerId: 'p1',
  };
}

function makeRequest(): CanonicalRequest {
  return {
    modelId: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: { maxTokens: 100 },
  };
}

/** mock fetch 返 500 + anthropic error SSE body（与 mock:error 剧本一致） */
function mockFetch500Error(): typeof fetch {
  return (async () => {
    const enc = new TextEncoder();
    const readable = new ReadableStream({
      start(ctl) {
        ctl.enqueue(enc.encode(buildErrorSse()));
        ctl.close();
      },
    });
    return new Response(readable, {
      status: 500,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

/** mock fetch 返 200 + 正常 SSE（验证非错误剧本不受影响） */
function mockFetch200Ok(): typeof fetch {
  return (async () => {
    const enc = new TextEncoder();
    const body =
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const readable = new ReadableStream({
      start(ctl) {
        ctl.enqueue(enc.encode(body));
        ctl.close();
      },
    });
    return new Response(readable, { status: 200 });
  }) as typeof fetch;
}

describe('BUG-004 regression: LlmClient.stream status 检查', () => {
  it('mock:error 500 → stream() 抛错且包含 status', async () => {
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      fetchImpl: mockFetch500Error(),
    });
    await expect(async () => {
      for await (const _ of client.stream(makeRequest())) void _;
    }).rejects.toThrow(/500/);
  });

  it('error SSE body 里的 message 被透出到异常信息', async () => {
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      fetchImpl: mockFetch500Error(),
    });
    let caught: Error | undefined;
    try {
      for await (const _ of client.stream(makeRequest())) void _;
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain('mock error');
  });

  it('非错误剧本（200 + 正常 SSE）不受影响，正常 yield StreamEvent', async () => {
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      fetchImpl: mockFetch200Ok(),
    });
    const types: string[] = [];
    for await (const e of client.stream(makeRequest())) types.push(e.type);
    expect(types).toEqual(['text_delta', 'finish']);
  });
});

describe('BUG-004 regression: LlmClient.call status 检查', () => {
  it('非 2xx → call() 抛错', async () => {
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      fetchImpl: (async () => new Response('{"error":{"message":"bad"}}', { status: 400 })) as typeof fetch,
    });
    await expect(client.call(makeRequest())).rejects.toThrow(/400/);
  });
});
