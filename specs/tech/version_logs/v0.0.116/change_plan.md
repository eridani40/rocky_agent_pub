# v0.0.116 变更计划书 — 心跳 squad 级升级 + 团队成员状态记录（presence）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 本文件分两部分：**part1 = 后端（scheduling / squad-runtime / squad store / API / presence 工具 / reminder provider / prompt）**（本文件）；**part2 = 前端 + 类型 + 单元测试 + 禁改项 + 打包影响评估**（见 [`change_plan-part2.md`](change_plan-part2.md)）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（scheduling / squad-runtime / squad-store / squad-api / presence-tool / reminder / prompt / ui-* / types / ut） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

---

## 0. 五个开放点裁决结论（本轮冻结，已同步 spec）

| # | 开放点 | 裁决 | 依据（核对代码） |
|---|---|---|---|
| 1 | engine activeWindows 多段归属 | **engine 保持纯 isDue，不引 activeWindows[]**。engine `isDue` interval 分支只按 `lastFiredAt + ms` 判到点（现状）；heartbeat job 的 `schedule.activeWindow` 置 `undefined`（首 tick isDue=true，交 handler gate）。`activeWindows[]` 业务 gate **全下沉 `HeartbeatHandler.tryFire` gate1**，多段来源 = `getSquad()` 返回的 `SquadSnapshot.heartbeatConfig.activeWindows`（不进 payload、不进 engine types）。 | `engine.ts:isDue` interval 分支只读 `lastFiredAt/ms`；`types.ts:IntervalSchedule` 只有单 `activeWindow?`。扩 engine 会污染纯度（`index.md §④原则1 引擎不感知业务`）。 |
| 2 | team-status running 判定入口 | **`SquadReminderDeps`/`SquadContextService` 加 `isSessionRunning(sid)`**，bootstrap `setSquadReminderDeps` 注入 `(sid)=>store.getSession(sid).then(s=>s?.state==='running')`。口径同 `agentManager.isSessionBusy`（`session.state==='running'`）。 | `agent-manager.ts:505 isSessionBusy` 即 `session?.state==='running'`；bootstrap `setSquadReminderDeps`（bootstrap.ts:725）闭包内 `store`(SessionStore) 可用。 |
| 3 | scheduler.json v1→v2 迁移 | **读时忽略 v1 `roles{}` + 存时收敛 v2 平铺，NO 运行时 migration、NO version marker 一次性清理**。守运行时不破坏性清理铁律。 | memory `runtime-no-ext-policy-write`。旧 `roles{memberId}` 读到即当无 lastFiredAt（心跳从当前重排，最多漏一次）。 |
| 4 | presence UI 展示位（member-panel 当前任务） | **本版本不做 currentWork 只读展示**。member-panel「当前任务」保持占位（PRD 未强制；`member-panel.md §职责` 已写「当前任务（占位）」）。currentWork 仅进 `SquadDetail.members[]` 回显（数据就位，UI 展示留后续版本）。 | `member-panel.md §职责`「当前任务（占位）」；PRD §3.3 只要求「读走 GET /squad members[].currentWork 回显」，未要求 member-panel 渲染。 |
| 5 | tick message 承载 | **新增 `buildHeartbeatTickMessage(sessionId, at)`**（tick-message.ts），承载 §0.1 固定文案；不改 `buildTickUserMessage`（与 file-watch 共享，改它会污染 file-changed 分支）。 | `tick-message.ts:buildTickUserMessage` 为 scheduler+file-watch 共用，heartbeat 专属文案独立函数更清晰。 |

---

