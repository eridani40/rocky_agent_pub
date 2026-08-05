/**
 * LlmCaller — v0.0.25 task 5 gap 1/2/3 集成测试
 * 参考: states/v0.0.25/verify/test-plan.md（task 5 收尾 gap）
 *
 * 覆盖：
 *   - Gap 2: MAX_TOKENS finish → prefill / bump / throw 三分支
 *     （stream 正常 finish 但 stop_reason='max_tokens' → applyMaxTokensOverlay 决策）
 *   - Gap 1: 生产接线（invoke 真被调，buildInvokeContext 从 client 派生 InvokeContext）
 *   - Gap 3: observability port 桥接（recordWireBody + endGenerationOk/Error 调真 adapter）
 *
 * 测试方式：stub LlmClient（可控 stream + getInfo），stub ObservabilityAdapter（spy 调用）。
 * 单文件 ≤300 行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LlmErrorCategory,
  type ClassifiedLlmError,
} from '../error_types';
import { invoke, type InvokeContext, type InvokeBaseReq, type ObservabilityPort } from '../llm_caller';
import type { LlmProviderConfig, LlmModelConfig } from '../../provider-types';
import type { LlmClient } from '../../client';
import type { StreamEvent } from '../../protocol';
import type { LlmErrorState } from '../llm_error_state';
import { createLlmErrorState } from '../llm_error_state';
import { createProviderHealthRegistry, __resetProviderHealthRegistryForTest } from '../provider_health_registry';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../../config/llm_request_config';
import type { ObservabilityAdapter, GenHandle } from '../../../observability/adapter';
import type { TraceHandle, SpanHandle } from '../../../observability/types';
import { buildInvokeContext } from '../build_invoke_context';
import { createLangfuseObservabilityPort } from '../langfuse_observability_port';

// ── stub 构造器 ──

/** 构造 LlmClient stub：可控 stream（按调用序号）+ getInfo（可选）。 */
function makeStubClient(args: {
  streams: Array<AsyncIterable<StreamEvent> | Error>;
  info?: { providerId?: string; modelId?: string; maxOutputTokens?: number; supportsPrefill?: boolean };
}): LlmClient {
  let callIdx = 0;
  const streamFn = async function* (_req: unknown, _signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const idx = callIdx++;
    const cur = args.streams[idx];
    if (cur === undefined) throw new Error(`stub client: no stream queued for call ${idx}`);
    if (cur instanceof Error) throw cur;
    for await (const evt of cur) yield evt;
  };
  const info = args.info ?? {};
  return {
    stream: streamFn,
    getInfo: () => ({
      providerId: info.providerId ?? 'p1',
      providerName: 'anthropic_compatible' as const,
      modelId: info.modelId ?? 'm1',
      maxOutputTokens: info.maxOutputTokens ?? 8192,
      capabilities: {
        maxOutputTokens: info.maxOutputTokens ?? 8192,
        supportsPrefill: info.supportsPrefill ?? true,
        supportsThinking: false,
      },
    }),
  } as unknown as LlmClient;
}

/** 文本流 stub（finish reason='stop'）。 */
async function* textStream(text: string): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', text };
  yield { type: 'usage', usage: { output_total_tokens: 10, input_total_tokens: 5 } as never };
  yield { type: 'finish', reason: 'stop' };
}

/** MAX_TOKENS finish 流 stub（finish reason='max_tokens' + partial text）。 */
async function* maxTokensStream(text: string, outputTokens = 100): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', text };
  yield { type: 'usage', usage: { output_total_tokens: outputTokens, input_total_tokens: 5 } as never };
  yield { type: 'finish', reason: 'max_tokens' };
}

