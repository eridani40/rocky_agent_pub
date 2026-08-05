---
type: spec
title: SSE Channel Multi-Subscriber（广播 + subId 注入 + 前端过滤 + refcount）
priority: P0
status: active
updated: 2026-07-07
since: v0.0.88
related: [[P0]sse_channel.md, [P0]sse_client_singleton.md, ../../agent/event/[P0]event_hub.md]
---

# SSE Channel Multi-Subscriber

> 管什么：后端 `SseChannel` 多订阅改造——SubscriberProxy 对象（**不持 sink**）+ **广播 + subId 注入 + 前端过滤**（方案 B）+ 三层 refcount。
> 不管什么：前端单例（→ `[P0]sse_client_singleton.md`）；hub refcount 细节（→ `../../agent/event/[P0]event_hub.md §3.1`）；基础 SSE 桥（→ `[P0]sse_channel.md §1-§10`）。
> 由来：v0.0.87 studio ownSse + playground sharedSse 共存暴露 hub/channel 多消费者未设计缺陷。详见 `reqs/[working] v0.0.88.sse_refactor/research.md`。
> **方案 B（用户最终拍板）**：writeFrame 保持广播语义不变；listener 闭包给帧注入 `subId`；后端**不**维护 sink-subId 关联；前端按 `subId` 路由（`Map<subId, handler>`）。
> **术语统一**：标识字段名 = `subId`（不用 `compId` / `subscriberId`）。**1 次订阅 = 1 个 sub id**——一个组件可能订阅多次（如 agent_loop + session_panel 两条），用 component id 做 key 会撞（同组件第二条覆盖第一条）；subId 贯穿前后端，是唯一粘合 key。

## 1. 现状缺陷（要消除的）

| # | 位置 | 缺陷 |
|---|------|------|
| **D5a** | `event-hub.ts:109-115,163` | `activeSubs: Map<string, ActiveSub[]>` 类型是数组但 `sub()` 命中已有记录直接 return head 的 cancel，**不 push 第二条**；`cancel` 时 `activeSubs.delete(key)` 全清 → 多消费者 unsubscribe 一个误清全局，其他静默收不到。 |
| **D5b** | `sse-channel.ts:subs` key 去重 | 多连接订同 group，新连接拿不到 replay buffer（只灌给第一个 subscribe 的 listener）。 |
| **D5c** | hub `_all` 多订阅者 | playground 列表 + studio 红点（理论上）订 `session_meta _all`，后端只灌第一个 handler。 |

> 单例落地后 D5 系列不再被前端触发（前端只 1 个 SseClient，每 (topic,group) 1 个消费者）。但补 refcount 让后端模型对多消费者安全——未来 Electron 多窗口、多 tab 仍可能产生多 SseChannel 连接，hub refcount 是防御层。

## 2. SubscriberProxy 架构（后端内存对象，**不持 sink**）

```typescript
/** 单个订阅者的代理对象：持 subId + listener 闭包（注入 subId 写广播帧）；不持 sink */
interface SubscriberProxy {
  subId: string;          // 前端生成 ULID（缺省时后端生成），全 app 唯一；帧路由 key
  topic: string;
  group: string;
  listener: (data: unknown) => void;  // 闭包：调 writeFrame({topic, group, data, subId}) 广播
  cancel: () => void;     // hub Subscription 的 cancel（refcount -1，归零才拆 bus 消费循环）
}
```

`SseChannel` 维护两个 Map（**不再持 sink→subId 关联**）：

| Map | key | value | 用途 |
|-----|-----|-------|------|
| `subscribers` | `subId` | `SubscriberProxy` | 全部活跃订阅者（按 subId 路由查找） |
| `groupSubs` | `${topic}:${group}` | `Set<subId>` | 每 (topic,group) 的订阅者集合 = channel 侧 refcount 来源 |

> **关键决策（方案 B）**：后端**不**维护 sink-subId 关联。一个 sink（GET /sse 连接）可能承载多个 subId（多个组件订阅），一个 subId 也可能在多 sink 上被消费（多 tab 同步订阅，由前端各自的 SseClient 单例各生成自己的 subId）。writeFrame 广播到所有 sinks，前端按 subId 过滤——后端只注入 subId 不做定向。

## 3. 订阅协议（带 subId）

| 方向 | 通道 | 内容 |
|---|---|---|
| client→server | `POST /sse/subscribe` | `{ topic, group, subId }`（v0.0.88 加 subId；subId 缺省后端生成 ULID 兜底） |
| client→server | `DELETE /sse/subscriber/:subId` | 路径参数 subId（v0.0.88 新增；精准取消一个订阅，refcount -1） |
| server→client | `GET /sse` 帧格式 | `{ topic, group, data, timestamp, subId }`（v0.0.88 加 `subId`） |

> 字段命名统一：`subId`（不用 `compId` / `subscriberId`）。前端 `Map<subId, handler>` 路由。

