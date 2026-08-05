---
type: interface
title: EventBus（通用 pub-sub transport）
priority: P0
status: active
updated: 2026-07-22
since: v0.0.8
---

# Event Bus

> 上层路由见 `[P0]event_hub.md`（topic 一级域 + group 二级渠道 → emitter map，跨 bus 实例路由，委托本文件定义的 EventBus 做 transport）。

## 1. 概述

通用发布-订阅 transport，支持多 **group** 隔离、可选 replay（消息补偿）。**不感知任何业务概念**（session/agent/...）—— group 只是一个通用分区 key，业务方自己往里编码含义。

**核心场景**：事件流的发布与订阅。生产方 emit 到 group；UI / logger / metrics 各自 subscribe，互不干扰。

**replay 不是无限历史回放**：replayable bus 的 buffer 是**有限窗口**，只含「自上次 `clearReplay` 之后 emit 的」事件。业务方按需调 `clearReplay` 收紧窗口（如 agent_loop 每次持久化后清，见 `agent_event.md` §11）。订阅方重新订阅时，replay 只回放**当前 buffer 内**的事件，**不是全部历史**——历史应由业务方另行持久化并提供查询接口（如 `GET /messages`），replay 只负责补「持久化点 → 当前」这段尚未持久化的空窗。完整应用层契约见 `agent_event.md` §11「API + SSE 不漏契约」。

**设计原则**：
- group 之间完全隔离（独立 replay buffer / 订阅者集合）
- replay 是 group 级别的可选能力
- 发布是 fire-and-forget，不等待消费者
- 多订阅者 fan-out，各自独立消费

### group 命名规范

group 是通用字符串，基础设施不解析内容。业务方按 `key_name:key_value` 编码，多个用下划线拼接：
- `session_id:01KVC...`（某 session 的主流）
- `session_id:01KVC..._run_id:01KVD...`（某 session 某 run）

> topic（一级域，如 agent/session）是 event_hub 层的概念，event_bus 只有 group、不知道 topic。

---

## 2. 核心接口

### 2.1 EventBusOptions

```typescript
interface EventBusOptions {
  /** 是否启用 replay buffer，默认 false */
  replayable?: boolean;
  /**
   * [v0.0.42] 生命周期标记 predicate（仅 replayable bus 有效）。
   * 返 true = 该 event 是「跨 ingest 边界的 run 生命周期标记」，写入独立 sticky slot，
   *   不被 clearReplay 清除；subscribe 时先回放 sticky 再回放 buffer。
   * 返 false / 不传 = 普通 content 事件，走默认 buffer 行为（clearReplay 清）。
   * 不传（undefined）= bus 无 sticky 行为，clearReplay 清整个 buffer（旧行为，向后兼容）。
   *
   * 设计：通用 predicate 函数，bus 内部不感知业务 type 名（不破坏「不感知业务」原则）。
   * 仅 agent_loop topic 的 bus 注入 predicate（识别 run_start/run_end）；其他 topic 不传。
   */
  lifecyclePredicate?: (event: EventBusEvent<unknown>) => boolean;
}
```

### 2.2 EventBus

```typescript
interface EventBus {
  /**
   * 向指定 group 发布事件
   * - replayable bus：事件写入该 group 的 replay buffer（或 sticky slot 若 lifecyclePredicate 命中——**sticky-exclusive：不进 buffer**），
   *   并推送给所有当前订阅者
   * - non-replayable bus：仅推送给当前订阅者
   */
  emit<T>(group: string, event: EventBusEvent<T>): void;

  /**
   * 订阅指定 group
   * - replayable bus：先回放该 group 的 sticky slot（若有），再回放 replay buffer，再接收新事件
   * - non-replayable bus：只接收订阅之后的新事件
   * 返回 AsyncIterable，消费者用 for await 消费
   */
  subscribe<T>(group: string): AsyncIterable<EventBusEvent<T>>;

  /**
   * 清空指定 group 的 replay buffer（仅 replayable bus 有效）
   * - 不产生事件、不影响已订阅者
   * - 之后新订阅的消费者从此刻开始回放
   * - [v0.0.42] 若 bus 配置了 lifecyclePredicate：**只清 content buffer，不清 sticky slot**
   *   （让 run 生命周期标记在 replay 中粘住，切走切回重订阅时可恢复 runActive）。
   *   sticky slot 的清理由 emit 时的 replace 语义负责（新 run_start 替换旧 run_start+run_end）。
   */
  clearReplay(group: string): void;
}
```