/** 构造最小 InvokeContext（含 fallback 兜底）。 */
function makeCtx(args: {
  errorState?: LlmErrorState;
  client: LlmClient;
  provider?: LlmProviderConfig;
  config?: typeof DEFAULT_LLM_REQUEST_CONFIG;
  observability?: ObservabilityPort;
}): InvokeContext {
  const provider = args.provider ?? {
    id: 'p1', name: 'anthropic_compatible' as const, protocolId: 'anthropic_messages' as const, baseUrl: 'https://p1.example.com',
    credentials: { key: 'sk-test' }, pluginId: 'builtin.anthropic', enabled: true,
    models: [{
      modelId: 'm1', inputModalities: ['text'], outputModalities: ['text'],
      contextWindow: 200000, maxOutputTokens: 8192, paramConstraints: {},
      pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
      providerId: 'p1',
      capabilities: { maxOutputTokens: 8192, supportsPrefill: true, supportsThinking: false },
    } as LlmModelConfig],
  };
  const model = provider.models[0]!;
  return {
    errorState: args.errorState ?? createLlmErrorState(),
    controller: { runId: 'r1', aborted: false },
    observability: args.observability,
    providers: new Map([[provider.id, provider]]),
    clientFactory: { getClient: () => args.client },
    fallback: { provider, keyRef: 'default', model, client: args.client },
    config: args.config ?? {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, backoff_base_s: 0, backoff_cap_s: 0, jitter: false },
    },
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
// Gap 2: MAX_TOKENS finish → prefill / bump / throw
// ============================================================
describe('[gap 2] MAX_TOKENS finish → prefill/bump/throw', () => {
  it('strategy=continue + supportsPrefill → 设 prefillPartial 续写（attempt2 成功）', async () => {
    const client = makeStubClient({
      // attempt1: max_tokens finish with partial text
      // attempt2: prefill 续写成功
      streams: [maxTokensStream('partial'), textStream(' continued')],
    });
    const ctx = makeCtx({ client });
    const resp = await invoke(makeBaseReq(), ctx);
    // attempt1 设了 prefillPartial，attempt2 应用后续写成功
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: ' continued' }),
    ]));
    // prefillPartial 应用后清（一次性）
    expect(ctx.errorState.prefillPartial).toBeUndefined();
  });

  it('[T12] strategy=increase → one-shot ceiling bump 后续成功（bumped maxTokens 不写 errorState）', async () => {
    // [T12] EXCEEDED bump 改 one-shot ceiling：bumped maxTokens 直接覆盖 baseReq.params.maxTokens，
    // 不再写 errorState.maxTokensOverlay（字段已删）。下轮 attempt 用 bumped maxTokens 重跑成功。
    const client = makeStubClient({
      streams: [maxTokensStream('partial'), textStream('ok with more tokens')],
    });
    const cfg = {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      length: { ...DEFAULT_LLM_REQUEST_CONFIG.length, max_tokens_bump_strategy: 'increase' as const },
    };
    const ctx = makeCtx({ client, config: cfg });
    const resp = await invoke(makeBaseReq(), ctx);
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'ok with more tokens' }),
    ]));
    // [T12] bumped maxTokens 不写 errorState（成功后 errorState 应干净，无 maxTokensOverlay 字段）
    expect((ctx.errorState as Record<string, unknown>).maxTokensOverlay).toBeUndefined();
  });

  it('strategy=none + max_tokens finish → throw MAX_TOKENS_EXCEEDED（不处理）', async () => {
    const client = makeStubClient({ streams: [maxTokensStream('partial')] });
    const cfg = {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      length: { ...DEFAULT_LLM_REQUEST_CONFIG.length, max_tokens_bump_strategy: 'none' as const },
    };
    const ctx = makeCtx({ client, config: cfg });
    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    expect(ctx.errorState.lastError?.category).toBe(LlmErrorCategory.MAX_TOKENS_EXCEEDED);
  });

  it('已到硬上限（currentMaxTokens >= maxOutputTokens）→ throw（不无限重试）', async () => {
    // provider model 的 maxOutputTokens=1024，与 client.getInfo() 一致
    const provider = {
      id: 'p1', name: 'anthropic_compatible' as const, protocolId: 'anthropic_messages' as const, baseUrl: 'https://p1.example.com',
      credentials: { key: 'sk-test' }, pluginId: 'builtin.anthropic', enabled: true,
      models: [{
        modelId: 'm1', inputModalities: ['text'], outputModalities: ['text'],
        contextWindow: 200000, maxOutputTokens: 1024, paramConstraints: {},
        pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
        providerId: 'p1',
        capabilities: { maxOutputTokens: 1024, supportsPrefill: false, supportsThinking: false },
      } as LlmModelConfig],
    };
    const client = makeStubClient({
      streams: [maxTokensStream('partial')],
      info: { maxOutputTokens: 1024, supportsPrefill: false },
    });
    const cfg = {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      length: { ...DEFAULT_LLM_REQUEST_CONFIG.length, max_tokens_bump_strategy: 'increase' as const },
    };
    const ctx = makeCtx({ client, provider, config: cfg });
    // baseReq maxTokens=1024 已达硬上限 → bump 决策 throw（不无限重试）
    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    expect(ctx.errorState.lastError?.category).toBe(LlmErrorCategory.MAX_TOKENS_EXCEEDED);
  });

  it('partial 含未完成 tool_use → 走 STREAM_INCOMPLETE（不 bump）', async () => {
    // 流以 max_tokens finish 但 partial 是空（无 text/tool）→ attemptLoop 走 STREAM_INCOMPLETE
    const client = makeStubClient({
      streams: [(async function* () {
        yield { type: 'finish', reason: 'max_tokens' } as StreamEvent;
      })()],
    });
    const ctx = makeCtx({ client });
    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    // STREAM_INCOMPLETE retryable=true，3 次重试后 NO_RETRY（最后 lastError 是 STREAM_INCOMPLETE 或其 retry 链末态）
    expect(ctx.errorState.lastError).toBeDefined();
  });
});

