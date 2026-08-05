---
type: interface
title: Session Event（session_panel + session_meta）
priority: P0
status: active
updated: 2026-07-31
since: v0.0.8
---

# Session Event

> **事件声明**（规范见 `../event/[P0]event_convention.md`）：
> - **依赖**：event_bus（transport）+ event_hub（路由），见 `../event/`
> - **topic**：`session_panel`（per-sid，**non-replayable**[v0.0.30]：bootstrap.ts:267 `new ReplayableEventBus({ replayable: false })`，与 session_meta 同；初始态靠 GET /session + GET /session/:id/usage 拉。chat 页 / workspace watch / usage 面板消费）
> - **topic**：`session_meta`（**[v0.0.27]** 广播，**non-replayable**，共享 group `_all`，会话列表消费——见 §3a）
> - **group（session_panel）**：`session_id:<sid>`（per-sid 分区）
> - **group（session_meta）**：`_all`（**共享广播 group**——所有 session 的 meta 变更都 emit 到此 group，列表订阅一次即收所有；传输层 `ReplayableEventBus` group 间完全隔离、无 wildcard，故用共享 group 达成 broadcast，见 §3a + decision.md §2）
> - **producer**：session 内部（SessionUsage 接口实现——**[v0.0.44]** `session_usage_update` 由**独立方法** `notifyUsageChanged(sid)` 发（读 `getUsageView(sid)` 全量 view 后 emit）；write ops `accumulateUsage` / `updateContextWindowUsage` **不再 emit**——见 §3；状态机 API markRunning/markInterrupting/markInterrupted/markIdle/markError/reconcileOnStartup 完成后触发；markRead 标读完成后触发；**[v0.0.27]** 未读产生 unread=true **不发** `session_read_update` 事件——见 §3。**[v0.0.27]** session 层 `SessionMetaBroadcaster` 订阅 statusBus 信号 → emit `session_meta_update` 到 `(session_meta, _all)`——见 §3a）
> - **bus 持有者**：session runtime（持有 session 侧 bus；具体组件待 session 生命周期 spec 明确）
> - **Event 类型**：`SessionEvent`（§2 联合，session_panel topic）；`SessionMetaEvent`（§3a，session_meta topic）
>
> session 面板（`session_panel`）的消息流——session 自身 meta 类信息的变更通知，供面板 UI 刷新。与 agent 进度流（topic=`agent_loop`）区分：本流是 session 维度的低频 meta 变更（usage / status 等），不是 agent run 的流式进度。usage 数据所有权见 `[P0]session_usage.md`；SessionUsageView 类型同引用。状态机字段（state/running/currentRunId）权威见 `[P0]session_state.md`。

## 1. 定位

SessionEvent 是 **session 内部**在 meta 变更时发出的事件，通知 session 面板订阅方刷新。它**不是外部接口**——由 session 的独立通知方法（`notifyUsageChanged` 等，v0.0.44）或状态机 CAS API 在完成后内部触发。

发布路径：
```
调用方（context / agent loop）先调 write ops（accumulateUsage / updateContextWindowUsage，静默不 emit）
  → write 完成后调 notifyUsageChanged(sid)（session 内部读 getUsageView(sid) 全量 view）
  → 内部构造 SessionEvent
  → bus.emit(`session_id:<sid>`, event)        // event_bus transport
  → 经 EventHub 注册的 emitter 透给订阅方：hub.sub("session_panel", `session_id:<sid>`, listener)
```

> topic=`session_panel`、group=`session_id:<sid>` 是约定（见 event_convention §3）。基础设施不感知 session，只认 (topic, group) 字符串。

## 2. SessionEvent 类型

`type` 联合，按变更类别区分；后续扩展更多类型（session status / meta / ...）。

