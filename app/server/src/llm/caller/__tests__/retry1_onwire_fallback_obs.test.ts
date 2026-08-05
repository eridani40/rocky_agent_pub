/**
 * v0.0.25 retry-1 修复验证测试
 * 参考: states/v0.0.25/task.json（code-review retry-1）
 *
 * 覆盖 3 项：
 *   - M1（必修）onWire 生产断链：fallback.client（空 chain）+ clientFactory.getClient（chain 非空）
 *     经 withOnWire 派生绑 onWire 的 client → invoke 触发 → recordWireBody → langfuse
 *     metadata.physical_wire_body 被填（spec §3.8）
 *   - P2 fallback_chain 多 provider 接通：buildInvokeContext 注入 llmRequestConfig + allProviders +
 *     health；resolveTarget 跳过 cooled_down provider 选下一个（spec §3 step 2）
 *
 * 测试方式：
 *   - M1：stub LlmClient 带 withOnWire spy（验证派生 + onWire 触发）
 *   - P2：注入多 provider + cooled_down registry → resolveTarget 选 next
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LlmErrorCategory,
} from '../error_types';
import { invoke, type InvokeContext, type InvokeBaseReq } from '../llm_caller';
import { resolveTarget } from '../resolve_target';
import type { LlmProviderConfig, LlmModelConfig } from '../../provider-types';
import type { LlmClient } from '../../client';
import type { StreamEvent } from '../../protocol';
import type { LlmErrorState } from '../llm_error_state';
import { createLlmErrorState } from '../llm_error_state';
import {
  createProviderHealthRegistry,
  __resetProviderHealthRegistryForTest,
  type ProviderHealthRegistry,
} from '../provider_health_registry';
import { DEFAULT_LLM_REQUEST_CONFIG, type LlmRequestConfig } from '../../../config/llm_request_config';
import { buildInvokeContext } from '../build_invoke_context';
import { createLangfuseObservabilityPort } from '../langfuse_observability_port';
import type { ObservabilityAdapter, GenHandle } from '../../../observability/adapter';
import type { TraceHandle } from '../../../observability/types';

// ── stub 构造器（带 withOnWire spy）──

/** 构造带 withOnWire spy 的 LlmClient stub：验证 M1 onWire 绑定链路。 */
function makeStubClientWithOnWireSpy(args: {
  streams: Array<AsyncIterable<StreamEvent> | Error>;
  info?: { providerId?: string; modelId?: string; maxOutputTokens?: number; supportsPrefill?: boolean };
}): { client: LlmClient; withOnWireCalls: unknown[][] } {
  const withOnWireCalls: unknown[][] = [];
  let callIdx = 0;
  const streamFn = async function* (_req: unknown, _signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const idx = callIdx++;
    const cur = args.streams[idx];
    if (cur === undefined) throw new Error(`stub client: no stream queued for call ${idx}`);
    if (cur instanceof Error) throw cur;
    for await (const evt of cur) yield evt;
  };
  const info = args.info ?? {};
  // 模拟生产 LlmClient：withOnWire 派生新实例（带同样 stream + getInfo + withOnWire）
  const baseObj = {
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
  };
  const makeProxy = (boundOnWire?: (req: unknown, body: unknown, url: string) => void): LlmClient => {
    const proxy = {
      stream: async function* (req: unknown, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
        // 模拟 LlmClient.stream 内部 onWire 触发（spec §3.8：prepare 后 fetch 前）
        if (boundOnWire) boundOnWire(req, { model: 'm1', messages: [] }, 'https://stub.example.com');
        for await (const evt of streamFn(req, signal)) yield evt;
      },
      getInfo: baseObj.getInfo,
      withOnWire: (newOnWire: (req: unknown, body: unknown, url: string) => void): LlmClient => {
        withOnWireCalls.push([newOnWire]);
        return makeProxy(newOnWire); // 派生新实例（绑定新 onWire）
      },
    };
    return proxy as unknown as LlmClient;
  };
  return { client: makeProxy(undefined), withOnWireCalls };
}

/** 文本流 stub。 */
async function* textStream(text: string): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', text };
  yield { type: 'usage', usage: { output_total_tokens: 10, input_total_tokens: 5 } as never };
  yield { type: 'finish', reason: 'stop' };
}

