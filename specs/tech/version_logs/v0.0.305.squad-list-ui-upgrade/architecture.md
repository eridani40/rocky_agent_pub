# v0.0.305 团队列表 UI 升级 — 架构设计

> 对应 PRD：`specs/prd/version_logs/v0.0.305.squad-list-ui-upgrade/prd.md`
> 产出物：本架构文档 + `change_plan.md`（method 级契约）+ `states/v0.0.305/task.json`

## 1. 核心设计决策

### D1：聚合服务 — 双入口共享核心纯函数

**`squad-aggregate-service`（新增 `app/server/src/squad/squad-aggregate-service.ts`）**：

```
computeSquadAggregates(deps, squadIds)  → Map<squadId, SquadAggregate>   // GET /squad 列表批量用
computeSquadAggregate(deps, squadId)    → SquadAggregate | null          // SSE broadcaster 单点用
aggregateFromViews(squad, members, sessionMap) → SquadAggregate          // 纯函数（UT 直接测）
```

- **批量入口**（GET /squad）：一次 `sessionStore.listSessions({ biz: 'studio' })` 全量拉 studio session，内存按 squadId 分组 → 单次遍历完成全部 squad 聚合。**避免 N+1**（`listSessionsBySquad` 内部是 crud.query 全量扫 + filter，N 个 squad = N 次全量扫）。
- **单点入口**（SSE）：`listSessions({ biz: 'studio' })` 一次拉全量 → 过滤目标 squadId（session 量小，单次扫可接受；与批量共用同一实现避免两套口径）。
- **口径统一（D2）**：核心 `aggregateFromViews` 只认 `squadChatSessionId + members[].sessionId` 这个 session 集合（seats 口径），不认 squadId 全匹配（会混入 subagent 子会话）。

### D2：字段口径 — 与 seats 面板完全一致（PRD §4.1/§4.3）

| 字段 | 口径 | 依据 |
|------|------|------|
| `onlineCount` | `members.filter(m => m.state === 'deployed').length` | use-seats-data.ts:194 同款 |
| `inProgressCount` | 遍历 `[squadChatSessionId, ...members[].sessionId]`，`state ∈ {running, interrupting, suspended}` 计数 | deriveInProgressCount 同款（含 suspended） |
| `lastActiveAt` | 上述 session 集合 `updatedAt` 最大值；集合空 → `squad.updatedAt` | PRD §4.1；恒有值可排序 |

**为什么不用 `listSessionsBySquad(squadId)` 全匹配**：subagent 派生会话也带 squadId，会多算 inProgressCount / lastActiveAt，与 seats 面板（只数 squadChat + members 直连 session）不一致。PRD 明确「与 seats 同口径」+「统一数据源，不各自算各自」→ 聚合服务与 seats 用同一 session 集合。

### D3：broadcaster — 仿 SessionMetaBroadcaster 自治订阅 statusBus

**`SquadMetaBroadcaster`（新增 `app/server/src/squad/squad-meta-broadcaster.ts`）**：

- 构造依赖：`sessionStore`（查事件 session 的 squadId + 拉 sessions 计算）、`squadStore`（getSquad）、`memberStore`（listMembers）、`squadMetaBus`（emit）。
- **事件→squad 路由**：收到 `session_status_update` 等事件（只有 sessionId，无 squadId）→ `sessionStore.getSession(sessionId)` → `s.squadId`；`null`（playground）跳过；非 null → `broadcast(squadId)`。
- **broadcast(squadId)**：读最新 squad + members + sessions → `computeSquadAggregate` → squad 不存在返回 null（并发删除）→ no-op；否则 emit `squad_meta_update` 到 `(squad_meta, _all)`。
- **触发集合**（对齐 SessionMetaBroadcaster META_TRIGGERING_TYPES 模式）：
  - `session_status_update`（状态 CAS，覆盖 run_start/run_end/busy 变化）
  - `summary_task_update`（压缩任务，updatedAt 推进）
  - `session_usage_update`（usage 变化）
  - `session_read_update` / `messages_cleared`（meta 变化，lastActiveAt 可能不变但无害）
  - 高频 `session_workspace_file_changed` **不触发**（同 SessionMetaBroadcaster 决策）
- **fan-out 注入**：扩展现有 `wrapStatusBusForUnread` 的 `WrapStatusBusOptions`，加 `squadMetaBroadcaster?` 字段；wrap 里 `squadMetaBroadcaster.handleSessionEvent(data)`。**不新增 wrap 层**（避免 wrap 嵌套叠加）。
- **无防抖**：对齐 SessionMetaBroadcaster 先例——session 状态事件本身低频（CAS 级），每次重算 1 个 squad（3 个 store 读）成本可接受。广播风暴防护靠「触发集合过滤 + 单点 fan-out」。
- **触发纪律（PRD §4.4.2）**：状态机/agent-loop 不感知 squad_meta；broadcaster 是 squad 层组件自治订阅。同步语义：写路径 await 落盘后再 broadcast（v0.0.163 race 教训）。

