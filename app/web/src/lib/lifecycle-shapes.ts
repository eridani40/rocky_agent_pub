/**
 * lifecycle-shapes —— Lifecycle 数据三形标准化（v0.0.94.component_refactor T1）
 * 参考: specs/tech/app/frontend/[P0]lifecycle_data_shapes.md（契约权威源）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10 数据三形 + 不变量①
 *       reqs/[working] v0.0.94.component_refactor/design-decisions.md §4
 *
 * 定义所有 useLifecycle 数据 hook 的 ctx 可收敛成的三种标准数据形状 + 每形一个纯 reducer：
 *   - Collection<T>（list 型：有序 + 按 id 索引）      → applyCrud（upsert/delete/replace）
 *   - Snapshot<T>（单个型：一个对象/标量的最新态）   → applySnapshot（replace/patch）
 *   - KeyedMap<K,V>（kv 型：点查 map）                → applyKeyed（set/delete/clear）
 *
 * onEvent 拿到 SSE 帧后按形调对应 reducer 得新 ctx（ref-latest 写回 + 排队渲染，见 §3.10 不变量①）。
 *
 * 本模块是纯函数库：无副作用、不 import React/SSE/store。三条硬约束（三个 reducer 全遵守）：
 *   1. immutable —— 有变化时返回新引用（不原地改传入对象）
 *   2. 幂等      —— 无变化时返回原引用（Object.is 相等，让 React/setState 跳过 rerender）
 *   3. 保序      —— Collection.upsert 已存在 key 原地替换不移位；新 key append 尾部
 *
 * 流式特例（不套本模块）：useMessages 的 applyAgentEventToMessages（part 级累积）比 CRUD 复杂一个
 * 量级（详见 [P0]chat_area_hooks.md §3），它是三形之外的第四类「流式特例」，spec 显式标明。
 */

// ──────────────────────────────────────────────────────────────────────────────
// §2.1 Collection<T>（list 型：有序 + 按 id 索引）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 有序 + 按 id 索引的集合。
 * items 保序（渲染直接用）；keyOf 一次注入（reducer 复用取稳定 key，不外泄给渲染）。
 */
export interface Collection<T> {
  /** 稳定顺序的元素数组（渲染直接用） */
  items: T[];
  /** 从元素取稳定 key（一次注入，reducer 复用） */
  keyOf: (item: T) => string;
}

/** Collection 上的 CRUD 操作（by key 幂等） */
export type CrudOp<T> =
  | { op: 'upsert'; item: T } // 存在则替换（同 key），不存在则 append
  | { op: 'upsert'; items: T[] } // 批量 upsert（保序：新元素按传入序 append）
  | { op: 'delete'; key: string } // 按 key 删除（不存在 no-op）
  | { op: 'replace'; items: T[] }; // 整表替换（transcript fetch / 初始 GET）

/** 构造空 Collection（onInit 初值 / reset 用） */
export function emptyCollection<T>(keyOf: (item: T) => string): Collection<T> {
  return { items: [], keyOf };
}

/**
 * 单条 upsert 的内核：同 key 原地替换保位；新 key append 尾部。
 * 返回新 items 数组，或原数组（无变化时——同引用元素放同位置）。
 */
function upsertOne<T>(items: T[], keyOf: (item: T) => string, item: T): T[] {
  const key = keyOf(item);
  const idx = items.findIndex((it) => keyOf(it) === key);
  if (idx === -1) {
    // 新 key：append 到尾（不打乱既有序）
    return [...items, item];
  }
  // 已存在：同引用则无变化（幂等，返回原数组）
  if (Object.is(items[idx], item)) return items;
  // 原地替换保位（不移位——避免列表因一次更新跳动）
  const next = items.slice();
  next[idx] = item;
  return next;
}

/**
 * 把一个 CRUD 操作应用到 Collection，返回新 Collection（immutable，幂等）。
 * - upsert(item)：同 key 原地替换保位；新 key append 到尾（不打乱既有序）
 * - upsert(items)：批量按传入序依次 upsert（新元素按序 append）
 * - delete：按 key 过滤；key 不存在返回原引用（幂等，React 跳过 rerender）
 * - replace：整表换新（keyOf 不变）；引用相等（同数组）时返回原 Collection
 *
 * @param coll 当前 Collection
 * @param op   要应用的 CRUD 操作
 * @returns    新 Collection（无变化时返回原引用）
 */