## 1. 后端 — scheduling 子系统（job 粒度 / payload / gate 链 / persistence v2）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| scheduling | app/server/src/scheduling/payloads.ts | `HeartbeatPayload` | 修改 | 去 `memberId`/`sessionId`，仅留 `{ squadId }`（成员在 fire 时按 scope 展开） | MUST 只带 squadId；MUST NOT 保留 memberId/sessionId | heartbeat_handler.md §0 表；data_model §1.1a | +2/-6 |
| scheduling | app/server/src/scheduling/types.ts | `IntervalSchedule` | 修改（保守） | 保持单 `activeWindow?`（heartbeat 不再用它）；**不引入 `activeWindows[]`**（开放点1裁决）。仅注释标 heartbeat 走 handler gate | MUST NOT 加 `activeWindows[]` 到 engine types（守引擎纯度） | 开放点1；index.md §④原则1 | +1/-0 |
| scheduling | app/server/src/scheduling/handlers/heartbeat-handler.ts | `HeartbeatHandlerDeps` | 修改 | 加 `listMembers(squadId): Promise<MemberSnapshot[]>`（逐成员展开用）；`isSessionBusy`/`deliverTo` 签名不变 | MUST 用注入 listMembers，不直接 new MemberStore | heartbeat_handler.md §2 | +4/-0 |
| scheduling | app/server/src/scheduling/handlers/heartbeat-handler.ts | `TickResultKind` | 修改 | 保留 `fired/skipped_window/skipped_budget/skipped_killswitch`；`skipped_busy` 降级为成员级 continue（不再 job 级 TickResult） | MUST 队级 gate 全通过即 `fired`；成员级 busy/benched/非白名单只 continue | heartbeat_handler.md §2 注意 | +0/-1 |
| scheduling | app/server/src/scheduling/handlers/heartbeat-handler.ts | `HeartbeatHandler.tryFire` | 修改 | 重写 squad 级 gate：gate0 killswitch → gate1 activeWindows 多段（`squad.heartbeatConfig.activeWindows.some(withinActiveWindow)`，空=全天放行）→ gate2 budget → 逐成员 filter（`scope.mode==='whitelist' && !memberIds.includes(m.id)` skip / `m.state!=='deployed'` skip / `!m.sessionId` skip / `isSessionBusy` skip）→ `deliverTo(m.sessionId, buildHeartbeatTickMessage(...))` | MUST 队级任一 gate 不过则整队 skip；MUST 多段来源 = getSquad 返回的 heartbeatConfig，不读 job.schedule.activeWindow；MUST NOT 绕过 deliverTo 直投 | heartbeat_handler.md §2 伪码；开放点1 | +30/-18 |
| scheduling | app/server/src/scheduling/handlers/heartbeat-handler.ts | `HeartbeatHandler.fire` | 修改 | payload downcast 去 memberId；落盘走 `stateStore.writeSquad(p.squadId, {...})`（squad 级，非 writeRole） | MUST fire 成功才 updateJobLastFiredAt；MUST 走 writeSquad | heartbeat_handler.md §3 | +3/-4 |
| scheduling | app/server/src/scheduling/handlers/heartbeat-handler.ts | `HeartbeatHandler.recordHistory` | 修改 | roleId 改记 `p.squadId`（squad 级一条），去 memberId | MUST NOT 依赖 payload.memberId | heartbeat_handler.md §2 recordHistory | +1/-2 |
| scheduling | app/server/src/scheduling/persistence/heartbeat-adapter.ts | `HeartbeatPersistenceAdapterDeps` | 修改 | 去 `listHeartbeatRoles`，改 `getHeartbeatConfig(squadId): Promise<{ config: SquadHeartbeatConfig; tz: string } | null>`（读 squad.heartbeatConfig + timezone） | MUST 单一源 squad.heartbeatConfig | heartbeat_handler.md §3 | +5/-4 |
| scheduling | app/server/src/scheduling/persistence/heartbeat-adapter.ts | `HeartbeatPersistenceAdapter.loadJobs` | 修改 | 返 0/1 squad 级 job：`getHeartbeatConfig(squadId)` 返配置（含 `heartbeatConfig=null` 时走默认 interval=15/[]/all，见 `projectSquadHeartbeatConfig`）→ 建 1 job；**enableHeartBeat 开关不在此拦**（killswitch 是每-tick 现取的动态 gate0，见 handler，非 loadJobs 静态判——避免开关切换需 reload）。仅 squad 不存在返 []。job=`buildSquadHeartbeatJob`（读 `stateStore.readSquad` 回填 lastFiredAt） | MUST 至多 1 job/squad；MUST NOT 用 enableHeartBeat 静态拦 loadJobs（killswitch 走 handler gate0 动态）；MUST NOT 建 per-member job | heartbeat_handler.md §3 loadJobs（收敛 coder 定位）；§0 killswitch 每tick现取 | +12/-11 |
| scheduling | app/server/src/scheduling/persistence/heartbeat-adapter.ts | `HeartbeatPersistenceAdapter.upsertJob` | 修改 | 走 `stateStore.writeSquad`（squad 级 lastFiredAt/lastResult） | MUST 仅 fire 成功调（caller 保证） | heartbeat_handler.md §3 | +4/-6 |
| scheduling | app/server/src/scheduling/persistence/heartbeat-adapter.ts | `removeJob`/`removeAllJobs` | 修改 | no-op 语义不变（stateStore 不删 lastFiredAt；teardown 走 disposeSquad） | MUST NOT 删 stateStore entry | heartbeat_handler.md §3 | +0/-0 |