```typescript
interface SessionEventBase {
  sessionId: string;          // 变更的 session（也编码在 group 里，冗余便于消费方直接取）
  type: SessionEventType;     // 变更类别（discriminated union key）
  createdAt: string;          // ISO 8601 UTC
}

type SessionEventType =
  | "session_usage_update"            // usage 变更
  | "session_status_update"           // [v0.0.12] 运行态变更（state/running/currentRunId）
  | "summary_task_update"             // [v0.0.13] summaryTask 旁路状态变更（D2.6）
  | "session_workspace_file_changed"  // [v0.0.17] workspace 文件变化（chokidar 检测到 add/change/unlink/addDir/unlinkDir）
  | "session_workspace_dir_changed"   // [v0.0.17] workspace 切换目录（PUT /session/:id 改 workspaceDir）
  | "session_read_update"             // [v0.0.27] 已读水位线变更（markRead 后触发，见 §2 SessionReadUpdateEvent）
  | "messages_cleared"                // [v0.0.16] session 清空（clearSession 后触发，见 §2 MessagesClearedEvent）
  | "session_todo_changed"            // [v0.0.228] todo 变更轻量信号（TodoStore 写成功后触发，见 §2 SessionTodoChangedEvent）
  | string;                           // 预留扩展

// ── session_usage_update：usage 变更（accumulateUsage / updateContextWindowUsage 后触发）──
interface SessionUsageUpdateEvent extends SessionEventBase {
  type: "session_usage_update";
  data: SessionUsageView;     // 整个 usage 视图（见 session_usage.md §8）
}

// ── session_status_update：运行态变更（v0.0.12 新增；状态机 API 写完成后触发）──
interface SessionStatusUpdateEvent extends SessionEventBase {
  type: "session_status_update";
  data: SessionStatus;        // 当前运行态快照（state/running/currentRunId）
}

/** session 运行态快照（见 session_store.md §2 Session 字段 + session_state.md） */
interface SessionStatus {
  state: "idle" | "running" | "interrupting" | "interrupted" | "error";
  running: boolean;
  currentRunId: string | null;
}

// ── summary_task_update：后台任务状态变更（compact / tier1 整理 / 同类；v0.0.13 新增 D2.6，v0.0.55 一度删除，v0.0.78.bug 恢复）──
interface SummaryTaskUpdateEvent extends SessionEventBase {
  type: "summary_task_update";
  data: SessionTaskState;      // 当前 (sid, taskType) 任务快照（类型见 session_task_lock.md §2）
}

/**
 * [v0.0.78.bug] data 用 `SessionTaskState`（定义见 session_task_lock.md §2）：
 *   { status: 'idle'|'running'|'done'|'failed'; runId?; startedAt?; error? }
 * 字段为 optional（与 SessionTaskLock 内存态对齐）；emit 时点会填全 4 字段（idle 态用 IDLE_STATE 常量）。
 *
 * 事件名保留 `summary_task_update`（不改为 compact_task_update）的决策见
 * specs/tech/version_logs/v0.0.78.bug/change_log.md §决策：「最小变更恢复 SSE」+ 前端契约/spec 历史命名零改动。
 */

type SessionEvent = SessionUsageUpdateEvent | SessionStatusUpdateEvent | SummaryTaskUpdateEvent | SessionWorkspaceFileChangedEvent | SessionWorkspaceDirChangedEvent | SessionReadUpdateEvent | MessagesClearedEvent | SessionTodoChangedEvent;

// ── session_workspace_file_changed：workspace 文件变化（v0.0.17 新增；SessionWorkspaceManager.handleFsEvent 处理后触发，见 [P0]session_workspace_manager.md §6）──
interface SessionWorkspaceFileChangedEvent extends SessionEventBase {
  type: "session_workspace_file_changed";
  data: {
    path: string;                     // 相对 workspaceDir 的相对路径（前端 join 后 GET 子目录重拉；非绝对路径，防泄漏）
    kind: "add" | "change" | "unlink" | "addDir" | "unlinkDir";   // chokidar eventName 映射，见 manager spec §6
    isDir: boolean;                   // addDir/unlinkDir → true；add/change/unlink → false（冗余便于消费方分支）
  };
}

// ── session_workspace_dir_changed：workspace 切换目录（v0.0.17 新增；SessionStore.setWorkspaceDir 完成后触发，见 [P0]session_workspace.md §4）──
interface SessionWorkspaceDirChangedEvent extends SessionEventBase {
  type: "session_workspace_dir_changed";
  data: {
    workspaceDir: string;             // 新的 workspaceDir（绝对路径）
    prevDir: string | null;           // 旧 workspaceDir（首次设为 null）
  };
}

// ── session_read_update：未读状态变更（v0.0.27 explicit-bool；markRead 完成后触发，见 session_state.md §6）──
interface SessionReadUpdateEvent extends SessionEventBase {
  type: "session_read_update";
  data: SessionReadState;             // 标读后的未读状态快照（unread=false）
}

/** [v0.0.27] 未读状态快照（字段见 session_store.md §2 + session_state.md §6） */
interface SessionReadState {
  unread: boolean;                    // 标读后必为 false（消除未读的唯一事件来源是 markRead）
}

// ── messages_cleared：session 清空（v0.0.16 新增；session_clear.md §5 step4）──
interface MessagesClearedEvent extends SessionEventBase {
  type: "messages_cleared";
  data: Record<string, never>;        // 空对象（事件本身即「该 session 全清」语义，sessionId 在事件顶级）
}

// ── session_todo_changed：todo 变更轻量信号（v0.0.228 新增；TodoStore.upsertItem/removeItem/cleanupFinished 写成功后触发，见 [P1]todo_tools.md §4/§7）──
interface SessionTodoChangedEvent extends SessionEventBase {
  type: "session_todo_changed";
  data: Record<string, never>;        // 空对象（轻量信号不携带 todo 数据；消费方收事件后重拉 GET /session/:id/todos 全量——todo 规模小，重拉代价可忽略，对齐 20-todo.md「写操作返小对象、完整数据走 GET」省 payload 原则）
}
```