export function applyCrud<T>(coll: Collection<T>, op: CrudOp<T>): Collection<T> {
  const { items, keyOf } = coll;

  if (op.op === 'upsert') {
    // 单条 vs 批量：批量按传入序依次 upsert（复用 upsertOne 内核）
    if ('items' in op) {
      let nextItems = items;
      for (const it of op.items) {
        nextItems = upsertOne(nextItems, keyOf, it);
      }
      // 全程无变化（同引用）→ 返回原 Collection（幂等跳渲染）
      return nextItems === items ? coll : { items: nextItems, keyOf };
    }
    const nextItems = upsertOne(items, keyOf, op.item);
    return nextItems === items ? coll : { items: nextItems, keyOf };
  }

  if (op.op === 'delete') {
    const idx = items.findIndex((it) => keyOf(it) === op.key);
    // key 不存在：原引用返回（幂等）
    if (idx === -1) return coll;
    const nextItems = items.slice(0, idx).concat(items.slice(idx + 1));
    return { items: nextItems, keyOf };
  }

  // replace：整表换新；同数组引用时无变化返回原 Collection
  if (op.items === items) return coll;
  return { items: op.items, keyOf };
}

// ──────────────────────────────────────────────────────────────────────────────
// §2.2 Snapshot<T>（单个型：一个对象/标量的最新态）
// ──────────────────────────────────────────────────────────────────────────────

/** 单对象/标量快照（null = 未拉到 / 占位） */
export type Snapshot<T> = T | null;

/** Snapshot 上的操作 */
export type SnapshotOp<T> =
  | { op: 'replace'; value: T | null } // 整体替换（usage_update / GET 快照，含换成 null 清空）
  | { op: 'patch'; patch: Partial<T> }; // 字段级 patch（局部字段推送，须 prev != null）

/**
 * 把一个 Snapshot 操作应用到当前快照，返回新快照（immutable）。
 * - replace：直接换（含换成 null 表示清空）；同引用时返回原引用（幂等）
 * - patch：{...prev, ...patch}；prev 为 null 时返回 null（不凭空造对象——调用方须先 replace 建基线）
 *
 * @param snap 当前快照
 * @param op   要应用的操作
 * @returns    新快照（replace 同引用 / patch prev==null 时返回原态）
 */
export function applySnapshot<T>(snap: Snapshot<T>, op: SnapshotOp<T>): Snapshot<T> {
  if (op.op === 'replace') {
    // 同引用（含 null===null）无变化返回原引用（幂等）
    return Object.is(snap, op.value) ? snap : op.value;
  }
  // patch：仅在 prev != null 有效（局部更新已存在对象）；prev == null 返回 null（不凭空造）
  if (snap === null) return null;
  return { ...snap, ...op.patch };
}

// ──────────────────────────────────────────────────────────────────────────────
// §2.3 KeyedMap<K,V>（kv 型：点查 map）
// ──────────────────────────────────────────────────────────────────────────────

/** 点查 map（普通对象，渲染直接点查 map[key]） */
export type KeyedMap<K extends string, V> = Record<K, V>;

/** KeyedMap 上的操作 */
export type KeyedOp<K extends string, V> =
  | { op: 'set'; key: K; value: V } // 设/覆盖单 key
  | { op: 'delete'; key: K } // 删单 key
  | { op: 'clear' }; // 清空（dataVersion 变化 / 失效）

/**
 * 把一个 KeyedMap 操作应用到当前 map，返回新 map（immutable，幂等）。
 * - set：同 key 同值（Object.is）返回原引用（幂等跳 rerender）；否则 {...prev, [key]:value}
 * - delete：key 不存在返回原引用；存在则删（新对象）
 * - clear：非空返回 {}；已空返回原引用
 *
 * @param map 当前 map
 * @param op  要应用的操作
 * @returns   新 map（无变化时返回原引用）
 */
export function applyKeyed<K extends string, V>(
  map: KeyedMap<K, V>,
  op: KeyedOp<K, V>,
): KeyedMap<K, V> {
  if (op.op === 'set') {
    // 同 key 同值（Object.is）→ 原引用（幂等，如 unread 已是 false 再 set false 不触发渲染）
    if (Object.prototype.hasOwnProperty.call(map, op.key) && Object.is(map[op.key], op.value)) {
      return map;
    }
    return { ...map, [op.key]: op.value };
  }

  if (op.op === 'delete') {
    // key 不存在：原引用返回（幂等）
    if (!Object.prototype.hasOwnProperty.call(map, op.key)) return map;
    const next = { ...map };
    delete next[op.key];
    return next;
  }

  // clear：非空返回 {}；已空返回原引用（幂等）
  return Object.keys(map).length === 0 ? map : ({} as KeyedMap<K, V>);
}
