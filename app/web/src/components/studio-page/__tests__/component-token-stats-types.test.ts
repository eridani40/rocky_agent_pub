/**
 * @vitest-environment jsdom
 * component-token-stats-types 单测 —— breakdown 派生 + valueByKind 口径
 * 参考: specs/ui/components/studio-page/component-token-stats.md §口径
 *       specs/api/overall/11c-token-stats.md §3（API 返回字段）
 *
 * 覆盖 T2 UT 范围（test-plan §新 UT）：
 *   - API point → 视图 breakdown（三段合并）派生
 *   - 序列化渲染（pointToBreakdown 正确映射字段）
 *   - valueByKind 按 kind 切换值（含 cacheRate 比率口径）
 */
import { describe, it, expect } from 'vitest';
import {
  pointToBreakdown,
  totalOf,
  valueByKind,
  type TokenUsageStatPoint,
} from '../component-token-stats-types';

/** 构造一个 mock API point */
function mkPoint(over: Partial<TokenUsageStatPoint> = {}): TokenUsageStatPoint {
  return {
    bucket: '2026-07-05',
    input_no_cache: 100,
    cache_read: 50,
    cache_creation: 20,
    output_response: 80,
    output_reasoning: 40,
    cost: 0.01,
    llmCallCount: 1,
    total: 290,
    cacheRate: 50 / 150,
    ...over,
  };
}

describe('pointToBreakdown —— API point → 视图 breakdown（三段合并）', () => {
  it('input = input_no_cache', () => {
    const b = pointToBreakdown(mkPoint({ input_no_cache: 200 }));
    expect(b.input).toBe(200);
  });

  it('output = output_response + output_reasoning', () => {
    const b = pointToBreakdown(mkPoint({ output_response: 80, output_reasoning: 40 }));
    expect(b.output).toBe(120);
  });

  it('cache = cache_read + cache_creation', () => {
    const b = pointToBreakdown(mkPoint({ cache_read: 50, cache_creation: 20 }));
    expect(b.cache).toBe(70);
  });

  it('序列化渲染：全字段映射正确（API 6 字段 → 视图 3 字段）', () => {
    const b = pointToBreakdown(mkPoint({
      input_no_cache: 1000,
      cache_read: 500,
      cache_creation: 200,
      output_response: 800,
      output_reasoning: 400,
    }));
    expect(b).toEqual({ input: 1000, output: 1200, cache: 700 });
  });
});

describe('totalOf —— 三段求和', () => {
  it('0+0+0 = 0', () => {
    expect(totalOf({ input: 0, output: 0, cache: 0 })).toBe(0);
  });

  it('三段之和', () => {
    expect(totalOf({ input: 100, output: 200, cache: 50 })).toBe(350);
  });
});

describe('valueByKind —— 按 KindFilter 取值', () => {
  const b = { input: 1000, output: 2000, cache: 500 };

  it('total = 三段和', () => {
    expect(valueByKind(b, 'total')).toBe(3500);
  });

  it('input/output/cache 单段', () => {
    expect(valueByKind(b, 'input')).toBe(1000);
    expect(valueByKind(b, 'output')).toBe(2000);
    expect(valueByKind(b, 'cache')).toBe(500);
  });

  it('cacheRate = cache/(cache+input)，不含 output', () => {
    // 500 / (500 + 1000) = 500/1500 = 0.333...
    expect(valueByKind(b, 'cacheRate')).toBeCloseTo(0.3333, 3);
  });

  it('cacheRate 分母 ≤0 → 0', () => {
    expect(valueByKind({ input: 0, output: 0, cache: 0 }, 'cacheRate')).toBe(0);
    expect(valueByKind({ input: -10, output: 0, cache: 5 }, 'cacheRate')).toBe(0);
  });

  it('cacheRate cache=0 → 0（即便 input > 0）', () => {
    expect(valueByKind({ input: 1000, output: 0, cache: 0 }, 'cacheRate')).toBe(0);
  });

  it('cacheRate 全 cache（input=0）→ 1.0', () => {
    expect(valueByKind({ input: 0, output: 0, cache: 500 }, 'cacheRate')).toBe(1);
  });
});
