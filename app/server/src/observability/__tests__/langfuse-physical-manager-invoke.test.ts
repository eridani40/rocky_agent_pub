/**
 * ObservabilityManager + LangfuseObservabilityPort + invoke 集成测试 — v0.0.50 physical bug 复现
 * 参考: specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md §4 §5 §6
 *
 * AT langfuse_physical_generation_tc1 round-1 暴露 bug：logPhysical=true 时 logical usage=0。
 * 本文件走完整 manager + port + invoke 链路（不经过 LoopObservability，但其他全真），
 * 验证 manager 层 kind 分支 + fan-out 在 invoke 触发 physical+logical end 时正确。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Langfuse } from 'langfuse';
import type { Usage } from '../../message/types';

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

/** v0.0.138 起 SDK 调用走 LangfuseEventQueue 异步 consumer（批间 250ms yield）。
 * manager 持 child adapter（children[0].adapter），需穿透到 adapter['queue'].flush。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function flush(manager: any, deadlineMs = 5_000): Promise<void> {
  const child = manager['children'][0];
  if (child) await child.adapter['queue'].flush(deadlineMs);
}

import type { GenHandle } from '../types';
import type { ObservabilityAdapter } from '../adapter';
import { ObservabilityManager } from '../observability-manager';
import type { StreamEvent } from '../../llm/protocol';
import type { LlmClient } from '../../llm/client';
import type { LlmProviderConfig, LlmModelConfig } from '../../llm/provider-types';
import type { InvokeContext, InvokeBaseReq, ObservabilityPort } from '../../llm/caller/llm_caller';
import { invoke } from '../../llm/caller/llm_caller';
import { createLangfuseObservabilityPort } from '../../llm/caller/langfuse_observability_port';

/** 构造 stub LlmClient：可控 stream + withOnWire（onWire 真触发）+ getInfo。 */
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

async function* textStreamWithUsage(text: string): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', text };
  // [v0.0.61] usage 含拆分字段 + cost（对齐断言：input_no_cache=10 + cache_read=100 + cache_write=50 = 160 total；
  // output_response=20 + reasoning=5 = 25 total；cost=0.012）
  yield {
    type: 'usage',
    usage: {
      input_no_cache: 10, input_cache_read: 100, input_cache_write: 50, input_total_tokens: 160,
      output_response: 20, output_reasoning: 5, output_total_tokens: 25, total_tokens: 185,
      cost: 0.012,
    } as never,
  };
  yield { type: 'finish', reason: 'stop' };
}

import { createLlmErrorState } from '../../llm/caller/llm_error_state';
import { createProviderHealthRegistry, __resetProviderHealthRegistryForTest } from '../../llm/caller/provider_health_registry';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../config/llm_request_config';

