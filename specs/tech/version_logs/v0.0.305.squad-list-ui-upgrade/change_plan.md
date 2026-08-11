# v0.0.305 变更计划书 — 团队列表 UI 升级（squad_meta SSE + 聚合服务 + sidebar 升级）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 详细设计见同目录 `architecture.md`（D1-D8）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

### A 组：squad 层新增（事件类型 + 聚合服务 + broadcaster）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad 层 | app/server/src/squad/squad-event-types.ts | SQUAD_META_TOPIC | 新增 | `export const SQUAD_META_TOPIC = 'squad_meta'` | MUST 值='squad_meta'（白名单/bus-phase 同值） | PRD §4.4.1；session-event-types.ts SESSION_META_TOPIC 同构 | +3 |
| squad 层 | app/server/src/squad/squad-event-types.ts | SQUAD_META_BROADCAST_GROUP | 新增 | `export const SQUAD_META_BROADCAST_GROUP = '_all'` | MUST 值='_all'（共享广播 group） | session-event-types.ts SESSION_META_BROADCAST_GROUP 同构 | +3 |
| squad 层 | app/server/src/squad/squad-event-types.ts | SquadAggregate | 新增 | `{ squadId: string; onlineCount: number; inProgressCount: number; lastActiveAt: string }` | MUST 三数字字段非 optional（聚合服务恒算全） | PRD §4.4.1 data schema | +6 |
| squad 层 | app/server/src/squad/squad-event-types.ts | SquadMetaUpdateEvent | 新增 | `{ id: string; type: 'squad_meta_update'; squadId: string; createdAt: string; data: SquadAggregate }` | MUST type='squad_meta_update'；data=全量聚合（非 diff） | PRD §4.4.1；SessionMetaUpdateEvent 同构 | +10 |
| squad 层 | app/server/src/squad/squad-aggregate-service.ts | SquadAggregateDeps | 新增 | `{ sessionStore: SessionStore; squadStore: SquadStore; memberStore: MemberStore }` 最小依赖接口 | MUST 只依赖三个 store（不依赖 handler/bus） | architecture D1；SessionMetaBroadcasterDeps 同构 | +6 |
| squad 层 | app/server/src/squad/squad-aggregate-service.ts | aggregateFromViews() | 新增 | 纯函数：`(squad, members, sessionMap) => SquadAggregate`。onlineCount=members.filter(state==='deployed').length；inProgressCount=遍历 [squadChatSessionId, ...members[].sessionId] 数 state∈{running,interrupting,suspended}；lastActiveAt=max(该集合 session.updatedAt) ?? squad.updatedAt | MUST 只数 squadChat+members 直连 session（**不得**用 squadId 全匹配——会混入 subagent 子会话，与 seats 口径不一致）；MUST 纯函数（无 IO，UT 直测） | PRD §4.1；use-seats-data.ts derivePresence/deriveInProgressCount 同口径 | +25 |
| squad 层 | app/server/src/squad/squad-aggregate-service.ts | computeSquadAggregate() | 新增 | `(deps, squadId) => Promise<SquadAggregate \| null>`：getSquad + listMembers + listSessions({biz:'studio'}) → 过滤目标 squadId 的 session 集合 → aggregateFromViews。squad 不存在返 null | MUST 一次 listSessions 拉全量后内存过滤（不 N+1）；MUST 返回 null 当 squad 删除（caller no-op） | architecture D1/D2 | +18 |
| squad 层 | app/server/src/squad/squad-aggregate-service.ts | computeSquadAggregates() | 新增 | `(deps, squadIds) => Promise<Map<squadId, SquadAggregate>>`：一次 listSessions({biz:'studio'}) 全量 → 内存按 squadId 分组 + listMembers 逐 squad → 批量聚合（GET /squad 用，避免 N+1） | MUST 单次 listSessions 完成全部 squad（不逐 squad 调 computeSquadAggregate） | architecture D1 | +25 |
| squad 层 | app/server/src/squad/squad-meta-broadcaster.ts | SquadMetaBroadcasterDeps | 新增 | `{ sessionStore; squadStore; memberStore; squadMetaBus: ReplayableEventBus }` | MUST 依赖最小（store + bus，不依赖 handler） | SessionMetaBroadcasterDeps 同构 | +8 |
| squad 层 | app/server/src/squad/squad-meta-broadcaster.ts | SQUAD_META_TRIGGERING_TYPES | 新增 | Set：`session_status_update` / `summary_task_update` / `session_usage_update` / `session_read_update` / `messages_cleared` | MUST 不含 `session_workspace_file_changed`（高频非 meta）；MUST 用 Set\<string\>（UT 可查任意字符串） | SessionMetaBroadcaster META_TRIGGERING_TYPES 同构 | +7 |
| squad 层 | app/server/src/squad/squad-meta-broadcaster.ts | SquadMetaBroadcaster.handleSessionEvent() | 新增 | 收 statusBus 事件：非触发类型 return；`sessionStore.getSession(event.sessionId)` → `s.squadId` 为 null（playground）return；非 null → `this.broadcast(squadId)` | MUST 事件只有 sessionId → 查 session 得 squadId 路由；MUST playground（无 squadId）跳过 | PRD §4.4.2；SessionMetaBroadcaster.handleSessionEvent 同构 | +12 |
| squad 层 | app/server/src/squad/squad-meta-broadcaster.ts | SquadMetaBroadcaster.broadcast() | 新增 | `(squadId: string) => void`：computeSquadAggregate → null（squad 已删）return → 组 SquadMetaUpdateEvent → `squadMetaBus.emit(SQUAD_META_BROADCAST_GROUP, { data: event, timestamp })`。异常吞（不影响调用方写路径） | MUST 每次读最新态（非缓存）；MUST 异常 try/catch 吞掉不 throw；MUST emit 到 `_all` group | SessionMetaBroadcaster.broadcast 同构；v0.0.163 race 教训 | +18 |

