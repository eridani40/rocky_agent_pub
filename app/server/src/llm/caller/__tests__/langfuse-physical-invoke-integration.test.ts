/**
 * LangfuseObservabilityPort + invoke 集成测试 — v0.0.50 physical+logical 双 generation
 * 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §4 §6
 *
 * AT langfuse_physical_generation_tc1 round-1 暴露的 UT 缺口：logPhysical=true 时
 * invoke 跑通后，adapter.endGeneration 必须收到两次独立调用：
 *   ① logical 带 REAL usage（>0）
 *   ② physical 带 EMPTY usage（=0）
 *
 * 本测试用真 LangfuseAdapter（mock SDK）+ LangfuseObservabilityPort + stub LlmClient
 * （带 withOnWire）+ invoke 完整跑通，验证 port 层把真 usage 透传给 logical endGeneration。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Langfuse } from 'langfuse';
import type { Usage } from '../../../message/types';

type SpyFn = ReturnType<typeof vi.fn>;

interface ObsMock {
  __id: number;
  update: SpyFn;
  span: (p: unknown) => ObsMock;
  generation: (p: unknown) => ObsMock;
}

type Call = { method: string; obsId: number; args: unknown[] };

const calls: Call[] = [];
let obsSeq = 0;

function makeObs(): ObsMock {
  const id = ++obsSeq;
  return {
    __id: id,
    update: vi.fn((p: unknown) => calls.push({ method: 'obs.update', obsId: id, args: [p] })),
    span: (p: unknown) => {
      const child = makeObs();
      calls.push({ method: 'obs.span', obsId: child.__id, args: [p] });
      return child;
    },
    generation: (p: unknown) => {
      const child = makeObs();
      calls.push({ method: 'obs.generation', obsId: child.__id, args: [p] });
      return child;
    },
  };
}

let traceSpy: SpyFn | null = null;
const proto = Langfuse.prototype as { trace?: unknown };
const origTrace = proto.trace;

function installSpies(): void {
  traceSpy = vi.fn((p: unknown) => {
    const t = makeObs();
    calls.push({ method: 'client.trace', obsId: t.__id, args: [p] });
    return t;
  });
  proto.trace = traceSpy;
}
function restoreSpies(): void {
  proto.trace = origTrace;
  traceSpy = null;
}

/** v0.0.138 起 SDK 调用走 LangfuseEventQueue 异步 consumer（批间 250ms yield），测试需 flush 等 consumer 处理完再断言 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flush(adapter: any, deadlineMs = 5_000): Promise<void> {
  await adapter['queue'].flush(deadlineMs);
}

import type { GenHandle } from '../../../observability/types';
import type { ObservabilityAdapter } from '../../../observability/adapter';
import type { StreamEvent } from '../../protocol';
import type { LlmClient } from '../../client';
import type { InvokeContext, InvokeBaseReq, ObservabilityPort } from '../llm_caller';
import { invoke } from '../llm_caller';
import { createLangfuseObservabilityPort } from '../langfuse_observability_port';
import { createLlmErrorState } from '../llm_error_state';
import { createProviderHealthRegistry, __resetProviderHealthRegistryForTest } from '../provider_health_registry';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../../config/llm_request_config';

/** 构造 stub LlmClient：可控 stream + withOnWire（onWire 真触发）+ getInfo。
 * withOnWire 派生新 client，stream 内部模拟 prepare 后 fetch 前触发 onWire（与生产 client.ts 同构）。
 */
function makeStubClientWithOnWire(streams: Array<AsyncIterable<StreamEvent>>): LlmClient {
  let callIdx = 0;
  const streamFn = async function* (_req: unknown, _signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const idx = callIdx++;
    const cur = streams[idx];
    if (!cur) throw new Error(`stub: no stream queued #${idx}`);
    for await (const evt of cur) yield evt;
  };
  const build = (
    onWire?: (req: unknown, body: unknown, url: string) => void,
  ): LlmClient => {
    const c = {
      stream: async function* (req: unknown, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
        // 模拟 client.stream：在 fetch 前（这里没真 fetch）触发 onWire
        onWire?.(req, { wire: 'body-from-stub' }, 'https://stub.example.com');
        yield* streamFn(req, signal);
      },
      getInfo: () => ({
        providerId: 'p1', providerName: 'anthropic_compatible' as const, modelId: 'm1',
        maxOutputTokens: 8192,
        capabilities: { maxOutputTokens: 8192, supportsPrefill: false, supportsThinking: false },
      }),
      withOnWire: (nextOnWire?: (req: unknown, body: unknown, url: string) => void) =>
        build(nextOnWire),
    } as unknown as LlmClient;
    return c;
  };
  return build(undefined);
}