> `session_usage_update.data` 直接放整个 `SessionUsageView`（current/sub/forked + total + contextWindowUsage），消费方一次拿到全貌，无需再查。
> `session_status_update.data` 放运行态三元组（state/running/currentRunId），前端据此刷新中断按钮 / enqueue view / run-finish 渲染。

## 3. 触发时机

| 触发操作 | 发出的 SessionEvent |
|---|---|
| **[v0.0.44]** `notifyUsageChanged(sid)` 完成后（读 `getUsageView(sid)` 全量 view → emit；write ops `accumulateUsage` / `updateContextWindowUsage` 本身静默） | `session_usage_update`（data = 最新 SessionUsageView） |
| `markRunning(sid, runId)` CAS 成功后 | `session_status_update`（data = {state:"running", running:true, currentRunId:runId}） |
| `markInterrupting(sid, run)` CAS 成功后 | `session_status_update`（data = {state:"interrupting", running:true, currentRunId:null}） |
| `markInterrupted(sid)` CAS 成功后 | `session_status_update`（data = {state:"interrupted", running:false, currentRunId:null}） |
| `markIdle(sid, run)` CAS 成功后 | `session_status_update`（data = {state:"idle", running:false, currentRunId:null}） |
| `markError(sid, run)` CAS 成功后 | `session_status_update`（data = {state:"error", running:false, currentRunId:null}） |
| `reconcileOnStartup()` 每个 orphan session 修复后 | `session_status_update`（data = {state:"idle", running:false, currentRunId:null}） |
| `markSummaryRunning(sid, runId)` CAS 成功后 | [v0.0.13] `summary_task_update`（data = {status:"running", runId, startedAt:now, error:null}） |
| `markSummaryDone(sid)` CAS 成功后 | [v0.0.13] `summary_task_update`（data = {status:"done", runId:null, startedAt:null, error:null}） |
| `markSummaryFailed(sid, err)` CAS 成功后 | [v0.0.13] `summary_task_update`（data = {status:"failed", runId:null, startedAt:null, error:err}） |
| `markSummaryIdle(sid)` CAS 成功后（手动复位 / 调试 / 管理 API） | [v0.0.13] `summary_task_update`（data = {status:"idle", runId:null, startedAt:null, error:null}） |
| `reconcileSummaryTaskOnStartup()` 每个 orphan session 修复后（status=running→idle） | [v0.0.13] `summary_task_update`（data = {status:"idle", runId:null, startedAt:null, error:null}） |