### B 组：bus 装配 + wrap 扩展 + bootstrap + 白名单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bus 装配 | app/server/src/bootstrap-bus-phase.ts | SQUAD_META_TOPIC const | 新增 | `const SQUAD_META_TOPIC = 'squad_meta'` + export（供白名单测试 import） | MUST 与 squad-event-types.ts 同值（import 复用或字面量一致） | bootstrap-bus-phase.ts PANORAMA_TOPIC 同构 | +2 |
| bus 装配 | app/server/src/bootstrap-bus-phase.ts | bootstrapBusPhase() | 修改 | 注册 squad_meta topic：`new ReplayableEventBus({ replayable: false })` + wrapBusWithLog + hub.registerTopic；返回 `squadMetaBus` | MUST replayable=false（快照态，初始走 GET /squad）；MUST 在 SseChannel 构造前注册 | session_meta bus 注册同构（§10.3） | +12 |
| wrap 扩展 | app/server/src/agent/session-unread-runtime.ts | WrapStatusBusOptions | 修改 | 加 `squadMetaBroadcaster?: SquadMetaBroadcaster` 可选字段 | MUST 可选（既有调用方零改动） | session-unread-runtime.ts:133 现状 | +2 |
| wrap 扩展 | app/server/src/agent/session-unread-runtime.ts | wrapStatusBusForUnread() | 修改 | wrap 的 fan-out 加 `if (opts.squadMetaBroadcaster) opts.squadMetaBroadcaster.handleSessionEvent(data)` | MUST 在 metaBroadcaster fan-out 之后调；MUST 异常吞掉不影响 emit 主路径；MUST NOT 新增 wrap 层（复用本 wrap 单点捕获） | architecture D3；session-unread-runtime.ts:152-180 现状 | +4 |
| store 装配 | app/server/src/bootstrap-store-phase.ts | bootstrapStorePhase() | 修改 | 构造 SquadMetaBroadcaster（注入 sessionStore/squadStore/memberStore/squadMetaBus）→ wrapStatusBusForUnread opts 加 squadMetaBroadcaster；返回结构加 `squadMetaBroadcaster` | MUST 在 wrap 之前构造（wrap 引用）；MUST store 构造后注入（broadcaster 依赖 store） | bootstrap-store-phase.ts:84-100 现状 | +10 |
| bootstrap | app/server/src/bootstrap.ts | BootstrapResult | 修改 | 加 `squadMetaBroadcaster: SquadMetaBroadcaster` + `squadMetaBus: ReplayableEventBus` 字段（透传 store-phase/bus-phase 产出） | MUST 字段 required（装配后恒有） | bootstrap.ts:133 panoramaBus 同构 | +3 |
| bootstrap | app/server/src/bootstrap.ts | bootstrap() | 修改 | bootstrapBusPhase 解构加 squadMetaBus；bootstrapStorePhase 返回解构加 squadMetaBroadcaster；写入 BootstrapResult | MUST 装配顺序：bus-phase → store-phase（broadcaster 依赖 bus） | bootstrap.ts:368-392 现状 | +4 |
| SSE 白名单 | app/server/src/handlers/sse.ts | ALLOWED_TOPICS | 修改 | 加 `'squad_meta'` | MUST 同步 bus-phase 注册（防 BUG-001 漏配） | sse.ts:19 现状 | +1 |
| 白名单测试 | app/server/src/__tests__/sse-topic-whitelist.test.ts | TOPIC_VALUE_BY_IDENT | 修改 | 加 `SQUAD_META_TOPIC` 映射 | MUST 从 bootstrap-bus-phase 或 squad-event-types import 真值 | sse-topic-whitelist.test.ts:40 现状 | +2 |