/** 构造 spy ObservabilityAdapter（M1 + forked obs 用）。 */
function makeSpyAdapter(): { adapter: ObservabilityAdapter; calls: { method: string; args: unknown }[] } {
  const calls: { method: string; args: unknown }[] = [];
  const fakeHandle: GenHandle = { kind: 'gen', id: 'g1', parent: { kind: 'trace', id: 't1' } as TraceHandle } as unknown as GenHandle;
  const adapter: ObservabilityAdapter = {
    startTrace: (() => { calls.push({ method: 'startTrace', args: [] }); return { kind: 'trace', id: 't1' } as TraceHandle; }) as never,
    endTrace: ((h: TraceHandle) => { calls.push({ method: 'endTrace', args: { h } }); }) as never,
    startGeneration: (() => { calls.push({ method: 'startGeneration', args: [] }); return fakeHandle; }) as never,
    endGeneration: ((p: unknown) => { calls.push({ method: 'endGeneration', args: p }); }) as never,
    startSpan: (() => { calls.push({ method: 'startSpan', args: [] }); return { kind: 'span', id: 's1', parent: { kind: 'trace', id: 't1' } }; }) as never,
    endSpan: (() => { calls.push({ method: 'endSpan', args: [] }); }) as never,
    shutdown: (async () => { calls.push({ method: 'shutdown', args: [] }); }) as never,
  };
  return { adapter, calls };
}

function makeBaseReq(): InvokeBaseReq {
  return {
    modelId: 'm1',
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: { stream: true, maxTokens: 1024 },
  };
}

function makeProvider(id: string, modelId = 'm1'): LlmProviderConfig {
  return {
    id, name: 'anthropic_compatible' as const, protocolId: 'anthropic_messages' as const, baseUrl: `https://${id}.example.com`,
    credentials: { key: `sk-${id}` }, pluginId: 'builtin.anthropic', enabled: true,
    models: [{
      modelId, inputModalities: ['text'], outputModalities: ['text'],
      contextWindow: 200000, maxOutputTokens: 8192, paramConstraints: {},
      pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
      providerId: id,
      capabilities: { maxOutputTokens: 8192, supportsPrefill: true, supportsThinking: false },
    } as LlmModelConfig],
  };
}

beforeEach(() => {
  __resetProviderHealthRegistryForTest();
});

// ============================================================
// M1: onWire 生产断链修复（buildInvokeContext + invoke）
// ============================================================
describe('[retry-1 M1] onWire 生产断链修复', () => {
  it('buildInvokeContext.getClient 调 withOnWire 派生绑 onWire 的 client', () => {
    const { client, withOnWireCalls } = makeStubClientWithOnWireSpy({ streams: [textStream('ok')] });
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
    });
    const onWire = vi.fn();
    // 模拟 invoke 内部调 getClient 传 onWire（spec §6.4 LlmClientFactory 契约）
    const derived = ctx.clientFactory.getClient(makeProvider('p1'), 'default', 'sk', ctx.fallback!.model, onWire);
    // withOnWire 被调一次（派生新 client）
    expect(withOnWireCalls).toHaveLength(1);
    // 派生出的 client 与原 client 不同（新实例）
    expect(derived).not.toBe(client);
  });

  it('invoke 空 chain 路径：fallback 经 clientFactory 派生 → onWire 触发 → recordWireBody（[v0.0.50 §4.4] logical.metadata 不再写 physicalWireBody）', async () => {
    const { client } = makeStubClientWithOnWireSpy({ streams: [textStream('wire body ok')] });
    const { adapter, calls } = makeSpyAdapter();
    const port = createLangfuseObservabilityPort({
      adapter,
      genHandle: { kind: 'gen', id: 'g1', parent: { kind: 'trace', id: 't1' } as TraceHandle } as never,
      iteration: 1, step: 1, model: 'm',
    });
    // 经 buildInvokeContext 派生 ctx（生产路径形态）
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
      observability: port,
    });
    // 注入测试友好 config（chain 空 + backoff=0）+ 独立 health
    ctx.config = {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, backoff_base_s: 0, backoff_cap_s: 0, jitter: false },
    };
    ctx.health = createProviderHealthRegistry();
    await invoke(makeBaseReq(), ctx);
    // 验证 endGeneration 被调（成功路径）
    const endCall = calls.find((c) => c.method === 'endGeneration');
    expect(endCall).toBeDefined();
    const args = endCall!.args as { metadata?: { physicalWireBody?: { model?: string } }; status?: string };
    expect(args.status).toBe('success');
    // [v0.0.50 §4.4] wire body 写路径全部走独立 physical generation（kind='physical'），
    //   logical.metadata 不再携带 physicalWireBody（旧 v0.0.25 字段保留兼容读取，写路径移除）
    expect(args.metadata?.physicalWireBody).toBeUndefined();
  });

  it('invoke 空 chain 路径：onWire 未传（observability 缺省）→ withOnWire 不被调，行为等价旧实现', () => {
    const { client, withOnWireCalls } = makeStubClientWithOnWireSpy({ streams: [textStream('ok')] });
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
      // 无 observability → invoke 内部 onWire 闭包不调 recordWireBody，但仍会传给 getClient
    });
    // 不传 onWire → getClient 返原 client（不派生）
    const derived = ctx.clientFactory.getClient(makeProvider('p1'), 'default', 'sk', ctx.fallback!.model, undefined);
    expect(derived).toBe(client);
    expect(withOnWireCalls).toHaveLength(0);
  });

  it('duck-typed stub client 无 withOnWire → getClient 返原 client（能力探测向后兼容）', () => {
    const stubClient = { stream: async function* () {} } as unknown as LlmClient;
    const ctx = buildInvokeContext({
      client: stubClient,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
    });
    const onWire = vi.fn();
    const derived = ctx.clientFactory.getClient(makeProvider('p1'), 'default', 'sk', ctx.fallback!.model, onWire);
    // 无 withOnWire 方法 → 能力探测返原 client（不抛错）
    expect(derived).toBe(stubClient);
  });
});

