---
type: api
title: v0.0.88 SSE Channel Multi-Subscriber API 变更
priority: P0
status: active
updated: 2026-07-07
since: v0.0.88
related: [../overall/04-agent-session.md, ../../tech/app/frontend/[P0]sse_channel_multipub.md, ../../tech/app/frontend/[P0]sse_client_singleton.md]
---

# v0.0.88 SSE API 变更

> 范围：SSE 订阅协议加 `subId`（前端路由 key，方案 B：后端广播 + 前端 Map<subId, handler> 过滤）；SSE 帧格式加 `subId` 字段。其余 session/messages 端点**不变**（POST /messages、abort、cancel、clear、compact、read 全部沿用 v0.0.27 既有契约）。
> 完整 SSE 桥契约见 `specs/tech/app/frontend/[P0]sse_channel.md §11` + `[P0]sse_channel_multipub.md`；前端单例契约见 `[P0]sse_client_singleton.md`。
> **术语统一**：标识字段名 = `subId`（不用 `compId` / `subscriberId`）。**1 次订阅 = 1 个 sub id**——一个组件可能订阅多次，用 component id 做 key 会撞；subId 贯穿前后端，是唯一粘合 key。

## 1. 变更摘要

| 端点 | 变更 | 向后兼容 |
|------|------|---------|
| `POST /sse/subscribe` | body 加 `subId: string`（v0.0.88 起必填） | 旧客户端不传 → 后端生成 ULID 兜底 |
| `DELETE /sse/subscriber/:subId` | v0.0.88 新增（精准取消一个订阅，refcount -1）；POST /sse/unsubscribe body 形式保留为向后兼容 | 生产路径推荐 DELETE |
| `GET /sse` 帧格式 | payload 加 `subId: string` 字段（广播不变，前端按 subId 过滤） | 旧客户端不读该字段仍能工作（按 `${topic}:${group}` 路由） |

> **不破坏的端点**：`POST /session`、`GET /session`、`GET /session/:id`、`POST /session/:id/read`、`PUT /session/:id`、`DELETE /session/:id`、`GET /session/:id/messages`、`POST /session/:id/messages`、`POST /session/:id/abort`、`POST /session/:id/messages/:enqueueId/cancel`、`GET /session/:id/summary`、`GET /session/:id/usage`、`POST /session/:id/compact`、`POST /session/:id/clear` —— 全部沿用 v0.0.27 既有契约。

