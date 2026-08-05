---
type: spec
title: Lifecycle 数据三形标准化（Collection / Snapshot / KeyedMap）
priority: P0
status: active
updated: 2026-07-08
since: v0.0.94
related: [[P0]component_architecture.md, [P0]chat_area_hooks.md]
---

# Lifecycle 数据三形标准化（Collection / Snapshot / KeyedMap）

## §1 概述

- **管什么**：定义所有 useLifecycle 数据 hook 的 `ctx` 可收敛成的**三种标准数据形状**（Collection / Snapshot / KeyedMap）+ 每形一个**纯 reducer**（`applyCrud` / `applySnapshot` / `applyKeyed`）。`onEvent` 拿到 SSE 帧后按形调对应 reducer 得新 ctx。
- **不管什么**：useLifecycle 四方法调用时机与 ctx ref-latest 不变量（→ `[P0]component_architecture.md §3.10`）；对话区流式领域 reducer `applyAgentEventToMessages`（part 级累积，**不套本模块**，→ `[P0]chat_area_hooks.md §3`）；组件视觉/testid（→ `specs/ui/components/`）。
- **范畴一句话**：把「一块被 SSE 增量更新的数据」的更新逻辑，从每个 hook 各写一遍，收敛成三个业务无关的标准 reducer——list 型走 upsert/delete/replace、单对象型走 replace/patch、点查 map 型走 set/delete/clear。
- **与外界如何交互**：本模块是**纯函数库**（`app/web/src/lib/lifecycle-shapes.ts`），无副作用、不 import React/SSE/store。被各 area-hook / 数据 hook 的 `onEvent` 调用（`return applyCrud(ctx, {op:'upsert', item})`），返回值成为 useLifecycle 的新 ctx（ref-latest 写回 + 排队渲染，见 §3.10 不变量①）。

## §2 三形定义与 reducer

### 2.1 Collection\<T\>（list 型：有序 + 按 id 索引）

用于「一个有序列表，元素带稳定 id，SSE 增删改单个元素」。例：session 列表、board entity、cron jobs、memory entries、squad 列表。

```ts
/** 有序 + 按 id 索引的集合。order 保序，byId 供 O(1) 点查（reducer 内部维护，不外泄给渲染） */
export interface Collection<T> {
  /** 稳定顺序的元素数组（渲染直接用） */
  items: T[];
  /** 从元素取稳定 key（一次注入，reducer 复用） */
  keyOf: (item: T) => string;
}

/** Collection 上的 CRUD 操作（by key 幂等） */
export type CrudOp<T> =
  | { op: 'upsert'; item: T }                    // 存在则替换（同 key），不存在则 append
  | { op: 'upsert'; items: T[] }                 // 批量 upsert（保序：新元素按传入序 append）
  | { op: 'delete'; key: string }                // 按 key 删除（不存在 no-op）
  | { op: 'replace'; items: T[] };               // 整表替换（transcript fetch / 初始 GET）

/**
 * 把一个 CRUD 操作应用到 Collection，返回**新** Collection（immutable，幂等）。
 * - upsert：同 key 原地替换保位；新 key append 到尾（不打乱既有序）
 * - delete：按 key 过滤；key 不存在返回原引用（幂等，React 跳过 rerender）
 * - replace：整表换新（keyOf 不变）
 */
export function applyCrud<T>(coll: Collection<T>, op: CrudOp<T>): Collection<T>;

/** 构造空 Collection（onInit 初值 / reset 用） */
export function emptyCollection<T>(keyOf: (item: T) => string): Collection<T>;
```

**幂等语义（MUST）**：`upsert` 同 key 两次 = 一次（后者覆盖）；`delete` 不存在 key = 原引用返回（引用相等，React `Object.is` 跳过渲染）；`replace` 幂等（同输入同输出）。**保序不变量**：upsert 已存在 key 原地替换**不移位**（避免列表因一次更新跳动）；新 key 一律 append 尾部。

### 2.2 Snapshot\<T\>（单个型：一个对象/标量的最新态）

用于「一个单对象/标量的最新快照，SSE 整体替换或字段 patch」。例：usage（SessionUsageView）、runState、summaryTask、budget（BudgetUsage）。

