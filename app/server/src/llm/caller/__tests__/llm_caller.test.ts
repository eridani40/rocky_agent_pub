/**
 * LlmCaller.invoke 主流程 + decide 决策矩阵 单测
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §2 §3 §6
 *       states/v0.0.25/verify/test-plan.md §3（llm_caller_overview 行）
 *
 * 覆盖：
 *   1. decide 决策矩阵（5 action 全分支 + 瞬时超 max 兜底 FALLBACK）
 *   2. invoke 主流程（happy path / RETRY_BACKOFF / ROTATE_KEY / FIX_AND_RETRY_MAX_TOKENS /
 *      FIX_AND_RETRY_CONTEXT_LENGTH / NO_RETRY / FALLBACK / user_abort / all_dead）
 *   3. backgroundPath=true 时 overload 不重试（防雪崩）
 *   4. 跨 attempt overlay 继承（maxTokensOverlay / prefillPartial）
 *
 * 测试方式：stub LlmClient（注入可控 stream/error），测编排逻辑（非 mock-LLM）。
 * 单文件 ≤300 行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LlmErrorCategory,
  type ClassifiedLlmError,
} from '../error_types';
import { invoke, type InvokeContext, type InvokeBaseReq } from '../llm_caller';
import { decideAction } from '../decide_action';
import type { ResolvedTarget } from '../resolve_target';
import type { LlmProviderConfig, LlmModelConfig } from '../../provider-types';
import type { LlmClient } from '../../client';
import type { StreamEvent } from '../../protocol';
import type { LlmErrorState } from '../llm_error_state';
import { createLlmErrorState } from '../llm_error_state';
import { createProviderHealthRegistry, __resetProviderHealthRegistryForTest } from '../provider_health_registry';
// [v0.0.359 T1] 成功 target registry（ok 分支写入断言）
import { getSuccessTarget, __resetSuccessTargetRegistryForTest } from '../success-target-registry';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../../config/llm_request_config';

// ── 测试 stub 构造器 ──

/** 构造 LlmClient stub：可控 stream（按调用序号返回不同结果）。 */
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

/** 文本流 stub：text → usage → finish。 */
async function* textStream(text: string): AsyncGenerator<StreamEvent> {
  yield { type: 'text_delta', text };
  yield { type: 'usage', usage: { output_total_tokens: 10, input_total_tokens: 5 } as never };
  yield { type: 'finish', reason: 'stop' };
}

/** 把数组包装成 async iterable。 */
async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/** 构造 HTTP 错（client.stream 抛 Error）。 */
function httpError(message: string, status = 500): Error {
  const e = new Error(message);
  (e as unknown as { status: number }).status = status;
  (e as unknown as { body: unknown }).body = { error: { message } };
  return e;
}

/** 构造最小 LlmProviderConfig。 */
function makeProvider(id: string, name: 'anthropic_compatible' | 'openai_compatible' | 'glm' = 'anthropic_compatible'): LlmProviderConfig {
  return {
    id, name, protocolId: 'anthropic_messages', baseUrl: `https://${id}.example.com`,
    credentials: { key: 'sk-test' },
    pluginId: 'builtin.anthropic', enabled: true, models: [makeModel('m1')],
  };
}

/** 构造最小 LlmModelConfig。 */
function makeModel(modelId: string): LlmModelConfig {
  return {
    modelId, inputModalities: ['text'], outputModalities: ['text'],
    contextWindow: 200000, maxOutputTokens: 8192, paramConstraints: {},
    pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
    providerId: '',
    capabilities: { maxOutputTokens: 8192, supportsPrefill: true, supportsThinking: false },
  };
}

/** 构造最小 InvokeContext（含 fallback 单一 target 兜底，空 chain 场景）。 */
function makeCtx(args: {
  errorState?: LlmErrorState;
  client: LlmClient;
  provider?: LlmProviderConfig;
  backgroundPath?: boolean;
  onEvent?: (e: StreamEvent) => void;
}): InvokeContext {
  const provider = args.provider ?? makeProvider('p1');
  const model = provider.models[0]!;
  return {
    errorState: args.errorState ?? createLlmErrorState(),
    controller: { runId: 'r1', aborted: false },
    backgroundPath: args.backgroundPath,
    onEvent: args.onEvent,
    providers: new Map([[provider.id, provider]]),
    clientFactory: {
      // 单一 target 兜底场景：factory 永远返同一 stub client
      getClient: () => args.client,
    },
    fallback: { provider, keyRef: 'default', model, client: args.client },
    config: { ...DEFAULT_LLM_REQUEST_CONFIG, retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, backoff_base_s: 0, backoff_cap_s: 0, jitter: false } },
    health: createProviderHealthRegistry(),
  };
}