### D4：member / squad 写路径 — handler 层显式 broadcast

| 写路径 | 触发点 | 方式 |
|--------|--------|------|
| member hire | `member-hire-handler.ts handleHire` 成功后 | 显式 `broadcast(squadId)` |
| member deploy/bench | `member.ts handleDeploy/handleBench` 成功后 | 显式 `broadcast(squadId)` |
| member PATCH（name/intro 等） | `member.ts handlePatch` 成功后 | 不 broadcast（聚合不依赖这些字段） |
| squad create | `squad.ts handleCreateSquad` 成功后 | 显式 `broadcast(id)`（新 squad 聚合） |
| squad delete | `squad.ts handleDeleteSquad` 成功后 | 不 broadcast（前端 mutation 后 reloadSquads 兜底；squad 已删 broadcaster 算不出） |
| 新会话产生 | — | **不侵入 createSession**；新会话启动跑起后状态机 CAS → session_status_update 覆盖；idle 新会话不改变聚合（不在 busy 集合，updatedAt 不领先），GET /squad 初始已含 |

**注入方式**：`SquadHandlerDeps` 加 `squadMetaBroadcaster?`（可选，UT 兼容）；`dispatchSquadRoutes`（squad-routes.ts）装配时从 `bs` 透传；`bootstrap.ts` 构造 broadcaster 后写入 `BootstrapResult`。

### D5：SSE topic 装配 — 与 session_meta 同构

- **topic**：`squad_meta`；**group**：`_all`（共享广播）；**replayable**：`false`（快照态，初始走 GET /squad，同 session_meta §10.3）。
- **装配**：`bootstrap-bus-phase.ts` 注册 `squad_meta` topic（ReplayableEventBus non-replayable + wrapBusWithLog），返回 `squadMetaBus`。
- **白名单**：`handlers/sse.ts ALLOWED_TOPICS` 加 `'squad_meta'`；`sse-topic-whitelist.test.ts` 的 `TOPIC_VALUE_BY_IDENT` 加映射（双向对齐断言防 BUG-001 漏配）。
- **事件类型**（`session-event-types.ts` 或新 `squad-event-types.ts` 定义）：

```typescript
export interface SquadAggregate {
  squadId: string;
  onlineCount: number;      // member.state==='deployed' 数
  inProgressCount: number;  // busy session 数（running/interrupting/suspended）
  lastActiveAt: string;     // max(session.updatedAt) ?? squad.updatedAt
}

export interface SquadMetaUpdateEvent {
  id: string;               // 事件自身 ULID
  type: 'squad_meta_update';
  squadId: string;
  createdAt: string;
  data: SquadAggregate;     // 全量聚合 payload（非 diff）
}
```

**放哪**：新增 `app/server/src/squad/squad-event-types.ts`（squad 层事件类型独立文件，避免 session-event-types.ts 膨胀 + 语义归位）。`SQUAD_META_TOPIC = 'squad_meta'` + `SQUAD_META_BROADCAST_GROUP = '_all'` 同文件导出。

### D6：前端 useSquadMeta — page-studio 级单例 + 双数据源合并

**`useSquadMeta`（新增 `app/web/src/components/studio-page/use-squad-meta.ts`）**，仿 useStudioUnreadMeta：

```
useSquadMeta(reloadSquads) → { aggregateMap: Record<squadId, SquadAggregate> }
```

- **ctx**：`KeyedMap<squadId, SquadAggregate>`（applyKeyed set 纯 reducer）。
- **onInit**：`subscribe('squad_meta', '_all')` + 返空 map。
- **onEvent**：`squad_meta_update` → `applyKeyed({ op: 'set', key: data.squadId, value: data })`。
- **onResumed 断连兜底（PRD §6）**：`getSseClient().onResumed(() => reloadSquads())`——hook 收 `reloadSquads` 回调 prop（page-studio 的 useSquadMutations.reloadSquads），SSE 重连后全量拉 GET /squad 兜底（对齐 session_meta §10.3 模式）。
- **GET 初始值合并**：useSquadMeta 不持 squads（不重复拉）；page-studio 渲染时用统一 helper：