> **[v0.0.78.bug] emit 源迁移**：上表 5 行原描述基于 v0.0.13 的 `Session.summaryTask` 持久化字段 + `markSummary*` CAS API（v0.0.55 已废弃）；现 emit 实际由 **`SessionTaskLock.acquire/markDone/markFailed/release`** 在 CAS 成功后直接调（subsumes 旧 markSummary* 调用点）。即 compact runner 调 `taskLock.acquire(sid,'compact',runId)` 成功 → emit `summary_task_update`(running)；调 `markDone/markFailed` → emit (done/failed)；`release` → emit (idle)。**事件契约（type/data shape/topic/group）零变化**，仅 emit 入口从 SessionStateMachine 迁到 SessionTaskLock（与 v0.0.55 lock 重构对齐）。详见 `session_task_lock.md` + `specs/tech/version_logs/v0.0.78.bug/change_log.md`。
| [v0.0.17] chokidar 检测到 workspace 内 add/change/unlink/addDir/unlinkDir（SessionWorkspaceManager.handleFsEvent debounce 后） | `session_workspace_file_changed`（data = {path: 相对路径, kind, isDir}） |
| [v0.0.17] `setWorkspaceDir(sid, newDir)` 完成（切换 workspaceDir，见 session_workspace.md §4） | `session_workspace_dir_changed`（data = {workspaceDir: newDir, prevDir}） |
| [v0.0.16] `clearSession(sid)` 完成（清空 transcript/summary/runs/usage/summaryTask + state→idle，单事务，见 session_clear.md） | `session_status_update`(state=idle) + `session_usage_update`(零) + `messages_cleared`(空 data)（三事件，前端清对话区一次完成） |
| [v0.0.27] `markRead(sid)` 完成（CAS `unread=true→false`，标读端点 POST /session/:id/read 调，见 session_state.md §6 + session_store.md §4） | `session_read_update`（data = `{unread:false}`） |
| [v0.0.228] `TodoStore.upsertItem` 写成功 / `removeItem` 真删（返 true）/ `cleanupFinished` 真清（removed>0）（agent 工具 todo-tool 与 HTTP todo-handler 两条写路径共享 TodoStore，store 层单点 emit 全覆盖；emit 细节见 [P1]todo_tools.md §4） | `session_todo_changed`（data = 空对象） |

> **[v0.0.228] session_todo_changed 三不 emit 原则**（对齐 SessionTaskLock/AppTaskLock 先例）：statusBus 未注入（optional dep）→ no-op；写路径无实际变更（removeItem 无此 item 返 false / cleanupFinished removed=0）→ 不 emit；emit 异常吞错 console.warn 不影响写路径语义（写已成功，事件是附加通知）。`removeAll`（session 销毁 hook）不 emit——session 销毁时订阅方已退订，无消费场景。

> 所有更新接口都在**内部最后**发对应 SessionEvent（不再有外部 onChange 回调）。session 内部决定发事件；消费方订阅 `(session_panel, session_id:<sid>)` 收。
> CAS 失败（0 行受影响）不发事件（状态未变）。状态机权威见 `[P0]session_state.md`（五态 §1-§5 + summaryTask 旁路 §3a）。