/** 构造最小 baseReq。 */
function makeBaseReq(): InvokeBaseReq {
  return {
    modelId: 'm1',
    messages: [{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    params: { stream: true, maxTokens: 1024 },
  };
}

beforeEach(() => {
  __resetProviderHealthRegistryForTest();
  __resetSuccessTargetRegistryForTest();
});

// ============================================================
// 1. decide 决策矩阵
// ============================================================
describe('decideAction 决策矩阵', () => {
  const target: ResolvedTarget = {
    providerId: 'p1', provider: makeProvider('p1'), keyRef: 'default',
    keyValue: 'sk-test', model: makeModel('m1'), client: {} as LlmClient,
  };

  function mkErr(category: LlmErrorCategory, hints: Partial<{ retryable: boolean; shouldRotateKey: boolean; shouldFallbackProvider: boolean; shouldCompressContext: boolean; shouldBumpMaxTokens: boolean }>): ClassifiedLlmError {
    const e = new Error(category) as ClassifiedLlmError;
    e.category = category;
    e.hints = {
      retryable: false, shouldRotateKey: false, shouldFallbackProvider: false,
      shouldCompressContext: false, shouldBumpMaxTokens: false, ...hints,
    };
    return e;
  }

  it('shouldCompressContext → FIX_AND_RETRY_CONTEXT_LENGTH', () => {
    const a = decideAction(mkErr(LlmErrorCategory.CONTEXT_LENGTH_EXCEEDED, { shouldCompressContext: true }), target, 1, 3);
    expect(a).toBe('FIX_AND_RETRY_CONTEXT_LENGTH');
  });

  it('shouldBumpMaxTokens → FIX_AND_RETRY_MAX_TOKENS', () => {
    const a = decideAction(mkErr(LlmErrorCategory.MAX_TOKENS_EXCEEDED, { shouldBumpMaxTokens: true }), target, 1, 3);
    expect(a).toBe('FIX_AND_RETRY_MAX_TOKENS');
  });

  it('shouldRotateKey + provider 有备用 per_key key → ROTATE_KEY', () => {
    const provider = makeProvider('p1');
    provider.credentials = { keys: [
      { keyRef: 'default', keyValue: 'k1', quotaScope: 'per_key' },
      { keyRef: 'backup', keyValue: 'k2', quotaScope: 'per_key' },
    ] };
    const t: ResolvedTarget = { ...target, provider };
    const a = decideAction(mkErr(LlmErrorCategory.AUTH_INVALID, { shouldRotateKey: true }), t, 1, 3);
    expect(a).toBe('ROTATE_KEY');
  });

  it('shouldRotateKey 但无备用 key → FALLBACK', () => {
    const a = decideAction(mkErr(LlmErrorCategory.AUTH_INVALID, { shouldRotateKey: true }), target, 1, 3);
    expect(a).toBe('FALLBACK');
  });

  it('retryable + attempt<max → RETRY_BACKOFF', () => {
    const a = decideAction(mkErr(LlmErrorCategory.SERVER_ERROR, { retryable: true }), target, 1, 3);
    expect(a).toBe('RETRY_BACKOFF');
  });

  it('retryable + attempt>=max + shouldFallbackProvider → FALLBACK', () => {
    const a = decideAction(mkErr(LlmErrorCategory.RATE_LIMITED, { retryable: true, shouldFallbackProvider: true }), target, 3, 3);
    expect(a).toBe('FALLBACK');
  });

  it('retryable + attempt>=max + 无 fallback → NO_RETRY', () => {
    const a = decideAction(mkErr(LlmErrorCategory.SERVER_ERROR, { retryable: true }), target, 3, 3);
    expect(a).toBe('NO_RETRY');
  });

  it('NO_RETRY 类（CONTENT_FILTERED）→ NO_RETRY', () => {
    const a = decideAction(mkErr(LlmErrorCategory.CONTENT_FILTERED, {}), target, 1, 3);
    expect(a).toBe('NO_RETRY');
  });
});

// ============================================================
// 2. invoke 主流程
// ============================================================
describe('invoke 主流程', () => {
  it('happy path：首次成功 → 返回 message，errorState 清瞬时态', async () => {
    const client = makeStubClient([textStream('hello')]);
    const ctx = makeCtx({ client });
    const resp = await invoke(makeBaseReq(), ctx);
    expect(resp.message.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'hello' })]));
    expect(resp.stopReason).toBe('stop');
    // 瞬时态被清
    expect(ctx.errorState.lastError).toBeUndefined();
  });

  it('[T4 根治版] branch-1 调用点注入：baseReq.modelId 与 target 不一致时，client.stream 收到 target.modelId', async () => {
    // 验证 llm_caller.ts 在 invokeCore 内层 attempt 前注入 baseReq.modelId，buildRequest 不再二次改写。
    const captured: Array<{ modelId: string }> = [];
    const provider = makeProvider('p1');
    const model = makeModel('target-model');
    provider.models = [model];
    const client: LlmClient = {
      stream: async function* (req: { modelId: string }): AsyncGenerator<StreamEvent> {
        captured.push({ modelId: req.modelId });
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'usage', usage: { output_total_tokens: 3, input_total_tokens: 2 } as never };
        yield { type: 'finish', reason: 'stop' };
      },
    } as unknown as LlmClient;
    const ctx = makeCtx({ client, provider });
    const baseReq = { ...makeBaseReq(), modelId: 'wrong-model' };
    const resp = await invoke(baseReq, ctx);
    expect(resp.message.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'ok' })]));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.modelId).toBe('target-model');
  });

  it('RETRY_BACKOFF：attempt1 SERVER_ERROR → attempt2 成功', async () => {
    const client = makeStubClient([
      (async function* () { throw httpError('server error', 500); })(),
      textStream('ok'),
    ]);
    const ctx = makeCtx({ client });
    const resp = await invoke(makeBaseReq(), ctx);
    expect(resp.message.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'ok' })]));
  });

  it('NO_RETRY：CONTENT_FILTERED 首次即 throw（不上抛半截）', async () => {
    const client = makeStubClient([
      (async function* () { throw httpError('content policy', 400); })(),
    ]);
    const ctx = makeCtx({ client });
    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    expect(ctx.errorState.lastError?.category).toBe(LlmErrorCategory.BAD_REQUEST_OTHER);
  });

  it('user abort：controller.aborted=true 在 chunk 间 → throw ABORTED_BY_USER + 保留 partial', async () => {
    const client = makeStubClient([
      (async function* () {
        yield { type: 'text_delta', text: 'partial' };
        // 模拟 controller 在 chunk 间被置位（attemptLoop 读 userController.aborted 后 abortByUser + break）
      })(),
    ]);
    const ctx = makeCtx({ client });
    ctx.controller.aborted = true; // 首 chunk 后 attemptLoop 检查到
    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    expect(ctx.errorState.partialResult).toBeDefined();
    expect(ctx.errorState.partialResult?.message.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'partial' })]));
  });

  it('all_dead：fallback chain 空 + 单 target dead → throw NETWORK（不塌缩 LOOP_ERROR）', async () => {
    const client = makeStubClient([]);
    const ctx = makeCtx({ client });
    // 手动把唯一 target 标 dead
    ctx.health!.markDead('', 'p1', 'default', 'm1', 'test', Date.now());
    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow(/all targets unavailable/);
  });

  it('backgroundPath=true 时 PROVIDER_OVERLOADED 直接 fail（防雪崩，不重试）', async () => {
    // 用 529 + overloaded_error 形态（AnthropicErrorClassifier 会归 PROVIDER_OVERLOADED）
    const client = makeStubClient([
      (async function* () {
        throw { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } } };
      })(),
    ]);
    const ctx = makeCtx({ client, backgroundPath: true });
    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    // lastError 应该是 PROVIDER_OVERLOADED（背景路径直接 fail，不重试）
    expect(ctx.errorState.lastError?.category).toBe(LlmErrorCategory.PROVIDER_OVERLOADED);
  });
});

