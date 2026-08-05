/**
 * llm_attempt SSE event + sessionId 接线 单测（v0.0.25 rev2 T15）
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3.1（llm_attempt event emit 时机）
 *       specs/api/version_logs/v0.0.25/change_log.md §1.4（llm_attempt wire schema）
 *       specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md（block ③）
 *
 * 覆盖：
 *   1. invoke RETRY_BACKOFF：emit llm_attempt{action:RETRY}，payload 正确（category/providerId/modelId/keyRef/attempt）
 *   2. invoke NO_RETRY（CONTENT_FILTERED）：emit llm_attempt{action:FAIL}
 *   3. invoke 成功（attempt 1 首次成功）：不发 llm_attempt
 *   4. invoke 用户 abort：不发 llm_attempt（走原 abort 路径）
 *   5. llm_attempt StreamEvent payload：类型字段齐全（type='llm_attempt' + 6 字段）
 *   6. sessionId 接线：buildInvokeContext(input.sessionId) → InvokeContext.sessionId → invoke 内 health.recordSuccess(sessionId,...)
 *   7. sessionId 默认兜底：invoke ctx.sessionId 未传时 health 用 ''（单 session 兜底）
 *
 * 测试方式：stub LlmClient（注入可控 error），捕获 ctx.onEvent 的 llm_attempt StreamEvent。
 * 单文件 ≤300 行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LlmErrorCategory,
  type ClassifiedLlmError,
} from '../error_types';
import { invoke, type InvokeContext, type InvokeBaseReq } from '../llm_caller';
import type { StreamEvent } from '../../protocol';
import type { LlmProviderConfig, LlmModelConfig } from '../../provider-types';
import type { LlmClient } from '../../client';
import type { LlmErrorState } from '../llm_error_state';
import { createLlmErrorState } from '../llm_error_state';
import { createProviderHealthRegistry, __resetProviderHealthRegistryForTest } from '../provider_health_registry';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../../config/llm_request_config';
import { buildInvokeContext } from '../build_invoke_context';

// ── 测试 stub ──

/** 构造 LlmClient stub：按序号抛错或产流。 */
function makeStubClient(streams: Array<AsyncIterable<StreamEvent> | Error>): LlmClient {
  let callIdx = 0;
  const streamFn = async function* (_req: unknown, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const idx = callIdx++;
    const cur = streams[idx];
    if (cur === undefined) throw new Error(`stub client: no stream queued for call ${idx}`);
    if (cur instanceof Error) {
      if (signal?.aborted) throw cur;
      throw cur;
    }
    for await (const evt of cur) yield evt;
  };
  return { stream: streamFn } as unknown as LlmClient;
}

async function* textStream(text: string): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', text };
  yield { type: 'usage', usage: { output_total_tokens: 10, input_total_tokens: 5 } as never };
  yield { type: 'finish', reason: 'stop' };
}

/** HTTP 429 错（RATE_LIMITED，retryable）。 */
function http429(): Error {
  const e = new Error('rate limited');
  (e as unknown as { status: number }).status = 429;
  (e as unknown as { body: unknown }).body = { error: { type: 'rate_limit_error', message: 'rate limited' } };
  return e;
}

/** HTTP 500 错（SERVER_ERROR，retryable）。 */
function http500(): Error {
  const e = new Error('server error');
  (e as unknown as { status: number }).status = 500;
  (e as unknown as { body: unknown }).body = { error: { type: 'api_error', message: 'server error' } };
  return e;
}

/** 构造最小 LlmProviderConfig（含 429 retryable → anthropic_compatible name 派发 classify）。 */
function makeProvider(id: string, opts: { multiKey?: boolean } = {}): LlmProviderConfig {
  // multiKey=true → credentials.keys 数组（decideAction 判 hasMultipleKeys 走 ROTATE_KEY）
  // keys 用 CredentialKey 形态（keyRef/keyValue/quotaScope）；fallbackKeyRef='k1' 让 'k2' 可轮换
  const credentials = opts.multiKey
    ? {
        keys: [
          { keyRef: 'k1', keyValue: 'sk-1', quotaScope: 'per_key' as const },
          { keyRef: 'k2', keyValue: 'sk-2', quotaScope: 'per_key' as const },
        ],
      }
    : { key: 'sk-test' };
  return {
    id, name: 'anthropic_compatible', protocolId: 'anthropic_messages', baseUrl: `https://${id}.example.com`,
    credentials: credentials as LlmProviderConfig['credentials'],
    pluginId: 'builtin.anthropic', enabled: true, models: [makeModel('m1')],
  };
}

function makeModel(modelId: string): LlmModelConfig {
  return {
    modelId, inputModalities: ['text'], outputModalities: ['text'],
    contextWindow: 200000, maxOutputTokens: 8192, paramConstraints: {},
    pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
    providerId: '',
    capabilities: { maxOutputTokens: 8192, supportsPrefill: true, supportsThinking: false },
  };
}