---

## 2. 后端 — squad/scheduler 支撑（state v2 / tick message / snapshot 类型）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| scheduling | app/server/src/squad/scheduler/scheduler-state.ts | `SchedulerStateFileV2` | 新增 | 新 interface `{ version: 2; lastFiredAt: string | null; lastResult: SchedulerLastResult }`（squad 级平铺，去 roles 分桶） | MUST version=2 | heartbeat_handler.md §3 schema 演进 | +6 |
| scheduling | app/server/src/squad/scheduler/scheduler-state.ts | `SchedulerStateStore.readSquad` | 新增 | 读 scheduler.json：见 v2 平铺直接返；见 v1 旧 `roles{}` 结构 → **忽略**返 `{lastFiredAt:null}`（开放点3：不 migrate 不删） | MUST 忽略 v1 roles，返 null lastFiredAt；MUST NOT 破坏性清理 | heartbeat_handler.md §3；memory runtime-no-ext-policy-write | +12 |
| scheduling | app/server/src/squad/scheduler/scheduler-state.ts | `SchedulerStateStore.writeSquad` | 新增 | 写 v2 平铺结构（原子写覆盖旧文件，旧 roles 随之收敛消失=保存时收敛非运行时删） | MUST 写 version=2 平铺；MUST NOT 保留旧 roles | heartbeat_handler.md §3 | +10 |
| scheduling | app/server/src/squad/scheduler/scheduler-state.ts | `readRole`/`writeRole` | 删除 | per-member 分桶读写废弃（无 caller 后删净，不留僵尸） | MUST 删净所有 caller | 原则 delete-old-code-fully | +0/-14 |
| scheduling | app/server/src/squad/scheduler/tick-message.ts | `HEARTBEAT_TICK_PROMPT` | 新增 | 常量 = §0.1 权威文案（写死） | MUST 逐字对齐 §0.1；MUST NOT 改文案 | heartbeat_handler.md §0.1 | +4 |
| scheduling | app/server/src/squad/scheduler/tick-message.ts | `buildHeartbeatTickMessage` | 新增 | `(sessionId, at) => Message`：content=HEARTBEAT_TICK_PROMPT，role='user'，sender `{source:'system', system.kind:'heartbeat'}`，metadata.tickMessage=tickMessage(at,'heartbeat')。**不改** `buildTickUserMessage`（file-watch 共享） | MUST NOT 动 buildTickUserMessage；MUST 走 inbox enqueue 原语（role:'user'） | 开放点5；heartbeat_handler.md §0.1 | +20 |
| scheduling | app/server/src/squad/scheduler/types.ts | `SquadSnapshot` | 修改 | 加 `heartbeatConfig: SquadHeartbeatConfig | null`（handler gate1/scope 读） | MUST 含 heartbeatConfig；null=默认（interval15/全天/all） | data_model §1.1a | +2 |
| scheduling | app/server/src/squad/scheduler/types.ts | `SquadHeartbeatConfig` | 新增 | interface `{ interval:number; activeWindows:Array<{start;end}>; scope:{mode:'all'|'whitelist'; memberIds:string[]} }`（scheduler 层投影副本，或从 shared import；coder 定位单一源） | MUST 与 data_model §1.1a 字段一致 | data_model §1.1a | +8 |
| scheduling | app/server/src/squad/scheduler/types.ts | `MemberSnapshot` | 新增 | interface `{ id; sessionId?; state:'deployed'|'benched'; role }`（handler listMembers 逐成员展开用） | MUST 含 scope filter 所需字段 | heartbeat_handler.md §2 | +6 |
| scheduling | app/server/src/squad/scheduler/types.ts | `RoleHeartbeat` | 删除 | per-member 投影废弃（无 caller） | MUST 删净 caller | heartbeat_handler.md §5 | +0/-14 |

