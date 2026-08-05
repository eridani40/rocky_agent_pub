/**
 * [v0.0.25 BUG-004 Critical 回归] LlmClient 非 2xx 错误分类端到端 UT
 * 参考: states/v0.0.25/bugs/BUG-004-error-category-network-[open].md
 *
 * 关键（堵 UT bypass 漏洞）：
 *   - 旧 UT 直接喂 WireResponse 形态给 classify，bypass client.ts throw 路径 → 373/373 绿但生产 NETWORK 塌缩。
 *   - 本文件**必须经 client.ts throw 路径**：mock fetchImpl 返非 2xx Response → client.stream/call throw
 *     → 捕获 throw 出的 error → 喂给 classify() → 断言 category。
 *   - 这样 LlmHttpError 是否携 numeric status 才真正被验证（asWireResponse 命中与否）。
 *
 * 覆盖矩阵（anthropic_compatible adapter 期望）：
 *   - 401 + authentication_error → AUTH_INVALID（核心：原 bug 就塌缩成 NETWORK）
 *   - 429 + rate_limit_error     → RATE_LIMITED
 *   - 529 + overloaded_error     → PROVIDER_OVERLOADED
 *   - 真 fetch throw（TypeError）→ 仍 NETWORK（LlmHttpError 不拦截 fetch 层错误）
 *   - LlmHttpError 实例形态自检（status/body/headers/message 齐全）
 */
import { describe, it, expect } from 'vitest';
import { LlmClient } from '../client';
import { LlmHttpError } from '../http_error';
import { classify } from '../caller/error_classify';
import { LlmErrorCategory } from '../caller/error_types';
import AnthropicCompatibleProvider from '../../../../plugins/builtins/llm_anthropic/provider';
import AnthropicMessagesProtocol from '../../../../plugins/builtins/llm_anthropic/protocol';
import type { LlmProviderConfig, LlmModelConfig } from '../provider-types';
import type { CanonicalRequest } from '../protocol';

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

/** 构造返指定 status + JSON body 的 mock fetch */
function mockFetchJsonStatus(status: number, body: unknown, headers: Record<string, string> = {}): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })) as typeof fetch;
}

/** 构造返指定 status + 非 JSON text 的 mock fetch */
function mockFetchTextStatus(status: number, text: string): typeof fetch {
  return (async () =>
    new Response(text, {
      status,
      headers: { 'content-type': 'text/plain' },
    })) as typeof fetch;
}

function makeClient(fetchImpl: typeof fetch): LlmClient {
  return new LlmClient({
    providerConfig: makeProviderConfig(),
    provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
    protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
    modelConfig: makeModelConfig(),
    fetchImpl,
  });
}

/** 消费 stream（触发 throw），捕获抛出的 error */
async function captureStreamError(client: LlmClient): Promise<unknown> {
  try {
    for await (const _ of client.stream(makeRequest())) void _;
    throw new Error('expected stream to throw, but did not');
  } catch (e) {
    return e;
  }
}

/** 消费 call（触发 throw），捕获抛出的 error */
async function captureCallError(client: LlmClient): Promise<unknown> {
  try {
    await client.call(makeRequest());
    throw new Error('expected call to throw, but did not');
  } catch (e) {
    return e;
  }
}

describe('[BUG-004] LlmHttpError 形态自检（client throw 后实例字段齐全）', () => {
  it('stream 401 → throw LlmHttpError，含 numeric status / body 对象 / headers / message', async () => {
    const client = makeClient(
      mockFetchJsonStatus(401, {
        error: { type: 'authentication_error', message: 'login fail' },
      }),
    );
    const err = (await captureStreamError(client)) as LlmHttpError;
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.status).toBe(401);
    expect(typeof err.status).toBe('number'); // asWireResponse 命中条件
    expect(err.body).toEqual({
      error: { type: 'authentication_error', message: 'login fail' },
    });
    expect(err.headers).toBeDefined();
    expect(err.message).toContain('401');
    expect(err.message).toContain('login fail');
  });

  it('call 429 + Retry-After header → throw LlmHttpError，headers 透传（lowercase）', async () => {
    const client = makeClient(
      mockFetchJsonStatus(
        429,
        { error: { type: 'rate_limit_error' } },
        { 'Retry-After': '30' },
      ),
    );
    const err = (await captureCallError(client)) as LlmHttpError;
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.status).toBe(429);
    expect(err.headers?.['retry-after']).toBe('30');
  });

  it('非 JSON body → LlmHttpError.body 留 text 字符串（status-based 分类仍可用）', async () => {
    const client = makeClient(mockFetchTextStatus(500, 'Internal Server Error'));
    const err = (await captureCallError(client)) as LlmHttpError;
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err.status).toBe(500);
    expect(typeof err.body).toBe('string');
    expect(err.body).toBe('Internal Server Error');
  });
});