// ============================================================
// P2: fallback_chain 多 provider 接通（resolveTarget 跳过 cooled_down）
// ============================================================
describe('[retry-1 P2] fallback_chain 多 provider 接通', () => {
  it('chain 非空 + p1 cooled_down → resolveTarget 跳过 p1 选 p2', () => {
    const p1 = makeProvider('p1');
    const p2 = makeProvider('p2');
    const providers = new Map([
      [p1.id, p1],
      [p2.id, p2],
    ]);
    const health = createProviderHealthRegistry();
    // 标 p1/default cooled_down（overload 多次 → degrade）
    const now = Date.now();
    health.escalate('sess-a', 'p1', 'default', 'm1', LlmErrorCategory.PROVIDER_OVERLOADED, now);
    // escalate 一次不足以 cool_down（默认 consecutiveToDegrade=3），手动 mark 多次
    health.escalate('sess-a', 'p1', 'default', 'm1', LlmErrorCategory.PROVIDER_OVERLOADED, now);
    health.escalate('sess-a', 'p1', 'default', 'm1', LlmErrorCategory.PROVIDER_OVERLOADED, now);

    const config: LlmRequestConfig = {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      fallbackChain: [
        { providerId: 'p1', keyRef: 'default', modelId: 'm1' },
        { providerId: 'p2', keyRef: 'default', modelId: 'm1' },
      ],
    };
    const fakeClient = {} as LlmClient;
    const resolved = resolveTarget({
      config,
      providers,
      health,
      sessionId: 'sess-a',
      clientFactory: { getClient: () => fakeClient },
      now,
    });
    expect(resolved.kind).toBe('target');
    if (resolved.kind === 'target') {
      // p1 不可用 → 选 p2
      expect(resolved.target.providerId).toBe('p2');
    }
  });

  it('buildInvokeContext 注入 llmRequestConfig + allProviders → ctx.config + providers 含全部 provider', () => {
    const p1 = makeProvider('p1');
    const p2 = makeProvider('p2');
    const { client } = makeStubClientWithOnWireSpy({ streams: [textStream('ok')] });
    const cfg: LlmRequestConfig = {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      fallbackChain: [
        { providerId: 'p1', keyRef: 'default', modelId: 'm1' },
        { providerId: 'p2', keyRef: 'default', modelId: 'm1' },
      ],
    };
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
      llmRequestConfig: cfg,
      allProviders: [p1, p2],
      health: createProviderHealthRegistry(),
    });
    // ctx.config 透传
    expect(ctx.config?.fallbackChain).toHaveLength(2);
    // providers Map 含 p1 + p2（外加 client 派生的条目，p1 重复不覆盖）
    expect(ctx.providers.has('p1')).toBe(true);
    expect(ctx.providers.has('p2')).toBe(true);
    expect(ctx.providers.size).toBe(2);
  });

  it('chain 空（默认单 provider）→ buildInvokeContext 行为等价旧实现（providers 只 1 条 + ctx.config undefined）', () => {
    const { client } = makeStubClientWithOnWireSpy({ streams: [textStream('ok')] });
    const ctx = buildInvokeContext({
      client,
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
    });
    expect(ctx.providers.size).toBe(1);
    expect(ctx.config).toBeUndefined();
    expect(ctx.health).toBeUndefined();
  });
});