> **[v0.0.27] 未读产生（unread=true）不发 `session_read_update` 事件**（设计判断）：
> - **理由**：产生未读的 timing 是 run 完成且**不在前台**（isSessionActive=false），即用户当前未订阅该 session 的 session_panel topic → 即便发事件也无订阅方收到。
> - **list 可见即可**：用户后续打开会话列表（GET /session）时拉到的 `unread: true` 即是产生信号，前端据 list 响应渲染红点——无需事件推送「产生了未读」。
> - **abort / interrupted / 崩溃恢复均不产生未读**（见 session_state.md §4.4 no-op 情形），无对应事件。
> - 唯一会发 `session_read_update` 的是**消除未读**（markRead → unread=false），其订阅方场景：同 session 多 tab 时 A tab 标读、B tab 同步清红点（B 已订阅 session_panel）。

## 4. 订阅

```typescript
const hub = EventHub.singleton();
const sub = hub.sub<SessionEvent>("session_panel", `session_id:${sid}`, (event) => {
  if (event.type === "session_usage_update") {
    refreshUsagePanel(event.data);   // SessionUsageView
  }
});
```

## 5. 边界

| 零件 | 归属 |
|---|---|
| SessionEvent 类型 + type 联合 + 触发时机 | 本文（session_event）✅ |
| SessionMetaEvent 类型 + SessionMetaView + session_meta topic 触发时机 | 本文 §3a ✅ |
| 何时调 accumulateUsage / updateContextWindowUsage | context（context_usage_detail §2）/ agent loop |
| SessionUsageView / Usage 类型 | session_usage.md |
| EventHub (topic+group) / EventBus (group) transport | event/ |

## 3a. session_meta topic（v0.0.27 新增，广播，列表订阅）

> 背景：会话列表（左侧常驻 conv-panel）只在挂载时 `GET /session` 拉一次全量；后台 session 完成时前端收不到通知（`session_status_update` 是 per-sid 订阅，列表只订 active session 的 group）→ 后台完成的 session 的红点不实时出现。新增 `session_meta` 广播 topic，承载「session 变了」的通知，列表订阅它实时刷新。
> 决策详见 `specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md`（topic 模型 / 共享 `_all` group / 全量 payload / 触发时机全集 / producer 归属）。

### 3a.1 topic 属性

| 属性 | 值 | 说明 |
|---|---|---|
| topic 名 | `session_meta` | SSE 白名单需含（见 api/overall/04 §4.2） |
| group | `_all` | **共享广播 group**——所有 session 的 meta 变更都 emit 到此 |
| replayable | **false** | 列表初始态靠挂载时 `GET /session` 拉全量；只需订阅后的增量，避免回放陈旧 meta |
| 订阅方 | 会话列表（conv-panel / page-chat 挂载时 subscribe `(session_meta, _all)` 一次） | **非 per-session**，是共享 `_all` 一次订阅 |

> **传输层 group 分区约束（既定，本 spec 如实说明，不提议改传输层）**：`ReplayableEventBus`（`app/server/src/agent/event-bus.ts`）的 group 间**完全隔离**——`emit(group, event)` 只写入 + fan-out 给**该 group 的订阅者**；`subscribe(group)` 只回放 + 收**该 group** 的事件。**无原生 wildcard / 不带 group 订阅**（group 是必填分区 key，bus 不感知业务，只认字符串）。
> 故「列表收所有 session 的 meta」的落地 = **共享广播 group `_all`**：所有 session 的 meta 都 emit 到它，列表订阅 `(session_meta, _all)` 一次即收所有。`_all` 是约定常量（非特殊语法），与其他 group 字符串等价。详见 decision.md §2。

### 3a.2 SessionMetaEvent 类型

```typescript
// session_meta topic 的事件（区别于 session_panel topic 的 SessionEvent 联合）
interface SessionMetaUpdateEvent {
  id: string;                              // 事件自身 ULID
  type: "session_meta_update";             // 固定（session_meta topic 只此一种事件）
  sessionId: string;                       // 变更的 session（reducer 据此整条替换）
  createdAt: string;                       // ISO 8601 UTC
  data: SessionMetaView;                   // session 完整最新 meta 视图（全量，非 diff）
}

type SessionMetaEvent = SessionMetaUpdateEvent;   // 预留扩展（后续可加更多 meta 事件类型）
```

