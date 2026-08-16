/**
 * LangfuseObservabilityPort 单测 — v0.0.353 T2 recordAttemptTarget（调用谁记录谁）。
 * 参考: specs/tech/version_logs/v0.0.353/model-routing-trace-correctness/change_plan.md D4/D6
 *
 * 覆盖：
 *   - recordAttemptTarget 后 startPhysicalGeneration：adapter.startGeneration 收到真实 modelId
 *     （替代 opts.model）+ providerId/providerName（metadata 由 adapter 落盘）
 *   - 未 recordAttemptTarget → model 回退 opts.model（向后兼容，旧调用点零改动）
 *   - endPhysicalGeneration metadata 带真实 provider/model
 *   - logical（endGenerationOk）不填真实 provider（A1 治理：真实信息下沉 physical 子 span）
 *
 * 测试方式：mock ObservabilityAdapter（不真调 langfuse SDK），只验证 port 层翻译。
 */
import { describe, it, expect, vi } from 'vitest';
import { createLangfuseObservabilityPort } from '../langfuse_observability_port';
import type { ObservabilityAdapter, GenHandle } from '../../../observability/adapter';
import type { GenStart, GenEnd } from '../../../observability/types';

/** mock adapter：捕获 startGeneration/endGeneration 入参 */
function makeMockAdapter(): {
  adapter: ObservabilityAdapter;
  starts: GenStart[];
  ends: GenEnd[];
} {
  const starts: GenStart[] = [];
  const ends: GenEnd[] = [];
  const adapter = {
    startTrace: vi.fn(),
    endTrace: vi.fn(),
    startSpan: vi.fn(),
    endSpan: vi.fn(),
    startGeneration: vi.fn((p: GenStart) => {
      starts.push(p);
      return { kind: 'gen', id: `g${starts.length}`, parent: p.parent } as GenHandle;
    }),
    endGeneration: vi.fn((p: GenEnd) => ends.push(p)),
    shutdown: vi.fn(async () => {}),
  } as unknown as ObservabilityAdapter;
  return { adapter, starts, ends };
}

const genHandle: GenHandle = {
  kind: 'gen',
  id: 'g0',
  parent: { kind: 'span', id: 's1', parent: { kind: 'trace', id: 't1' } },
};

describe('[v0.0.353 T2] LangfuseObservabilityPort recordAttemptTarget', () => {
  it('recordAttemptTarget 后 startPhysicalGeneration → adapter 收到真实 modelId + providerId/providerName', () => {
    const { adapter, starts } = makeMockAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle, iteration: 1, step: 1, model: 'config-model',
    });
    // 调用方（llm_caller/routing_loop）target 确定后上报真实 target
    port.recordAttemptTarget?.({ providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'real-m1' });
    port.startPhysicalGeneration?.({ wire: 1 }, new Date());
    expect(starts).toHaveLength(1);
    const s = starts[0]!;
    // model = 真实 target modelId（替代 opts.model=config-model）
    expect(s.model).toBe('real-m1');
    expect(s.providerId).toBe('p1');
    expect(s.providerName).toBe('anthropic_compatible');
    expect(s.kind).toBe('physical');
  });

  it('未 recordAttemptTarget → startPhysicalGeneration model 回退 opts.model（旧调用点零改动）', () => {
    const { adapter, starts } = makeMockAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle, iteration: 1, step: 1, model: 'config-model',
    });
    port.startPhysicalGeneration?.({ wire: 1 }, new Date());
    expect(starts).toHaveLength(1);
    expect(starts[0]!.model).toBe('config-model');
    expect(starts[0]!.providerId).toBeUndefined();
    expect(starts[0]!.providerName).toBeUndefined();
  });

  it('endPhysicalGeneration → metadata 含真实 provider/model', () => {
    const { adapter, ends } = makeMockAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle, iteration: 1, step: 1, model: 'config-model',
    });
    port.recordAttemptTarget?.({ providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'real-m1' });
    const h = port.startPhysicalGeneration?.({ wire: 1 }, new Date());
    port.endPhysicalGeneration?.(h!, new Date());
    expect(ends).toHaveLength(1);
    const meta = ends[0]!.metadata as { providerId?: string; providerName?: string; modelId?: string };
    expect(meta.providerId).toBe('p1');
    expect(meta.providerName).toBe('anthropic_compatible');
    expect(meta.modelId).toBe('real-m1');
  });

  it('logical（endGenerationOk）不填真实 provider（A1：真实信息下沉 physical 子 span）', () => {
    const { adapter, ends } = makeMockAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle, iteration: 1, step: 1, model: 'config-model',
    });
    // 即便已 recordAttemptTarget，logical end 也不带 provider（A1 治理，D5）
    port.recordAttemptTarget?.({ providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'real-m1' });
    port.endGenerationOk?.({ id: 'a1', role: 'assistant', content: [] } as never, null);
    expect(ends).toHaveLength(1);
    const meta = ends[0]!.metadata as unknown as Record<string, unknown>;
    // [v0.0.353 T3 A1] 显式置 null（非 undefined）+ logicalView: true 标识业务视图
    expect(meta.providerId).toBe(null);
    expect(meta.providerName).toBe(null);
    expect(meta.logicalView).toBe(true);
    // 真实 provider 信息只在 physical 子 span（见上 endPhysicalGeneration 用例）
    expect(meta.modelId).toBeUndefined();
  });
});