## 4. 投递：广播 + subId 注入（替代 `[P0]sse_channel.md §5` writeFrame 行为描述）

**核心变更（方案 B）**：原 `writeFrame(frame)` 广播给所有活跃 sink 的语义**不变**；每个 `SubscriberProxy.listener` 是一个闭包，捕获自己的 `subId`，收到 event 后调 `writeFrame({ topic, group, data, timestamp, subId })`——帧携带 subId，但 writeFrame 仍广播所有 sinks。前端按 subId 过滤路由。

```typescript
// SseChannel.subscribe（改造后伪代码，方案 B）：
subscribe(topic, group, subId): void {
  if (this.destroyed) return;
  if (this.subscribers.has(subId)) return;  // 幂等：同 subId 重复订阅 no-op

  // listener 闭包捕获 subId，收到 data 后注入 subId 写广播帧
  const listener = (data: unknown) => {
    this.writeFrame({
      topic, group, data,
      timestamp: nowIso(),
      subId,  // 注入本订阅者的 subId
    });  // writeFrame 广播到所有 sinks（不定向）
  };

  // hub.sub 注册到 bus：hub 内部 activeSubs[key] 真数组 +1 元素；
  // bus emit fan-out 时该 listener 被调
  const sub = this.hub.sub(topic, group, listener);

  const proxy: SubscriberProxy = { subId, topic, group, listener, cancel: () => sub.cancel() };
  this.subscribers.set(subId, proxy);

  const set = this.groupSubs.get(`${topic}:${group}`) ?? new Set();
  set.add(subId);
  this.groupSubs.set(`${topic}:${group}`, set);

  // 首 sub 触发 hook（订阅生命周期可观测点）
  if (set.size === 1) this.subscribeHooks.onSubscribe?.(topic, group);
}

// unsubscribe（按 subId）：
unsubscribe(subId): void {
  const proxy = this.subscribers.get(subId);
  if (!proxy) return;  // 幂等
  const key = `${proxy.topic}:${proxy.group}`;
  this.subscribers.delete(subId);
  proxy.cancel();  // hub.activeSubs[key] 数组 splice 移除该 record；refcount -1
  const set = this.groupSubs.get(key);
  if (set) {
    set.delete(subId);
    if (set.size === 0) {
      // channel 侧 refcount 归零 → 清 groupSubs + 触发 onUnsubscribe
      // （hub 层 bus 消费循环由 hub refcount 自管：activeSubs[key] 空才 delete + wakePendingSubscribers）
      this.groupSubs.delete(key);
      this.subscribeHooks.onUnsubscribe?.(proxy.topic, proxy.group);
    }
  }
}
```

> **关键不变量**：
> - `writeFrame` 实现**不动**（仍 `for (const sink of this.sinks) sink.push(serializeFrame(frame))`）。
> - listener 闭包捕获 subId 后 writeFrame 帧体自动带 subId 字段。
> - 多 subId 订同 (topic,group) → bus 一次 emit → fan-out 到 N 个 listener → writeFrame 调 N 次（每次带不同 subId）→ 广播 N×M 帧（M=sink 数）→ 前端按 subId 过滤。
> - 浪费是设计权衡：换后端零状态（不维护 sink→subId），简化实现 + 多 tab 天然支持（每 tab 各自 SseClient 各生成 subId，sink 独立）。

## 5. hub refcount（防御性，治 D5a；三层 refcount 之 hub 层）

**`EventHub.sub` 同 (topic,group) 多消费者时 refcount +1，cancel -1，归零才 `activeSubs.delete` + 拆 bus 消费循环。**

- 现状（`event-hub.ts:57,109-115,163`）：`activeSubs: Map<string, ActiveSub[]>` 类型已是数组，但 `sub()` 命中已有记录直接 return head 的 cancel（**不 push**）；`cancel` 时 `activeSubs.delete(key)` 全清。
- v0.0.88 改造：
  - `sub()` 命中已有记录 → `activeSubs.get(key).push(newRecord)`（真数组）；返回新 record 自己的 cancel 句柄。
  - `cancel` 按 `record` 引用从数组 `splice` 移除，数组空才 `delete(key)` + `wakePendingSubscribers(group)` 唤醒消费循环退出。
- 详见 `../../agent/event/[P0]event_hub.md §3.1`（同步更新）。

> **三层 refcount 模型**（方案 B 下均保留）：
> 1. **channel 层** `groupSubs[topic:group] = Set<subId>` —— 每订阅者一个 subId，channel 据此判断 onSubscribe/onUnsubscribe 时机。
> 2. **hub 层** `activeSubs[topic:group] = SubscriberProxy[]` —— 同 (topic,group) 多消费者真数组，cancel 按 record 引用 splice。
> 3. **bus 层** 订阅者 Set —— bus 内部维护，hub 复用 head 的 bus 消费循环去重（不会对同 group 起多并行消费者）。

