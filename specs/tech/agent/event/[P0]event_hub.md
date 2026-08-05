---
type: interface
title: EventHub（全局 singleton 路由表）
priority: P0
status: active
updated: 2026-06-30
since: v0.0.8
---

# Event Hub

> **全局单例**中心；`Map<topic, EventBus>` 路由表。每个 topic 一个 EventBus 实例（见 event_bus）。规范见 `[P0]event_convention.md`，transport 见 `[P0]event_bus.md`。
>
> **唯一目的：订阅方只要 (topic, group) 就能收事件，不需要持有 bus 实例。**

## 1. 概述

EventHub 是**全局 singleton**（系统唯一一个）。每个 topic 对应**一个** EventBus 实例（per-topic）；hub 维护 `Map<topic, EventBus>`，把 `(topic, group)` 路由到对应 topic 的 bus 的 group。

- **EventHub**：全局 1 个
- **EventBus**：per-topic（每 topic 一个实例；bus 内按 group 分区各 session）

hub **不感知业务**，只认 topic / group 字符串（规范见 event_convention）。

### 两级寻址

| 层级 | 含义 |
|---|---|
| **topic** | 一级域（`agent_loop` / `session_panel` / ...）→ 选 bus 实例 |
| **group** | topic 下的二级渠道（`session_id:<sid>`）→ bus 内分区 |

（group 在 topic 下唯一；sub 双参。）

### 为什么需要 hub

没有 hub，订阅方要拿到具体 bus 实例 + 知道 group。hub 去耦：订阅方只给 `(topic, group)`，hub 找 topic 的 bus → `bus.subscribe(group)`。

---

## 2. 接口

```typescript
interface EventHub {
  /** 注册 topic 及其专属 EventBus 实例（每 topic 一个）。重复注册覆盖。 */
  registerTopic(topic: string, bus: EventBus): void;

  /** 订阅 (topic, group)：找 topic 的 bus → bus.subscribe(group) → unwrap data → listener。 */
  sub<T>(topic: string, group: string, listener: (msg: T) => void): Subscription;

  /** 取消订阅 */
  unsub(subscription: Subscription): void;
}

interface Subscription {
  topic: string;
  group: string;
  cancel(): void;
}
```

---

## 3. 内部：Map<topic, EventBus>（singleton，全局唯一）

```typescript
class EventHubImpl {
  private buses: Map<string, EventBus> = new Map();

  /** 全局唯一实例入口 */
  static singleton(): EventHub { /* ... */ }

  registerTopic(topic: string, bus: EventBus): void {
    this.buses.set(topic, bus);
  }

  sub<T>(topic: string, group: string, listener: (msg: T) => void): Subscription {
    const bus = this.buses.get(topic);
    if (!bus) {
      return { topic, group, cancel: () => {} };   // 没人注册该 topic：空订阅
    }
    const iter = bus.subscribe<T>(group);
    const stop = { stopped: false };
    (async () => {
      for await (const e of iter) {
        if (stop.stopped) break;
        listener(e.data);   // EventBusEvent = { data, timestamp }，透传 data
      }
    })();
    return { topic, group, cancel: () => { stop.stopped = true; iter.return?.(); } };
  }

  unsub(sub: Subscription): void { sub.cancel(); }
}
```

**路由就一行**：`buses.get(topic)` → `bus.subscribe(group)`。map 既是路由表，也是可观测面——iterate keys 就知道系统里注册了哪些 topic。

> **[v0.0.8/v0.0.10 基线] hub 级 (topic,group) 去重**：impl 对同 (topic,group) 复用同一消费循环 + 单条 cancel 记录（`activeSubs`）。即多个**相同 listener** 对同 (topic,group) sub 在 v0.0.8/v0.0.10 hub 下被合并为单条消费循环（`sub` 命中已有记录直接返）。理由：避免对同一 (topic,group) 创建多个并行 bus.subscribe 消费者。**注意**：hub 层去重 ≠ bus 层多订阅者 fan-out（bus 层仍是 fan-out，event_bus §1 不变）——多个**不同 listener**对**不同 group** sub 仍各自独立。SseChannel 路径靠此去重（`key=${topic}:${group}`）。详见 `specs/tech/version_logs/v0.0.8/change_log.md §7` + `v0.0.10 §5`。

> **[v0.0.10] cancel 实现**：cancel 不用 `bus.emit(group, {data:undefined})` 哨兵事件（会污染 replayable buffer，紧随其后的新 sub 回放出一条伪事件），改调 `bus.wakePendingSubscribers(group)`（只 resolve 排队中的 pending `next()` Promise，不向 buffer 注入伪事件）。EventBus 最小依赖接口相应新增 `wakePendingSubscribers(group)`。详见 `specs/tech/version_logs/v0.0.10/change_log.md §5`。

### 3.1 [v0.0.88] 多消费者 refcount（防御性）

> 背景：v0.0.87 studio ownSse + playground sharedSse 共存暴露「同 (topic,group) 多消费者」后端不支持的缺陷——`sub()` 命中已有记录直接 return head 的 cancel（**不 push 第二条**），`cancel` 时 `activeSubs.delete(key)` 全清 → 多消费者 unsubscribe 一个误清全局，其他静默收不到。
>
> 单例落地后（`specs/tech/app/frontend/[P0]sse_client_singleton.md`）此路径不再被前端触发，但补 refcount 让后端模型对多消费者安全——未来 Electron 多窗口、多 tab 仍可能产生多 SseChannel 连接，hub refcount 是防御层。