> **注意**：`replayable` 是 EventBus 实例级别的属性，创建时通过 `EventBusOptions` 指定，不可修改。同一个 EventBus 实例下所有 group 共享这个行为。`lifecyclePredicate` 同样实例级、创建时定。

---

## 3. EventBusEvent

EventBus 中流转的通用事件包装。

```typescript
interface EventBusEvent<T> {
  data: T;
  timestamp: string;
}
```

---

## 4. Replay Buffer 行为

### 4.1 replayable = true

```
时间线（某 group）：
  t1: emit(A)  → buffer: [A]
  t2: emit(B)  → buffer: [A, B]
  t3: subscribe(S1) → S1 收到回放 [A, B]，然后继续收新事件
  t4: emit(C)  → buffer: [A, B, C]，S1 收到 C
  t5: clearReplay(group) → buffer: []，已订阅者不受影响
  t6: emit(D)  → buffer: [D]，S1 收到 D
  t7: subscribe(S2) → S2 回放 [D]，然后继续收新事件
```

### 4.2 replayable = false（默认）

```
emit → 仅推送给当前活跃订阅者，不缓存
subscribe → 只收订阅之后的事件
clearReplay → 无效果（没有 buffer 可清）
```

### 4.3 [v0.0.42] sticky slot（生命周期标记粘住）

**背景**：切走切回重订阅 agent_loop 时，run 生命周期标记（`run_start`/`run_end`）需要「粘住」——它们决定前端 `runActive` 翻转，丢失则 spinner 永不回归。但 `clearReplay`（每次 ingest 调）清整个 buffer，连生命周期标记一起清掉。

**方案**：bus 实例配置 `lifecyclePredicate` 后，每 group 额外维护一个**独立 sticky slot**（与 content buffer 分离）：

- **emit** 时若 `lifecyclePredicate(event) === true`：
  - 写入 sticky slot（按 event type 替换，保证每种 type 至多一份；典型仅 `run_start` + `run_end` 各一份）。
  - **sticky-exclusive（不进 content buffer）**：sticky 已持有该事件供 subscribe replay，再进 buffer 会让 subscribe（先回放 sticky 再回放 buffer）把同一事件回放两次 → run_start 重复。
  - **特殊：emit run_start 时，先把 sticky 内已有的 run_start/run_end 全部移除，再写入新 run_start**——保证多 run 时序正确（连续 run 时 sticky 只含最新一组 run_start [run_end?]）。
- **clearReplay** 只清 content buffer，**不动 sticky slot**（生命周期标记跨 ingest 边界存活）。
- **subscribe** 时**先回放 sticky slot**（run 生命周期事件）**再回放 content buffer**（content 半截）——保证 reducer 先翻 runActive、再处理 content delta。

```
agent_loop run 进行中（半截在 buffer，run_start 粘在 sticky）：
  t1: emit(run_start, runId=R1)  → sticky: {run_start_R1}, buffer: []   （sticky-exclusive：不进 buffer）
  t2: emit(message_start, M1)    → buffer: [message_start_M1]
  t3: emit(text_delta, M1)       → buffer: [message_start_M1, text_delta_M1]
  → 用户切走（unsubscribe）

切回重订阅：
  t4: subscribe → 回放 sticky [run_start_R1] + buffer [message_start_M1, text_delta_M1]
  → reducer 喂入：run_start（runActive=true, phase=thinking）
                  → message_start（建 message, phase=answering）
                  → text_delta（append）
  → runActive 恢复 ✅，spinner 回归 ✅
  → run_start 恰好一次（无重复回放）

run 结束：
  t5: emit(run_end, R1)          → sticky: {run_start_R1, run_end_R1}, buffer: [...]   （run_end 不进 buffer）
  → 下次切回：sticky replay run_start_R1 + run_end_R1 → runActive 最终 false（spinner 不显，正确）
```

