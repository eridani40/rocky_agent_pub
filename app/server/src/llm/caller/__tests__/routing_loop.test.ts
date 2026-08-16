/**
 * routing_loop — 模型路由候选决策主循环 UT
 * 参考: specs/tech/agent/providers_and_models/[P0]model_routing.md §5（attempt 内路由循环）
 *       specs/prd/model-routing-PRD-2026-08-14.md §2.5（①-⑥ 步骤）
 *
 * 覆盖（tech §5 伪代码逐条）：
 *   1. 时间过滤：本地小时 ∉ hours → skipped（候选全跳 → 「当前无可用模型」）
 *   2. enabled=false → skipped（同 ①）
 *   3. 熔断 Open → skipped + banned；下一个候选正常尝试
 *   4. banned 命中：前候选 abandoned 后同模型 item 跳过（去重键 providerId+modelId）
 *   5. 429（RATE_LIMITED）→ 0 次模型内重试，快速降级下一个候选（0 sleep）
 *   6. 网络错误（NETWORK）→ 1 次模型内重试后降级
 *   7. 401（AUTH_INVALID）→ directOpen + 降级；全部 AUTH 失败 → 上抛首个 AUTH 错误
 *   8. 全失败 → 「所有候选模型不可用」聚合错误（含失败摘要）
 *   9. 用户 abort → 直接返回（不算失败，不 recordFailure）
 *   10. 成功：首候选成功 → 返回 + recordSuccess + health recordSuccess
 *   11. 换模型降级 0 sleep（sleep spy 断言仅模型内重试调用）
 *
 * 测试方式：stub client.stream 抛 WireResponse 形状错误 → 走真实 attemptLoop + classify；
 * createCircuitBreakerRegistry() 隔离实例 + RoutingLoopOverrides 注入时钟/睡眠。
 * 单文件 ≤300 行。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routingAttemptLoop, type RoutingPlanInput } from '../routing_loop';
import type { InvokeContext } from '../llm_caller';
import { createLlmErrorState } from '../llm_error_state';
import { createProviderHealthRegistry } from '../provider_health_registry';
import { createCircuitBreakerRegistry } from '../circuit_breaker_registry';
// [v0.0.359 T1] 成功 target registry（ok 分支写入断言）
import { getSuccessTarget, __resetSuccessTargetRegistryForTest } from '../success-target-registry';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../../config/llm_request_config';
import { LlmErrorCategory } from '../error_types';
import type { LlmProviderConfig, LlmModelConfig } from '../../provider-types';
import type { LlmClient } from '../../client';
import type { StreamEvent } from '../../protocol';
import type { GenHandle } from '../../../observability/types';

// ── 测试辅助 ──

function makeProvider(id: string, modelId: string): LlmProviderConfig {
  const model: LlmModelConfig = {
    modelId, inputModalities: ['text'], outputModalities: ['text'],
    contextWindow: 200000, maxOutputTokens: 8192, paramConstraints: {},
    pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
    providerId: id,
    capabilities: { maxOutputTokens: 8192, supportsPrefill: false, supportsThinking: false },
  };
  return {
    id, name: 'anthropic_compatible' as const, protocolId: 'anthropic_messages' as const,
    baseUrl: `https://${id}.example.com`, credentials: { key: `sk-${id}` },
    pluginId: 'builtin.anthropic', enabled: true, models: [model],
  };
}

/** stub client：stream 抛 WireResponse 形状错误 或 产出成功流 */
function makeClient(behavior: 'ok' | { status: number; body?: unknown }): LlmClient {
  const streamFn = async function* (): AsyncGenerator<StreamEvent> {
    if (behavior === 'ok') {
      yield { type: 'text_delta', text: 'hi' };
      yield { type: 'usage', usage: { output_total_tokens: 3, input_total_tokens: 2 } as never };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    throw { status: behavior.status, body: behavior.body };
  };
  return { stream: streamFn } as unknown as LlmClient;
}

/** 捕获 client.stream 收到的 req.modelId，用于路由回退 wire body 一致性断言 */
function makeClientWithCapture(
  expectedModelId: string,
  seenModelIds: string[],
  behavior: 'ok' | { status: number; body?: unknown },
): LlmClient {
  const streamFn = async function* (req: { modelId: string }): AsyncGenerator<StreamEvent> {
    seenModelIds.push(req.modelId);
    expect(req.modelId).toBe(expectedModelId);
    if (behavior === 'ok') {
      yield { type: 'text_delta', text: 'hi' };
      yield { type: 'usage', usage: { output_total_tokens: 3, input_total_tokens: 2 } as never };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    throw { status: behavior.status, body: behavior.body };
  };
  return { stream: streamFn } as unknown as LlmClient;
}

/** 构造 routingAttemptLoop 最小 ctx + 依赖 */
function makeDeps(args: {
  providers: Array<LlmProviderConfig>;
  clients: Record<string, LlmClient>; // key = providerId|modelId
  circuit?: ReturnType<typeof createCircuitBreakerRegistry>;
  aborted?: boolean;
}) {
  const providers = new Map(args.providers.map((p) => [p.id, p]));
  const health = createProviderHealthRegistry();
  const ctx: InvokeContext = {
    errorState: createLlmErrorState(),
    sessionId: 's1',
    controller: { runId: 'r1', aborted: args.aborted ?? false },
    providers,
    clientFactory: {
      getClient: (provider: LlmProviderConfig, _kr: string, _kv: string, model: LlmModelConfig) =>
        args.clients[`${provider.id}|${model.modelId}`] ?? makeClient('ok'),
    },
    config: {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, backoff_base_s: 0, backoff_cap_s: 0, jitter: false },
    },
    health,
    circuitRegistry: args.circuit ?? createCircuitBreakerRegistry(),
  };
  const sleep = vi.fn(async () => {});
  const physicalGens: GenHandle[] = [];
  const obsState = { observabilityEnded: false };
  const plan: RoutingPlanInput = {
    planId: 'plan-1',
    items: args.providers.map((p, i) => ({
      providerId: p.id, modelId: p.models[0]!.modelId, priority: i + 1, enabled: true,
    })),
    circuit: {},
  };
  return { ctx, sleep, physicalGens, obsState, plan };
}

function makeBaseReq() {
  return {
    modelId: 'm1',
    messages: [{ id: 'u1', role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
    params: { stream: true, maxTokens: 1024 },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  __resetSuccessTargetRegistryForTest();
});

describe('[routing_loop] 候选决策主循环', () => {
  it('时间过滤：当前小时 ∉ hours → 候选全跳过 → 「当前无可用模型」', async () => {
    const p1 = makeProvider('p1', 'm1');
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1], clients: { 'p1|m1': makeClient('ok') },
    });
    plan.items[0]!.timeCondition = { hours: [9] }; // 当前 localHour=10 ∉ [9]
    await expect(
      routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, { localHour: () => 10, sleep }),
    ).rejects.toThrow('当前无可用模型');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('enabled=false → skipped（不尝试）→ 「当前无可用模型」', async () => {
    const p1 = makeProvider('p1', 'm1');
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1], clients: { 'p1|m1': makeClient('ok') },
    });
    plan.items[0]!.enabled = false;
    await expect(
      routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, { localHour: () => 10, sleep }),
    ).rejects.toThrow('当前无可用模型');
  });

  it('熔断 Open → skipped + banned；下一个候选正常尝试成功', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const circuit = createCircuitBreakerRegistry();
    // 预熔断 p1（连续 4 失败 → Open）
    for (let i = 0; i < 4; i++) circuit.recordFailure('plan-1', 'p1', 'm1');
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: { 'p1|m1': makeClient('ok'), 'p2|m2': makeClient('ok') },
      circuit,
    });
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    expect(sleep).not.toHaveBeenCalled();
  });

  it('429（RATE_LIMITED）→ 0 次模型内重试，快速降级下一个候选成功（0 sleep）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: { 'p1|m1': makeClient({ status: 429, body: { error: { type: 'rate_limit_error', message: 'rate limited' } } }), 'p2|m2': makeClient('ok') },
    });
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    expect(sleep).not.toHaveBeenCalled(); // 429 0 次重试 + 换模型 0 sleep
  });

  it('路由回退：首候选失败后切到次候选，client.stream 收到的 req.modelId 跟随次候选（wire body 一致性，T4）', async () => {
    const p1 = makeProvider('p1', 'MiniMax-M3');
    const p2 = makeProvider('p2', 'deepseek-chat');
    const seenModelIds: string[] = [];
    const capture = (modelId: string) => makeClientWithCapture(modelId, seenModelIds, { status: 429, body: { error: { type: 'rate_limit_error', message: 'rate limited' } } });
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: {
        'p1|MiniMax-M3': capture('MiniMax-M3'),
        'p2|deepseek-chat': makeClientWithCapture('deepseek-chat', seenModelIds, 'ok'),
      },
    });
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    // baseReq.modelId='m1'；首候选 429 快速降级；次候选收到 deepseek-chat
    expect(seenModelIds).toEqual(['MiniMax-M3', 'deepseek-chat']);
  });

  it('网络错误（NETWORK）→ 1 次模型内重试（有 sleep）后降级下一个候选', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: { 'p1|m1': makeClient({ status: 0 } as never), 'p2|m2': makeClient('ok') },
    });
    // status=0 的 WireResponse → 非 HTTP 分类 → 走 fetch throw → NETWORK（尝试 2 次）
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    expect(sleep).toHaveBeenCalledTimes(1); // 模型内 1 次重试退避
  });

  it('401（AUTH_INVALID）→ directOpen + 降级；全部候选 AUTH 失败 → 上抛首个 AUTH 错误', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const circuit = createCircuitBreakerRegistry();
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: {
        'p1|m1': makeClient({ status: 401, body: { error: { type: 'authentication_error', message: 'invalid key' } } }),
        'p2|m2': makeClient({ status: 403, body: { error: { type: 'permission_error', message: 'forbidden' } } }),
      },
      circuit,
    });
    await expect(
      routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, { localHour: () => 10, sleep }),
    ).rejects.toMatchObject({ category: LlmErrorCategory.AUTH_INVALID });
    // AUTH directOpen：两个候选都 Open
    expect(circuit.getState('plan-1', 'p1', 'm1')).toBe('open');
    expect(circuit.getState('plan-1', 'p2', 'm2')).toBe('open');
  });

  it('全失败（非 AUTH）→ 「所有候选模型不可用」聚合错误（含失败摘要）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: {
        'p1|m1': makeClient({ status: 500, body: { error: { type: 'server_error', message: 'boom' } } }),
        'p2|m2': makeClient({ status: 503, body: { error: { type: 'server_error', message: 'unavailable' } } }),
      },
    });
    const err = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    }).then(() => null, (e: Error) => e);
    expect(err!.message).toContain('所有候选模型不可用');
    expect(err!.message).toContain('p1/m1');
    expect(err!.message).toContain('p2/m2');
  });

  it('用户 abort → 直接返回（不算失败，不 recordFailure 不 banned）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const circuit = createCircuitBreakerRegistry();
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1],
      clients: { 'p1|m1': makeClient({ status: 500 } as never) },
      circuit,
      aborted: true,
    });
    await expect(
      routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, { localHour: () => 10, sleep }),
    ).rejects.toMatchObject({ category: LlmErrorCategory.ABORTED_BY_USER });
    // abort 不算失败：熔断不 recordFailure（仍 closed）
    expect(circuit.getState('plan-1', 'p1', 'm1')).toBe('closed');
  });

  it('成功：recordSuccess + health recordSuccess（熔断 closed 保持）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const circuit = createCircuitBreakerRegistry();
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1], clients: { 'p1|m1': makeClient('ok') }, circuit,
    });
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    // recordSuccess 后快照含 1 条成功记录
    const snap = circuit.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ planId: 'plan-1', providerId: 'p1', modelId: 'm1', state: 'closed' });
  });

  it('换模型降级 0 sleep（可复现）：失败候选模型内 0 重试 + 换模型无 sleep', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const p3 = makeProvider('p3', 'm3');
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2, p3],
      clients: {
        'p1|m1': makeClient({ status: 429, body: { error: { type: 'rate_limit_error', message: 'rl' } } }),
        'p2|m2': makeClient({ status: 429, body: { error: { type: 'rate_limit_error', message: 'rl' } } }),
        'p3|m3': makeClient('ok'),
      },
    });
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    expect(sleep).not.toHaveBeenCalled(); // 429 无重试 + 换模型 0 sleep
  });

  it('方案级 circuit 覆盖（failureThreshold=2）在 routing 时序中生效（getState/tryAcquirePermit 传 cfg）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const circuit = createCircuitBreakerRegistry();
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: {
        'p1|m1': makeClient({ status: 500, body: { error: { type: 'server_error', message: 'boom' } } }),
        'p2|m2': makeClient('ok'),
      },
      circuit,
    });
    plan.circuit = { failureThreshold: 2 }; // 方案级覆盖：2 次失败即 Open（默认 4）
    // 第 1 次 call：p1 失败 1 次（closed，1 < 2）→ p2 成功
    const resp1 = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp1.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    expect(circuit.getState('plan-1', 'p1', 'm1')).toBe('closed');
    // 第 2 次 call：p1 再失败 1 次 → 累计 2 次 ≥ failureThreshold=2 → Open（banned）→ p2 成功
    const resp2 = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp2.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    expect(circuit.getState('plan-1', 'p1', 'm1')).toBe('open');
  });
});