// ============================================================
// [v0.0.353 T5 D8/D9] routingPlan 透传 + recordSkippedCandidate
// ============================================================
describe('[v0.0.353 T5] LangfuseObservabilityPort routingPlan + recordSkippedCandidate', () => {
  it('D8: opts.routingPlan 传入 → buildMetadata（logical end）对称携带 routingPlan', () => {
    const { adapter, ends } = makeMockAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle, iteration: 1, step: 1, model: 'config-model',
      routingPlan: { planId: 'plan-1', planName: '主方案' },
    });
    port.endGenerationOk?.({ id: 'a1', role: 'assistant', content: [] } as never, null);
    expect(ends).toHaveLength(1);
    const meta = ends[0]!.metadata as unknown as Record<string, unknown>;
    expect(meta.routingPlan).toEqual({ planId: 'plan-1', planName: '主方案' });
  });

  it('D8: 无 routingPlan → buildMetadata 不含该字段（零行为变化）', () => {
    const { adapter, ends } = makeMockAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle, iteration: 1, step: 1, model: 'config-model',
    });
    port.endGenerationOk?.({ id: 'a1', role: 'assistant', content: [] } as never, null);
    expect(ends).toHaveLength(1);
    const meta = ends[0]!.metadata as unknown as Record<string, unknown>;
    expect(meta.routingPlan).toBeUndefined();
  });

  it('D9: recordSkippedCandidate → 成对 gen（name=llm-N-skip-M + 立即 end + metadata.skipped/reason）', () => {
    const { adapter, starts, ends } = makeMockAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle, iteration: 3, step: 1, model: 'config-model',
    });
    port.recordSkippedCandidate?.({
      providerId: 'p1', providerName: 'anthropic_compatible', modelId: 'm1', reason: 'time_window',
    });
    port.recordSkippedCandidate?.({
      providerId: 'p2', providerName: 'anthropic_compatible', modelId: 'm2', reason: 'circuit_open',
    });
    // 成对 gen：2 条 start + 2 条 end
    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    // name 与 physical 同 N 前缀成组（llm-3-skip-1 / llm-3-skip-2）
    expect(starts[0]!.name).toBe('llm-3-skip-1');
    expect(starts[1]!.name).toBe('llm-3-skip-2');
    expect(starts[0]!.kind).toBe('physical');
    // model = 被跳候选 modelId（非 opts.model）
    expect(starts[0]!.model).toBe('m1');
    expect(starts[1]!.model).toBe('m2');
    // providerId/providerName 透传（adapter 写 metadata）
    expect(starts[0]!.providerId).toBe('p1');
    expect(starts[0]!.providerName).toBe('anthropic_compatible');
    // start metadata：skipped=true + reason
    expect(starts[0]!.metadata).toMatchObject({ skipped: true, reason: 'time_window', providerId: 'p1' });
    expect(starts[1]!.metadata).toMatchObject({ skipped: true, reason: 'circuit_open', providerId: 'p2' });
    // end metadata：skipped=true + skipReason + provider/model
    const endMeta0 = ends[0]!.metadata as unknown as Record<string, unknown>;
    expect(endMeta0).toMatchObject({
      skipped: true, skipReason: 'time_window', providerId: 'p1', modelId: 'm1',
    });
    const endMeta1 = ends[1]!.metadata as unknown as Record<string, unknown>;
    expect(endMeta1).toMatchObject({
      skipped: true, skipReason: 'circuit_open', providerId: 'p2', modelId: 'm2',
    });
  });

  it('D9: recordSkippedCandidate 与 physical 同 parent（= logical genHandle.parent）', () => {
    const { adapter, starts } = makeMockAdapter();
    const port = createLangfuseObservabilityPort({
      adapter, genHandle, iteration: 1, step: 1, model: 'config-model',
    });
    port.recordSkippedCandidate?.({
      providerId: 'p1', modelId: 'm1', reason: 'disabled',
    });
    expect(starts).toHaveLength(1);
    // skipped gen 与 physical 同 parent（logical genHandle.parent = step span s1）
    expect(starts[0]!.parent).toEqual(genHandle.parent);
  });

  it('D9: adapter.startGeneration 抛错 → safe 吞（recordSkippedCandidate 不冒泡）', () => {
    const adapter = {
      startGeneration: vi.fn(() => { throw new Error('adapter boom'); }),
      endGeneration: vi.fn(),
    } as unknown as ObservabilityAdapter;
    const port = createLangfuseObservabilityPort({
      adapter, genHandle, iteration: 1, step: 1, model: 'config-model',
    });
    // 不应抛出
    expect(() =>
      port.recordSkippedCandidate?.({ providerId: 'p1', modelId: 'm1', reason: 'banned' }),
    ).not.toThrow();
  });
});