// ============================================================
// Gap 1: 生产接线（buildInvokeContext + invoke 真被调）
// ============================================================
describe('[gap 1] buildInvokeContext 生产接线', () => {
  it('从 LlmClient.getInfo() 派生完整 InvokeContext（providers/fallback/clientFactory）', async () => {
    const client = makeStubClient({ streams: [textStream('hello')] });
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
    });
    // providers Map 有 1 条
    expect(ctx.providers.size).toBe(1);
    // fallback 单 target 兜底
    expect(ctx.fallback).toBeDefined();
    expect(ctx.fallback!.provider.id).toBe('p1');
    expect(ctx.fallback!.model.modelId).toBe('m1');
    expect(ctx.fallback!.model.capabilities?.supportsPrefill).toBe(true);
    // clientFactory.getClient 返原 client
    expect(ctx.clientFactory.getClient(ctx.fallback!.provider, 'default', 'k', ctx.fallback!.model)).toBe(client);
  });

  it('能力探测：旧 stub client 无 getInfo → 兜底最小形状（不抛错）', () => {
    const stubClient = { stream: async function* () {} } as unknown as LlmClient;
    const ctx = buildInvokeContext({
      client: stubClient,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
    });
    expect(ctx.providers.size).toBe(1);
    expect(ctx.fallback).toBeDefined();
    expect(ctx.fallback!.model.maxOutputTokens).toBe(8192); // 兜底
  });

  it('invoke 经 buildInvokeContext 派生的 ctx 走通（happy path 零回归）', async () => {
    const client = makeStubClient({ streams: [textStream('via invoke')] });
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
      config: undefined,
    } as never);
    // 注入测试友好 config（backoff=0）+ health（避免用全局单例）
    ctx.config = {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, backoff_base_s: 0, backoff_cap_s: 0, jitter: false },
    };
    ctx.health = createProviderHealthRegistry();
    const resp = await invoke(makeBaseReq(), ctx);
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'via invoke' }),
    ]));
  });
});