### C 组：squad/member handler 写路径 + GET /squad 聚合

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad handler | app/server/src/handlers/squad.ts | SquadSummary | 修改 | 加 `onlineCount?: number; inProgressCount?: number; lastActiveAt?: string`（optional） | MUST optional（向后兼容旧前端） | PRD §4.1 | +3 |
| squad handler | app/server/src/handlers/squad.ts | SquadHandlerDeps | 修改 | 加 `squadMetaBroadcaster?: SquadMetaBroadcaster` + `memberStore?: MemberStore`（memberStore 供聚合计算；现 makeStores 内部 new，需改注入） | MUST 可选（UT 兼容）；MUST NOT 改既有字段 | squad.ts:62-72 现状 | +2 |
| squad handler | app/server/src/handlers/squad.ts | handleListSquads() | 修改 | `computeSquadAggregates(deps, ids)` → 合并 3 字段进 toSummary 结果 | MUST 批量一次算（不逐 squad N+1）；聚合失败单个 squad 降级跳过（不 500） | architecture D1/D7 | +8 |
| squad handler | app/server/src/handlers/squad.ts | handleCreateSquad() | 修改 | 成功 return 前（transaction 完成后）调 `deps.squadMetaBroadcaster?.broadcast(created.squad.id)` | MUST await 落盘后再 broadcast（v0.0.163 race）；MUST 可选（undefined no-op） | PRD §4.4.2 | +2 |
| squad handler | app/server/src/handlers/squad.ts | handleDeleteSquad() | 修改 | **不 broadcast**（squad 已删 broadcaster 算不出；前端 mutation 后 reloadSquads 兜底） | MUST NOT 调 broadcast（明确不推删除信号） | PRD §4.4.2 | +0 |
| member handler | app/server/src/handlers/member-hire-handler.ts | handleHire() | 修改 | 成功 return 前调 `deps.squadMetaBroadcaster?.broadcast(squadId)` | MUST await 落盘后；MUST 可选 | PRD §4.4.2 | +2 |
| member handler | app/server/src/handlers/member.ts | handleDeploy() | 修改 | 成功 return 前调 `deps.squadMetaBroadcaster?.broadcast(squadId)` | MUST await 落盘后；MUST 可选 | PRD §4.4.2 | +1 |
| member handler | app/server/src/handlers/member.ts | handleBench() | 修改 | 成功 return 前调 `deps.squadMetaBroadcaster?.broadcast(squadId)` | MUST await 落盘后；MUST 可选 | PRD §4.4.2 | +1 |
| member handler | app/server/src/handlers/member.ts | handlePatch() | 修改 | **不 broadcast**（聚合不依赖 name/intro/skillConfig 字段） | MUST NOT 调 broadcast | PRD §4.4.2 | +0 |
| routes | app/server/src/routes/squad-routes.ts | dispatchSquadRoutes() | 修改 | SquadHandlerDeps 构造加 `squadMetaBroadcaster: bs.squadMetaBroadcaster` + `memberStore: bs.memberStore`（若有） | MUST 从 BootstrapResult 透传；MUST 可选兼容（bs 无字段时 undefined） | squad-routes.ts:54-64 现状 | +3 |