**多 run 时序（连续 run）**：
```
session run1 → run_end1 → run2 → run_start2 emit 时：
  - 先清 sticky 内 run_start1 + run_end1
  - 再写入 run_start2
  → sticky 只含最新一组（run_start2 [后续 run_end2]），无旧 run 噪音
```

**影响面隔离**：sticky slot 是 per-group（与 content buffer 同 group 分区），仅 agent_loop topic 的 bus 配置了 `lifecyclePredicate`；session_panel / session_meta 的 bus 不配（`lifecyclePredicate === undefined`），无 sticky 行为，clearReplay 仍清整个 buffer（旧行为，零回归）。

**已知权衡（reviewer 观测）**：当前 emit 内多 run replace 语义硬编码 `data.type === 'run_start'`（命中 run_start 时清旧 sticky 内的 run_start + run_end 再写新 run_start）——这与「bus 不感知业务 type 名」理想**略有偏差**（`lifecyclePredicate` 本身是通用的，但 replace group 仍写死在 emit 分支）。当前 bus 仅 agent_loop topic 启用且只识别 run_start/run_end 两类生命周期事件，硬编码够用；**未来泛化方向**（如需支持多个生命周期 type 互斥场景，如 chat 协议的 user_turn/assistant_turn）：把 replace group 也声明为 `EventBusOptions` 配置（如 `replaceGroups?: Map<eventType, eventType[]>`，predicate 命中 + 同 group 内旧 sticky 全清再写新），让 bus 在多组互斥生命周期场景仍保持通用。当前不引入此选项——YAGNI，待真实多生命周期场景出现再加。

**与 §4.1 的兼容**：lifecyclePredicate 不传时（其他 topic）行为完全等于 v0.0.8 以来的旧行为；predicate 传入仅是「为命中类型额外维护一份粘住的副本，且**该副本 sticky-exclusive**（命中事件不再进 content buffer）」。

> **核心设计原则**：replay 粘住——`clearReplay` 只清 content 增量、不清生命周期标记，保证切走切回 run 状态可恢复。sticky slot 是**独立**于 content buffer 的副本，由 emit 维护、clearReplay 不动、subscribe 先回放。命中 predicate 的事件**sticky-exclusive（不进 buffer）**，避免 subscribe 时被回放两次（run_start 重复回归）。

---

## 5. 伪代码实现

```typescript
interface GroupState {
  buffer: any[];
  /** [v0.0.42] sticky slot：生命周期标记镜像（lifecyclePredicate 命中的 event） */
  sticky?: Map<string /* event.type */, EventBusEvent<unknown>>;
  subscribers: Set<{ push: (e: any) => void }>;
}

class ReplayableEventBus implements EventBus {
  private replayable: boolean;
  /** [v0.0.42] 生命周期标记 predicate（仅 replayable bus 用） */
  private lifecyclePredicate?: (e: EventBusEvent<unknown>) => boolean;
  private groups: Map<string, GroupState> = new Map();

  constructor(options?: EventBusOptions) {
    this.replayable = options?.replayable ?? false;
    this.lifecyclePredicate = options?.lifecyclePredicate;
  }

  emit<T>(group: string, event: EventBusEvent<T>): void {
    let state = this.groups.get(group);
    if (!state) {
      state = { buffer: [], subscribers: new Set() };
      this.groups.set(group, state);
    }
    if (this.replayable) {
      const ev = event as EventBusEvent<unknown>;
      const data = ev.data as { type?: string };
      if (this.lifecyclePredicate?.(ev) && data?.type) {
        // [v0.0.42] lifecyclePredicate 命中 → 写 sticky slot（按 type 替换），sticky-exclusive 不进 buffer
        if (!state.sticky) state.sticky = new Map();
        // run_start 特殊：清旧 sticky 内的 run_start/run_end（多 run replace 语义）
        if (data.type === 'run_start') {
          state.sticky.delete('run_start');
          state.sticky.delete('run_end');
        }
        state.sticky.set(data.type, ev);
      } else {
        // 非 sticky 事件（content delta）进 buffer（clearReplay 清）
        state.buffer.push(event);
      }
    }
    for (const sub of state.subscribers) {
      sub.push(event);
    }
  }

  subscribe<T>(group: string): AsyncIterable<EventBusEvent<T>> {
    let state = this.groups.get(group);
    if (!state) {
      state = { buffer: [], subscribers: new Set() };
      this.groups.set(group, state);
    }
    const queue: EventBusEvent<T>[] = [];
    const stateAny = state as any;
    if (this.replayable) {
      // [v0.0.42] 先回放 sticky slot（生命周期标记），再回放 content buffer
      if (stateAny.sticky) {
        for (const e of stateAny.sticky.values()) queue.push(e as EventBusEvent<T>);
      }
      for (const e of stateAny.buffer) {
        queue.push(e);
      }
    }
    const subscriber = { push: (e: EventBusEvent<T>) => queue.push(e) };
    stateAny.subscribers.add(subscriber);
    return {
      async *[Symbol.asyncIterator]() {
        try {
          while (true) {
            if (queue.length > 0) {
              yield queue.shift()!;
            } else {
              await new Promise((r) => setTimeout(r, 0));
            }
          }
        } finally {
          stateAny.subscribers.delete(subscriber);
        }
      },
    };
  }

  clearReplay(group: string): void {
    if (!this.replayable) return;
    const state = this.groups.get(group);
    if (state) {
      state.buffer = [];
      // [v0.0.42] 不清 sticky slot（lifecyclePredicate 命中的标记跨 ingest 存活）
    }
  }
}
```