/** 构造最小 InvokeContext，注入 onEvent 捕获 llm_attempt。 */
function makeCtx(args: {
  client: LlmClient;
  onEvent?: (e: StreamEvent) => void;
  sessionId?: string;
  backgroundPath?: boolean;
  errorState?: LlmErrorState;
  provider?: LlmProviderConfig;
  fallbackKeyRef?: string;
}): InvokeContext {
  const provider = args.provider ?? makeProvider('p1');
  const model = provider.models[0]!;
  return {
    errorState: args.errorState ?? createLlmErrorState(),
    sessionId: args.sessionId,
    controller: { runId: 'r1', aborted: false },
    backgroundPath: args.backgroundPath,
    onEvent: args.onEvent,
    providers: new Map([[provider.id, provider]]),
    clientFactory: { getClient: () => args.client },
    fallback: { provider, keyRef: args.fallbackKeyRef ?? 'default', model, client: args.client },
    config: { ...DEFAULT_LLM_REQUEST_CONFIG, retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, backoff_base_s: 0, backoff_cap_s: 0, jitter: false } },
    health: createProviderHealthRegistry(),
  };
}

function makeBaseReq(): InvokeBaseReq {
  return {
    modelId: 'm1',
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: { stream: true, maxTokens: 1024 },
  };
}

beforeEach(() => {
  __resetProviderHealthRegistryForTest();
});

// ============================================================
// 1. RETRY_BACKOFF → emit llm_attempt{action:RETRY}
// ============================================================
describe('llm_attempt emit — RETRY_BACKOFF', () => {
  it('catch 429 → decide RETRY_BACKOFF → emit llm_attempt{action:RETRY, category:RATE_LIMITED}', async () => {
    const events: StreamEvent[] = [];
    // 2 次错（429）→ 第 3 次成功
    const client = makeStubClient([http429(), http429(), textStream('ok')]);
    await invoke(makeBaseReq(), makeCtx({ client, onEvent: (e) => events.push(e) }));
    const attempts = events.filter((e) => e.type === 'llm_attempt');
    expect(attempts).toHaveLength(2);
    // 两次 RETRY（attempt 1 / 2 各失败一次）
    for (const a of attempts) {
      expect(a).toMatchObject({
        type: 'llm_attempt',
        action: 'RETRY',
        category: LlmErrorCategory.RATE_LIMITED,
        providerId: 'p1',
        modelId: 'm1',
        keyRef: 'default',
      });
    }
    expect((attempts[0] as Extract<StreamEvent, { type: 'llm_attempt' }>).attempt).toBe(1);
    expect((attempts[1] as Extract<StreamEvent, { type: 'llm_attempt' }>).attempt).toBe(2);
  });
});

// ============================================================
// 2. NO_RETRY (CONTENT_FILTERED) → emit llm_attempt{action:FAIL}
// ============================================================
describe('llm_attempt emit — NO_RETRY → FAIL', () => {
  it('MODEL_NOT_FOUND NO_RETRY → emit llm_attempt{action:FAIL} 后 throw', async () => {
    const events: StreamEvent[] = [];
    // HTTP 404 + message 匹配 model_not_found pattern → MODEL_NOT_FOUND（NO_RETRY，spec 决策矩阵）
    function notFound(): Error {
      const e = new Error('model not found: claude-xyz');
      (e as unknown as { status: number }).status = 404;
      (e as unknown as { body: unknown }).body = { error: { type: 'not_found_error', message: 'model not found: claude-xyz' } };
      return e;
    }
    const client = makeStubClient([notFound()]);
    await expect(invoke(makeBaseReq(), makeCtx({ client, onEvent: (e) => events.push(e) })))
      .rejects.toThrow();
    const attempts = events.filter((e) => e.type === 'llm_attempt');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      type: 'llm_attempt',
      action: 'FAIL',
      category: LlmErrorCategory.MODEL_NOT_FOUND,
    });
  });
});

// ============================================================
// 3. 成功（attempt 1 首次成功）→ 不发 llm_attempt
// ============================================================
describe('llm_attempt emit — 成功不发', () => {
  it('attempt 1 首次成功 → 无 llm_attempt 事件', async () => {
    const events: StreamEvent[] = [];
    const client = makeStubClient([textStream('hello')]);
    await invoke(makeBaseReq(), makeCtx({ client, onEvent: (e) => events.push(e) }));
    const attempts = events.filter((e) => e.type === 'llm_attempt');
    expect(attempts).toHaveLength(0);
  });
});