### D 组：前端 useSquadMeta + 类型 + page-studio + sidebar + seats

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-squad | app/web/src/components/studio-page/squad-types.ts | SquadSummary | 修改 | 加 `onlineCount?: number; inProgressCount?: number; lastActiveAt?: string` | MUST optional（旧后端无字段不 crash） | PRD §4.3 | +3 |
| ui-squad | app/web/src/components/studio-page/use-squad-meta.ts | SquadMetaCtx | 新增 | `{ aggregateMap: KeyedMap<squadId, SquadAggregate> }` | MUST 用 KeyedMap（applyKeyed set 幂等） | useStudioUnreadMeta StudioMetaCtx 同构 | +5 |
| ui-squad | app/web/src/components/studio-page/use-squad-meta.ts | SquadAggregate（前端类型） | 新增 | `{ squadId: string; onlineCount: number; inProgressCount: number; lastActiveAt: string }` | MUST 与后端 SquadAggregate 同构 | PRD §4.4.1 | +4 |
| ui-squad | app/web/src/components/studio-page/use-squad-meta.ts | useSquadMeta() | 新增 | `(opts: { reloadSquads: () => Promise<void> }) => { aggregateMap }`：onInit subscribe('squad_meta','_all') 返空 map；onEvent squad_meta_update → applyKeyed set；onResumed → void reloadSquads()（断连兜底） | MUST onInit 只 subscribe 不拉 GET（初始值由 page-studio squads 提供）；MUST onEvent 按 data.squadId 整条替换；MUST onResumed 注册 reloadSquads 兜底（防漏） | architecture D6；useStudioUnreadMeta 同构 | +40 |
| ui-squad | app/web/src/components/studio-page/page-studio.tsx | PageStudio() | 修改 | 调 `useSquadMeta({ reloadSquads })`（useSquadMutations 已返 reloadSquads）；`getAgg(squadId)` 合并 aggregateMap ?? squads 字段；`aggregateMap` + `getAgg` 经 props 下发 StudioSidebar + SeatsPanel | MUST page-studio 级单例订阅一次（非每组件各自订阅）；MUST SSE 值优先、GET 值兜底 | PRD §4.4.4 | +10 |
| ui-squad | app/web/src/components/studio-page/section-studio-sidebar.tsx | StudioSidebarProps | 修改 | 加 `aggregates: Record<squadId, SquadAggregate \| undefined>`（或 getAgg 回调） | MUST 不改既有 props 语义（squads/selectedSquadId/onSelectSquad/onNewSquad 不变） | PRD §3/§4.4.4 | +2 |
| ui-squad | app/web/src/components/studio-page/section-studio-sidebar.tsx | SquadRow（内部） | 修改 | 彩色字母头像（32×32 rounded-lg，首字符 + hashHueIndex(squad.id) 8 色）+ 两行布局（名字 15px semibold / `X 在线 · Y 工作中` 11px muted）+ Y>0 橙色脉冲点（animate-pulse + aria-hidden）+ pin 按钮（hover 显隐，visibility:hidden 占位） | MUST 复用 hue-hash hashHueIndex（INV-5 不重复实现）；MUST pin 按钮 visibility:hidden 预留槽位（禁 display:none）；MUST Y=0 无脉冲点 | PRD §3；temp/sidebar-design-options.html Option B | +40/-20 |
| ui-squad | app/web/src/components/studio-page/section-studio-sidebar.tsx | useSquadSorting（内部） | 新增 | 排序纯函数：置顶组（localStorage studio.squadPins 顺序）+ 非置顶组（lastActiveAt ?? updatedAt desc）；置顶组内部也按 lastActiveAt desc | MUST 排序键 lastActiveAt ?? updatedAt（旧后端降级）；MUST pin 组整体最前（组内仍按活跃）；MUST 未知 squadId 渲染时忽略（不写回） | PRD §5.1 | +25 |
| ui-squad | app/web/src/components/studio-page/section-studio-sidebar.tsx | togglePin() | 新增 | 点击 pin 按钮：读/写 localStorage `studio.squadPins`（JSON string[]，新 pin 插入头部；解析失败→[]）；立即重排；不触发 onSelectSquad | MUST 点击 pin 不触发选中（stopPropagation）；MUST localStorage 损坏→[]（不 crash） | PRD §5.2 | +15 |
| ui-squad | app/web/src/components/studio-page/component-seats-panel.tsx | SeatsPanel 统计条 | 修改 | 统计条 onlineCount/inProgressCount 改消费 props 传入的聚合数据（`getAgg(squadId)?.onlineCount ?? stats.onlineCount`）；member 粒度坐席卡仍走 useSeatsData | MUST 统计条与 sidebar 同源（统一数据源）；MUST 坐席卡粒度不变（不冲突） | PRD §4.3/§2.2 | +5/-3 |
| ui-squad | app/web/src/components/studio-page/use-seats-data.ts | stats 字段 | 修改 | 统计条消费走后 stats.onlineCount/inProgressCount 保留（坐席卡/其他消费仍用）或移除 | MUST NOT 破坏坐席卡渲染（成员粒度 stateMap 不变） | PRD §2.2 | +0 |
| ui-squad | app/web/src/components/studio-page/component-seats-panel.tsx | SeatsPanelProps | 修改 | 加聚合数据 prop（aggregates/getAgg） | MUST 可选（旧消费方兼容） | PRD §4.4.4 | +2 |
| i18n | app/web/src/locales/studio.*.json | sidebar.status / sidebar.pin / sidebar.unpin | 修改 | 新增 3 个 i18n key（zh/en 双语） | MUST 用 i18n 模板变量 {{online}}/{{working}} | PRD §3.3 | +6 |

## 影响面评估

- **跨模块**：squad 层（新增 3 文件）→ bus 装配（1 文件）→ wrap 扩展（1 文件）→ bootstrap（2 文件）→ SSE 白名单（2 文件）→ handler（4 文件）→ 前端（6 文件 + i18n 2 文件）。
- **破坏性变更**：无。所有新增字段/依赖 optional；SquadSummary 只加字段；SSE 新 topic 不影响旧订阅。
- **依赖顺序**：A 组（类型+服务+broadcaster）→ B 组（bus/wrap/bootstrap 装配）→ C 组（handler 写路径）→ D 组（前端）。后端完成 + 白名单同步后前端可并行。
- **风险点**：① N+1 已规避（批量一次 listSessions）；② subagent 会话污染（D2 口径钉死）；③ 广播风暴（触发集合过滤 + 单点 fan-out，对齐 session_meta 先例）；④ 断连恢复（onResumed → reloadSquads）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