## 2. `POST /sse/subscribe` — 订阅 (topic, group, subId)

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/sse/subscribe` | 后端 `hub.sub(topic, group, listener)`，listener 收 event 转 SSE 帧携带 `subId` **广播所有 sinks**（不定向）；前端按 subId 过滤路由到 handler | `SubscribeBody` | `200` + `{ ok: true }` |

```typescript
interface SubscribeBody {
  topic: string;            // "agent_loop" / "session_panel" / "session_meta"（合法集合不变）
  group: string;            // "session_id:<sid>_amt:current" / "session_id:<sid>" / "_all"
  /**
   * [v0.0.88] 订阅唯一 id（前端生成 ULID）。后端帧携带此 id 下行，前端按 id 路由到 handler。
   * 必填：前端单例 SseClient 必须传（每 subscribe 调用内部生成一个）。
   * 向后兼容：旧客户端不传 → 后端生成 ULID 兜底（仍按 (topic:group) 路由）。
   */
  subId?: string;
}
```

**幂等**：同 (topic,group,subId) 重复订阅不重复登记（hub `subs` Map key=`${topic}:${group}` 去重；channel `subscribers` Map key=subId 去重）。同 (topic,group) 不同 subId 视为多订阅（channel 维护 `groupSubs[topic:group] = Set<subId>`，refcount +1）。

**合法 topic 集合**（不变）：`agent_loop`（v0.0.8）/ `session_panel`（v0.0.12）/ `session_meta`（v0.0.27）。

## 3. `DELETE /sse/subscriber/:subId` — 精准取消一个订阅（v0.0.88 新增，推荐路径）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `DELETE` | `/sse/subscriber/:subId` | 后端 `SseChannel.unsubscribe(subId)`；refcount -1，归零才拆 hub 订阅 | `200` + `{ ok: true }` |

**幂等**：subId 不存在 → 200 no-op。

> **POST /sse/unsubscribe 保留为向后兼容**：body 接 `{ topic, group, subId? }`；`subId` 可选（不传时取消该 (topic,group) 全部订阅者——仅测试用）。生产路径推荐用 DELETE（subId 是唯一路由 key，无需 topic+group）。

**错误**（subscribe/unsubscribe 共享）：`400` body 非法 / topic 不存在合法集合 / topic 或 group 字段缺失（空串）。

## 4. SSE 帧格式变更

旧（v0.0.8-v0.0.87）：
```
data: {"topic":"agent_loop","group":"session_id:01KV..._amt:current","data":<AgentEvent>,"timestamp":"..."}
```

新（v0.0.88+）：
```
data: {"topic":"agent_loop","group":"session_id:01KV..._amt:current","data":<AgentEvent>,"timestamp":"...","subId":"01J..."}
```

```typescript
interface SseFrame {
  topic: string;
  group: string;
  data: unknown;
  timestamp: string;
  /** [v0.0.88] 订阅唯一 id（前端生成 ULID 上行）；前端按此 id 路由到 handler，零过滤 */
  subId?: string;  // 向后兼容：旧后端不传，旧客户端不读
}
```

> **方案 B（后端广播 + 前端过滤）**：
> - 后端 `writeFrame` 广播所有 sinks 不变；每 (topic,group) 的 N 个订阅者各调一次 writeFrame，每次带自己 subId（N×M 帧，M=sink 数）；前端只匹配自己 subId，其他 tab 帧静默丢弃。
> - 新前端 SseClient 单例**只读** `subId` 路由（帧无该字段则 drop）。
> - 旧前端 SseClient 不读 `subId`，仍按 `${topic}:${group}` 路由（多 handler 靠客户端 Set 兜底）。
> - 新后端 SseChannel 总在帧里写 `subId`（每 proxy 写帧时携带）。
> - 旧后端 SseChannel 不写 `subId`，新前端收不到字段 → drop（混合版本部署时不工作，要求前后端同步升级 v0.0.88）。

## 5. AT 覆盖

| 路径 | 端点组合 |
|------|---------|
| **AA（v0.0.88）：单例订阅 + 帧带 subId** | `POST /sse/subscribe {topic:agent_loop, group:..., subId:ulid_A}` → 触发 run → `GET /sse` 断言收到帧含 `subId == ulid_A` |
| **AB：同 (topic,group) 多订阅者各自收带自己 subId 的帧** | `POST /sse/subscribe {subId:ulid_A}` + `POST /sse/subscribe {subId:ulid_B}`（同 topic+group）→ 触发 emit → `GET /sse`（连接 A）断言收到帧含 `subId == ulid_A`（也收 ulid_B 帧但 SseClient 单例过滤丢弃）；`GET /sse`（连接 B）断言收到帧含 `subId == ulid_B` |
| **AC：unsubscribe 一个不影响另一个** | 承接 AB → `DELETE /sse/subscriber/ulid_A` → emit 一次 → 连接 A 不再收带 ulid_A 的帧；连接 B 仍收帧含 `subId == ulid_B` |
| **AD：末 unsub 拆 hub 订阅** | 承接 AC → `DELETE /sse/subscriber/ulid_B` → `GET /sse` 不再收该 (topic,group) 帧；`isSessionActive(sid)` 返回 false（若是 session_panel） |

## 6. 文件变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/handlers/sse.ts` | 修改 | `SubscribeBody` interface 加 `subId?: string`；`parseSubscribeBody` 校验 topic/group 不变（subId 可选）；handler 调 `channel.subscribe(topic, group, subId)` / `channel.unsubscribe(subId)`；新增 `DELETE /sse/subscriber/:subId` 路由 |
| `app/server/src/sse/sse-channel.ts` | 修改 | `subscribe(topic, group, subId)` 新签名（**不传 sink**）；新增 `subscribers`/`groupSubs` Map；`SubscriberProxy` interface（**不持 sink**）；`unsubscribe(subId)` 新签名；`writeFrame` 保持广播不变（listener 闭包注入 subId）；`isSessionActive` 改查 `groupSubs.get(key)?.size > 0` |
| `app/server/src/agent/event-hub.ts` | 修改 | `sub()` 命中已有记录 push 真 ActiveSub 数组（refcount +1）；`cancel` 按 record 引用 splice 移除，数组空才 `activeSubs.delete(key)` |
| `app/web/src/lib/sse-client.ts` | 修改 | `handlers` 改 `Map<subId, handler>`；`subscribe()` 内部生成 ULID + 上行 body 携带 + 返回 `SubscribeHandle {subId, topic, group, unsubscribe}`；`unsubscribe(handle)` 按 subId 移除 + DELETE /sse/subscriber/:subId；`onmessage` 按 `frame.subId` 路由 |
| `app/web/src/lib/sse-singleton.ts` | 新增 | `getSseClient()` lazy 单例 + `_resetSseSingletonForTest()` 测试隔离 |
| `app/web/src/components/chat-page/page-chat.tsx` | 修改 | 删模块级 `let sharedSse`；mount 不再 `new+connect`；`session_meta _all` 订阅改 `getSseClient().subscribe(...)`；session_meta handler 保留 `refreshChildren(evt.data.parentSessionId)` 兜底链路（line 122，conversation-item 轮询消除后靠这条） |
| `app/web/src/components/chat-page/use-session-run-state.ts` | 修改 | 删 `ownSse` 分支；强制 `getSseClient()` 取单例；cleanup 不 destroy；加状态自愈（run_end 校正 + session_status_update 强制 runActive=false） |
| `app/web/src/components/studio-page/section-squad-chat.tsx` | 修改 | 删 `setInterval(fetchOnce, 2000)`；改单例 subscribe `agent_loop` + `session_panel` |
| `app/web/src/components/chat-page/component-conversation-item.tsx` | 修改 | 删 line 115-116 `setInterval(onRefreshChildren, 1500)` + `setTimeout(stopPolling, 30000)`；保留 line 113 expandOnce 主动刷一次；保留 stopPolling 函数（active 切换 cleanup 用） |

## 7. 版本

v0.0.88（2026-07-07）：SSE 订阅协议加 `subId`（前端路由 key，方案 B 后端广播 + 前端过滤）；SSE 帧格式加 `subId` 字段；新增 `DELETE /sse/subscriber/:subId`；前后端同步升级（混合版本不工作）。其余端点不变。统一字段名 `subId`（不用 `compId` / `subscriberId`）——「1 次订阅 = 1 个 sub id」，组件多次订阅各生成独立 subId 不撞车。