describe('[BUG-004 Critical] 端到端分类（client throw → classify → category）', () => {
  it('stream 401 + authentication_error → AUTH_INVALID（非 NETWORK，框架复活）', async () => {
    const client = makeClient(
      mockFetchJsonStatus(401, {
        error: { type: 'authentication_error', message: 'login fail' },
      }),
    );
    const rawError = await captureStreamError(client);
    const classified = classify(rawError, 'anthropic_compatible');
    expect(classified.category).toBe(LlmErrorCategory.AUTH_INVALID);
  });

  it('call 401 + authentication_error → AUTH_INVALID（call 路径同复活）', async () => {
    const client = makeClient(
      mockFetchJsonStatus(401, {
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      }),
    );
    const rawError = await captureCallError(client);
    const classified = classify(rawError, 'anthropic_compatible');
    expect(classified.category).toBe(LlmErrorCategory.AUTH_INVALID);
  });

  it('stream 429 + rate_limit_error → RATE_LIMITED', async () => {
    const client = makeClient(
      mockFetchJsonStatus(429, { error: { type: 'rate_limit_error' } }),
    );
    const rawError = await captureStreamError(client);
    const classified = classify(rawError, 'anthropic_compatible');
    expect(classified.category).toBe(LlmErrorCategory.RATE_LIMITED);
  });

  it('stream 529 + overloaded_error → PROVIDER_OVERLOADED', async () => {
    const client = makeClient(
      mockFetchJsonStatus(529, { error: { type: 'overloaded_error' } }),
    );
    const rawError = await captureStreamError(client);
    const classified = classify(rawError, 'anthropic_compatible');
    expect(classified.category).toBe(LlmErrorCategory.PROVIDER_OVERLOADED);
  });

  it('stream 500 → SERVER_ERROR', async () => {
    const client = makeClient(
      mockFetchJsonStatus(500, { error: { type: 'api_error', message: 'boom' } }),
    );
    const rawError = await captureStreamError(client);
    const classified = classify(rawError, 'anthropic_compatible');
    expect(classified.category).toBe(LlmErrorCategory.SERVER_ERROR);
  });
});