---

## 3. 后端 — squad-runtime（job 注册 / reload / listMembers 注入）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad-runtime | app/server/src/squad/squad-runtime-helpers.ts | `buildSquadHeartbeatJob` | 新增 | `(squadId, config:SquadHeartbeatConfig, tz, lastFiredAt) => Job`：id=`heartbeat:<squadId>`，schedule=`{kind:'interval', ms:(config.interval??15)*60000, tz}`（**不设 activeWindow**，activeWindows 走 handler gate），payload=`{squadId}`，owner=squadId | MUST id=`heartbeat:<squadId>`；MUST NOT 设 schedule.activeWindow；MUST NOT 建 per-member | heartbeat_handler.md §1；开放点1 | +18 |
| squad-runtime | app/server/src/squad/squad-runtime-helpers.ts | `heartbeatJobId` | 修改 | 签名改 `(squadId) => 'heartbeat:'+squadId`（去 memberId 段） | MUST 单参 squadId | heartbeat_handler.md §5 | +1/-3 |
| squad-runtime | app/server/src/squad/squad-runtime-helpers.ts | `buildHeartbeatJob` | 删除 | per-member job 构造废弃（被 buildSquadHeartbeatJob 取代） | MUST 删净 caller | heartbeat_handler.md §5 | +0/-26 |
| squad-runtime | app/server/src/squad/squad-runtime-helpers.ts | `projectMemberHeartbeat` | 删除 | per-member 投影废弃（member.heartbeat dead） | MUST 删净 caller | heartbeat_handler.md §5；data_model §1.2 | +0/-6 |
| squad-runtime | app/server/src/squad/squad-runtime-helpers.ts | `projectSquadSnapshot` | 修改 | 投影加 `heartbeatConfig: (squad.heartbeatConfig ?? null)`（cast，向前兼容旧 squad 无字段） | MUST 含 heartbeatConfig | data_model §1.1a | +2 |
| squad-runtime | app/server/src/squad/squad-runtime-helpers.ts | `SchedulerFacade`/`makeSchedulerFacade` | 修改 | 去 `reloadRole`（per-member 心跳废弃）；保留 `getHistory` | MUST NOT 保留 reloadRole | heartbeat_handler.md §5 | +2/-8 |
| squad-runtime | app/server/src/squad/squad-runtime-helpers.ts | `projectSquadHeartbeatConfig` | 新增 | `(squad) => { config:SquadHeartbeatConfig; tz } | null`：读 squad.heartbeatConfig（null→默认 interval15/[]/all），组合 timezone，供 adapter.getHeartbeatConfig | MUST null 走默认值 | data_model §1.1a §87 | +12 |
| squad-runtime | app/server/src/squad/squad-runtime.ts | `SquadRuntime.constructor` | 修改 | heartbeatAdapter deps 改注入 `getHeartbeatConfig: (sid)=>this.getHeartbeatConfig(sid)`（去 listHeartbeatRoles） | MUST 单一源 squad.heartbeatConfig | heartbeat_handler.md §5 | +2/-2 |
| squad-runtime | app/server/src/squad/squad-runtime.ts | `SquadRuntime.getHeartbeatConfig` | 新增 | 私有：读 squadStore.getSquad → projectSquadHeartbeatConfig（含 tz）；供 adapter | MUST 复用 projectSquadHeartbeatConfig | heartbeat_handler.md §5 | +6 |
| squad-runtime | app/server/src/squad/squad-runtime.ts | `SquadRuntime.listHeartbeatRoles` | 删除 | per-member 列举废弃 | MUST 删净 | heartbeat_handler.md §5 | +0/-10 |
| squad-runtime | app/server/src/squad/squad-runtime.ts | `SquadRuntime.reloadRole` | 删除 | per-member reload 废弃（reloadSquad 唯一心跳刷入口） | MUST 删净；getScheduler facade 同步去 reloadRole | heartbeat_handler.md §5 | +0/-26 |
| squad-runtime | app/server/src/squad/squad-runtime.ts | `SquadRuntime.registerHeartbeatJobs` | 修改 | 调 adapter.loadJobs 拿 0/1 squad job → 注入 tz → register（tz 后处理保留；activeWindows 不进 schedule） | MUST 至多 1 job/squad | heartbeat_handler.md §5 | +2/-4 |
| squad-runtime | app/server/src/squad/squad-runtime.ts | `SquadRuntime.reloadSquad` | 修改 | 保持 unregister+register 逻辑（现有）；成为 heartbeatConfig/enableHeartBeat/budget/tz 变更唯一实时刷入口 | MUST 是心跳配置唯一实时刷入口 | heartbeat_handler.md §5；11a §1.4 | +0/-0 |
| squad-runtime | app/server/src/squad/squad-runtime.ts | `SquadRuntime.getScheduler` | 修改 | facade 去 reloadRole 闭包（只透传 getHistory） | MUST NOT 传 reloadRole | heartbeat_handler.md §5 | +1/-3 |
| squad-runtime | app/server/src/squad/squad-runtime.ts | `SquadRuntime.shouldSchedule` | 修改 | 判条件去 member.heartbeat 探测；改 `squad.enableHeartBeat===true`（唯一条件；per-member 心跳废弃） | MUST 只看 enableHeartBeat | data_model §1.2 dead；heartbeat_handler.md §5 | +1/-6 |
| scheduling | app/server/src/scheduling/boot.ts | `bootScheduler`（HeartbeatHandler deps 装配段） | 修改 | HeartbeatHandler deps 加 `listMembers: (sid)=>memberStore.listMembers(sid).then(投影 MemberSnapshot[])`（memberStore 从 deps；boot 已有 squadStore/agentManager，需加 memberStore 入参） | MUST 注入 listMembers 投影；MUST NOT handler 内 new store | heartbeat_handler.md §2；boot.ts:176 | +10/-0 |
| scheduling | app/server/src/scheduling/boot.ts | `BootSchedulerDeps` | 修改 | 加 `memberStore`（HeartbeatHandler.listMembers 用）；bootstrap 传入 memberStoreForRuntime | MUST bootstrap 注入 | heartbeat_handler.md §2 | +3/-0 |
| bootstrap | app/server/src/bootstrap.ts | `bootScheduler` 调用点 | 修改 | 传 `memberStore: memberStoreForRuntime` 给 BootSchedulerDeps | MUST 复用已有 memberStoreForRuntime | bootstrap.ts:752 | +1/-0 |