function makeCtx(client: LlmClient, observability: ObservabilityPort): InvokeContext {
  const provider: LlmProviderConfig = {
    id: 'p1', name: 'anthropic_compatible', protocolId: 'anthropic_messages', baseUrl: 'https://p1.example.com',
    credentials: { key: 'sk-test' }, pluginId: 'builtin.anthropic', enabled: true,
    models: [{
      modelId: 'm1', inputModalities: ['text'], outputModalities: ['text'],
      contextWindow: 200000, maxOutputTokens: 8192, paramConstraints: {},
      pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
      providerId: 'p1',
      capabilities: { maxOutputTokens: 8192, supportsPrefill: false, supportsThinking: false },
    } as LlmModelConfig],
  };
  const model = provider.models[0]!;
  return {
    errorState: createLlmErrorState(),
    controller: { runId: 'r1', aborted: false },
    observability,
    providers: new Map([[provider.id, provider]]),
    clientFactory: {
      getClient: (_p, _k, _v, _m, onWire) => {
        const withOnWireFn = (client as LlmClient & { withOnWire?(onWire: unknown): LlmClient }).withOnWire;
        if (typeof withOnWireFn === 'function') return withOnWireFn.call(client, onWire);
        return client;
      },
    },
    fallback: { provider, keyRef: 'default', model, client },
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

describe('ObservabilityManager + port + invoke — v0.0.50 physical+logical 端到端', () => {
  beforeEach(() => {
    calls.length = 0;
    obsSeq = 0;
    installSpies();
    __resetProviderHealthRegistryForTest();
  });
  afterEach(restoreSpies);

  /**
   * 用真 ObservabilityManager（logPhysical=true）+ port + invoke 跑通：
   *   1. manager.startTrace / startSpan / startGeneration（logical）
   *   2. port = createLangfuseObservabilityPort({adapter: manager, genHandle, ...})
   *   3. invoke 内部 onWire → port.startPhysicalGeneration → manager.startGeneration(kind:physical)
   *   4. invoke 成功 → port.endGenerationOk → manager.endGeneration(logical)
   *   5. invoke finally → port.endPhysicalGeneration → manager.endGeneration(physical)
   * 验证：manager fan-out 后 adapter 收到两次独立 endGeneration，各自 usage 正确。
   */
  it('logPhysical=true manager：invoke 后 logical 带 REAL usage / physical 带 0 usage', async () => {
    const manager = new ObservabilityManager([{
      id: 'a', name: 'A', type: 'langfuse',
      baseUrl: 'http://lf', publicKey: 'pk', secretKey: 'sk',
      enabled: true, logPhysical: true,
    }]);
    expect(manager.hasPhysicalChild()).toBe(true);

    const trace = manager.startTrace({
      id: 'r', sessionId: 's',
      metadata: { runId: 'r', sessionId: 's', inputMessageIds: [], modelId: 'm1', toolNames: [] },
    });
    const step = manager.startSpan({
      parent: trace, name: 'step 1', input: { step: 1 },
      metadata: { step: 1, ingestUpTo: null, llmUpTo: null, newMessageCount: 0, hasToolCall: false },
    });
    const genHandle: GenHandle = manager.startGeneration({
      parent: step, model: 'm1', name: 'llm-1-logical',
      input: {
        system: 'sys', systemCharCount: 3, messages: [], messagesCharCount: 10,
        tools: [], params: {}, modelId: 'm1', iteration: 1,
      },
    });

    // v0.0.138：start ops 入队后需 flush 等 consumer 处理完才能读 SDK calls
    await flush(manager);

    const logicalGenCalls = calls.filter((c) => c.method === 'obs.generation');
    const logicalObsId = logicalGenCalls[logicalGenCalls.length - 1]!.obsId;

    const port = createLangfuseObservabilityPort({
      adapter: manager as unknown as ObservabilityAdapter, genHandle,
      iteration: 1, step: 1, model: 'm1',
    });

    const client = makeStubClientWithOnWire([textStreamWithUsage('hello')]);
    const ctx = makeCtx(client, port);

    calls.length = 0;
    await invoke(makeBaseReq(), ctx);

    // v0.0.138：invoke 内的 end ops 入队后需 flush 等 consumer 处理完才能读 SDK calls
    await flush(manager);

    const genCalls = calls.filter((c) => c.method === 'obs.generation');
    const updates = calls.filter((c) => c.method === 'obs.update');

    const physicalGenCall = genCalls.find((c) => {
      const arg = c.args[0] as Record<string, unknown>;
      return arg['name'] === 'llm-1-physical';
    });
    expect(physicalGenCall, 'physical generation 应被 start').toBeDefined();
    const physicalObsId = physicalGenCall!.obsId;

    const logicalUpd = updates.find((u) => u.obsId === logicalObsId);
    const physicalUpd = updates.find((u) => u.obsId === physicalObsId);
    expect(logicalUpd, 'logical update 应被调用').toBeDefined();
    expect(physicalUpd, 'physical update 应被调用').toBeDefined();

    // ★ 核心断言（AT round-1 bug 修复目标）：logical usageDetails > 0（v0.0.61 互斥拆分防双计）
    // cache/reasoning key 用 langfuse Anthropic 原生 snake_case（对齐 langfuse-usage-protocol §二/§四）
    const lArg = logicalUpd!.args[0] as Record<string, unknown>;
    const lUD = lArg['usageDetails'] as Record<string, number>;
    expect(lUD['input'], 'logical usageDetails.input 必须 > 0').toBe(10); // input_no_cache（拆分路径）
    expect(lUD['cache_read_input_tokens']).toBe(100);
    expect(lUD['cache_creation_input_tokens']).toBe(50);
    expect(lUD['output']).toBe(20);
    expect(lUD['output_reasoning_tokens']).toBe(5);
    const lCD = lArg['costDetails'] as Record<string, number>;
    expect(lCD['total']).toBe(0.012);

    // physical: mapUsageDetails({}) → usageDetails 全 0 + costDetails 空（不污染 cost dashboard）
    const pArg = physicalUpd!.args[0] as Record<string, unknown>;
    const pUD = pArg['usageDetails'] as Record<string, number>;
    expect(pUD['input']).toBe(0);
    expect(pUD['output']).toBe(0);
    expect(Object.keys(pArg['costDetails'] as Record<string, number>)).toHaveLength(0);
  });
});
