---
type: spec
title: Squad 聚合视图 + squad_meta 广播（squad-aggregate-service + squad-meta-broadcaster）
priority: P1
updated: 2026-08-09
---

# Squad 聚合视图 + squad_meta 广播

## ① 是什么

squad 聚合 = **从既有持久权威源（squad/member/session）实时派生的轻量视图**：`onlineCount`（deployed 成员数）/ `inProgressCount`（busy session 数）/ `lastActiveAt`（最后活跃时间）。聚合计算收敛为单一服务（GET /squad 列表 + SSE 推送共用），配合 `squad_meta` SSE topic 实时推送到前端 sidebar / seats 统计条。

| 概念 | 说明 |
|---|---|
| **squad-aggregate-service** | `app/server/src/squad/squad-aggregate-service.ts`——聚合计算服务（批量/单点双入口 + 纯函数核心） |
| **squad-meta-broadcaster** | `app/server/src/squad/squad-meta-broadcaster.ts`——squad 层广播器（订阅 statusBus + 写路径显式入口） |
| **squad_meta topic** | SSE topic（group=`_all`，replayable=false），事件类型 `squad_meta_update`，全量 payload |
| **useSquadMeta** | `app/web/src/components/studio-page/use-squad-meta.ts`——前端 page-studio 级单例订阅 hook |

## ② 聚合口径（D2 — 与 seats 面板完全一致）

| 字段 | 口径 | 依据 |
|------|------|------|
| `onlineCount` | `members.filter(m => m.state === 'deployed').length` | use-seats-data.ts 同款 |
| `inProgressCount` | 遍历 **直连 session 集合** `[squadChatSessionId, ...members[].sessionId]`，`state ∈ {running, interrupting, suspended}` 计数 | deriveInProgressCount 同款（含 suspended） |
| `lastActiveAt` | 直连 session 集合 `updatedAt` 最大值；集合空 → `squad.updatedAt`（恒有值可排序） | PRD §4.1 |

**核心不变量：只认直连 session 集合，不用 squadId 全匹配**——subagent 派生会话也带 `squadId`，全匹配会多算 inProgressCount / lastActiveAt，与 seats 面板（只数 squadChat + members 直连 session）不一致。PRD 明确「与 seats 同口径」+「统一数据源」→ 聚合服务与 seats 用同一 session 集合。

## ③ 聚合服务（squad-aggregate-service.ts）

```typescript
// 最小依赖接口：只依赖三个 store，不依赖 handler/bus
interface SquadAggregateDeps { sessionStore: SessionStore; squadStore: SquadStore; memberStore: MemberStore; }

aggregateFromViews(squad, members, sessionMap) → SquadAggregate   // 纯函数（无 IO，UT 直测）
computeSquadAggregate(deps, squadId)          → Promise<SquadAggregate | null>  // SSE 单点
computeSquadAggregates(deps, squadIds)        → Promise<Map<squadId, SquadAggregate>>  // GET /squad 批量
```

- **批量入口**（GET /squad）：一次 `sessionStore.listSessions({ biz: 'studio' })` 全量拉 studio session，内存按 squadId 分组 → 单次遍历完成全部 squad 聚合。**避免 N+1**（listSessionsBySquad 内部是 crud.query 全量扫 + filter，N 个 squad = N 次全量扫）。
- **单点入口**（SSE）：同一次 listSessions 全量 → 内存过滤目标 squadId（session 量小，单次扫可接受；与批量共用同一实现避免两套口径）。
- **降级**：squad 不存在（并发删除）→ `computeSquadAggregate` 返 null（caller no-op）；批量模式单个 squad 聚合失败 catch 降级跳过（不 500）。

## ④ broadcaster（squad-meta-broadcaster.ts）

仿 SessionMetaBroadcaster 自治订阅 statusBus（状态机 + agent-loop **不感知** squad_meta，不调 broadcaster）：

- **事件→squad 路由**：`handleSessionEvent(event)` 收 statusBus 事件（只有 sessionId，无 squadId）→ 触发类型集合过滤 → `sessionStore.getSession(sessionId)` → `s.squadId`；null（playground）跳过；非 null → `broadcast(squadId)`。
- **触发类型集合**（`SQUAD_META_TRIGGERING_TYPES`，Set\<string\>）：`session_status_update` / `summary_task_update` / `session_usage_update` / `session_read_update` / `messages_cleared`；高频 `session_workspace_file_changed` **不触发**（同 SessionMetaBroadcaster 决策）。
- **broadcast(squadId)**：读最新 squad + members + sessions → `computeSquadAggregate` → null（squad 已删并发）→ no-op；否则组 `SquadMetaUpdateEvent` → `squadMetaBus.emit(SQUAD_META_BROADCAST_GROUP, { data: event, timestamp })`。每次读最新态（非缓存）；异常 try/catch 吞掉不影响调用方写路径。
- **写路径显式触发**（handler 落盘后调 `deps.squadMetaBroadcaster?.broadcast(squadId)`，可选）：member hire / deploy / bench 成功后 + squad create 成功后。**不触发**：member PATCH（聚合不依赖 name/intro 字段）、squad DELETE（前端 mutation 后 reloadSquads 兜底）。同步语义：**await 落盘后再 broadcast**（v0.0.163 race 教训）。
- **循环依赖打破**：sessionStore 依赖 wrap（statusBusForStore），wrap 依赖 broadcaster → 构造时 sessionStore **延迟注入**（`setSessionStore`，store 构造后调）。未注入前 handleSessionEvent no-op（store 构造前 statusBus 无事件可达）。
- **无防抖**：session 状态事件本身低频（CAS 级），每次重算 1 个 squad（3 个 store 读）成本可接受。广播风暴防护靠「触发集合过滤 + 单点 fan-out」。