// ============================================================
// [v0.0.353 T2] 分支2 recordAttemptTarget（调用谁记录谁）
// ============================================================
describe('[v0.0.353 T2] 分支2 recordAttemptTarget', () => {
  it('每次候选 target 确定后 recordAttemptTarget 带真实 provider/model（首个候选成功只报 1 次）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const targets: Array<{ providerId: string; providerName: string; modelId: string }> = [];
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: { 'p1|m1': makeClient('ok'), 'p2|m2': makeClient('ok') },
    });
    ctx.observability = { recordAttemptTarget: (t) => targets.push(t) };
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    // 首候选成功：只上报 p1|m1 一次（providerName = provider.name 接入方标识）
    expect(targets).toEqual([{ providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'm1' }]);
  });

  it('首候选失败降级次候选：每次候选确定各报一次（p1 失败 → p2 成功）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const targets: Array<{ providerId: string; providerName: string; modelId: string }> = [];
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: {
        'p1|m1': makeClient({ status: 500, body: { error: { type: 'server_error', message: 'boom' } } }),
        'p2|m2': makeClient('ok'),
      },
    });
    ctx.observability = { recordAttemptTarget: (t) => targets.push(t) };
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    // p1 失败（模型内 1 次重试同 target 不重复报）→ 降级 p2 再报一次
    expect(targets).toEqual([
      { providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'm1' },
      { providerId: 'p2', providerName: 'anthropic_compatible', modelId: 'm2' },
    ]);
  });

  it('observability 未注入 → 安全跳过不报错', async () => {
    const p1 = makeProvider('p1', 'm1');
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1],
      clients: { 'p1|m1': makeClient('ok') },
    });
    // 不注入 observability → 正常成功（optional 链式调用安全）
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
  });
});

