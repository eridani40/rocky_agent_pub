import { describe, it, expect } from 'vitest';
import { ChildrenIndex, type ChildRef } from '../session-children-index';

describe('ChildrenIndex', () => {
  it('build: 首次建索引（按 parentSessionId 分组），幂等（二次 build 无效）', () => {
    const idx = new ChildrenIndex();
    const records: ChildRef[] = [
      { id: 'c1', parentSessionId: 'p1' },
      { id: 'c2', parentSessionId: 'p1' },
      { id: 'c3', parentSessionId: 'p2' },
      { id: 'top' }, // 顶层 session 无 parent，不入索引
    ];
    idx.build(records);
    expect(idx.isReady).toBe(true);
    expect([...(idx.get('p1') ?? [])].sort()).toEqual(['c1', 'c2']);
    expect([...(idx.get('p2') ?? [])]).toEqual(['c3']);
    expect(idx.get('top')).toBeUndefined();

    // 幂等：二次 build 不覆盖（即使传不同 records）
    idx.build([{ id: 'c9', parentSessionId: 'p1' }]);
    expect([...(idx.get('p1') ?? [])].sort()).toEqual(['c1', 'c2']); // 仍是旧的，c9 没进
  });

  it('get: 未 build 返 undefined；无 children 返 undefined', () => {
    const idx = new ChildrenIndex();
    expect(idx.isReady).toBe(false);
    expect(idx.get('p1')).toBeUndefined();
    idx.build([{ id: 'c1', parentSessionId: 'p1' }]);
    expect(idx.get('nope')).toBeUndefined();
  });

  it('onCreated: 索引已建时挂到 parent；未建时不维护（首次 build 覆盖）', () => {
    const idx = new ChildrenIndex();
    // 未建：onCreated 无效
    idx.onCreated('p1', 'c1');
    expect(idx.isReady).toBe(false);
    idx.build([{ id: 'c2', parentSessionId: 'p1' }]);
    // 已建：onCreated 增量加
    idx.onCreated('p1', 'c3');
    idx.onCreated('p2', 'c4');
    expect([...(idx.get('p1') ?? [])].sort()).toEqual(['c2', 'c3']);
    expect([...(idx.get('p2') ?? [])]).toEqual(['c4']);
    // onCreated 无 parentSessionId（顶层 session）→ 不入索引
    idx.onCreated(undefined, 'top');
    expect(idx.get('top')).toBeUndefined();
  });

  it('onDeleted: 删 child 从 parent set 移除；删 parent 清自己 set', () => {
    const idx = new ChildrenIndex();
    idx.build([
      { id: 'c1', parentSessionId: 'p1' },
      { id: 'c2', parentSessionId: 'p1' },
      { id: 'c3', parentSessionId: 'p1' },
    ]);
    // 删 c2（child）→ 从 p1 set 移除
    idx.onDeleted('c2', 'p1');
    expect([...(idx.get('p1') ?? [])].sort()).toEqual(['c1', 'c3']);
    // 删 p1（parent）→ 清 p1 自己的 set（children c1/c3 变孤儿，不级联删 record）
    idx.onDeleted('p1', undefined);
    expect(idx.get('p1')).toBeUndefined();
  });

  it('onCreated/onDeleted: 索引未建时都是 no-op（不影响首次 build）', () => {
    const idx = new ChildrenIndex();
    idx.onCreated('p1', 'c1');
    idx.onDeleted('c2', 'p1');
    expect(idx.isReady).toBe(false);
    idx.build([{ id: 'c3', parentSessionId: 'p1' }]);
    expect([...(idx.get('p1') ?? [])]).toEqual(['c3']); // 只 c3，c1 没进（未建时 onCreated 无效）
  });

  it('resetForTest: 清空，下次 build 重建', () => {
    const idx = new ChildrenIndex();
    idx.build([{ id: 'c1', parentSessionId: 'p1' }]);
    expect(idx.isReady).toBe(true);
    idx.resetForTest();
    expect(idx.isReady).toBe(false);
    idx.build([{ id: 'c2', parentSessionId: 'p1' }]);
    expect([...(idx.get('p1') ?? [])]).toEqual(['c2']);
  });
});