### 3a.3 SessionMetaView 字段（与 GET /session 返回 shape 对齐）

`SessionMetaView` = session 完整最新 meta 视图，**与 `GET /session` 返回的 session 对象 shape 对齐**（让 reducer 能整条替换列表条目）；**不含 transcript 消息体**（list + 状态展示用）。

```typescript
/** [v0.0.27] session 完整最新 meta 视图（对齐 GET /session 返回 shape，见 api/overall/04 §2.1/§2.2） */
interface SessionMetaView {
  id: string;                              // ULID
  title: string;
  status: "active" | "archived";           // 业务生命周期
  // ── 运行态（对齐 SessionStatus，session_state.md §1）──
  state: "idle" | "running" | "interrupting" | "interrupted" | "error";
  running: boolean;
  currentRunId: string | null;
  // ── workspace（session_workspace.md §2）──
  workspaceDir: string;
  // ── 未读（session_state.md §6 explicit-bool）──
  unread: boolean;
  // ── titled（v0.0.47 新增，AI 起名 CAS gate；详见 session_store.md §2 + auto_naming/）──
  titled: boolean;                            // [v0.0.47] true = title 已命名（人工改名 OR AI 起名应用过）；前端列表 reducer 整条替换不读此字段（仅 AI 起名 service 内部 CAS gate 用 + GET /session 暴露给可观测）。lazy 默认 false（session.titled ?? false）。
  // ── summaryTask（[v0.0.78.bug] optional，broadcaster 不填——方案 A）──
  // 数据源是 SessionTaskLock（内存 only，broadcaster 持 crud 不持 lock），故 broadcaster 不填此字段；
  // 前端 CompactBtn 通过单独的 `summary_task_update` SSE 事件订阅 compact 状态（不读 meta_view.summaryTask）。
  summaryTask?: SessionTaskState;          // optional；同 SummaryTaskUpdateEvent.data 类型（session_task_lock.md §2）
  createdAt: string;                       // isoDate
  updatedAt: string;
}
```

> **语义**：reducer 收到 `session_meta_update` → 按 `data.id`(=sessionId) 在 `sessions[]` 中**整条替换**（不存在则插入）→ 列表始终反映权威最新态（红点 / running / title / summaryTask / workspaceDir 全实时），与哪个字段变了无关。
> **不含 transcript**：`SessionMetaView` 不含 messages 数组（避免事件体过大；transcript 由 `GET /session/:id/messages` 分页拉取）。

### 3a.4 触发时机（全集，任何 session 状态 OR meta 变更）

producer = session 层 **`SessionMetaBroadcaster`**（持 crud 读最新 record + sessionMetaBus emit 到 `_all`），**保持状态机 + agent-loop 纯粹**（不感知 session_meta）。触发接线见 `specs/tech/agent/session/[P0]session_state.md §6.4` + decision.md §5。

