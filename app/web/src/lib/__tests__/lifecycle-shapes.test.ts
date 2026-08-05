// @vitest-environment node
/**
 * lifecycle-shapes 三形 reducer 单测（v0.0.94.component_refactor T1）
 * 参考: specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2/§3.3（三形定义 + 幂等/immutable 约束）
 *       specs/tech/version_logs/v0.0.94.component_refactor/change_plan.md §T1 shapes 行
 *
 * 覆盖三 reducer 的核心语义（纯函数，无副作用）：
 *   - applyCrud：upsert 同 key 保位不移位 / 新 key append 尾 / 批量 upsert / delete 幂等返原引用 / replace
 *   - applySnapshot：replace 换值+同引用幂等 / patch prev!=null 有效 / patch prev==null 返 null
 *   - applyKeyed：set 同值幂等返原引用 / set 新值 / delete 不存在返原引用 / clear 非空返{} / clear 已空返原引用
 *
 * MUST 验幂等返原引用（Object.is）：无变化时三 reducer 必须返回原引用，React 靠 Object.is 跳 rerender。
 */
import { describe, it, expect } from 'vitest';
import {
  applyCrud,
  applySnapshot,
  applyKeyed,
  emptyCollection,
  type Collection,
  type KeyedMap,
} from '../lifecycle-shapes';

/** 测试用元素类型：带稳定 id */
interface Item {
  id: string;
  v: number;
}
const keyOf = (it: Item): string => it.id;
/** 构造带初始元素的 Collection */
function coll(items: Item[]): Collection<Item> {
  return { items, keyOf };
}

