/**
 * LlmClient 单测 — onWire 物理层钩子（v0.0.25 BUG-001 §3.8）
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_client_interface.md §3.8
 *       states/v0.0.25/bugs/BUG-001-tool-result-visibility-[open].md
 *
 * 覆盖：
 *   - onWire 在 prepare（encode + header 组装）后、fetchImpl 前调用
 *   - onWire 收到 (request, body, url) 三参 —— body 是 protocol.encode 产出（最终 wire body）
 *   - stream + call 两路都触发
 *   - 向后兼容：不传 onWire 时行为完全不变（正常发包 / 不抛错）
 *   - onWire 抛错不被吞（保持钩子语义清晰；调用方负责 try/catch）
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

/** 记录 fetch 收到的 body（验证 onWire 拿到的是同一个 wire body） */
interface FetchSpy {
  fetchImpl: typeof fetch;
  /** 调用 fetch 后最新捕获的 body（在 fetch 执行后读取） */
  state: { body: unknown; url: string };
}

function makeFetchSpy(): FetchSpy {
  const state = { body: null as unknown, url: '' };
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    state.url = String(input);
    state.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      id: 'msg_1',
      content: [{ type: 'text', text: '答' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, state };
}

function makeStreamFetchSpy(): FetchSpy {
  const state = { body: null as unknown, url: '' };
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    state.url = String(input);
    state.body = JSON.parse(String(init?.body));
    const enc = new TextEncoder();
    const readable = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ));
        c.close();
      },
    });
    return new Response(readable, { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, state };
}

function makeClient(opts: {
  fetchImpl: typeof fetch;
  onWire?: (req: CanonicalRequest, body: unknown, url: string) => void;
}): LlmClient {
  return new LlmClient({
    providerConfig: makeProviderConfig(),
    provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
    protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
    modelConfig: makeModelConfig(),
    fetchImpl: opts.fetchImpl,
    ...(opts.onWire !== undefined ? { onWire: opts.onWire } : {}),
  });
}

// ============================================================
// 1. call 路径：onWire 在 prepare 后 fetch 前被调用
// ============================================================

describe('LlmClient.onWire (call path)', () => {
  it('onWire 在 fetchImpl 前被调用（顺序保证）', async () => {
    const order: string[] = [];
    const spy = makeFetchSpy();
    const client = makeClient({
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        order.push('fetch');
        return spy.fetchImpl(...args);
      }) as typeof fetch,
      onWire: () => { order.push('onWire'); },
    });
    await client.call(makeRequest());
    // 顺序：onWire 必须在 fetch 前
    expect(order).toEqual(['onWire', 'fetch']);
  });

  it('onWire 收到 (request, body, url) —— body 是 protocol.encode 产出', async () => {
    const spy = makeFetchSpy();
    let capturedReq: CanonicalRequest | undefined;
    let capturedBody: unknown;
    let capturedUrl = '';
    const client = makeClient({
      fetchImpl: spy.fetchImpl,
      onWire: (req, body, url) => {
        capturedReq = req;
        capturedBody = body;
        capturedUrl = url;
      },
    });
    await client.call(makeRequest());
    // url = baseUrl + protocol.path
    expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages');
    expect(capturedUrl).toBe(spy.state.url);
    // request 是逻辑层 CanonicalRequest
    expect(capturedReq?.modelId).toBe('claude-sonnet-4-6');
    expect(capturedReq?.messages).toHaveLength(1);
    // body 是 protocol.encode 产出（与 fetch 收到的一致）
    expect(capturedBody).toEqual(spy.state.body);
    // wire body 含 anthropic 形态（model + messages + max_tokens）
    expect((capturedBody as Record<string, unknown>)['model']).toBe('claude-sonnet-4-6');
    expect((capturedBody as Record<string, unknown>)['stream']).toBe(false);
  });

  it('onWire body 含 tool_result content 原文（BUG-001 核心确诊点）', async () => {
    const spy = makeFetchSpy();
    let capturedBody: unknown;
    const client = makeClient({
      fetchImpl: spy.fetchImpl,
      onWire: (_req, body) => { capturedBody = body; },
    });
    await client.call(makeRequest({
      messages: [
        { role: 'user', content: [{ type: 'text', text: '调工具' }] },
        {
          role: 'assistant',
          // canonical tool_call（v0.0.8 字段名 id/name/arguments）
          content: [{ type: 'tool_call', id: 't1', name: 'bash', arguments: { cmd: 'ls' } }],
        },
        {
          role: 'tool',
          content: [{
            // canonical tool_result（字段名 toolCallId/content(ContentBlock[])/isError）
            type: 'tool_result',
            toolCallId: 't1',
            content: [{ type: 'text', text: 'REAL_RESULT_NO_TRUNCATION' }],
            isError: false,
          }],
        },
      ],
    }));
    // wire body 应含 tool_result 的真实 content（task 7 已改 role=tool→user + 合并）。
    // v0.0.8 起 canonical tool_result.content 是 ContentBlock[],encode 后 wire 也是
    // content block 数组(非裸 string)。断言改为读出首个 text block 的 text。
    const body = capturedBody as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    const allBlocks = body.messages.flatMap(m => m.content);
    const toolResult = allBlocks.find(b => b['type'] === 'tool_result');
    expect(toolResult).toBeDefined();
    const trContent = toolResult?.['content'] as Array<{ type: string; text?: string }>;
    expect(Array.isArray(trContent)).toBe(true);
    expect(trContent[0]?.text).toBe('REAL_RESULT_NO_TRUNCATION');
  });
});