---

## 4. 后端 — squad store schema（heartbeatConfig 读写 + currentWork + heartbeat dead）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad-store | app/server/src/agent/schema_defs/squad/squad.ts | `SquadSchema.fields.heartbeatConfig` | 新增 | `{ type:'json', required:false }`（SquadHeartbeatConfig \| null；容忍历史无字段） | MUST required:false | data_model §1.1a §87 | +5 |
| squad-store | app/server/src/agent/schema_defs/squad/member.ts | `MemberSchema.fields.heartbeat` | 修改 | 注释标 **dead**（[v0.0.116] 停读写，保留 schema 避免历史 record 迁移风险） | MUST 保留 schema；MUST NOT 代码读写 | data_model §1.2 dead | +1/-1 |
| squad-store | app/server/src/agent/schema_defs/squad/member.ts | `MemberSchema.fields.currentWork` | 新增 | `{ type:'json', required:false }`（presence：`{ text; updatedAt } \| null`） | MUST required:false | data_model §1.2b | +5 |

---

## 5. 后端 — squad API（PATCH /squad heartbeatConfig 校验 + 废弃 member heartbeat 端点 + SquadDetail 回显）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad-api | app/server/src/handlers/squad.ts | `PatchSquadBody` | 修改 | 加 `heartbeatConfig?: { interval; activeWindows; scope } \| null`（undefined=不改/null=清空回默认） | MUST 支持 null 语义 | 11a §1.4 | +1/-0 |
| squad-api | app/server/src/handlers/squad.ts | `validateHeartbeatConfig` | 新增 | 校验：interval∈{5,15,30,60}（非法→400）；activeWindows 每段 HH:mm 格式 + `start<end`（不跨0点，违反→400）+ **段间不重叠**（排序后相邻段 `prev.end<=cur.start`，重叠→400）；scope.mode∈{all,whitelist}（非法→400）+ whitelist 时 memberIds string[]。返 errorMsg\|null | MUST 400 覆盖：interval 非枚举 / 段重叠 / 单段 start>=end / 格式错 / scope.mode 非法；MUST NOT 暴露跨午夜 | 11a §1.4 错误；data_model §1.1a §85 | +40 |
| squad-api | app/server/src/handlers/squad.ts | `handlePatchSquad` | 修改 | body.heartbeatConfig!==undefined 时先 `validateHeartbeatConfig`（400 优先于 404）→ patch.heartbeatConfig 写入（null 直写）；写后 reloadSquad（现有）刷 job | MUST 400 字段级优先于 404；MUST 走 reloadSquad 实时刷 | 11a §1.4 | +8/-0 |
| squad-api | app/server/src/handlers/squad.ts | `SquadDetail`/`toDetail` | 修改 | SquadDetail 加 `heartbeatConfig`（含 null 回显）；members[] 天然含 currentWork（MemberEntity 已带新字段，无需改 toDetail） | MUST 回显 heartbeatConfig（含 null） | 11a §1.4 SquadDetail | +2/-0 |
| squad-api | app/server/src/handlers/squad.ts | `SquadSummary`/`toSummary` | 修改 | 不含 heartbeatConfig（summary 精简，仅 detail 回显） | MUST NOT 加到 summary | 11a §1.2 | +0/-0 |
| squad-api | app/server/src/handlers/squad-heartbeat-handler.ts | 整个文件 | 删除 | PATCH /squad/:id/member/:mid/heartbeat 端点废弃（member 无独立心跳）；含 `handleHeartbeatRoute`/`handlePatchHeartbeat`/`validateHeartbeat`/`PatchHeartbeatBody` 全删 | MUST 删净文件 + router 引用 | 11a §4.2 废弃；PRD §2.4 | +0/-128 |
| squad-api | app/server/src/router.ts | heartbeat route 分发（line 96 import + 535 调用） | 修改 | 删 `import handleHeartbeatRoute` + `return handleHeartbeatRoute(...)` 分支 | MUST 删净引用（否则 typecheck 断） | 11a §4.2 | +0/-3 |

---

> **续 part2**：presence 工具 / squad_team_status provider / prompt content / 前端 / 类型 / 单元测试 / 禁改项 / 打包影响评估 → [`change_plan-part2.md`](change_plan-part2.md)。