// ──────────────────────────────────────────────────────────────────────────────
// applyCrud（Collection：有序 + 按 id 索引）
// ──────────────────────────────────────────────────────────────────────────────
describe('applyCrud（Collection）', () => {
  it('emptyCollection 构造空集合，keyOf 保留', () => {
    const c = emptyCollection<Item>(keyOf);
    expect(c.items).toEqual([]);
    expect(c.keyOf).toBe(keyOf);
  });

  it('upsert 新 key：append 到尾（不打乱既有序）', () => {
    const c = coll([{ id: 'a', v: 1 }]);
    const next = applyCrud(c, { op: 'upsert', item: { id: 'b', v: 2 } });
    expect(next.items).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ]);
    // immutable：返回新引用
    expect(next).not.toBe(c);
    expect(next.items).not.toBe(c.items);
  });

  it('upsert 已存在 key：原地替换保位（不移位——列表不跳动）', () => {
    const c = coll([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
      { id: 'c', v: 3 },
    ]);
    // 更新中间的 b：值变但位置仍在 index 1
    const next = applyCrud(c, { op: 'upsert', item: { id: 'b', v: 99 } });
    expect(next.items).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 99 },
      { id: 'c', v: 3 },
    ]);
    expect(next.items.findIndex((it) => it.id === 'b')).toBe(1);
  });

  it('upsert 同引用元素：无变化返回原引用（幂等 Object.is）', () => {
    const shared: Item = { id: 'a', v: 1 };
    const c = coll([shared, { id: 'b', v: 2 }]);
    // upsert 同一对象引用 → 无实际变化 → 原 Collection 引用
    const next = applyCrud(c, { op: 'upsert', item: shared });
    expect(next).toBe(c);
  });

  it('upsert 批量 items：按传入序依次 upsert（保序 append + 原地替换）', () => {
    const c = coll([{ id: 'a', v: 1 }]);
    const next = applyCrud(c, {
      op: 'upsert',
      items: [
        { id: 'a', v: 10 }, // 替换保位
        { id: 'b', v: 2 }, // 新增 append
        { id: 'c', v: 3 }, // 新增 append
      ],
    });
    expect(next.items).toEqual([
      { id: 'a', v: 10 },
      { id: 'b', v: 2 },
      { id: 'c', v: 3 },
    ]);
  });

  it('upsert 批量全同引用：无变化返回原 Collection（幂等）', () => {
    const a: Item = { id: 'a', v: 1 };
    const b: Item = { id: 'b', v: 2 };
    const c = coll([a, b]);
    const next = applyCrud(c, { op: 'upsert', items: [a, b] });
    expect(next).toBe(c);
  });

  it('delete 存在 key：过滤掉该元素（immutable）', () => {
    const c = coll([
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
    ]);
    const next = applyCrud(c, { op: 'delete', key: 'a' });
    expect(next.items).toEqual([{ id: 'b', v: 2 }]);
    expect(next).not.toBe(c);
  });

  it('delete 不存在 key：返回原引用（幂等 Object.is）', () => {
    const c = coll([{ id: 'a', v: 1 }]);
    const next = applyCrud(c, { op: 'delete', key: 'zzz' });
    expect(next).toBe(c);
  });

  it('replace：整表换新（keyOf 不变）', () => {
    const c = coll([{ id: 'a', v: 1 }]);
    const fresh = [
      { id: 'x', v: 8 },
      { id: 'y', v: 9 },
    ];
    const next = applyCrud(c, { op: 'replace', items: fresh });
    expect(next.items).toBe(fresh);
    expect(next.keyOf).toBe(keyOf);
  });

  it('replace 同数组引用：无变化返回原 Collection（幂等）', () => {
    const items = [{ id: 'a', v: 1 }];
    const c = coll(items);
    const next = applyCrud(c, { op: 'replace', items });
    expect(next).toBe(c);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// applySnapshot（Snapshot：单对象/标量）
// ──────────────────────────────────────────────────────────────────────────────
describe('applySnapshot（Snapshot）', () => {
  interface Usage {
    total: number;
    limit: number;
  }

  it('replace：整体换值', () => {
    const snap: Usage | null = { total: 10, limit: 100 };
    const next = applySnapshot(snap, { op: 'replace', value: { total: 20, limit: 100 } });
    expect(next).toEqual({ total: 20, limit: 100 });
  });

  it('replace 同引用值：返回原引用（幂等 Object.is）', () => {
    const val: Usage = { total: 10, limit: 100 };
    const next = applySnapshot(val, { op: 'replace', value: val });
    expect(next).toBe(val);
  });

  it('replace null→null：返回原引用（幂等，null===null）', () => {
    const next = applySnapshot<Usage>(null, { op: 'replace', value: null });
    expect(next).toBeNull();
  });

  it('replace 换成 null：清空快照', () => {
    const snap: Usage | null = { total: 10, limit: 100 };
    const next = applySnapshot(snap, { op: 'replace', value: null });
    expect(next).toBeNull();
  });

  it('patch prev!=null：字段级合并 {...prev,...patch}', () => {
    const snap: Usage | null = { total: 10, limit: 100 };
    const next = applySnapshot(snap, { op: 'patch', patch: { total: 55 } });
    expect(next).toEqual({ total: 55, limit: 100 });
    // immutable：新对象
    expect(next).not.toBe(snap);
  });

  it('patch prev==null：返回 null（不凭空造对象，须先 replace 建基线）', () => {
    const next = applySnapshot<Usage>(null, { op: 'patch', patch: { total: 5 } });
    expect(next).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// applyKeyed（KeyedMap：点查 map）
// ──────────────────────────────────────────────────────────────────────────────
describe('applyKeyed（KeyedMap）', () => {
  it('set 新 key：{...prev,[key]:value}', () => {
    const m: KeyedMap<string, boolean> = { a: true };
    const next = applyKeyed(m, { op: 'set', key: 'b', value: false });
    expect(next).toEqual({ a: true, b: false });
    expect(next).not.toBe(m);
  });

  it('set 同 key 同值：返回原引用（幂等 Object.is——unread 已 false 再 set false 不触发渲染）', () => {
    const m: KeyedMap<string, boolean> = { a: false };
    const next = applyKeyed(m, { op: 'set', key: 'a', value: false });
    expect(next).toBe(m);
  });

  it('set 同 key 不同值：新对象覆盖', () => {
    const m: KeyedMap<string, boolean> = { a: false };
    const next = applyKeyed(m, { op: 'set', key: 'a', value: true });
    expect(next).toEqual({ a: true });
    expect(next).not.toBe(m);
  });

  it('delete 存在 key：删该 key（新对象）', () => {
    const m: KeyedMap<string, boolean> = { a: true, b: false };
    const next = applyKeyed(m, { op: 'delete', key: 'a' });
    expect(next).toEqual({ b: false });
    expect(next).not.toBe(m);
  });

  it('delete 不存在 key：返回原引用（幂等 Object.is）', () => {
    const m: KeyedMap<string, boolean> = { a: true };
    const next = applyKeyed(m, { op: 'delete', key: 'zzz' });
    expect(next).toBe(m);
  });

  it('clear 非空：返回 {}', () => {
    const m: KeyedMap<string, boolean> = { a: true, b: false };
    const next = applyKeyed(m, { op: 'clear' });
    expect(next).toEqual({});
    expect(next).not.toBe(m);
  });

  it('clear 已空：返回原引用（幂等 Object.is）', () => {
    const m: KeyedMap<string, boolean> = {};
    const next = applyKeyed(m, { op: 'clear' });
    expect(next).toBe(m);
  });
});