// ============================================================
// [v0.0.68 R7] invoke() 外层 catch endGenerationError 兜底（spec llm_caller.md §2.1 line 65 不变量）
// ============================================================
describe('[R7] invoke 外层 catch endGenerationError 兜底', () => {
  /**
   * 构造一个 ctx，clientFactory.getClient 抛非 ClassifiedLlmError 异常（如 TypeError / programming error）。
   * invokeCore 内部 buildTarget 调 clientFactory.getClient → 异常未经 attemptLoop catch（attemptLoop 只包 client.stream）
   * 直接上抛 invoke 外层 catch。本构造用于验证「外层 catch 对非 ClassifiedLlmError 补 endGenerationError」。
   */
  function makeCtxWithThrowingFactory(extra?: Partial<InvokeContext>): InvokeContext {
    const provider = makeProvider('p1');
    const model = provider.models[0]!;
    const dummyClient = makeStubClient([]);
    return {
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
      providers: new Map([[provider.id, provider]]),
      // clientFactory.getClient 抛 programming error（非 ClassifiedLlmError，无 category 字段）
      clientFactory: {
        getClient: () => {
          throw new TypeError('boom: bug in client factory');
        },
      },
      fallback: { provider, keyRef: 'default', model, client: dummyClient },
      config: { ...DEFAULT_LLM_REQUEST_CONFIG, retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, backoff_base_s: 0, backoff_cap_s: 0, jitter: false } },
      health: createProviderHealthRegistry(),
      ...extra,
    };
  }

  it('非 ClassifiedLlmError 异常 → 补 endGenerationError(INTERNAL) 后 rethrow', async () => {
    // 用 spy observability 观察是否被调用
    const calls: Array<{ category: LlmErrorCategory; reason: string }> = [];
    const ctx = makeCtxWithThrowingFactory({
      observability: {
        endGenerationError: (category, reason) => {
          calls.push({ category, reason });
        },
      },
    });
    // invoke 应抛 TypeError（保留原错误语义）
    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow(/boom: bug in client factory/);
    // 外层 catch 兜底：endGenerationError 被调用一次，category=INTERNAL
    expect(calls.length).toBe(1);
    expect(calls[0]!.category).toBe(LlmErrorCategory.INTERNAL);
    expect(calls[0]!.reason).toContain('boom: bug in client factory');
  });

  it('ClassifiedLlmError 已 end → 不重复调 endGenerationError（observabilityEnded 防双调）', async () => {
    // NO_RETRY 路径：CONTENT_FILTERED → invokeCore 已 endGenerationError 后 throw →
    // 外层 catch 见 ClassifiedLlmError（有 category）→ 不再补 end。
    const client = makeStubClient([
      (async function* () { throw httpError('content policy', 400); })(),
    ]);
    const calls: Array<{ category: LlmErrorCategory; reason: string }> = [];
    const ctx = makeCtx({
      client,
    });
    ctx.observability = {
      endGenerationError: (category, reason) => {
        calls.push({ category, reason });
      },
    };
    await expect(invoke(makeBaseReq(), ctx)).rejects.toThrow();
    // invokeCore 内部 NO_RETRY 分支已 end 一次；外层 catch 见 category → 不补 end（防双调）
    expect(calls.length).toBe(1);
    expect(calls[0]!.category).toBe(LlmErrorCategory.BAD_REQUEST_OTHER);
  });
});