describe('[BUG-004 回归保护] 真 fetch throw（无 HTTP 响应）仍 NETWORK（语义不破）', () => {
  it('fetchImpl 抛 TypeError("fetch failed") → classify 返 NETWORK（LlmHttpError 不拦截 fetch 层错误）', async () => {
    const client = makeClient((() => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    const rawError = await captureStreamError(client);
    const classified = classify(rawError, 'anthropic_compatible');
    expect(classified.category).toBe(LlmErrorCategory.NETWORK);
  });

  it('fetchImpl 抛 TypeError call 路径 → 同样 NETWORK', async () => {
    const client = makeClient((() => {
      throw new TypeError('fetch failed');
    }) as typeof fetch);
    const rawError = await captureCallError(client);
    const classified = classify(rawError, 'anthropic_compatible');
    expect(classified.category).toBe(LlmErrorCategory.NETWORK);
  });
});

/**
 * [BUG-005 收口] client.validate() 抛 LlmHttpError（非裸 Error）→ classify 正确分类
 * 参考: states/v0.0.25/bugs/BUG-005-client-validate-error-network-[open].md
 *
 * 关键（堵 BUG-005 回归）：必经 client.ts validate throw 路径。mock fetchImpl 永不到达
 * （validate 在 call/stream 入口先 throw）。validate 抛 LlmHttpError{status:400, body} →
 * classifier asWireResponse 命中 numeric status → classifyWire 400 分支：
 *   - maxTokens 越界（body.message 含 "max_tokens"）→ MAX_TOKENS_TOO_HIGH（retryable:true）
 *   - temperature/topP 越界（body.message 不含 "max_tokens"）→ BAD_REQUEST_OTHER（retryable:false）
 *
 * 旧实现裸 Error(string) → asWireResponse null → NETWORK(retryable:true) → misconfig 白重试 3 次。
 */
describe('[BUG-005] validate() 抛 LlmHttpError → classify 正确分类（非 NETWORK）', () => {
  /** 构造 maxOutputTokens=4096 的 modelConfig（用户低配 misconfig 场景） */
  function makeLowMaxModelConfig(): LlmModelConfig {
    return {
      ...makeModelConfig(),
      maxOutputTokens: 4096,
      paramConstraints: {
        temperature: { min: 0, max: 1, default: 1 },
        topP: { min: 0, max: 1, default: 0.95 },
      },
    };
  }

  function makeClientWithLowMax(fetchImpl: typeof fetch): LlmClient {
    return new LlmClient({
      providerConfig: makeProviderConfig(),
      provider: new AnthropicCompatibleProvider('anthropic_compatible', {}),
      protocol: new AnthropicMessagesProtocol('anthropic_messages', {}),
      modelConfig: makeLowMaxModelConfig(),
      fetchImpl,
    });
  }

  /** mock fetch 永不调用（validate 先 throw）；这里只是占位满足构造签名 */
  const unreachableFetch = (() => {
    throw new Error('validate should throw before fetch');
  }) as typeof fetch;

  it('maxTokens=20000 超 model.maxOutputTokens=4096 → throw LlmHttpError{status:400}（含 max_tokens 字样）', async () => {
    const client = makeClientWithLowMax(unreachableFetch);
    const req: CanonicalRequest = {
      modelId: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      params: { maxTokens: 20000 },
    };
    let caught: unknown;
    try {
      await client.call(req);
      throw new Error('expected validate to throw, but did not');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmHttpError);
    const err = caught as LlmHttpError;
    expect(err.status).toBe(400);
    expect(typeof err.status).toBe('number'); // asWireResponse 命中条件
    // body 形态：{ error: { type, message } }，message 含 "max_tokens"（wire 字段名）
    const body = err.body as { error: { type: string; message: string } };
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('max_tokens');
    expect(body.error.message).toContain('20000');
    expect(body.error.message).toContain('4096');
  });

  it('maxTokens 越界 → classify → MAX_TOKENS_TOO_HIGH（非 NETWORK；retryable:true 可降 ×0.7 重试）', async () => {
    const client = makeClientWithLowMax(unreachableFetch);
    const req: CanonicalRequest = {
      modelId: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      params: { maxTokens: 20000 },
    };
    let rawError: unknown;
    try {
      await client.call(req);
      throw new Error('expected validate to throw');
    } catch (e) {
      rawError = e;
    }
    const classified = classify(rawError, 'anthropic_compatible');
    // 核心 BUG-005 断言：不再塌缩 NETWORK
    expect(classified.category).not.toBe(LlmErrorCategory.NETWORK);
    expect(classified.category).toBe(LlmErrorCategory.MAX_TOKENS_TOO_HIGH);
    // retryable:true（让 buildRequest 降 ×0.7 重试自适应恢复，而非 NO_RETRY）
    expect(classified.hints.retryable).toBe(true);
  });

  it('temperature=2 超 [0,1] → throw LlmHttpError{status:400}（message 不含 max_tokens）', async () => {
    const client = makeClientWithLowMax(unreachableFetch);
    const req: CanonicalRequest = {
      modelId: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      params: { maxTokens: 100, temperature: 2 },
    };
    let caught: unknown;
    try {
      await client.call(req);
      throw new Error('expected validate to throw');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmHttpError);
    const err = caught as LlmHttpError;
    expect(err.status).toBe(400);
    const body = err.body as { error: { type: string; message: string } };
    expect(body.error.message).toContain('temperature');
    expect(body.error.message).not.toContain('max_tokens');
  });

  it('temperature 越界 → classify → BAD_REQUEST_OTHER（非 NETWORK；retryable:false 不重试）', async () => {
    const client = makeClientWithLowMax(unreachableFetch);
    const req: CanonicalRequest = {
      modelId: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      params: { maxTokens: 100, temperature: 5 },
    };
    let rawError: unknown;
    try {
      await client.call(req);
      throw new Error('expected validate to throw');
    } catch (e) {
      rawError = e;
    }
    const classified = classify(rawError, 'anthropic_compatible');
    expect(classified.category).not.toBe(LlmErrorCategory.NETWORK);
    expect(classified.category).toBe(LlmErrorCategory.BAD_REQUEST_OTHER);
    // NO_RETRY：misconfig 不可恢复，重试只会浪费配额
    expect(classified.hints.retryable).toBe(false);
  });

  it('topP 越界 → classify → BAD_REQUEST_OTHER（非 NETWORK；retryable:false）', async () => {
    const client = makeClientWithLowMax(unreachableFetch);
    const req: CanonicalRequest = {
      modelId: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      params: { maxTokens: 100, topP: 2 },
    };
    let rawError: unknown;
    try {
      // stream 路径同样先 validate（覆盖 call+stream 双路 validate throw）
      for await (const _ of client.stream(req)) void _;
      throw new Error('expected validate to throw');
    } catch (e) {
      rawError = e;
    }
    const classified = classify(rawError, 'anthropic_compatible');
    expect(classified.category).not.toBe(LlmErrorCategory.NETWORK);
    expect(classified.category).toBe(LlmErrorCategory.BAD_REQUEST_OTHER);
    expect(classified.hints.retryable).toBe(false);
  });
});