// ============================================================
// [v0.0.353 T5 D9] recordSkippedCandidate（被跳过候选逐条记录）
// ============================================================
describe('[v0.0.353 T5 D9] recordSkippedCandidate', () => {
  it('时间窗 skip → port 收到 time_window reason（providerName 带接入方标识）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const skipped: Array<{ providerId: string; providerName?: string; modelId: string; reason: string }> = [];
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1], clients: { 'p1|m1': makeClient('ok') },
    });
    ctx.observability = { recordSkippedCandidate: (c) => skipped.push(c) };
    plan.items[0]!.timeCondition = { hours: [9] }; // 当前 localHour=10 ∉ [9]
    await expect(
      routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, { localHour: () => 10, sleep }),
    ).rejects.toThrow('当前无可用模型');
    expect(skipped).toEqual([
      { providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'm1', reason: 'time_window' },
    ]);
  });

  it('enabled=false skip → port 收到 disabled reason', async () => {
    const p1 = makeProvider('p1', 'm1');
    const skipped: Array<{ providerId: string; modelId: string; reason: string }> = [];
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1], clients: { 'p1|m1': makeClient('ok') },
    });
    ctx.observability = { recordSkippedCandidate: (c) => skipped.push(c) };
    plan.items[0]!.enabled = false;
    await expect(
      routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, { localHour: () => 10, sleep }),
    ).rejects.toThrow('当前无可用模型');
    expect(skipped).toEqual([
      { providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'm1', reason: 'disabled' },
    ]);
  });

  it('熔断 Open skip → port 收到 circuit_open reason + 次候选正常尝试', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const skipped: Array<{ providerId: string; modelId: string; reason: string }> = [];
    const circuit = createCircuitBreakerRegistry();
    for (let i = 0; i < 4; i++) circuit.recordFailure('plan-1', 'p1', 'm1');
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: { 'p1|m1': makeClient('ok'), 'p2|m2': makeClient('ok') },
      circuit,
    });
    ctx.observability = { recordSkippedCandidate: (c) => skipped.push(c) };
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    expect(skipped).toEqual([
      { providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'm1', reason: 'circuit_open' },
    ]);
  });

  it('resolve 失败（provider 缺失）→ port 收到 resolve_failed reason（无 providerName）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const skipped: Array<{ providerId: string; providerName?: string; modelId: string; reason: string }> = [];
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1], // 只注册 p1；plan 含 p2（provider 缺失）
      clients: { 'p1|m1': makeClient('ok') },
    });
    // plan.items 手动加 p2（provider 未注册 → resolve 失败）；priority 0 确保 p2 先被处理
    plan.items.push({ providerId: 'p2', modelId: 'm2', priority: 0, enabled: true });
    ctx.observability = { recordSkippedCandidate: (c) => skipped.push(c) };
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    // p2 无 provider → resolve_failed 且 providerName 省略；p1 正常尝试成功
    expect(skipped).toEqual([
      { providerId: 'p2', modelId: 'm2', reason: 'resolve_failed' },
    ]);
  });

  it('bannedModels 命中 skip → port 收到 banned reason（同 provider+model 重复条目场景）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const skipped: Array<{ providerId: string; modelId: string; reason: string }> = [];
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: {
        'p1|m1': makeClient({ status: 429, body: { error: { type: 'rate_limit_error', message: 'rate limited' } } }),
        'p2|m2': makeClient('ok'),
      },
    });
    ctx.observability = { recordSkippedCandidate: (c) => skipped.push(c) };
    // 重复 p1|m1：第一个尝试失败（429 0 重试）后被加入 bannedModels；第二个命中 banned 分支
    plan.items.push({ providerId: 'p1', modelId: 'm1', priority: 1, enabled: true });
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    expect(skipped).toEqual([
      { providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'm1', reason: 'banned' },
    ]);
  });

  it('half-open 已有探测在途 → port 收到 probe_inflight reason（限流 skip）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const skipped: Array<{ providerId: string; modelId: string; reason: string }> = [];
    const circuit = createCircuitBreakerRegistry();
    for (let i = 0; i < 4; i++) circuit.recordFailure('plan-1', 'p1', 'm1');
    // 直接模拟 half-open 且已有探测在途：routing_loop 调 tryAcquirePermit 会触发 probe_inflight
    // 通过内部 entries 将 state 改 half_open / probing=true（timeout 未到期时 getState 仍报 open，不影响 routing_loop）
    (circuit as any).entries.get('plan-1|p1|m1').state = 'half_open';
    (circuit as any).entries.get('plan-1|p1|m1').probing = true;
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: { 'p1|m1': makeClient('ok'), 'p2|m2': makeClient('ok') },
      circuit,
    });
    ctx.observability = { recordSkippedCandidate: (c) => skipped.push(c) };
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    expect(skipped).toEqual([
      { providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'm1', reason: 'probe_inflight' },
    ]);
  });

  it('recordSkippedCandidate 抛错 → 路由主流程不受影响（safe）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1], clients: { 'p1|m1': makeClient('ok') },
    });
    ctx.observability = {
      recordSkippedCandidate: () => { throw new Error('observability boom'); },
    };
    plan.items[0]!.timeCondition = { hours: [9] }; // 触发 skip 分支 → recordSkippedCandidate 抛错
    await expect(
      routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, { localHour: () => 10, sleep }),
    ).rejects.toThrow('当前无可用模型'); // 路由语义不变（仍跳过 → 无可用模型）
  });
});

