/**
 * routing_loop 时区调度 UT（v0.0.353 T1）
 * 参考: specs/tech/version_logs/v0.0.353/model-routing-trace-correctness/change_plan.md D1/D2
 *       specs/tech/agent/providers_and_models/[P0]model_routing.md §5 ① 时间过滤
 *
 * 覆盖：
 *   1. getHourInTimezone：原生 Intl 跨时区取小时（同一时刻 Asia/Shanghai vs UTC 相差 8）
 *   2. timezoneNow 注入：条目带 timezone 时按该时区小时过滤（跨时区过滤生效）
 *   3. timezone 缺省：按 DEFAULT_ROUTING_TIMEZONE（Asia/Shanghai）解析
 *   4. localHour 兼容兜底：无 timezoneNow 时 localHour 仍生效（deprecated 但不破坏旧 UT/行为）
 *   5. 条件时区不同 → 各自独立过滤
 */
import { describe, it, expect, vi } from 'vitest';
import { routingAttemptLoop, getHourInTimezone, type RoutingPlanInput } from '../routing_loop';
import type { InvokeContext } from '../llm_caller';
import { createLlmErrorState } from '../llm_error_state';
import { createProviderHealthRegistry } from '../provider_health_registry';
import { createCircuitBreakerRegistry } from '../circuit_breaker_registry';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../../config/llm_request_config';
import type { LlmProviderConfig, LlmModelConfig } from '../../provider-types';
import type { LlmClient } from '../../client';
import type { StreamEvent } from '../../protocol';
import type { GenHandle } from '../../../observability/types';

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

function makeOkClient(): LlmClient {
  const streamFn = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'text_delta', text: 'hi' };
    yield { type: 'usage', usage: { output_total_tokens: 3, input_total_tokens: 2 } as never };
    yield { type: 'finish', reason: 'stop' };
  };
  return { stream: streamFn } as unknown as LlmClient;
}

function makeCtx(providers: LlmProviderConfig[]): {
  ctx: InvokeContext; sleep: ReturnType<typeof vi.fn>;
  physicalGens: GenHandle[]; obsState: { observabilityEnded: boolean };
  plan: RoutingPlanInput;
} {
  const health = createProviderHealthRegistry();
  const ctx: InvokeContext = {
    errorState: createLlmErrorState(),
    sessionId: 's1',
    controller: { runId: 'r1', aborted: false },
    providers: new Map(providers.map((p) => [p.id, p])),
    clientFactory: { getClient: () => makeOkClient() },
    config: {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      retry: { ...DEFAULT_LLM_REQUEST_CONFIG.retry, backoff_base_s: 0, backoff_cap_s: 0, jitter: false },
    },
    health,
    circuitRegistry: createCircuitBreakerRegistry(),
  };
  const plan: RoutingPlanInput = {
    planId: 'plan-tz',
    items: providers.map((p, i) => ({
      providerId: p.id, modelId: p.models[0]!.modelId, priority: i + 1, enabled: true,
    })),
    circuit: {},
  };
  return { ctx, sleep: vi.fn(async () => {}), physicalGens: [], obsState: { observabilityEnded: false }, plan };
}