/** 文本流 stub（带 usage 事件 → 模拟真实 LLM 响应）。 */
async function* textStreamWithUsage(text: string): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', text };
  yield { type: 'usage', usage: { output_total_tokens: 25, input_total_tokens: 160, total_tokens: 185 } as never };
  yield { type: 'finish', reason: 'stop' };
}

function makeCtx(client: LlmClient, observability: ObservabilityPort): InvokeContext {
  return {
    errorState: createLlmErrorState(),
    controller: { runId: 'r1', aborted: false },
    observability,
    providers: new Map([['p1', {
      id: 'p1', name: 'anthropic_compatible' as const, protocolId: 'anthropic_messages', baseUrl: 'https://p1.example.com',
      credentials: { key: 'sk-test' }, pluginId: 'builtin.anthropic', enabled: true,
      models: [{
        modelId: 'm1', inputModalities: ['text'], outputModalities: ['text'],
        contextWindow: 200000, maxOutputTokens: 8192, paramConstraints: {},
        pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
        providerId: 'p1',
        capabilities: { maxOutputTokens: 8192, supportsPrefill: false, supportsThinking: false },
      }],
    }]]),
    clientFactory: {
      getClient: (_p, _k, _v, _m, onWire) => {
        // 模拟生产 buildInvokeContext：onWire 透传到 client.withOnWire（生产 spec §3.8）
        const withOnWireFn = (client as LlmClient & {
          withOnWire?(onWire: unknown): LlmClient;
        }).withOnWire;
        if (typeof withOnWireFn === 'function') return withOnWireFn.call(client, onWire);
        return client;
      },
    },
    fallback: {
      provider: {
        id: 'p1', name: 'anthropic_compatible' as const, protocolId: 'anthropic_messages', baseUrl: 'https://p1.example.com',
        credentials: { key: 'sk-test' }, pluginId: 'builtin.anthropic', enabled: true,
        models: [{
          modelId: 'm1', inputModalities: ['text'], outputModalities: ['text'],
          contextWindow: 200000, maxOutputTokens: 8192, paramConstraints: {},
          pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
          providerId: 'p1',
          capabilities: { maxOutputTokens: 8192, supportsPrefill: false, supportsThinking: false },
        }],
      },
      keyRef: 'default',
      model: {
        modelId: 'm1', inputModalities: ['text'], outputModalities: ['text'],
        contextWindow: 200000, maxOutputTokens: 8192, paramConstraints: {},
        pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
        providerId: 'p1',
        capabilities: { maxOutputTokens: 8192, supportsPrefill: false, supportsThinking: false },
      },
      client,
    },
    config: {
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

describe('LangfuseObservabilityPort + invoke — v0.0.50 physical+logical 集成', () => {
  let Adapter: typeof import('../../../observability/langfuse-adapter').LangfuseAdapter;

  beforeEach(async () => {
    calls.length = 0;
    obsSeq = 0;
    installSpies();
    Adapter = (await import('../../../observability/langfuse-adapter')).LangfuseAdapter;
    __resetProviderHealthRegistryForTest();
  });
  afterEach(restoreSpies);

  /**
   * 生产场景：logPhysical=true → invoke 内部启 physical 埋点。
   * 验证：adapter.endGeneration 收到两次独立调用：
   *   ① logical 带 stream usage（非 0）
   *   ② physical 带空 usage（=0）
   */
  it('logPhysical=true：invoke 成功后 logical 带 REAL usage / physical 带 0 usage', async () => {
    const adapter: ObservabilityAdapter = new Adapter({ publicKey: 'pk', secretKey: 'sk', baseUrl: 'http://lf' });
    // 用真 adapter 构造 port（genHandle 用 adapter 自身的 startGeneration 产出，便于完整跑通）
    const trace = adapter.startTrace({
      id: 'r', sessionId: 's',
      metadata: { runId: 'r', sessionId: 's', inputMessageIds: [], modelId: 'm1', toolNames: [] },
    });
    const step = adapter.startSpan({
      parent: trace, name: 'step 1', input: { step: 1 },
      metadata: { step: 1, ingestUpTo: null, llmUpTo: null, newMessageCount: 0, hasToolCall: false },
    });
    const genHandle: GenHandle = adapter.startGeneration({
      parent: step, model: 'm1', name: 'llm-1-logical',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 10,
        tools: [], params: {}, modelId: 'm1', iteration: 1,
      },
    });

    // v0.0.138：start ops 入队后需 flush 等 consumer 处理完才能读 SDK calls
    await flush(adapter);

    // 记录 logical 的 obs id（用于后续断言 update 落在它上面）
    const logicalGenCalls = calls.filter((c) => c.method === 'obs.generation');
    const logicalObsId = logicalGenCalls[logicalGenCalls.length - 1]!.obsId;

    // 构造 port：adapter + genHandle + iteration + model + 模拟 hasPhysicalChild=true
    const port = createLangfuseObservabilityPort({
      adapter, genHandle, iteration: 1, step: 1, model: 'm1',
    });
    // 能力探测：用 wrapper 让 hasPhysicalChild 返 true（模拟 logPhysical=true）
    const portWithPhysical: ObservabilityPort = {
      ...port,
      hasPhysicalChild: () => true,
    };

    const client = makeStubClientWithOnWire([textStreamWithUsage('hello')]);
    const ctx = makeCtx(client, portWithPhysical);

    calls.length = 0; // 清 start 阶段，只看 invoke 内部的 SDK 调用
    await invoke(makeBaseReq(), ctx);

    // v0.0.138：invoke 内的 end ops 入队后需 flush 等 consumer 处理完才能读 SDK calls
    await flush(adapter);

    // 收集所有 obs.generation（physical start 应在此）+ obs.update（end 阶段）
    const genCalls = calls.filter((c) => c.method === 'obs.generation');
    const updates = calls.filter((c) => c.method === 'obs.update');

    // ★ 断言 1：physical generation 被 start（logPhysical=true）
    const physicalGenCall = genCalls.find((c) => {
      const arg = c.args[0] as Record<string, unknown>;
      return arg['name'] === 'llm-1-physical';
    });
    expect(physicalGenCall, 'physical generation 应被 start').toBeDefined();
    const physicalObsId = physicalGenCall!.obsId;

    // ★ 断言 2：两次 update（logical + physical），分别落在不同 obs id 上
    const logicalUpd = updates.find((u) => u.obsId === logicalObsId);
    const physicalUpd = updates.find((u) => u.obsId === physicalObsId);
    expect(logicalUpd, 'logical update 应被调用').toBeDefined();
    expect(physicalUpd, 'physical update 应被调用').toBeDefined();

    // ★ 断言 3（核心 bug 修复目标）：logical update 带 REAL usageDetails（>0）
    // [v0.0.61] usage → usageDetails/costDetails（互斥拆分防双计）。本 stub 仅 total（无拆分）→ fallback 路径：
    // usageDetails.input = input_total_tokens（160）；无 cache key；costDetails 空（cost 缺省）
    const lArg = logicalUpd!.args[0] as Record<string, unknown>;
    const lUD = lArg['usageDetails'] as Record<string, number>;
    expect(lUD['input'], 'logical usageDetails.input 必须 > 0（AT round-1 bug：此处为 0）').toBe(160);
    expect(lUD['output']).toBe(25);
    // 防双计：旧 usage 字段不再写入
    expect(lArg['usage']).toBeUndefined();

    // ★ 断言 4：physical update 带 0 usageDetails（mapUsageDetails({}) 全 0）
    const pArg = physicalUpd!.args[0] as Record<string, unknown>;
    const pUD = pArg['usageDetails'] as Record<string, number>;
    expect(pUD['input']).toBe(0);
    expect(pUD['output']).toBe(0);
    expect(pArg['usage']).toBeUndefined();
  });
});