// ============================================================
// 4. 用户 abort → 不发 llm_attempt
// ============================================================
describe('llm_attempt emit — 用户 abort 不发', () => {
  it('controller.aborted → user_abort 路径 → 无 llm_attempt', async () => {
    const events: StreamEvent[] = [];
    async function* abortStream(): AsyncGenerator<StreamEvent> {
      // 模拟流中 abort（不抛 error，由 controller 标记）
      yield { type: 'text_delta', text: 'partial' };
    }
    const client = makeStubClient([abortStream()]);
    const ctx = makeCtx({ client, onEvent: (e) => events.push(e) });
    // 预置 controller.aborted=true，attemptLoop 流读完后判 user_abort
    ctx.controller.aborted = true;
    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    const attempts = events.filter((e) => e.type === 'llm_attempt');
    expect(attempts).toHaveLength(0);
  });
});

// ============================================================
// 5. llm_attempt StreamEvent payload 字段齐全
// ============================================================
describe('llm_attempt StreamEvent payload', () => {
  it('payload 含全部 6 字段（category/providerId/modelId/keyRef/attempt/action）+ type', async () => {
    const events: StreamEvent[] = [];
    const client = makeStubClient([http500(), textStream('ok')]);
    await invoke(makeBaseReq(), makeCtx({ client, onEvent: (e) => events.push(e) }));
    const attempt = events.find((e) => e.type === 'llm_attempt') as Extract<StreamEvent, { type: 'llm_attempt' }> | undefined;
    expect(attempt).toBeDefined();
    expect(attempt!.type).toBe('llm_attempt');
    expect(attempt!.category).toBe(LlmErrorCategory.SERVER_ERROR);
    expect(attempt!.providerId).toBe('p1');
    expect(attempt!.modelId).toBe('m1');
    expect(attempt!.keyRef).toBe('default');
    expect(attempt!.attempt).toBe(1);
    expect(attempt!.action).toBe('RETRY');
  });
});

// ============================================================
// 6. sessionId 接线：buildInvokeContext(input.sessionId) → InvokeContext.sessionId
// ============================================================
describe('sessionId 接线 — buildInvokeContext', () => {
  it('input.sessionId 传入 → InvokeContext.sessionId 携带该值', () => {
    const client = makeStubClient([]);
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      sessionId: 'sess-123',
      controller: { runId: 'r1', aborted: false },
    });
    expect(ctx.sessionId).toBe('sess-123');
  });

  it('input.sessionId 未传 → InvokeContext.sessionId undefined（invoke 内兜底空串）', () => {
    const client = makeStubClient([]);
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
    });
    expect(ctx.sessionId).toBeUndefined();
  });

  it('invoke ctx.sessionId 传入 → health.recordSuccess 接收该 sessionId', async () => {
    const health = createProviderHealthRegistry();
    const recordSuccessSpy = vi.spyOn(health, 'recordSuccess');
    const client = makeStubClient([textStream('ok')]);
    await invoke(makeBaseReq(), {
      ...makeCtx({ client }),
      sessionId: 'sess-xyz',
      health,
    });
    expect(recordSuccessSpy).toHaveBeenCalledWith('sess-xyz', 'p1', 'default', 'm1');
  });

  it('invoke ctx.sessionId 未传 → health.recordSuccess 接收空串（兜底单 session）', async () => {
    const health = createProviderHealthRegistry();
    const recordSuccessSpy = vi.spyOn(health, 'recordSuccess');
    const client = makeStubClient([textStream('ok')]);
    await invoke(makeBaseReq(), {
      ...makeCtx({ client }),
      // sessionId 故意不传
      health,
    });
    expect(recordSuccessSpy).toHaveBeenCalledWith('', 'p1', 'default', 'm1');
  });

  it('invoke ctx.sessionId 传入 → health.markDead（ROTATE_KEY 路径）接收该 sessionId', async () => {
    const health = createProviderHealthRegistry();
    const markDeadSpy = vi.spyOn(health, 'markDead');
    // HTTP 401 + 多 key provider → AUTH_INVALID + shouldRotateKey → ROTATE_KEY → markDead
    function auth401(): Error {
      const e = new Error('invalid api key');
      (e as unknown as { status: number }).status = 401;
      (e as unknown as { body: unknown }).body = { error: { type: 'authentication_error', message: 'invalid api key' } };
      return e;
    }
    const client = makeStubClient([auth401(), auth401(), auth401()]);
    const provider = makeProvider('p1', { multiKey: true });
    await expect(invoke(makeBaseReq(), {
      ...makeCtx({ client, provider, fallbackKeyRef: 'k1' }),
      sessionId: 'sess-auth',
      health,
    })).rejects.toThrow();
    // ROTATE_KEY 至少调过一次 markDead，且 sessionId = 'sess-auth'
    const calls = markDeadSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c[0]).toBe('sess-auth');
    }
  });
});
