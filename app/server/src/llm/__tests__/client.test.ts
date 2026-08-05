/**
 * LlmClient 单测（白盒）—— stream 编排 + 可注入 fetch
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_client_interface.md §2/§3.2
 *       specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.6（StreamEvent）
 *
 * 覆盖：
 *   - stream() 拼接 URL = baseUrl + protocol.path
 *   - headers 含 buildAuthHeaders + Content-Type
 *   - 用 protocol.parseStream 解析每个 chunk 并 yield StreamEvent
 *   - mock 注入点（fetch 可注入，T4 server 用此返假 SSE）
 */
import { describe, it, expect } from 'vitest';
import { LlmClient } from '../client';
import AnthropicCompatibleProvider from '../../../../plugins/builtins/llm_anthropic/provider';
import AnthropicMessagesProtocol from '../../../../plugins/builtins/llm_anthropic/protocol';
import type { LlmProviderConfig, LlmModelConfig } from '../provider-types';
import type { CanonicalRequest } from '../protocol';

function makeProviderConfig(
  overrides: Partial<LlmProviderConfig> = {},
): LlmProviderConfig {
  return {
    id: 'p1',
    name: 'anthropic_compatible',
    protocolId: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com',
    credentials: { key: 'sk-test' },
    pluginId: 'builtin.anthropic',
    enabled: true,
    models: [],
    ...overrides,
  };
}

function makeModelConfig(
  overrides: Partial<LlmModelConfig> = {},
): LlmModelConfig {
  return {
    modelId: 'claude-sonnet-4-6',
    inputModalities: ['text'],
    outputModalities: ['text'],
    contextWindow: 200000,
    maxOutputTokens: 16000,
    paramConstraints: {},
    pricing: {
      inputPerMillion: 3,
      outputPerMillion: 15,
      currency: 'USD',
    },
    providerId: 'p1',
    ...overrides,
  };
}

function makeRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    modelId: 'claude-sonnet-4-6',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ],
    params: { maxTokens: 100 },
    ...overrides,
  };
}

/** 构造一个可注入的 mock fetch，返回给定 SSE 文本切成 N 个 chunk */
function mockFetchSse(chunks: string[]): typeof fetch {
  return (async () => {
    const enc = new TextEncoder();
    const readable = new ReadableStream({
      start(ctl) {
        for (const c of chunks) ctl.enqueue(enc.encode(c));
        ctl.close();
      },
    });
    return new Response(readable, { status: 200 });
  }) as typeof fetch;
}

describe('LlmClient.stream', () => {
  it('yields StreamEvents parsed from SSE chunks (thinking + text + finish)', async () => {
    const providerConfig = makeProviderConfig();
    const client = new LlmClient({
      providerConfig,
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      fetchImpl: mockFetchSse([
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"想"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"答"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    });

    const evts: string[] = [];
    for await (const e of client.stream(makeRequest())) {
      evts.push(e.type);
    }
    expect(evts).toEqual(['thinking_delta', 'text_delta', 'finish']);
  });

  it('builds URL = baseUrl + protocol.path', async () => {
    let calledUrl = '';
    const fetchImpl = (async (input: unknown) => {
      calledUrl = String(input);
      return new Response(new ReadableStream({ start(c) { c.close(); } }), {
        status: 200,
      });
    }) as typeof fetch;
    const providerConfig = makeProviderConfig({
      baseUrl: 'https://example.test',
    });
    const client = new LlmClient({
      providerConfig,
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      fetchImpl,
    });
    // drain
    for await (const _ of client.stream(makeRequest())) {
      void _;
    }
    expect(calledUrl).toBe('https://example.test/v1/messages');
  });

  it('passes auth headers + content-type via provider + protocol', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(new ReadableStream({ start(c) { c.close(); } }), {
        status: 200,
      });
    }) as typeof fetch;
    const client = new LlmClient({
      providerConfig: makeProviderConfig({ credentials: { key: 'sk-xyz' } }),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      fetchImpl,
    });
    for await (const _ of client.stream(makeRequest())) void _;
    expect(capturedHeaders?.['x-api-key']).toBe('sk-xyz');
    expect(capturedHeaders?.['anthropic-version']).toBe('2023-06-01');
    expect(capturedHeaders?.['Content-Type']).toBe('application/json');
  });

  it('sends stream:true in encoded body', async () => {
    let capturedBody: unknown;
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(new ReadableStream({ start(c) { c.close(); } }), {
        status: 200,
      });
    }) as typeof fetch;
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      fetchImpl,
    });
    for await (const _ of client.stream(makeRequest())) void _;
    expect((capturedBody as Record<string, unknown>)['stream']).toBe(true);
  });
});