```ts
/** 单对象/标量快照（null = 未拉到 / 占位） */
export type Snapshot<T> = T | null;

/** Snapshot 上的操作 */
export type SnapshotOp<T> =
  | { op: 'replace'; value: T | null }           // 整体替换（usage_update / GET 快照）
  | { op: 'patch'; patch: Partial<T> };          // 字段级 patch（局部字段推送，须 T extends object）

/**
 * 把一个 Snapshot 操作应用到当前快照，返回**新**快照（immutable）。
 * - replace：直接换（含换成 null 表示清空）
 * - patch：{...prev, ...patch}；prev 为 null 时 patch 语义未定义 → 返回 null（调用方须先 replace 建基线）
 */
export function applySnapshot<T>(snap: Snapshot<T>, op: SnapshotOp<T>): Snapshot<T>;
```

**语义（MUST）**：`patch` 仅在 `prev != null` 有效（局部更新一个已存在对象）；`prev == null` 时 patch 返回 null（不凭空造对象——调用方须先 `replace` 建基线）。绝大多数 Snapshot hook 只用 `replace`（后端推全量快照，如 `session_usage_update` 的 `SessionUsageView` 是累计快照非增量）。

### 2.3 KeyedMap\<K,V\>（kv 型：点查 map）

用于「一个 `Record<key,value>` 点查表，SSE 按 key set/delete」。例：studio 未读 `Record<sid,boolean>`、StudioSidebar detail 懒缓存 `Record<squadId,SquadDetail>`。

```ts
/** 点查 map（普通对象，渲染直接点查 map[key]） */
export type KeyedMap<K extends string, V> = Record<K, V>;

/** KeyedMap 上的操作 */
export type KeyedOp<K extends string, V> =
  | { op: 'set'; key: K; value: V }              // 设/覆盖单 key
  | { op: 'delete'; key: K }                     // 删单 key
  | { op: 'clear' };                             // 清空（dataVersion 变化 / 失效）

/**
 * 把一个 KeyedMap 操作应用到当前 map，返回**新** map（immutable，幂等）。
 * - set：同 key 同值返回原引用（幂等，跳 rerender）；不同值 {...prev, [key]:value}
 * - delete：key 不存在返回原引用；存在则删（新对象）
 * - clear：非空返回 {}；已空返回原引用
 */
export function applyKeyed<K extends string, V>(map: KeyedMap<K, V>, op: KeyedOp<K, V>): KeyedMap<K, V>;
```

**幂等语义（MUST）**：`set` 同 key 同值 → 原引用（如 `unread` 已是 false 再 set false 不触发渲染，等价现 `use-studio-unread-meta` 的 `if (prev[id]===incoming.unread) return prev`）；`delete`/`clear` 空操作返回原引用。

**消费方 ctx 类型必须显式标 `KeyedMap<string, V>`（不可省略 K 让泛型从字面量反推）**：sid/squadId 等业务 key 一定是 `string`，但 TypeScript 从 `Record<'a' | 'b', V>` 字面量 key 反推出 `K = 'a' | 'b'` → 跨 hook 传递时类型不兼容（一个 hook 的 sid 是 string，另一个 hook 写字面量 union）。消费方 hook 的 ctx 类型须显式写 `KeyedMap<string, V>`（如 `useStudioUnreadMeta` 的 ctx = `KeyedMap<string, boolean>`），让 K 锁死为 string，避免 union 字面量泄漏到 ctx 类型。reducer 内部 `applyKeyed<K, V>` 的 K 由调用方传入 op 推断，但 ctx 类型不应依赖 op 字面量反推。

## §3 设计决策

### 3.1 为什么三形而非「一个通用 reducer」

- **结论**：三个独立形 + 三个 reducer，不做「万能 state 容器」。
- **理由**：list / 单对象 / kv 的**更新代数不同**——list 关心保序 + by-key upsert，单对象关心 replace/patch，kv 关心点查 set/delete。硬塞一个容器会让每个 hook 都要理解不相关的 op（如 usage hook 不需要「保序 append」概念）。三形让「每个 hook 恰好持一形一块数据」（design-decisions §4），依赖最小。
- **反例**：若用一个 `Store<T>` 同时支持 list-append 和 scalar-replace，`useUsage`（单个 SessionUsageView）就被迫携带 `items[]/keyOf` 这些它永远用不到的字段 → 概念泄漏，违背原子化。

### 3.2 为什么 useMessages 走 buffer 第三参数（原流式特例，v0.0.95 已纯化）