---

## 6. 在架构中的应用

EventBus 实例 **per-topic**：每个 topic 一个 bus 实例（独立 replay buffer / 订阅者集合），由该 topic 的 owner 创建并 `registerTopic` 到全局 EventHub（见 `event_hub.md §4`）。bus 内按 group（`session_id:<sid>`）分区各 session。

```
EventHub（全局单例，系统唯一）
  └─ Map<topic, EventBus>：registerTopic(topic, bus)

per-topic bus（每 topic 一个，owner 持有）：
  agent_loop    topic → owner agent_manager   持有 bus_agent
  session_panel topic → owner session runtime 持有 bus_session

生产方（emit 用 group）：
  agent_loop:    bus_agent.emit(`session_id:<sid>`, event)
  session_panel: bus_session.emit(`session_id:<sid>`, event)

消费方（sub 用 (topic, group)，经 hub）：
  hub.sub("agent_loop", `session_id:<sid>`, listener)    → bus_agent.subscribe(group)
  hub.sub("session_panel", `session_id:<sid>`, listener) → bus_session.subscribe(group)
```

> EventBus 实例级 replayable 决定该 topic 所有 group 的行为（事件流用 `replayable: true`）。**生产方 emit 用 group（bus 层），消费方 sub 用 (topic, group)（hub 层）**——hub 按 topic 选 bus，再按 group 订阅。

**生产方内部**（以 agent_loop 为例，完整契约见 `agent_event.md` §11）：
- 每个事件 → `bus.emit(group, { data: event, timestamp: ... })`（写入 buffer 或 sticky slot + push 所有当前订阅者）
- **每次持久化一批消息（ingest）→ `bus.clearReplay(group)`**：持久化的数据已落 DB，消费方经查询接口（`GET /messages`）必能拿到，buffer 不必再持有 → 清空。这使 buffer 永远只含「尚未持久化的半截」，新订阅者 replay 得到的是这段空窗的完整事件序列。`clearReplay` 不产生事件、不影响已订阅者（只影响之后新订阅者的回放起点）。
- **[v0.0.42] run 生命周期标记粘住**：agent_loop topic 的 bus 在 `bootstrap.ts` 注册时注入 `lifecyclePredicate`（识别 `run_start` / `run_end`），让生命周期标记额外写入 sticky slot，不被 `clearReplay` 清除。切走切回重订阅时 sticky 先回放，保证前端 `runActive` 翻转可恢复（spinner 不丢）。其他 topic（session_panel / session_meta）不注入 predicate，行为完全等于 v0.0.8 以来（零回归）。详见 §4.3。

## 7. （版本史见 `log.md`）
