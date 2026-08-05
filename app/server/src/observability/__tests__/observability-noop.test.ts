/**
 * Observability 单测 — NoopAdapter + mapUsageDetails。
 * 从 observability.test.ts 拆分而来（v0.0.10：原文件 345 行 > 300 硬规，按主题分文件）。
 *
 * 本文件覆盖：
 *   (a) NoopAdapter：零异常、零副作用；shutdown resolve。
 *   (b) mapUsageDetails：Usage → langfuse usageDetails/costDetails 互斥拆分映射（v0.0.61 防双计）。
 *
 * 参考: specs/tech/agent/observability/[P0]overall.md §6/§7
 *       specs/tech/agent/observability/[P0]langfuse_adapter.md §4/§5/§6
 */
import { describe, it, expect } from 'vitest';
import { NoopAdapter, noopAdapter, mapUsageDetails } from '../index';
import type { Usage } from '../../message/types';

/** trace metadata 工厂（NoopAdapter 不读内容，但 startTrace 入参需满足类型） */
function traceMeta(runId = 'r', sessionId = 's') {
  return { runId, sessionId, inputMessageIds: [] as string[], modelId: 'm', toolNames: [] as string[] };
}

/** step span metadata 工厂 */
function stepMeta(step = 1) {
  return { step, ingestUpTo: null, llmUpTo: null, newMessageCount: 0, hasToolCall: false };
}

// ============================================================
// (a) NoopAdapter
// ============================================================

describe('NoopAdapter — 零异常零副作用', () => {
  it('startTrace 返回固定 dummy TraceHandle', () => {
    const a = new NoopAdapter();
    const h = a.startTrace({ id: 'run-1', sessionId: 's1', metadata: traceMeta('run-1', 's1') });
    expect(h.kind).toBe('trace');
    expect(h.id).toBe('noop-trace');
  });

  it('所有方法都不抛错（核心红线：loop 默认路径不炸）', () => {
    const a = new NoopAdapter();
    const trace = a.startTrace({ id: 'r', sessionId: 's', metadata: traceMeta() });
    expect(() => a.endTrace(trace)).not.toThrow();
    const span = a.startSpan({ parent: trace, name: 'step 1', metadata: stepMeta() });
    expect(span.kind).toBe('span');
    expect(() => a.endSpan(span)).not.toThrow();
    const gen = a.startGeneration({ parent: span, model: 'm', input: {} as never });
    expect(gen.kind).toBe('gen');
    expect(() =>
      a.endGeneration({ gen, output: {} as never, usage: {}, metadata: {} as never }),
    ).not.toThrow();
  });

  it('shutdown() 立即 resolve（无 SDK 资源）', async () => {
    await expect(noopAdapter.shutdown()).resolves.toBeUndefined();
  });
});

// ============================================================
// (b) mapUsageDetails（v0.0.61 防双计：互斥拆分）
// ============================================================

describe('mapUsageDetails — Usage → langfuse usageDetails/costDetails（§6 防双计）', () => {
  it('有 cache 拆分字段 → 互斥拆分写 input/cache_read_input_tokens/cache_creation_input_tokens + output/output_reasoning_tokens', () => {
    const u: Usage = {
      input_cache_read: 1, input_cache_write: 2, input_no_cache: 3, input_total_tokens: 6,
      output_response: 4, output_reasoning: 5, output_total_tokens: 9, total_tokens: 15,
      cost: 0.5, inputCharCount: 100, outputCharCount: 50, currency: 'USD',
    };
    const m = mapUsageDetails(u);
    // 输入拆分（互斥防双计）：input = input_no_cache（不含 cache）；cache 单独写
    // cache key 用 langfuse Anthropic 原生 snake_case（对齐 langfuse-usage-protocol §二）
    expect(m.usageDetails.input).toBe(3);
    expect(m.usageDetails.cache_read_input_tokens).toBe(1);
    expect(m.usageDetails.cache_creation_input_tokens).toBe(2);
    // 输出拆分：output = output_response；reasoning 用 OpenAI flatten 名（§四.2）
    expect(m.usageDetails.output).toBe(4);
    expect(m.usageDetails.output_reasoning_tokens).toBe(5);
    // costDetails：保留应用定价权威（Usage.cost = LlmClient.computeCost）
    expect(m.costDetails.total).toBe(0.5);
    // 防双计：不再写 total / unit / metadata / charCount / currency
    expect(m.usageDetails['total']).toBeUndefined();
    expect(m.usageDetails['unit']).toBeUndefined();
    expect((m as { metadata?: unknown }).metadata).toBeUndefined();
  });

  it('缺省 token 字段 ({}) → input=0/output=0 + 空 costDetails（fallback 路径，不传 cache key）', () => {
    const m = mapUsageDetails({} as Usage);
    // 无拆分字段 → 走 fallback：input_total_tokens 缺省 → 0；output_total_tokens 缺省 → 0
    expect(m.usageDetails.input).toBe(0);
    expect(m.usageDetails.output).toBe(0);
    // fallback 路径不写 cache key（防双计：避免 langfuse UI 求和时 input + cacheRead 双计）
    expect(m.usageDetails['cache_read_input_tokens']).toBeUndefined();
    expect(m.usageDetails['cache_creation_input_tokens']).toBeUndefined();
    expect(m.usageDetails['output_reasoning_tokens']).toBeUndefined();
    // cost 缺省 → 空 costDetails（不写 total）
    expect(Object.keys(m.costDetails)).toHaveLength(0);
  });
});