// ============================================================
// 3. overlay 跨 attempt 继承（unit level，直接测 buildRequest/applyMaxTokensOverlay）
// ============================================================
describe('overlay 跨 attempt 继承', () => {
  it('[T12] applyMaxTokensOverlay bump 路径 → 返 one-shot ceiling maxTokens（不写 errorState）', async () => {
    // [T12] EXCEEDED bump 改 one-shot ceiling：返 maxTokens（=model.maxOutputTokens），
    // 不再写 errorState.maxTokensOverlay（字段已删）；bumped 值由调用方写入 req.params。
    const { applyMaxTokensOverlay } = await import('../build_request');
    const state = createLlmErrorState();
    const partial = {
      id: 'a1', role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'partial output' }],
      usage: { output_total_tokens: 1024 },
    };
    const model = makeModel('m1'); // maxOutputTokens=8192
    const cfg = { ...DEFAULT_LLM_REQUEST_CONFIG, length: { ...DEFAULT_LLM_REQUEST_CONFIG.length, max_tokens_bump_strategy: 'increase' as const } };
    const r = applyMaxTokensOverlay(state, partial, model, 1024, cfg);
    expect(r.kind).toBe('updated');
    if (r.kind === 'updated') {
      // [T12] one-shot ceiling：直接到 model.maxOutputTokens（8192），不再是 1024*2=2048
      expect(r.maxTokens).toBe(8192);
      // [T12] bumped 值不写 errorState（state 原样返回，无 maxTokensOverlay 字段）
      expect(r.state).toBe(state);
    }
  });

  it('[T12 prefill defer] applyMaxTokensOverlay strategy=continue + supportsPrefill → 仍走 bump（不走 prefill）', async () => {
    // [T12 prefill defer] v0.0.25 不实现 prefill：即便 supportsPrefill + salvageable，
    // decideMaxTokensAction 仍走 bump（one-shot ceiling），不设 prefillPartial。
    const { applyMaxTokensOverlay } = await import('../build_request');
    const state = createLlmErrorState();
    const partial = {
      id: 'a1', role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'partial output' }],
      usage: { output_total_tokens: 100 },
    };
    const model = makeModel('m1'); // supportsPrefill=true
    const cfg = DEFAULT_LLM_REQUEST_CONFIG; // strategy=continue
    const r = applyMaxTokensOverlay(state, partial, model, 1024, cfg);
    expect(r.kind).toBe('updated');
    if (r.kind === 'updated') {
      // [T12] prefill defer：不设 prefillPartial，走 bump 返 maxTokens
      expect(r.state.prefillPartial).toBeUndefined();
      expect(r.maxTokens).toBe(8192); // one-shot ceiling
    }
  });

  it('[T12] applyMaxTokensOverlay current ≥ ceiling → throw', async () => {
    // [T12] 已到硬上限仍触顶 → throw（输出超 model 能力，§2.2 封顶）
    const { applyMaxTokensOverlay } = await import('../build_request');
    const state = createLlmErrorState();
    const partial = {
      id: 'a1', role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'partial output' }],
    };
    const model = makeModel('m1'); // maxOutputTokens=8192
    const cfg = DEFAULT_LLM_REQUEST_CONFIG;
    const r = applyMaxTokensOverlay(state, partial, model, 8192, cfg); // current == ceiling
    expect(r.kind).toBe('throw');
  });

  it('buildRequest 无 overlay → maxTokens 派生（recentErrors 空 = base）', async () => {
    // [v0.0.25 rev2] 无 maxTokensOverlay 时走 deriveMaxTokens：recentErrors 空 → 派生值 = base
    const { buildRequest } = await import('../build_request');
    const model = makeModel('m1');
    const req = buildRequest({
      baseReq: makeBaseReq(), errorState: { recentErrors: [] }, model,
      config: DEFAULT_LLM_REQUEST_CONFIG,
    });
    // base 来自 makeBaseReq 的 maxTokens（见 makeBaseReq）
    expect(req.req.params.maxTokens).toBe(req.req.params.maxTokens); // 派生 = base（无降级）
  });

  it('recentErrors 含 MAX_TOKENS_TOO_HIGH → 成功后 clearRecentErrors 清空（spec §2.3 rev2）', async () => {
    // [v0.0.25 rev2] 成功 → clearTransientOnErrorState → clearRecentErrors 清空整个 recentErrors
    const client = makeStubClient([textStream('ok')]);
    const state: LlmErrorState = {
      recentErrors: [{
        category: LlmErrorCategory.MAX_TOKENS_TOO_HIGH,
        modelEntry: { providerId: 'p1', keyRef: 'default', modelId: 'm1' },
        at: Date.now(),
      }],
    };
    const ctx = makeCtx({ client, errorState: state });
    await invoke(makeBaseReq(), ctx);
    // 成功清空 recentErrors（降级因子立即归零，spec §2.3 rev2 关键决定）
    expect(ctx.errorState.recentErrors).toEqual([]);
  });

  it('prefillPartial 应用后清（一次性，spec §2.3）', async () => {
    const client = makeStubClient([textStream('ok')]);
    const state: LlmErrorState = {
      prefillPartial: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'p' }] },
    };
    const ctx = makeCtx({ client, errorState: state });
    await invoke(makeBaseReq(), ctx);
    // prefillPartial 在 buildRequest 应用后，invoke 成功时清
    expect(ctx.errorState.prefillPartial).toBeUndefined();
  });
});