// ============================================================
// 2. stream 路径：onWire 同源注入（prepare 后 fetch 前）
// ============================================================

describe('LlmClient.onWire (stream path)', () => {
  it('onWire 在 stream fetchImpl 前被调用', async () => {
    const order: string[] = [];
    const spy = makeStreamFetchSpy();
    const client = makeClient({
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        order.push('fetch');
        return spy.fetchImpl(...args);
      }) as typeof fetch,
      onWire: () => { order.push('onWire'); },
    });
    for await (const _ of client.stream(makeRequest())) void _;
    expect(order).toEqual(['onWire', 'fetch']);
  });

  it('onWire 收到 stream=true 的 body（stream 路径特有）', async () => {
    const spy = makeStreamFetchSpy();
    let capturedBody: unknown;
    const client = makeClient({
      fetchImpl: spy.fetchImpl,
      onWire: (_req, body) => { capturedBody = body; },
    });
    for await (const _ of client.stream(makeRequest())) void _;
    // stream 路径 encode 时 stream=true
    expect((capturedBody as Record<string, unknown>)['stream']).toBe(true);
    expect(capturedBody).toEqual(spy.state.body);
  });
});

// ============================================================
// 3. 向后兼容：不传 onWire 行为不变
// ============================================================

describe('LlmClient.onWire (backward-compat)', () => {
  it('不传 onWire 时 call 正常工作', async () => {
    const spy = makeFetchSpy();
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      fetchImpl: spy.fetchImpl,
      // 故意不传 onWire
    });
    const resp = await client.call(makeRequest());
    expect(resp.message.role).toBe('assistant');
    expect(resp.usage.total_tokens).toBe(2);
  });

  it('不传 onWire 时 stream 正常工作', async () => {
    const spy = makeStreamFetchSpy();
    const client = new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeModelConfig(),
      fetchImpl: spy.fetchImpl,
      // 故意不传 onWire
    });
    const evts: string[] = [];
    for await (const e of client.stream(makeRequest())) {
      evts.push(e.type);
    }
    expect(evts).toContain('finish');
  });

  it('onWire 抛错不被 client 吞（钩子语义清晰，调用方负责 try/catch）', async () => {
    const spy = makeFetchSpy();
    const client = makeClient({
      fetchImpl: spy.fetchImpl,
      onWire: () => { throw new Error('onWire intentional failure'); },
    });
    // onWire 抛 → call 也抛（调用方决定是否吞）
    await expect(client.call(makeRequest())).rejects.toThrow(/onWire intentional failure/);
  });
});
