# session_meta 广播 topic 决策记录（v0.0.27）

> 背景缺口：v0.0.27 后端 unread 字段 + 产生/消除逻辑（session 层 event-driven）已实现且 5 个真 LLM API case 全 PASS。**但 E2E 揭示真实缺口**——前端会话列表（左侧常驻 conv-panel）只在挂载时 `GET /session` 拉一次；后台 session 完成时前端收不到通知（session_status_update 是 per-session 订阅 `session_id:<sid>`，列表只订 active session 的 group），→ 后台完成的 session 的红点**不实时出现**。
> 用户锁定方向：新增 `session_meta` **广播 topic**，承载「session 变了」的通知；会话列表订阅它实时刷新。
> 本文档记录关键设计决策的「为什么」。

## 1. 为什么是「广播 topic」而非「per-session 订阅」

用户定调：「unread 是 meta 的一部分」「列表订阅」。

- **per-session 订阅**（如复用 `session_panel:session_id:<sid>`）要求列表前端为每个 session 各 subscribe 一次 → N 个订阅、N 个 hub 消费循环、N 次切会话 unsubscribe。session 数量增长时线性膨胀。
- **广播 topic**：列表前端订阅**一次**即收所有 session 的 meta 变更。订阅复杂度 O(1)，与 session 数量解耦。
- 语义对齐：「会话列表关心所有 session 的 meta」是单一关注点，一个订阅表达。

结论：新增独立 topic `session_meta`，列表订阅一次。

## 2. 为什么是「共享广播 group `_all`」而非「wildcard 订阅」

**传输层既定约束（勘探确认，本节如实说明，不提议改传输层）**：

- `ReplayableEventBus`（`app/server/src/agent/event-bus.ts`）的 `groups: Map<string, GroupState>` 是 **per-group 分区**——`emit(group, event)` 只写入 + fan-out 给**该 group 的订阅者**；`subscribe(group)` 只回放 + 收**该 group**的事件。
- **无原生 wildcard**：没有「订阅所有 group」「不带 group 订阅」的能力。group 是必填的分区 key，bus 不感知业务（session/agent），只认字符串。
- 同理 `EventHub.sub(topic, group, listener)` 也要求 group 显式字符串。

落地选择：**所有 session 的 meta 变更都 emit 到同一个共享 group `_all`**，列表订阅 `(session_meta, _all)` 一次即收所有 session 的 meta。

- `_all` 是约定常量（非特殊语法），bus 不感知其语义，与其他 group 字符串等价。
- 不引入「订阅时 SID 列表」预知问题（列表前端不知道有哪些 session 会变，broadcast 模型天然不需预知）。
- 复用现有 bus 分区机制，零传输层改动。

> 不提议改传输层加 wildcard（`subscribe(*)`）—— 会破坏 group 分区语义、影响 agent_loop replay buffer 隔离、波及面过大。共享 group `_all` 是最小代价达成 broadcast 的方式。

## 3. 为什么是「全量最新态 payload」而非「部分 diff」

用户定调（三次强调）：「通知是 session 整个最新状态」「状态和 meta 变了都要通知」。

- **diff/部分字段** payload（如只发 `{unread: true}` 或 `{state: running}`）要求前端 reducer 维护 per-field merge 逻辑、还要追踪「上次完整态」用于合并 → 复杂、易错（漏字段、合并冲突）。
- **全量最新态** payload（`SessionMetaView` = session 完整 meta 视图）→ reducer 收到后**按 sessionId 整条替换**列表条目，无需 merge、无需追踪中间态。
- 通用性：「状态和 meta 变了都要通知」→ 无论哪个字段变了（unread / running / title / summaryTask / usage / workspaceDir），都发同一个 `session_meta_update`，payload 是当时的完整最新态。前端不关心「变了什么」，只关心「现在是啥」。
- 对齐 `GET /session` 返回 shape：`SessionMetaView` = `GET /session` 返回的 session 对象 shape（id/title/state/running/currentRunId/unread/summaryTask/workspaceDir/createdAt/updatedAt 等 list + 状态展示所需字段；**不含 transcript 消息体**）。reducer 整条替换后，列表条目与 `GET /session` 拉取的条目 shape 一致 → 列表始终是权威最新态。

## 4. 触发时机全集（读代码核实，见下表）

任何 session 状态 OR meta 变更都触发一次 `session_meta_update` 广播。下表是经勘探核实的**全量** session 变更写点：