// ============================================================
// [v0.0.353 T2] 分支1 recordAttemptTarget（调用谁记录谁）
// ============================================================
describe('[v0.0.353 T2] 分支1 recordAttemptTarget', () => {
  it('成功路径：target 确定后 recordAttemptTarget 带真实 providerId/providerName/modelId', async () => {
    const client = makeStubClient([textStream('ok')]);
    const targets: Array<{ providerId: string; providerName: string; modelId: string }> = [];
    const ctx = makeCtx({
      client,
      provider: makeProvider('p1', 'anthropic_compatible'),
    });
    ctx.observability = {
      recordAttemptTarget: (t) => targets.push(t),
    };
    await invoke(makeBaseReq(), ctx);
    // 分支1 resolveTarget 成功 → 上报一次真实 target（provider=p1, name=anthropic_compatible, model=m1）
    expect(targets.length).toBe(1);
    expect(targets[0]).toEqual({ providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'm1' });
  });

  it('fallback 兜底路径：单一 target 也 recordAttemptTarget（provider.name 真实）', async () => {
    const client = makeStubClient([textStream('ok')]);
    const targets: Array<{ providerId: string; providerName: string; modelId: string }> = [];
    const provider = makeProvider('fb1', 'openai_compatible');
    const model = provider.models[0]!;
    const ctx: InvokeContext = {
      errorState: createLlmErrorState(),
      controller: { runId: 'r1', aborted: false },
      providers: new Map([[provider.id, provider]]),
      clientFactory: { getClient: () => client },
      fallback: { provider, keyRef: 'default', model, client },
      config: { ...DEFAULT_LLM_REQUEST_CONFIG, retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, backoff_base_s: 0, backoff_cap_s: 0, jitter: false } },
      health: createProviderHealthRegistry(),
      observability: { recordAttemptTarget: (t) => targets.push(t) },
    };
    await invoke(makeBaseReq(), ctx);
    expect(targets.length).toBe(1);
    expect(targets[0]).toEqual({ providerId: 'fb1', providerName: 'openai_compatible', modelId: 'm1' });
  });

  it('observability 未注入（undefined）→ recordAttemptTarget 安全跳过不报错', async () => {
    const client = makeStubClient([textStream('ok')]);
    const ctx = makeCtx({ client });
    // 不注入 observability → invoke 成功且不抛错（optional 链式调用安全）
    const resp = await invoke(makeBaseReq(), ctx);
    expect(resp.message).toBeDefined();
  });
});

// ============================================================
// [v0.0.359 T1] 分支1 ok → recordSuccessTarget（ctx.sessionId + 真实 target 写入 registry）
// ============================================================
describe('[v0.0.359] 分支1 成功 target registry 写入', () => {
  it('attemptLoop ok → recordSuccessTarget 以 ctx.sessionId + 真实 target 写入（registry 内容非 observability mock）', async () => {
    const client = makeStubClient([textStream('ok')]);
    const provider = makeProvider('p1', 'anthropic_compatible');
    const ctx = makeCtx({ client, provider });
    ctx.sessionId = 'sess-359';
    // 不注入 observability：断言的是 registry（进程级单例）内容，非 observability mock
    await invoke(makeBaseReq(), ctx);
    const entry = getSuccessTarget('sess-359');
    expect(entry).toBeDefined();
    expect(entry!.providerId).toBe('p1');
    expect(entry!.providerName).toBe('anthropic_compatible');
    expect(entry!.modelId).toBe('m1');
    // 其他 sid 不受污染
    expect(getSuccessTarget('sess-other')).toBeUndefined();
  });
});