```typescript
// page-studio 或 hook 内
function getAgg(squadId: string, aggregateMap, squads): SquadAggregate | undefined {
  return aggregateMap[squadId] ?? squads.find(s => s.id === squadId) as SquadAggregate | undefined;
}
```

SSE 值优先，无则用 GET /squad 的 3 字段（旧后端无字段 → undefined → sidebar 降级不渲染第二行，PRD §6）。

### D7：GET /squad 列表聚合 + SquadSummary 扩展

- `handleListSquads`：`computeSquadAggregates(deps, squads.map(s => s.id))` → 合并进 `toSummary(s)`（3 个 optional 字段）。
- 后端 `SquadSummary` 加 `onlineCount? / inProgressCount? / lastActiveAt?`（optional，向后兼容）。
- 前端 `squad-api.ts listSquads()` 返回类型（squad-types.ts SquadSummary）同步加 3 个 optional 字段。

### D8：seats 统计条统一数据源

- SeatsPanel 统计条（当前 useSeatsData 内部自算 onlineCount/inProgressCount）改消费 `aggregateMap[squadId] ?? squads.find(id)`（page-studio props 下发）。
- **member 粒度坐席卡仍走 useSeatsData + stateMap**（粒度不同，不冲突，PRD §2.2）；只换统计条数字源。
- useSeatsData 的 stats.onlineCount/inProgressCount 保留（坐席卡/其他消费仍用），统计条渲染改取聚合。

## 2. 变更模块一览

| 模块 | 文件 | 要点 |
|------|------|------|
| squad 层新增 | `app/server/src/squad/squad-event-types.ts` | SQUAD_META_TOPIC + SquadAggregate + SquadMetaUpdateEvent |
| squad 层新增 | `app/server/src/squad/squad-aggregate-service.ts` | computeSquadAggregates / computeSquadAggregate / aggregateFromViews |
| squad 层新增 | `app/server/src/squad/squad-meta-broadcaster.ts` | SquadMetaBroadcaster（订阅 statusBus + 显式 broadcast 入口） |
| bus 装配 | `app/server/src/bootstrap-bus-phase.ts` | 注册 squad_meta topic + 返回 squadMetaBus |
| wrap 扩展 | `app/server/src/agent/session-unread-runtime.ts` | WrapStatusBusOptions 加 squadMetaBroadcaster + fan-out |
| store 装配 | `app/server/src/bootstrap-store-phase.ts` | 构造 SquadMetaBroadcaster + 注入 wrap |
| bootstrap | `app/server/src/bootstrap.ts` | BootstrapResult 加 squadMetaBroadcaster/squadMetaBus + 透传 |
| SSE 白名单 | `app/server/src/handlers/sse.ts` | ALLOWED_TOPICS 加 'squad_meta' |
| 白名单测试 | `app/server/src/__tests__/sse-topic-whitelist.test.ts` | TOPIC_VALUE_BY_IDENT 加映射 |
| squad handler | `app/server/src/handlers/squad.ts` | SquadSummary +3 字段；handleListSquads 聚合；handleCreateSquad broadcast；SquadHandlerDeps +broadcaster |
| member handler | `app/server/src/handlers/member.ts` + `member-hire-handler.ts` | deploy/bench/hire 成功后 broadcast |
| routes | `app/server/src/routes/squad-routes.ts` | SquadHandlerDeps 注入 broadcaster |
| 前端 hook | `app/web/src/components/studio-page/use-squad-meta.ts` | useSquadMeta（订阅 + onResumed 兜底） |
| 前端类型 | `app/web/src/components/studio-page/squad-types.ts` | SquadSummary +3 optional |
| 前端页面 | `app/web/src/components/studio-page/page-studio.tsx` | useSquadMeta 单例 + aggregateMap 下发 sidebar/seats |
| 前端 sidebar | `app/web/src/components/studio-page/section-studio-sidebar.tsx` | SquadRow 视觉升级 + 排序 + pin（见 change_plan B 组） |
| 前端 seats | `app/web/src/components/studio-page/component-seats-panel.tsx` | 统计条消费聚合数据 |

## 3. 风险与边界

- **N+1 已规避**：批量入口一次 listSessions 内存聚合。
- **subagent 会话污染已规避**：D2 口径只数 squadChat + members 直连 session。
- **广播风暴**：触发集合过滤 + 单点 fan-out；无防抖（对齐 session_meta 先例，状态事件低频）。
- **旧后端降级**：3 字段 optional；前端 `getAgg` 找不到 → sidebar 不渲染第二行 / 排序降级 updatedAt。
- **SSE 断连**：onResumed → reloadSquads 全量兜底。
- **squad 删除**：不推删除信号，前端 mutation 后 reloadSquads 兜底。