## 6. 多连接 fan-out 与单例的关系（方案 B 下天然支持）

| 场景 | 单 SseClient（v0.0.88 前端） | 多连接（多 tab / Electron 多窗口） |
|------|------------------------------|--------------------------------------|
| `subscribers` | 1 个 subId per (topic,group) | 多个 subId per (topic,group)，各 tab 独立 |
| `groupSubs[key]` | 1 元素 Set | 多元素 Set（每 tab 各生成自己的 subId） |
| `activeSubs[key]`（hub 侧） | 1 元素真数组 | 多元素真数组 |
| bus 订阅者（bus 侧） | 1 个 listener（head 的消费循环） | 仍 1 个 listener（hub 复用 head 的 bus 消费循环去重） |
| 投递 | 1 listener 调 writeFrame（带 subId）广播所有 sinks | N listener 各调 writeFrame（带各自 subId）广播所有 sinks；每 tab 的 sink 收到全部 N 帧后前端过滤 |

> 多连接 fan-out 在方案 B 下天然支持：后端无 sink 归属状态，writeFrame 广播所有 sinks，前端 SseClient 单例按自己的 subId 集合过滤。Electron 多窗口未来若需要无需再改后端。

## 7. isSessionActive 语义保持

- 原 `[P0]sse_channel.md §5/§7`：`isSessionActive(sid) = subs.has('session_panel:session_id:'+sid)`。
- v0.0.88 改造后：`isSessionActive(sid) = (groupSubs.get('session_panel:session_id:'+sid)?.size ?? 0) > 0`。
- 语义不变：仍反映「该 session 的 session_panel 有活跃订阅 = 用户正在看」。
- **关注点分离不变**：调用方仍是 session 层（SessionUnreadRuntime），agent-loop / 状态机不调（沿用 `[P0]sse_channel.md §7` 决策）。

## 8. 向后兼容

- **SSE 帧**：`subId` 字段新增。旧前端 SseClient 不读该字段仍能正常工作（按 `${topic}:${group}` 路由，多 handler 靠客户端 Set 兜底）；新前端 SseClient 单例只读 `subId` 路由（零过滤）。
- **POST /sse/subscribe**：`subId` 字段 v0.0.88 起必填；旧客户端不传 → 后端生成 ULID 兜底（向后兼容老 sharedSse 路径）。
- **DELETE /sse/subscriber/:subId**：v0.0.88 新增。POST /sse/unsubscribe body 形式保留为向后兼容（接 `{topic, group, subId?}`），生产路径推荐用 DELETE（subId 是唯一路由 key，无需 topic+group）。
- **session_meta `_all` 多订阅者**（playground 列表 + 未来 studio 红点）：v0.0.88 前靠「两个独立 SseClient 实例」绕开（hub 只灌第一个）；改造后单例上多个 subId 各收自己的帧，无冲突。

## 9. 与前端单例的端到端契约

```
前端组件 mount
  → getSseClient().subscribe(topic, group, handler)
  → 内部生成 subId（ULID）
  → handlers.set(subId, handler)
  → POST /sse/subscribe { topic, group, subId }
  → 后端 SseChannel.subscribe(topic, group, subId)
  → SubscriberProxy 入 subscribers + groupSubs
  → hub.sub(topic, group, listener) 注册 bus 消费者

bus emit(group, event)
  → bus fan-out → hub head 消费循环 → 调 N 个 listener（每 subId 一个）
  → 每 listener 调 writeFrame({topic, group, data, timestamp, subId})
  → writeFrame 广播到所有 sinks（不定向）

前端 onmessage
  → parseSseFrames
  → handlers.get(frame.subId)?.(frame.data)

前端组件 unmount
  → getSseClient().unsubscribe(handle)  或 handle.unsubscribe()
  → handlers.delete(subId)
  → DELETE /sse/subscriber/:subId
  → 后端 SseChannel.unsubscribe(subId)
  → subscribers.delete(subId) + groupSubs[key].delete(subId) + proxy.cancel()
  → (hub.activeSubs[key] 空) hub 拆 bus 消费循环 + activeSubs.delete(key)
  → (channel.groupSubs[key] 空) channel 清 groupSubs + onUnsubscribe
```

## 10. 版本史

- v0.0.88（2026-07-07）：新建。SubscriberProxy + **方案 B 广播 + subId 注入 + 前端过滤** + 三层 refcount（channel groupSubs / hub activeSubs / bus 订阅者 Set），从 `[P0]sse_channel.md §11` 拆分（避免主文件超 300 行）。初稿曾设计为「定向投递 + Proxy 持 sink」，**架构期用户拍板改方案 B**：后端不维护 sink-subId 关联，writeFrame 广播不变，靠前端 `Map<subId, handler>` 过滤。统一字段名 `subId`（不用 `compId` / `subscriberId`）——「1 次订阅 = 1 个 sub id」，组件多次订阅各生成独立 subId 不撞车。