describe('LlmClient.countTokens / contextWindow', () => {
  it('contextWindow getter returns modelConfig.contextWindow', () => {
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig({ contextWindow: 12345 }),
    });
    expect(client.contextWindow).toBe(12345);
  });

  it('countTokens falls back to char estimate when no tokenizer', () => {
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
    });
    expect(client.countTokens('hello')).toBeGreaterThan(0);
  });

  it('countTokens uses injected tokenizer when provided', () => {
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      tokenizer: { count: (s) => s.length * 2 },
    });
    expect(client.countTokens('abc')).toBe(6);
  });
});

// ============================================================
// v0.0.10 t6：call() 的 validate + computeCost + currency（spec §2/§3.3）
// ============================================================

describe('LlmClient.call — validate + computeCost + currency (v0.0.10 t6)', () => {
  /** mock fetch 返回非流式 anthropic 响应（含 cache 字段） */
  function mockFetchCall(usage: Record<string, number>): {
    fetchImpl: typeof fetch;
    capturedBody: { body: unknown };
  } {
    const state = { body: null as unknown };
    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      state.body = JSON.parse(String(init?.body));
      const resp = {
        id: 'msg_1',
        content: [{ type: 'text', text: '答' }],
        stop_reason: 'end_turn',
        usage,
      };
      return new Response(JSON.stringify(resp), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    return { fetchImpl, capturedBody: state };
  }

  it('computeCost 按 modelConfig.pricing 算 cost 并填 currency（spec §3.3）', async () => {
    const { fetchImpl } = mockFetchCall({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 80,
    });
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig({
        pricing: {
          inputPerMillion: 3,
          outputPerMillion: 15,
          cacheReadPerMillion: 0.3,
          cacheWritePerMillion: 3.75,
          currency: 'USD',
        },
      }),
      fetchImpl,
    });
    const resp = await client.call(makeRequest());
    // cost = 100*3/1e6 + 50*15/1e6 + 200*0.3/1e6 + 80*3.75/1e6
    //      = 0.0003 + 0.00075 + 0.00006 + 0.0003 = 0.00141
    expect(resp.usage.cost).toBeCloseTo(0.00141, 6);
    expect(resp.usage.currency).toBe('USD');
    // usage 字段翻译（parseAnthropicUsage）
    expect(resp.usage.input_no_cache).toBe(100);
    expect(resp.usage.output_response).toBe(50);
    expect(resp.usage.input_cache_read).toBe(200);
    expect(resp.usage.input_cache_write).toBe(80);
    expect(resp.usage.input_total_tokens).toBe(380);
    expect(resp.usage.output_total_tokens).toBe(50);
    expect(resp.usage.total_tokens).toBe(430);
  });

  it('computeCost 跳过无定价的 cache 字段（cacheRead/WritePerMillion 缺）', async () => {
    const { fetchImpl } = mockFetchCall({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 200,
    });
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig({
        pricing: { inputPerMillion: 3, outputPerMillion: 15, currency: 'USD' },
      }),
      fetchImpl,
    });
    const resp = await client.call(makeRequest());
    // 无 cacheReadPerMillion → cache_read 不计费
    // cost = 100*3/1e6 + 50*15/1e6 = 0.0003 + 0.00075 = 0.00105
    expect(resp.usage.cost).toBeCloseTo(0.00105, 6);
  });

  it('validate 拒绝超出 paramConstraints.temperature 范围的请求', async () => {
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig({
        paramConstraints: { temperature: { default: 1, min: 0, max: 1 } },
      }),
      fetchImpl: mockFetchCall({ input_tokens: 1, output_tokens: 1 }).fetchImpl,
    });
    await expect(
      client.call(makeRequest({ params: { maxTokens: 10, temperature: 2 } })),
    ).rejects.toThrow(/temperature.*out of/);
  });

  it('validate 拒绝 maxTokens 超过 modelConfig.maxOutputTokens', async () => {
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig({ maxOutputTokens: 100 }),
      fetchImpl: mockFetchCall({ input_tokens: 1, output_tokens: 1 }).fetchImpl,
    });
    // [v0.0.25 BUG-005/T14] validate 现 LlmHttpError{400}(非裸 Error),message 用 wire 字段名 max_tokens
    await expect(
      client.call(makeRequest({ params: { maxTokens: 200 } })),
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/max_tokens.*exceeds/),
    });
  });

  it('stream 也调 validate（拒绝前不发包）', async () => {
    const state = { called: false };
    const fetchImpl = (async () => {
      state.called = true;
      return new Response(new ReadableStream({ start(c) { c.close(); } }), {
        status: 200,
      });
    }) as typeof fetch;
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig({ maxOutputTokens: 100 }),
      fetchImpl,
    });
    await expect(async () => {
      for await (const _ of client.stream(
        makeRequest({ params: { maxTokens: 999 } }),
      )) {
        void _;
      }
    }).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/max_tokens.*exceeds/),
    });
    expect(state.called).toBe(false);
  });
});