- **结论**：`useMessages` 的 ctx（messages + run 派生态）**仍保留领域 reducer `applyAgentEventToMessages`**，不套 `applyCrud`。但 v0.0.95 起 reducer 已**纯化**（无 ctxRef mutate 副作用）+ 跨帧累积态走 useLifecycle 的 **buffer 第三参数**（不渲染通道），进契约纯函数通道。
- **v0.0.94 旧结论（已演进）**：原 reducer 对 `ctxRef.toolCallRawArgs`/`pendingError` 有 mutate 副作用 → 非纯函数 → 不进契约纯函数通道 → 自管 `sliceRef + runCtxRef + setSlice`，是 v0.0.94 唯一的「流式特例」。v0.0.95 通过给 useLifecycle 加 buffer 第三参数 + 纯化 reducer 消灭此特例（详 `reqs/[done] v0.0.95.lifecycle_buffer/req.md`）。
- **为什么仍不套 applyCrud**（粒度理由不变）：agent_loop 帧是 **part 级流式增量**（`text_block_delta` 累积到某 message 的某 block、`tool_call_delta` 累积 JSON 片段），不是「整条 message upsert」。`applyCrud` 的 by-key upsert 粒度太粗（覆盖会丢正在累积的 part）。reducer 是 message+part key 的领域逻辑，比 CRUD 复杂一个量级。
- **buffer 第三参数如何承担跨帧累积**（v0.0.95）：reducer 签名从 `(msgs, evt, ctxRef:{current}, state)` → `(msgs, runCtx, evt, state) => {messages, runCtx, ...派生态}`；`runCtx` 入参为值传递（不再 ref），返回新 runCtx（immutable）。useMessages 的 buffer = `{runCtx: RunContext|null}`，onEvent 调 reducer 后返 `{ctx: 新ctx, buffer: {runCtx: 新runCtx}}`——ctx 走渲染通道（messages/runActive/...），buffer 走工作内存通道（半截 rawArgs/pendingError 不渲染）。reducer 在 `tool_call_end` case 同帧从返回的新 buffer 中删 toolCallId key（D2 落地）。
- **落地**：`useMessages` 调纯化后的 `applyAgentEventToMessages`，buffer 第三参数承担累积，详 `[P0]chat_area_hooks.md §3`（buffer 第三参数落地样板）。本模块（lifecycle-shapes.ts）的三形 reducer 仍是业务无关的标准库；useMessages 是**业务相关的领域 reducer + buffer 通道**组合，不属于三形之一，但已不再是"自管 ref 不进契约"的特例。

### 3.3 immutable + 幂等 = ref-latest 前提

三个 reducer 全部**返回新引用**（immutable）+ **无变化返回原引用**（幂等），是 §3.10 ctx ref-latest 不变量①的前提：onEvent 返回新 ctx → useLifecycle 同步写 `ctxRef.current` + 排队 setCtx。幂等（无变化返回原引用）让高频帧里「事件不改变数据」时 React 靠 `Object.is` 跳过渲染，不空转。

## §4 示例（每形一个 + 流式特例指针）

```ts
// —— Collection：session 列表 hook（onEvent 收 session_meta 整条替换某 session）——
onEvent: (ctx, evt, from) => {
  if (from.topic === 'session_meta') {
    const s = (evt as SessionMetaUpdateEvent).data;
    return applyCrud(ctx, { op: 'upsert', item: s }); // 按 id upsert（保序）
  }
  return ctx;
}

// —— Snapshot：usage hook（onEvent 收 session_usage_update 整体替换）——
onEvent: (ctx, evt, from) => {
  if (from.topic === 'session_panel' && (evt as SessionEvent).type === 'session_usage_update') {
    return applySnapshot(ctx, { op: 'replace', value: (evt as SessionUsageEvent).data });
  }
  return ctx;
}

// —— KeyedMap：studio 未读 hook（onEvent 收 session_meta 按 sid set unread）——
onEvent: (ctx, evt, from) => {
  const incoming = (evt as SessionMetaUpdateEvent).data;
  if (!incoming || incoming.biz !== 'studio') return ctx;          // biz 反向守卫
  return applyKeyed(ctx, { op: 'set', key: incoming.id, value: incoming.unread === true });
}

// —— 流式 + buffer 第三参数：useMessages 走领域 reducer + buffer（不套本模块三形），见 [P0]chat_area_hooks.md §3 ——
```

## §5 边界

| 零件 | 归属 |
|---|---|
| Collection / Snapshot / KeyedMap 类型 + 3 reducer | 本文件（`lib/lifecycle-shapes.ts`） |
| ctx ref-latest 不变量 / 四方法调用时机 / effect 声明式 | `[P0]component_architecture.md §3.10` |
| `applyAgentEventToMessages` 流式领域 reducer | `store/chat-slice-reducer.ts`（→ `[P0]chat_area_hooks.md §3`） |
| 每个 hook 该持哪一形 | 迁移映射表（`[P0]component_architecture.md §3.11`） |
| 组件 testid/props/视觉 | `specs/ui/components/` |