function makeBaseReq() {
  return {
    modelId: 'm1',
    messages: [{ id: 'u1', role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
    params: { stream: true, maxTokens: 1024 },
  };
}

describe('[v0.0.353 T1] getHourInTimezone（原生 Intl）', () => {
  it('同一时刻跨时区小时差 8（Asia/Shanghai=10 ↔ UTC=2）', () => {
    // 2026-08-15T02:00:00Z → Asia/Shanghai 10 点 / UTC 2 点
    const t = Date.UTC(2026, 7, 15, 2, 0, 0);
    expect(getHourInTimezone('Asia/Shanghai', t)).toBe(10);
    expect(getHourInTimezone('UTC', t)).toBe(2);
  });

  it('UTC+0 边界：UTC 16 点 ↔ America/New_York 12 点（EDT）', () => {
    const t = Date.UTC(2026, 7, 15, 16, 0, 0);
    expect(getHourInTimezone('UTC', t)).toBe(16);
    expect(getHourInTimezone('America/New_York', t)).toBe(12);
  });
});

describe('[v0.0.353 T1] 时间过滤按条目 timezone 生效', () => {
  it('timezoneNow 注入：UTC 时区 hours=[2] 命中（北京时间 10 点但 UTC 2 点）→ 尝试成功', async () => {
    const { ctx, sleep, physicalGens, obsState, plan } = makeCtx([makeProvider('p1', 'm1')]);
    plan.items[0]!.timeCondition = { hours: [2], timezone: 'UTC' };
    const timezoneNow = vi.fn((tz: string) => (tz === 'UTC' ? 2 : 10));
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, { timezoneNow, sleep });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    expect(timezoneNow).toHaveBeenCalledWith('UTC');
  });

  it('跨时区过滤：hours=[9]（Asia/Shanghai 语义）但条目 timezone=UTC 且 UTC=2 → 全跳过「当前无可用模型」', async () => {
    const { ctx, sleep, physicalGens, obsState, plan } = makeCtx([makeProvider('p1', 'm1')]);
    plan.items[0]!.timeCondition = { hours: [9], timezone: 'UTC' };
    await expect(
      routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
        timezoneNow: (tz) => (tz === 'UTC' ? 2 : 10), sleep,
      }),
    ).rejects.toThrow('当前无可用模型');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('timezone 缺省：按 Asia/Shanghai 解析（timezoneNow 收到缺省时区且小时命中）', async () => {
    const { ctx, sleep, physicalGens, obsState, plan } = makeCtx([makeProvider('p1', 'm1')]);
    plan.items[0]!.timeCondition = { hours: [10] }; // 无 timezone → 缺省 Asia/Shanghai
    const timezoneNow = vi.fn(() => 10);
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, { timezoneNow, sleep });
    expect(timezoneNow).toHaveBeenCalledWith('Asia/Shanghai');
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
  });

  it('不同条目不同时区 → 各自独立过滤（UTC 条目跳过、Asia/Shanghai 条目命中）', async () => {
    const { ctx, sleep, physicalGens, obsState, plan } = makeCtx([makeProvider('p1', 'm1'), makeProvider('p2', 'm2')]);
    plan.items[0]!.timeCondition = { hours: [9], timezone: 'UTC' };     // UTC=2 ∉ [9] → skip
    plan.items[1]!.timeCondition = { hours: [10] };                    // 缺省 Asia/Shanghai=10 ∈ [10] → hit
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, {
      timezoneNow: (tz) => (tz === 'UTC' ? 2 : 10), sleep,
    });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
  });

  it('localHour 兼容兜底：无 timezoneNow 时 localHour() 生效（旧行为零回归）', async () => {
    const { ctx, sleep, physicalGens, obsState, plan } = makeCtx([makeProvider('p1', 'm1')]);
    plan.items[0]!.timeCondition = { hours: [9], timezone: 'UTC' };
    // localHour=9 → 命中 [9]（兼容口径：localHour 对所有时区同值）
    const resp = await routingAttemptLoop(makeBaseReq(), plan, ctx, physicalGens, obsState, { localHour: () => 9, sleep });
    expect(resp.message.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', text: 'hi' }),
    ]));
    // localHour=10 ∉ [9] → 跳过
    const { ctx: c2, sleep: s2, physicalGens: g2, obsState: o2, plan: p2 } = makeCtx([makeProvider('p1', 'm1')]);
    p2.items[0]!.timeCondition = { hours: [9], timezone: 'UTC' };
    await expect(
      routingAttemptLoop(makeBaseReq(), p2, c2, g2, o2, { localHour: () => 10, sleep: s2 }),
    ).rejects.toThrow('当前无可用模型');
  });
});