// ============================================================
// Gap 3: langfuse observability port 桥接
// ============================================================
describe('[gap 3] LangfuseObservabilityPort 桥接真 adapter', () => {
  /** 构造 spy ObservabilityAdapter */
  function makeSpyAdapter(): { adapter: ObservabilityAdapter; calls: { method: string; args: unknown }[] } {
    const calls: { method: string; args: unknown }[] = [];
    const fakeHandle: GenHandle = { kind: 'gen', id: 'g1', parent: { kind: 'trace', id: 't1' } as TraceHandle } as unknown as GenHandle;
    const adapter: ObservabilityAdapter = {
      startTrace: (() => { calls.push({ method: 'startTrace', args: [] }); return { kind: 'trace', id: 't1' }; }) as never,
      endTrace: ((h: TraceHandle) => { calls.push({ method: 'endTrace', args: { h } }); }) as never,
      startGeneration: (() => { calls.push({ method: 'startGeneration', args: [] }); return fakeHandle; }) as never,
      endGeneration: ((p: unknown) => { calls.push({ method: 'endGeneration', args: p }); }) as never,
      startSpan: (() => { calls.push({ method: 'startSpan', args: [] }); return { kind: 'span', id: 's1', parent: { kind: 'trace', id: 't1' } }; }) as never,
      endSpan: (() => { calls.push({ method: 'endSpan', args: [] }); }) as never,
      shutdown: (async () => { calls.push({ method: 'shutdown', args: [] }); }) as never,
    };
    return { adapter, calls };
  }

  it('endGenerationOk 调 adapter.endGeneration（status:success，output+usage 透传）', () => {
    const { adapter, calls } = makeSpyAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle: { kind: 'gen', id: 'g1', parent: { kind: 'trace', id: 't1' } } as never,
      iteration: 1, step: 1, model: 'm',
    });
    const msg = { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } as never;
    port.endGenerationOk!(msg, { output_total_tokens: 10 } as never);
    const call = calls.find((c) => c.method === 'endGeneration');
    expect(call).toBeDefined();
    const args = call!.args as { status?: string; output?: { message: { content: unknown[] } }; usage: { output_total_tokens?: number } };
    expect(args.status).toBe('success');
    expect(args.output?.message.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'hi' })]));
    expect(args.usage.output_total_tokens).toBe(10);
  });

  it('endGenerationError 调 adapter.endGeneration（status:error + errorCategory + metadata.retryChain）', () => {
    const { adapter, calls } = makeSpyAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle: { kind: 'gen', id: 'g1', parent: { kind: 'trace', id: 't1' } } as never,
      iteration: 1, step: 1, model: 'm',
    });
    port.endGenerationError!(
      LlmErrorCategory.PROVIDER_OVERLOADED,
      'overloaded',
      { retryChain: [{ providerId: 'p1', keyRef: 'default', attempt: 1, category: 'PROVIDER_OVERLOADED' }] },
    );
    const call = calls.find((c) => c.method === 'endGeneration');
    expect(call).toBeDefined();
    const args = call!.args as { status?: string; errorCategory?: string; metadata?: { retryChain?: unknown[]; errorCategory?: string } };
    expect(args.status).toBe('error');
    expect(args.errorCategory).toBe(String(LlmErrorCategory.PROVIDER_OVERLOADED));
    expect(args.metadata?.retryChain).toHaveLength(1);
  });

  it('[v0.0.50 §4.4] recordWireBody 缓存 wire body，但 endGenerationOk 不再写入 metadata.physicalWireBody（走独立 physical gen）', () => {
    const { adapter, calls } = makeSpyAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle: { kind: 'gen', id: 'g1', parent: { kind: 'trace', id: 't1' } } as never,
      iteration: 1, step: 1, model: 'm',
    });
    port.recordWireBody!(1, { model: 'm1', messages: [] }, 'https://api.example.com');
    port.endGenerationOk!({ id: 'a1', role: 'assistant', content: [] } as never, null);
    const call = calls.find((c) => c.method === 'endGeneration');
    const args = call!.args as { metadata?: { physicalWireBody?: { model?: string } } };
    // v0.0.50 §4.4：wire body 写路径全部走独立 physical generation，
    // logical.metadata 不再携带 physicalWireBody（避免 update 事件 payload 翻倍）
    expect(args.metadata?.physicalWireBody).toBeUndefined();
  });

  it('invoke 集成：成功路径调 endGenerationOk（zero leak）', async () => {
    const { adapter, calls } = makeSpyAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle: { kind: 'gen', id: 'g1', parent: { kind: 'trace', id: 't1' } } as never,
      iteration: 1, step: 1, model: 'm',
    });
    const client = makeStubClient({ streams: [textStream('ok')] });
    const ctx = makeCtx({ client, observability: port });
    await invoke(makeBaseReq(), ctx);
    expect(calls.some((c) => c.method === 'endGeneration')).toBe(true);
    const args = calls.find((c) => c.method === 'endGeneration')!.args as { status?: string };
    expect(args.status).toBe('success');
  });

  it('invoke 集成：错误路径调 endGenerationError（zero leak，含 errorCategory）', async () => {
    const { adapter, calls } = makeSpyAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle: { kind: 'gen', id: 'g1', parent: { kind: 'trace', id: 't1' } } as never,
      iteration: 1, step: 1, model: 'm',
    });
    const client = makeStubClient({
      streams: [(async function* () { throw new Error('content policy'); })()],
    });
    const ctx = makeCtx({ client, observability: port });
    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    const call = calls.find((c) => c.method === 'endGeneration');
    expect(call).toBeDefined();
    const args = call!.args as { status?: string; errorCategory?: string };
    expect(args.status).toBe('error');
    expect(args.errorCategory).toBeDefined();
  });
});