**fan-out 注入**：扩展现有 `wrapStatusBusForUnread` 的 `WrapStatusBusOptions` 加 `squadMetaBroadcaster?` 可选字段；wrap 里 `squadMetaBroadcaster.handleSessionEvent(data)`（异常吞掉不影响 emit 主路径）。**不新增 wrap 层**（避免 wrap 嵌套叠加）。

## ⑤ SSE topic 装配（squad_meta）

- **topic**：`squad_meta`（`squad-event-types.ts` 导出 `SQUAD_META_TOPIC`）；**group**：`_all`（`SQUAD_META_BROADCAST_GROUP`）；**replayable**：`false`（快照态，初始走 GET /squad）。
- **装配**：`bootstrap-bus-phase.ts` 注册 topic（ReplayableEventBus non-replayable + wrapBusWithLog + hub.registerTopic），返回 `squadMetaBus`；`bootstrap-store-phase.ts` 构造 SquadMetaBroadcaster 并注入 wrap；`bootstrap.ts` BootstrapResult 透传。
- **白名单**：`handlers/sse.ts ALLOWED_TOPICS` 加 `'squad_meta'`；`sse-topic-whitelist.test.ts` 的 `TOPIC_VALUE_BY_IDENT` 加映射（import 真值，双向对齐断言防漏配）。
- **事件类型**（`squad-event-types.ts`）：

```typescript
interface SquadAggregate {
  squadId: string;
  onlineCount: number;      // member.state==='deployed' 数
  inProgressCount: number;  // busy session 数（running/interrupting/suspended）
  lastActiveAt: string;     // max(直连 session.updatedAt) ?? squad.updatedAt
}
interface SquadMetaUpdateEvent {
  id: string;               // 事件自身 ULID
  type: 'squad_meta_update';
  squadId: string;
  createdAt: string;        // ISO 8601 UTC
  data: SquadAggregate;     // 全量聚合 payload（非 diff）
}
```

## ⑥ 前端消费（useSquadMeta — page-studio 级单例）

```typescript
useSquadMeta({ reloadSquads }) → { aggregateMap: Record<squadId, SquadAggregate> }
```

- **ctx**：`KeyedMap<squadId, SquadAggregate>`（applyKeyed set 纯 reducer，幂等）。
- **onInit**：`subscribe('squad_meta', '_all')` + 返空 map（**不拉 GET**——初始值由 page-studio squads 提供）。
- **onEvent**：`squad_meta_update` → `applyKeyed({ op: 'set', key: data.squadId, value: data })` 整条替换。
- **onResumed 断连兜底**：`getSseClient().onResumed(() => reloadSquads())`——SSE 重连后全量拉 GET /squad 兜底（对齐 session_meta §10.3 模式）。用 ref 保持 reloadSquads 最新引用（onResumed 注册一次，回调内读 ref）。
- **GET 初始值合并**：page-studio 渲染用统一 helper `getAgg(squadId) = aggregateMap[squadId] ?? squads.find(s => s.id === squadId)`（SSE 值优先，GET 兜底；旧后端无字段 → undefined → sidebar 不渲染第二行 / 排序降级 updatedAt，PRD §6）。
- **单例理由**：page-studio 级订阅一次（useSquadMeta），sidebar/seats 经 props 消费（`getAgg` 回调）——避免 N 个组件各自 subscribe 同 topic（SSE 连接复用但 handler 重复、状态分裂）；对齐 useStudioUnreadMeta 模式。

## ⑦ 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| squad 聚合视图计算 + squad_meta SSE 广播（服务 + broadcaster + 前端 hook） | session_meta / 其他 SSE topic（→ `specs/tech/app/frontend/[P0]sse_channel.md`） |
| 聚合口径（直连 session 集合） | squad/member/session entity + 写事务（→ `[P1]data_model.md`） |
| pin 置顶 / sidebar 排序（消费聚合数据） | sidebar 视觉基线（→ `specs/ui/components/studio-page/studio-sidebar.md`） |

- **无聚合数据持久化**：squad 聚合是实时派生状态（内存 + 每次计算），不写盘（session/member 是持久权威源，聚合可从它们重算；重启后 GET /squad 全量重算兜底）。
- **SquadSummary 3 字段 optional**（向后兼容旧前端/旧后端）；SquadDetail 不加字段（仅列表聚合）。
