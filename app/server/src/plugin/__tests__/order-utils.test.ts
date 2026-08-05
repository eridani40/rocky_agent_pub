/**
 * order-utils 单测 — computeEffectiveOrders 默认补位算法（design §1.2/§1.3）
 * 参考: specs/tech/config/[P0]plugin_config_service.md §3.1
 *
 * 覆盖：known 按 record 排序 / unknown 末尾补位 / 1..n 连续 / 稀疏 record 重排
 */
import { describe, it, expect } from 'vitest';
import { computeEffectiveOrders } from '../order-utils';
import type { RegisteredExtImpl, ExtImpl } from '../manifest';
import type { ExtImplPolicyData } from '../plugin-policy-store';

/** 构造测试用 RegisteredExtImpl（仅 implId + point 字段有意义） */
function mkEntry(implId: string, point = 'p'): RegisteredExtImpl {
  const manifest: ExtImpl = { implId, point, impl: './x.ts' };
  return { pluginId: 'plug', manifest, implClass: null };
}

/** 构造 getImplPolicy 回调（从 Map 读） */
function policyGetter(store: Map<string, ExtImplPolicyData>) {
  return (id: string) => store.get(id);
}

describe('computeEffectiveOrders — 默认补位算法（design §1.2）', () => {
  it('全 unknown → 全部按登记序补位 1..n', () => {
    const entries = [mkEntry('a'), mkEntry('b'), mkEntry('c')];
    const m = computeEffectiveOrders(entries, policyGetter(new Map()));
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(2);
    expect(m.get('c')).toBe(3);
  });

  it('全 known → 按 record 值排序后重排 1..n（连续化）', () => {
    const entries = [mkEntry('a'), mkEntry('b'), mkEntry('c')];
    // record 稀疏：a=10, b=5, c=20 → 排序 b<a<c → 重排 1,2,3
    const store = new Map([
      ['a', { order: 10 }],
      ['b', { order: 5 }],
      ['c', { order: 20 }],
    ]);
    const m = computeEffectiveOrders(entries, policyGetter(store));
    expect(m.get('b')).toBe(1); // record 最小
    expect(m.get('a')).toBe(2);
    expect(m.get('c')).toBe(3); // record 最大
  });

  it('known + unknown 混合 → known 按 record 排序在前，unknown 末尾按登记序补位', () => {
    const entries = [mkEntry('a'), mkEntry('b'), mkEntry('c'), mkEntry('d')];
    // a/c 已知（a=5, c=1），b/d 未知
    const store = new Map([
      ['a', { order: 5 }],
      ['c', { order: 1 }],
    ]);
    const m = computeEffectiveOrders(entries, policyGetter(store));
    // known 按 record 排序：c(1) < a(5) → c=1, a=2
    expect(m.get('c')).toBe(1);
    expect(m.get('a')).toBe(2);
    // unknown 按登记序接尾：b(登记 idx=1) < d(登记 idx=3) → b=3, d=4
    expect(m.get('b')).toBe(3);
    expect(m.get('d')).toBe(4);
  });

  it('空 entries → 空 map', () => {
    const m = computeEffectiveOrders([], policyGetter(new Map()));
    expect(m.size).toBe(0);
  });

  it('单 unknown → order=1', () => {
    const m = computeEffectiveOrders([mkEntry('a')], policyGetter(new Map()));
    expect(m.get('a')).toBe(1);
  });

  it('同 record 值冲突 → 按登记序稳定（先登记者靠前）', () => {
    const entries = [mkEntry('a'), mkEntry('b'), mkEntry('c')];
    // 全部 record=5 → 按 regIdx 稳定排序 a<b<c
    const store = new Map([
      ['a', { order: 5 }],
      ['b', { order: 5 }],
      ['c', { order: 5 }],
    ]);
    const m = computeEffectiveOrders(entries, policyGetter(store));
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(2);
    expect(m.get('c')).toBe(3);
  });

  it('非数字 order record（NaN/undefined）→ 视为 unknown 补位', () => {
    const entries = [mkEntry('a'), mkEntry('b')];
    const store = new Map([['a', { order: undefined as unknown as number }]]);
    const m = computeEffectiveOrders(entries, policyGetter(store));
    // a 无有效 order → 与 b 一样 unknown，按登记序 a=1, b=2
    expect(m.get('a')).toBe(1);
    expect(m.get('b')).toBe(2);
  });
});