// ============================================================
// [v0.0.359 T1] 候选链 ok → recordSuccessTarget（成功那一下的候选 target 写入 registry）
// ============================================================
describe('[v0.0.359] 候选链成功 target registry 写入', () => {
  it('候选链 ok → 该候选 target 写入 registry（registry 内容非 observability mock）', async () => {
    const p1 = makeProvider('p1', 'm1');
    const p2 = makeProvider('p2', 'm2');
    const { ctx, sleep, physicalGens, obsState, plan } = makeDeps({
      providers: [p1, p2],
      clients: {
        // 首候选失败 → 降级次候选成功：registry 应记次候选（成功那一下）
        'p1|m1': makeClient({ status: 500, body: { error: { type: 'server_error', message: 'boom' } } }),
        'p2|m2': makeClient('ok'),
      },
    });
    // makeDeps 的 ctx 已带 sessionId 's1'；不注入 observability：断言 registry 内容非 observability mock
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      localHour: () => 10, sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    const entry = getSuccessTarget('s1');
    expect(entry).toBeDefined();
    expect(entry!.providerId).toBe('p2'); // 失败候选 p1 不写，成功那一下 = p2
    expect(entry!.providerName).toBe('anthropic_compatible');
    expect(entry!.modelId).toBe('m2');
  });
});