**改造**：
- `activeSubs: Map<string, ActiveSub[]>` 本就是数组类型；`sub()` 命中已有记录时 **真 push** 新 record（不再 return head 的 cancel）；返回新 record 自己的 cancel 句柄。
- `cancel` 按 record 引用从数组 `splice` 移除；数组空（refcount=0）才 `activeSubs.delete(key)` + 调 `bus.wakePendingSubscribers(group)` 唤醒消费循环退出。
- bus 层 fan-out 不变（`event_bus.md §1` 不变）——多消费者各自独立队列，emit 时 push 给全部订阅者。

```typescript
sub<T>(topic, group, listener): Subscription {
  const key = `${topic}:${group}`;
  const existing = this.activeSubs.get(key);
  if (existing && existing.length > 0) {
    // 复用 head 的 bus 消费循环（避免对同 group 创建多个并行 bus.subscribe 消费者），
    // 但 push 新 ActiveSub record（refcount +1），返回新 record 自己的 cancel。
    const head = existing[0];
    const record: ActiveSub = { sub: { topic, group, cancel: () => {} }, canceled: false };
    record.sub.cancel = () => {
      if (record.canceled) return;
      record.canceled = true;
      // 从数组移除本 record（refcount -1）
      const arr = this.activeSubs.get(key);
      if (arr) {
        const i = arr.indexOf(record);
        if (i >= 0) arr.splice(i, 1);
        if (arr.length === 0) {
          // refcount 归零 → 拆 bus 消费循环
          head.sub.cancel();
          this.activeSubs.delete(key);
        }
      }
    };
    existing.push(record);
    return record.sub;
  }
  // 首消费者：建 bus 消费循环（原 §3 逻辑）
  // ...
}
```

> **关键**：hub 层仍只建 1 个 bus 消费循环 per (topic,group)（去重不变，避免对同 group 多并行 bus.subscribe 消费者）；refcount 只控制「何时拆这个 bus 消费循环」。多消费者通过 bus 层 fan-out（订阅者 Set 多个）+ hub 层 listener 多订阅（hub 不 unwrap 时直接调 listener × N）分发——本版本 SseChannel 在 `subscribe(topic,group,subscriberId)` 路径下用定向投递（见 `specs/tech/app/frontend/[P0]sse_channel_multipub.md §4`），hub 层多消费者 refcount 是为未来非 channel 直连场景（如多 SseChannel 实例）补的防御层。

---

## 4. 创建与管理

### EventHub（全局单例）
- 系统启动时创建唯一实例：`EventHub.singleton()`，全生命周期一个。

### EventBus（per-topic）
- 每个 topic 由其 **owner** 创建专属 bus 并 `registerTopic` 到 hub：
  - `agent_loop` topic → owner **agent_manager**：启动时 `new EventBus({ replayable: true })` + `hub.registerTopic("agent_loop", bus)`
  - `session_panel` topic → owner **session runtime**：`new EventBus({ ... })` + `hub.registerTopic("session_panel", bus)`
- topic 的 bus 在该 topic 整个生命周期复用（per-topic 单例）；**group 动态**——每 session 的 `session_id:<sid>`，session 活跃时由 producer emit、消费方 sub。

```
系统启动
  EventHub.singleton()                                       // 全局唯一 hub
  agent_manager:   bus_agent   = new EventBus({replayable:true}); hub.registerTopic("agent_loop",   bus_agent)
  session runtime: bus_session = new EventBus({...});            hub.registerTopic("session_panel", bus_session)

session S1 活跃（group = session_id:S1）
  producer(agent_loop):    bus_agent.emit(`session_id:S1`, event)
  producer(session_panel): bus_session.emit(`session_id:S1`, event)

消费方（经 hub，按 (topic, group)）
  hub.sub("agent_loop",   `session_id:S1`, listener)   → bus_agent.subscribe(group)
  hub.sub("session_panel", `session_id:S1`, listener)  → bus_session.subscribe(group)
```

---

## 5. 典型 (topic, group) 约定

| topic | bus owner | group | 流 | 文档 |
|---|---|---|---|---|
| `agent_loop` | agent_manager | `session_id:<sid>` | agent 进度事件（token / tool_call / message_end / ...） | `../agent_interface_and_loop/[P0]agent_event.md` |
| `session_panel` | session runtime | `session_id:<sid>` | session 面板 meta 变更（session_usage_update / ...） | `../session/[P0]session_event.md` |

> 同一 session 有两条不同 topic 的流（agent 进度 + session 面板），group 名都是 `session_id:<sid>`，但 topic 不同 → 落在不同 bus 实例、独立 replay。

---

## 6. 一句话

**hub = 全局 singleton + `Map<topic, EventBus>` + registerTopic / sub / unsub；每 topic 一个 bus，`sub(topic, group)` 委托该 topic 的 bus。**

## 7. （版本史见 `log.md`）