| 变更写点 | 经 statusBus? | 触发 broadcast? | 经谁触发 |
|---|---|---|---|
| 状态机 `markRunning/markInterrupting/markInterrupted/markIdle/markError` CAS 成功 → emit `session_status_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `reconcileOnStartup` 每 orphan → emit `session_status_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `markSummaryRunning/Done/Failed/Idle` CAS 成功 → emit `summary_task_update`（含手动 markSummaryIdle + reconcile） | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `reconcileSummaryTaskOnStartup` 每 orphan → emit `summary_task_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |

> **[v0.0.78.bug] 上两行 emit 源迁移**：原 `markSummaryRunning/Done/Failed/Idle`（v0.0.55 废弃）+ `reconcileSummaryTaskOnStartup` 的实际 emit 现由 **`SessionTaskLock.acquire/markDone/markFailed/release`** CAS 成功后承担（含 emit `summary_task_update` 到 statusBus → broadcaster 捕获触发 session_meta broadcast）。**broadcast 触发链零变化**——`summary_task_update` 重新加入 `_META_TRIGGERING_TYPES`（v0.0.55 误删，v0.0.78.bug 恢复），broadcaster.handleSessionEvent 逻辑泛化无改。
| **[v0.0.44]** `notifyUsageChanged(sid)` → emit `session_usage_update`（read full `getUsageView(sid)`；write ops `accumulateUsage` / `updateContextWindowUsage` 本身静默） | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| `clearSession` → emit `session_status_update` + `session_usage_update` + `messages_cleared`（三事件，见 §3） | ✅ | ✅ | broadcaster（statusBus wrap 捕获；多个事件触发多次 broadcast 但每次都读最新态，幂等无害） |
| `setWorkspaceDir` → emit `session_workspace_dir_changed` | ✅ | ✅ | broadcaster（statusBus wrap 捕获；workspaceDir 是 meta 字段） |
| chokidar fs event → emit `session_workspace_file_changed` | ✅ | ❌ 可选不触发 | 文件变化非 session meta 本身；列表不依赖；建议不触发（避免高频） |
| [v0.0.228] TodoStore 写成功 → emit `session_todo_changed` | ✅（**raw statusBus**，不经 wrap fan-out） | ❌ 不触发 | todo 不在 SessionMetaView 字段内，会话列表无感知需求——对齐 `session_workspace_file_changed` 不触发先例。双保险：TodoStore 注入的是 wrap 前的 raw bus（bootstrap 构造时序在 store-phase wrap 之前，天然不过 broadcaster/unreadRuntime）；且 `session_todo_changed` 不进 `META_TRIGGERING_TYPES`（即使未来改经 wrap 也被过滤） |
| `markRead` CAS 成功 → emit `session_read_update` | ✅ | ✅ | broadcaster（statusBus wrap 捕获） |
| **[v0.0.47] `updateSession({title, titled:true})`**（PUT /session/:id body.title 路径，`session-update.ts` applyTitleUpdate helper + `session.ts:184-195`；纯 CRUD 写，不经 statusBus） | ❌ | ✅ | **handler 写完直接调 `broadcaster.broadcast(sid)`**（v0.0.47 补强；让前端列表经 session_meta_update 实时刷新 title） |
| **[v0.0.47] `updateSession({title, titled:true})`**（AI 起名 service 应用路径，`auto-naming-service.ts`；纯 CRUD 写，不经 statusBus） | ❌ | ✅ | **`AutoNamingService.applyAiName` CAS 成功后直接调 `broadcaster.broadcast(sid)`**（runtime 自治直调，同 markUnreadTrue 模式） |
| **`markUnreadTrue`**（产生未读，runtime 内 CAS，**不经 statusBus**） | ❌ | ✅ | **`SessionUnreadRuntime.markUnreadTrue` CAS 成功后直接调 `broadcaster.broadcast(sid)`** |

> **不变量**：除 `markUnreadTrue`（runtime 自治直调 broadcaster）外，所有触发都经 statusBus wrap 单点捕获——无遗漏、无重复（每个 statusBus.emit 触发恰好一次 broadcast）。
> **CAS 失败不发事件 → 不触发 broadcast**（状态未变，session_state.md §3 不变量）。

### 3a.5 与 session_panel 各干各的

- **chat 页（active session）**：保持 `session_panel:session_id:<sid>` per-sid 订阅不动。session_panel 所有现有消费者（chat 页 sessionRunning / workspace watch 钩子 / usage / summaryTask / session_read_update）**零改动**。
- **会话列表（conv-panel）**：subscribe `(session_meta, _all)` 一次。
- 两个 topic 各自独立路由：`session_panel`（per-sid，**replayable=false** [v0.0.30/0.0.88 修正：code 实际是 false，spec 旧写 true 是 drift]）服务 active session 详情；`session_meta`（broadcast `_all`，**replayable=false**）服务列表增量。详见 sse_channel.md §10。

## 3b. app_task topic（v0.0.164 新增，广播，app 级任务状态）

> 背景：v0.0.164 新增手动触发 tier2 整理端点（`POST /consolidation/run`）+ `AppTaskLock`（app 级 × per-task 内存锁）。设置页「立即整理」按钮需实时刷新 disabled 态（running 时禁点，done/failed/idle 时可点），既有 `session_panel`（per-sid）+ `session_meta`（session 维度）语义都不匹配（app 级事件无 sessionId），故新增 `app_task` topic。详见 `[P0]app_task_lock.md` §3.4。

### 3b.1 topic 属性

| 属性 | 值 | 说明 |
|---|---|---|
| topic 名 | `app_task` | SSE 白名单需含（见 api/overall/04 §4.2） |
| group | `_all` | 共享广播 group（对齐 session_meta 共享 `_all` 模式） |
| replayable | **false** | 初始态靠 `GET /consolidation/status` 拉取；SSE 只作实时刷新，无需回放 |
| 订阅方 | 设置页「立即整理」组件（`section-consolidation-config.tsx` 挂载时 `useLifecycle` 订阅 `(app_task, _all)`） | 非 per-session（app 级 = 非会话维度） |

### 3b.2 ConsolidationTaskUpdateEvent 类型

```typescript
// app_task topic 的事件
interface ConsolidationTaskUpdateEvent {
  id: string;                                  // 事件自身 ULID
  type: "consolidation_task_update";           // 固定（本版本 app_task topic 只此一种事件）
  createdAt: string;                           // ISO 8601 UTC
  data: AppTaskState;                          // 结构与 AppTaskState 同构：{status, runId?, startedAt?, error?}
  // 无 sessionId 字段——app 级事件（区别于 SessionMetaUpdateEvent）
}
```

> **data inline 定义避循环 import**：`ConsolidationTaskUpdateEvent.data` 在 `session-event-types.ts` 内 inline 结构定义（不 import `AppTaskState`），避 `session-event-types.ts ↔ app-task-lock.ts` 循环 import；结构与 `AppTaskState` 完全同构，TS 结构类型天然兼容。

### 3b.3 触发时机

producer = **`AppTaskLock.emitTaskUpdate`**（`agent/app-task-lock.ts`，CAS 成功后由 acquire/markDone/markFailed/release 私有调用）：

| CAS 转换 | emit 事件 | data.status |
|---|---|---|
| `idle/done/failed → running`（acquire 成功） | `consolidation_task_update` | `running` |
| `running → done`（markDone） | `consolidation_task_update` | `done` |
| `running → failed`（markFailed） | `consolidation_task_update` | `failed` |
| `running → idle`（release，少见） | `consolidation_task_update` | `idle` |

> **三不 emit 原则**（对齐 SessionTaskLock）：bus 未注入 no-op / CAS 失败不 emit / emit 异常吞错 console.warn 不影响锁语义。详见 `[P0]app_task_lock.md §3.4`。

### 3b.4 与 session_panel / session_meta 各干各的

- **app_task 是 app 级**：无 sessionId，广播到 `_all` group（全 UI 客户端均可订阅）。
- **不进 session_panel / session_meta**：session_panel 是 per-sid（chat 页），session_meta 是 session 维度（列表），app 级事件不复用，避免语义污染。
- **初始态走 HTTP**：设置页组件挂载先 `GET /consolidation/status` 拉初始态（`{lastRunAt, summary, currentState}`），再 subscribe SSE 收增量刷新。

## 6. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。session_meta 广播决策见 `specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md`。app_task 广播决策 + AppTaskLock 独立 class 决策见 `specs/tech/version_logs/v0.0.164.memory_opt/change_log.md §2`。