| 变更写点 | 经 statusBus? | 触发广播? | 经谁触发广播 |
|---|---|---|---|
| 状态机 `markRunning` CAS 成功 → emit `session_status_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| 状态机 `markInterrupting` CAS 成功 → emit `session_status_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| 状态机 `markInterrupted` CAS 成功 → emit `session_status_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| 状态机 `markIdle` CAS 成功 → emit `session_status_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| 状态机 `markError` CAS 成功 → emit `session_status_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `reconcileOnStartup` 每个 orphan → emit `session_status_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `markSummaryRunning` CAS 成功 → emit `summary_task_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `markSummaryDone` CAS 成功 → emit `summary_task_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `markSummaryFailed` CAS 成功 → emit `summary_task_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `markSummaryIdle` CAS 成功（手动复位 / 调试） → emit `summary_task_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `reconcileSummaryTaskOnStartup` 每个 orphan（status=running→idle） → emit `summary_task_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `accumulateUsage` / `updateContextWindowUsage` → emit `session_usage_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `clearSession` → emit `session_status_update` + `session_usage_update` + `messages_cleared`（三事件，见 session_event.md §3） | ✅ | ✅ | broadcaster（statusBus wrap 捕获；多个事件触发多次 broadcast 但每次都读最新态，幂等无害） |
| `setWorkspaceDir` → emit `session_workspace_dir_changed` | ✅ | ✅ | broadcaster（statusBus wrap 捕获；workspaceDir 是 SessionMetaView 字段） |
| chokidar fs event → emit `session_workspace_file_changed` | ✅ | ⚠️ 可选不触发 | 见下注 |
| **`markRead`** CAS 成功 → emit `session_read_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| **`markUnreadTrue`**（产生未读，session-unread-runtime 内 CAS，**不经 statusBus**） | ❌ | ✅ | **`SessionUnreadRuntime.markUnreadTrue` CAS 成功后直接调 `broadcaster.broadcast(sid)`** |

### 4.1 [v0.0.47 补强] title 突变触发广播

v0.0.27 决策时 SessionMetaView 的 title 字段只随状态机事件附带变更（state/usage 等 broadcast 时 crud 读最新态顺带带新 title）；但**直接 PUT /session/:id body.title 改 title** 是纯 `store.updateSession({title})` CRUD 写，不经 statusBus → broadcaster 不会捕获 → 前端列表不刷新（conv-item title 不更新，多 tab 不同步）。v0.0.47 补强：

| 变更写点 | 经 statusBus? | 触发广播? | 经谁触发广播 |
|---|---|---|---|
| **[v0.0.47]** `updateSession({title, titled:true})`（PUT /session/:id body.title 路径，`session-update.ts:76-80` + `session.ts:165-191`；titled 同步置 true 防覆盖） | ❌ | ✅ | **handler 写完直接调 `broadcaster.broadcast(sid)`** |
| **[v0.0.47]** `updateSession({title, titled:true})`（AI 起名 service 应用路径，`auto-naming-service.ts`，CAS `titled===false → true`） | ❌ | ✅ | **`AutoNamingService.applyAiName` CAS 成功后直接调 `broadcaster.broadcast(sid)`**（runtime 自治直调，同 markUnreadTrue 模式；详见 `specs/tech/agent/auto_naming/[P0]auto_naming_service.md §3`） |

> **不变量补充**：title 突变不经 statusBus（statusBus 只承载 SessionEvent 联合，title 更新不是 SessionEvent），故走 handler/service 直调 broadcaster 路径（与 markUnreadTrue 同构）。其他经 statusBus 的触发不变（broadcaster 通过 statusBus wrap 单点捕获）。

> **chokidar fs event（`session_workspace_file_changed`）可选**：是 workspace 内**文件**变化（非 session meta 本身变化），列表红点/running/title 不依赖它。是否触发广播由实现决定（建议不触发，避免高频文件变化刷爆广播；workspace 变化由 ws-panel 自己订阅 `session_panel:<sid>` 处理，与列表无关）。**session_workspace_dir_changed（切目录）触发广播**（workspaceDir 是 SessionMetaView 字段）。

> **不变量**：除 `markUnreadTrue`（runtime 自治直接调 broadcaster）外，所有触发都经 statusBus wrap 单点捕获——无遗漏、无重复（每个 statusBus.emit 触发恰好一次 broadcast）。

## 5. Producer 归属：session 层（SessionMetaBroadcaster），状态机 + agent-loop 纯粹

**硬约束（用户三次纠正）**：状态机、agent-loop **不感知** session_meta / 不调 broadcaster。

设计：
- 新增 session 层组件 `SessionMetaBroadcaster`，持 `crud`（读最新 session record）+ `sessionMetaBus`（emit 到 `session_meta` 的 `_all` group）。
- 方法 `broadcast(sessionId)`：读最新 session record → 组装 `SessionMetaView` → emit `session_meta_update` 到 `(session_meta, _all)`。

**触发接线（最干净路径）**：
- **复用并泛化现有 `wrapStatusBusForUnread`**（`app/server/src/agent/session-unread-runtime.ts`）→ 扩展为同时 fan-out 给 `SessionUnreadRuntime`（既有）**和** `SessionMetaBroadcaster`：wrap 在 statusBus 的 emit 入口，对**任何**经过 statusBus 的 session 事件（`session_status_update` / `summary_task_update` / `session_usage_update` / `session_read_update` / `messages_cleared` / `session_workspace_dir_changed`）→ 调 `broadcaster.broadcast(event.sessionId)`。状态 CAS / summary / usage / read / clear / dir 全部经由 statusBus，**单点捕获**。
- **unread 产生**（`markUnreadTrue`，不经 statusBus）→ 由 `SessionUnreadRuntime` 在 `markUnreadTrue` CAS 成功后**直接调** `broadcaster.broadcast(sid)`（产生路径是 runtime 自己的，自然在那里触发）。

**为什么这样设计**：
- 状态机继续纯 CAS + emit `session_status_update`（v0.0.12 既有行为，零改动）。
- agent-loop 继续只调 `markIdle`/`markError`（v0.0.27 已还原纯粹）。
- broadcaster 是状态机之上的 session 层组件，订阅 statusBus 信号自治——与 SessionUnreadRuntime 同构（都是 session 层订阅者）。
- 复用现有 `wrapStatusBusForUnread` 注入点（bootstrap 已 wire），泛化为多 fan-out，零新协议、零状态机接口改动。

## 6. 与 session_panel 各干各的

- **chat 页（active session）**：保持 `session_panel:session_id:<sid>` per-sid 订阅不动。session_panel 所有现有消费者（chat 页 sessionRunning / workspace watch 钩子 / usage / summaryTask / session_read_update）**零改动**。
- **会话列表（conv-panel / page-chat 挂载时）**：subscribe `(session_meta, _all)` 一次。
- 两个 topic 各自独立路由：`session_panel`（per-sid，replayable）服务 active session 详情；`session_meta`（broadcast `_all`，**non-replayable**）服务列表增量。
- **replayable 差异**：`session_panel` replayable=true（chat 页 subscribe 在 run 启动后也能补收）；`session_meta` **replayable=false**（列表初始态靠挂载时 `GET /session` 拉全量，只需订阅后的增量，避免回放陈旧 meta——列表挂载时若回放历史 meta 会与刚拉的 `GET /session` 全量冲突/抖动）。

## 7. SSE 白名单

`app/server/src/handlers/sse.ts` 的 `ALLOWED_TOPICS` 加 `'session_meta'`（spec 的 api 侧同步）。

## 8. 决策小结

| 决策点 | 选择 | 理由 |
|---|---|---|
| topic 模型 | 独立广播 topic `session_meta` | 列表订阅一次即收所有；与 session_panel per-sid 解耦 |
| group 模型 | 共享广播 group `_all` | 传输层 group 分区约束（无 wildcard）；最小代价达成 broadcast |
| payload 模型 | 全量最新态 `SessionMetaView` | 用户定调「整个最新状态」；reducer 整条替换，通用、无 merge 复杂度 |
| 触发时机 | 任何 session 状态 OR meta 变更 | 用户定调「状态和 meta 变了都要通知」；通用 |
| producer 归属 | session 层（SessionMetaBroadcaster） | 状态机 + agent-loop 纯粹（硬约束） |
| 触发接线 | 复用 `wrapStatusBusForUnread` 泛化 + runtime 直调 | 单点捕获 statusBus；unread 产生 runtime 自治 |
| replayable | false（session_meta） | 列表初始态靠 GET /session 拉全量；只需增量，避免陈旧回放 |
| 与 session_panel 关系 | 各干各的（chat 页 session_panel 不动） | 零改动现有消费者 |
