---
type: interface
title: Session State Machine（五态 + CAS + 崩溃恢复）
priority: P0
status: active
updated: 2026-07-17
since: v0.0.12
---

# Session State Machine（五态 + CAS + 崩溃恢复）

> **纯 session 层状态机**（与 UI 无关）。本文件定义 Session 的运行态字段、五态机、CAS 原子写、谁什么时机改、崩溃恢复。
> 字段归属（Session.state / running / currentRunId）见 `[P0]session_store.md §2`；中断/abort 行为见 `../agent_interface_and_loop/[P0]agent_interrupt.md`。
> 设计源：`states/v0.0.12/design.md` 板块 4/5/7/11。

## 1. 六态定义（v0.0.101 起含 suspended）

Session 运行态由 **`state`** 六态枚举表达（外加冗余 bool `running` 便于查询、`currentRunId` 表达当前 Run 句柄）：

| 状态 | 含义 | 是否有活跃 loop | 是否可 activate |
|---|---|---|---|
| **idle** | 初始 / 正常结束后的空闲 | 否 | ✅ |
| **running** | run 进行中（loop 活跃） | 是 | 走 4.3 case1（already_activated） |
| **interrupting** | abort api 收尾中（**临时态**，currentRunId=null，loop 已退出或正在退出） | 否（收尾中） | 走 4.3 case3（循环等待） |
| **interrupted** | 被中断后的终态 | 否 | ✅ |
| **error** | run 出错后的终态 | 否 | ✅ |
| **suspended** | [v0.0.101] 等待用户回填悬挂型 tool call（pendingToolCalls 非空）；loop 已退出（StopReason=tool_pending），但等用户答案才续 | 否（loop 已退出） | ✅（回填/tool_reply 或新 query 进 inbox → markRunning CAS WHERE 含 suspended） |

> **冗余 `running: boolean`**：与 `state ∈ {running, interrupting}` 等价（loop 活跃或收尾中）。**v0.0.101 起 suspended 排除 running**（INV-2：suspended 是独立存活态非运行中——loop 已退出，只是等用户输入；前端据此列表亮「?」非 spinner，D6）。保留 bool 字段是为高频查询（前端 GET /session、UI 渲染中断按钮）避免枚举解析；写时与 state 同步设置（markSuspended 时 running=false）。

> **[v0.0.16] interrupting 与 loop 中断检查分离**：`state=interrupting` 是**持久化标志**（activate 闸门 + 崩溃恢复依据），但 loop **内部中断检查只读内存 `controller.aborted`**（O(1)，见 `[P0]agent_loop_base.md §5`）。换言之，持久化的 interrupting 状态服务于「外部 activate / 恢复」决策，loop 自己是否要退出靠 controller 的内存位——两者解耦：abort api 先 `markInterrupting`（持久化）+ `controller.aborted=true`（内存），loop 凭后者退出，前者保证期间无新 loop 起来。

## 2. 状态机图（含生产者标注）

**状态转换只有 3 类生产者 + 1 路崩溃恢复**（不变量 §6.1 / design §11.2，无其他写入路径）。下表把**图的每条箭头标注**解码成 生产者 / CAS 方法 / 目标态 / `running` bool：

| 图中标注 | 生产者 | CAS 方法 | 目标态 | `running` |
|---|---|---|---|---|
| `activate` | AgentManager.activate | `markRunning` | running | `true` |
| `run_end(正常)` | agent loop 正常退出 | `markIdle` | idle | `false` |
| `run_end(error)` | agent loop 异常退出 | `markError` | error | `false` |
| `abort step1` | abort api step1 | `markInterrupting` | interrupting | `true` |
| `abort step4` | abort api step4 | `markInterrupted` | interrupted | `false` |
| `崩溃恢复` | `reconcileOnStartup`（进程启动扫描，§5） | — | idle | `false` |

> **`running` bool** ⟺ `state∈{running, interrupting}`（冗余字段，前端 GET /session + UI abort-btn/enqueue-view 高频查询用，见 §1）；idle/interrupted/error 为 `false`。CAS 写时与 state 同步设置。
> **生产者唯一性**（grep 实证）：5 个 CAS 方法各有唯一调用方——`markRunning`→agent-manager、`markIdle`/`markError`→agent-loop、`markInterrupting`/`markInterrupted`→abort-finalize。**interrupting/interrupted 专属 abort api；idle/error 专属 agent loop；running 专属 activate。**

```
   idle ──activate──→ running
     ▲                  │
     │                  ├─run_end(正常)──→ idle
     │                  ├─run_end(error)──→ error ──activate──→ running
     │                  └─abort step1──→ interrupting ──abort step4──→ interrupted
     │                                                        │
     │                                                        └─activate──→ running
     │
     └── 崩溃恢复（running/interrupting → idle + Run=interrupted）

   idle / interrupted / error：皆"无活跃 run"，可直接 activate。
   running / interrupting：有活跃 run 或收尾中，activate 走分支（见 §4.3）。
```

**硬约束**：**所有状态转换只由 agent loop（run_end）/ abort api / activate 三者设置**——无其他写入路径（design §11.2）。

## 3. 状态维护 API（全 CAS 原子条件写）

所有写操作都是 **compare-and-set**：UPDATE 附带 WHERE 子句限定前置状态，防并发交错。返回受影响行数，0 行 = CAS 失败（状态已被他人改）。

```typescript
interface SessionStateStore {
  /** activate 用：CAS state ∈ {idle, interrupted, error, suspended} → running + 设 currentRunId
   *  [v0.0.101] WHERE 加 suspended：回填 tool_reply 或新 user query 进 inbox 时从 suspended 激活（O6 闸门） */
  markRunning(sessionId: string, newRunId: string): Promise<boolean>;

  /** abort step1 用：CAS currentRunId=<thisRun> AND state=running → interrupting + 清 currentRunId */
  markInterrupting(sessionId: string, expectedRunId: string): Promise<boolean>;

  /** abort step4 用：CAS state=interrupting → interrupted + running=false */
  markInterrupted(sessionId: string): Promise<boolean>;

  /** loop run_end(正常) 用：CAS currentRunId=<thisRun> AND state=running → idle + 清 currentRunId */
  markIdle(sessionId: string, expectedRunId: string): Promise<boolean>;

  /** loop run_end(error) 用：CAS currentRunId=<thisRun> AND state=running → error + running=false */
  markError(sessionId: string, expectedRunId: string): Promise<boolean>;

  /** [v0.0.101] loop run_end(tool_pending) 用：CAS currentRunId=<thisRun> AND state=running → suspended + running=false
   *  生产者唯一 = MainLifecyclePort.onRunEnd stopReason='tool_pending' 分支（见 build-deps.ts）。
   *  suspended 排除 running（INV-2：loop 已退出，等用户回填悬挂型 tool call）。
   *  currentRunId 清/留由实现定（recover 靠 pendingToolCalls 落盘不靠 currentRunId）。 */
  markSuspended(sessionId: string, expectedRunId: string): Promise<boolean>;

  /** 启动扫描用：无条件（仅扫 state ∈ {running, interrupting}）→ idle + 清 currentRunId
   *  [v0.0.101] **不动 suspended**：suspended 是合法存活态，reconcile 保留 + 校验 pendingToolCalls 落盘一致（INV-3）。 */
  reconcileOnStartup(): Promise<{ reconciled: string[] }>;
}
```

### 3.1 SQL WHERE 子句示例（伪 SQL）

```sql
-- markRunning（[v0.0.101] WHERE 加 suspended）
UPDATE session SET state='running', running=true, currentRunId=:newRunId, updatedAt=now()
WHERE id=:sessionId AND state IN ('idle','interrupted','error','suspended');

-- markInterrupting（abort step1）
UPDATE session SET state='interrupting', currentRunId=null, updatedAt=now()
WHERE id=:sessionId AND currentRunId=:expectedRunId AND state='running';

-- markInterrupted（abort step4）
UPDATE session SET state='interrupted', running=false, updatedAt=now()
WHERE id=:sessionId AND state='interrupting';

-- markIdle（loop run_end 正常）—— 仅状态转换，不在此置 unread
UPDATE session SET state='idle', running=false, currentRunId=null, updatedAt=now()
WHERE id=:sessionId AND currentRunId=:expectedRunId AND state='running';

-- markError（loop run_end error）—— 仅状态转换，不在此置 unread
UPDATE session SET state='error', running=false, currentRunId=null, updatedAt=now()
WHERE id=:sessionId AND currentRunId=:expectedRunId AND state='running';

-- [v0.0.101] markSuspended（loop run_end tool_pending）—— pendingToolCalls 已由 runReActLoop 在退出前 setPendingToolCalls 落盘
UPDATE session SET state='suspended', running=false, updatedAt=now()
WHERE id=:sessionId AND currentRunId=:expectedRunId AND state='running';

-- [v0.0.27] 产生未读（**session 层**自治：状态机只 emit completion 信号 session_status_update，agent-loop 只调 markIdle/markError，均不碰 unread）
--   session 层（SessionUnreadOps runtime）订阅 statusBus，收到 state→idle|error 且 isSessionActive(sid)=false 时 → CAS unread=true：
UPDATE session SET unread=true
WHERE id=:sessionId AND unread=false;   -- CAS：仅 false→true，幂等保护（已 true 不重复写）

-- [v0.0.27] 消除未读（POST /session/:id/read 端点调 markRead）
UPDATE session SET unread=false
WHERE id=:sessionId AND unread=true;    -- CAS：仅 true→false，幂等保护

> **CAS 失败处理**：调用方据返回值决定（如 markRunning 返 false → 已被他人改，activate 走 case1/case3 重读 state 分支）。

---

## 3a. ~~summaryTask~~ 旁路 CAS（v0.0.13 新增，D2.3；**v0.0.55 废弃**）

> **[v0.0.55] 废弃**：本节描述的 summaryTask 持久化字段 + `markSummaryRunning/Done/Failed/Idle` CAS + `reconcileSummaryTaskOnStartup` **已全部删除**——被统一 `SessionTaskLock`（内存 only，per-session × per-task）subsumes。新机制见 `[P0]session_task_lock.md`（权威 spec）。下方原描述保留作历史/语义参考；代码层 `Session.summaryTask` 字段、`markSummary*` 方法、`reconcileSummaryTaskOnStartup` 均已从 `session-store.ts` / `session-state-machine.ts` 删除（schema_defs/session.ts 也删字段）。
>
> **取代映射**（`session_task_lock.md §4`）：
> - `markSummaryRunning(sid, runId)` → `lock.acquire(sid, 'compact', runId)`（返 bool）
> - `markSummaryDone/Failed(sid, ...)` → `lock.markDone/markFailed(sid, 'compact', ...)`
> - `reconcileSummaryTaskOnStartup()` → `lock.reconcileOnStartup()`（no-op，内存已空）
> - HTTP 409 判定 `summaryTask.status==='running'` → `lock.getState(sid,'compact').status==='running'`（行为不变）

compact 任务（forked agent 跑 summary）需要一个"是否进行中"标志，避免并发 compact + 崩溃恢复一致性。**该状态独立于五态机**——不进 §1 五态枚举、不干扰 §2 主状态机、不参与 §4 activate 闸门判断。

> **设计理由（D2.3）**：compact 是 forked agent 触发的"agent loop 之外"的任务（forked agent 无副作用、不持 Run 句柄、不写 session.state）。把 compact 进度塞进五态机会污染主状态机语义（"running"专指 AgentLoop 活跃）。故另立旁路 CAS，复用 v0.0.12 CAS 模式但状态空间独立。

### 3a.1 字段（见 session_store §2 SummaryTask）

```typescript
interface SummaryTask {
  status: "idle" | "running" | "done" | "failed";
  runId?: string | null;      // compact 触发时所在的 AgentLoop.runId（观测用）
  startedAt?: string | null;
  error?: string | null;
}
```

单值字段（1 session 仅 1 个 compact 任务）→ 天然无"多任务并发"，CAS 只防"同 session 重复触发 compact"。

### 3a.2 转换表

| 转换 | 设置者 | 时机 | CAS WHERE | 调用 |
|---|---|---|---|---|
| (init) → idle | session 创建 | createSession 默认 status=idle | — | — |
| idle/done/failed → running | **compact 进入** | forked agent.run() 前 | `status IN ('idle','done','failed')` | `markSummaryRunning(runId)` |
| running → done | **compact 成功** | setSummary 后 | `status='running'` | `markSummaryDone()` |
| running → failed | **compact 失败** | catch 分支 | `status='running'` | `markSummaryFailed(error)` |
| running → idle | **崩溃恢复**（bootstrap） | 进程启动扫描 | `status='running'` | `reconcileSummaryTaskOnStartup()` |
| any → idle（手动复位，可选） | 调试 / 管理 API | — | 无条件（仅 status=running） | `markSummaryIdle()` |

### 3a.3 SQL WHERE 示例（伪 SQL）

```sql
-- markSummaryRunning
UPDATE session SET summaryTask = json_set(summaryTask, '$.status','running','$.runId',:runId,'$.startedAt',now(),'$.error',null)
WHERE id=:sessionId AND json_extract(summaryTask,'$.status') IN ('idle','done','failed');

-- markSummaryDone
UPDATE session SET summaryTask = json_set(summaryTask,'$.status','done','$.error',null)
WHERE id=:sessionId AND json_extract(summaryTask,'$.status')='running';

-- markSummaryFailed
UPDATE session SET summaryTask = json_set(summaryTask,'$.status','failed','$.error',:err)
WHERE id=:sessionId AND json_extract(summaryTask,'$.status')='running';
```

### 3a.4 不变量

1. summaryTask CAS **不写入 session.state**（五态机不动）；反之亦然（五态 CAS 不碰 summaryTask）。
2. summaryTask.status=running **不阻止 activate**（五态机是 activate 的唯一闸门）；compact 进行中用户仍可发消息（消息入 inbox，下轮 drain 处理）。
3. summaryTask.status=running 时再次触发 compact → markSummaryRunning CAS 失败（返 false）→ compact 流程拒绝执行（caller 决定如何处理，如记日志跳过）。
4. 崩溃恢复只动 `status=running`（终态 done/failed/idle 不修复，保留上次结果）。

### 3a.5 agentRuns map 关系（v0.0.16 新增）

AgentManager 内存 `agentRuns` map（key=`${sessionId}_${modeKey}`）是 SummaryTask 的运行时表达：

| 层 | 目的 | 机制 | 崩溃后 |
|----|------|------|--------|
| **agentRuns map**（内存） | 运行时闸门（同 modeKey 拒并发） | `agentRuns.has(key) && state==="running"` 拒绝新 run | **丢失**（需 SummaryTask 恢复） |
| **SummaryTask**（持久化） | 崩溃恢复持久化标志 | 四态 status=running/done/failed/idle，CAS 原子写 | `reconcileSummaryTaskOnStartup()` 清理 status=running 孤儿 |

- agentRuns map 中的 `state` 独立于 session.state（五态机）——前者管 agent run 级别是否活跃，后者管 session 级别是否可 activate。
- 运行时检查：`agentRuns.has(key)` 在先，多一次内存防护；持久化检查 `summaryTask.status=running` 在后，用于崩溃恢复。
- **两者不互斥**——agentRuns 管运行中拒绝并发，SummaryTask 管崩溃后恢复。

---

## 4. 谁什么时机修改

| 转换 | 设置者 | 时机 | 调用 |
|---|---|---|---|
| (init) → idle | session 创建 | `createSession()` 默认 state=idle, running=false, currentRunId=null | — |
| idle/interrupted/error → running | **activate** | AgentManager 启动新 AgentLoop 前（CAS 成功才启动 loop） | `markRunning(runId)` |
| running → idle | **agent loop run_end**（stopReason=no_tool_call / no_new_messages / max_iterations / doom_loop） | loop 正常退出收尾时 | `markIdle(runId)` |
| running → error | **agent loop run_end**（stopReason=error） | loop 异常退出收尾时 | `markError(runId)` |
| running → interrupting | **abort api step1** | 收到 abort 请求、调 loop.abort() 同时 | `markInterrupting(runId)` |
| interrupting → interrupted | **abort api step4** | 收尾完成（partial 持久化 + tool_result 补齐 + clearReplay + emit run_stop 后） | `markInterrupted()` |
| running/interrupting → idle | **崩溃恢复**（bootstrap 时 reconcileOnStartup） | 进程启动扫描发现孤儿 run | `reconcileOnStartup()` |

### 4.4 未读两个离散 timing（v0.0.27，explicit-bool 模型，详见 §6 未读模型）

`unread: boolean`（见 `[P0]session_store.md §2`）有**两个离散更新时机**——产生（置 true）与消除（置 false）各一个，互不重叠。**两个 timing 都在 session 层**（状态机之上的「交互 + 状态」层；具体为 `SessionUnreadOps` runtime + `POST /read` handler），**不在 agent-loop、不在状态机**：

| timing | 触发条件 | 调用方（session 层） | 操作 |
|---|---|---|---|
| **产生（→true）** | 状态机 `markIdle`/`markError` CAS 成功 → emit `session_status_update(state→idle\|error)` → **session 层**（SessionUnreadOps runtime，订阅 statusBus `session_panel`/`session_id:<sid>`）观察到 completion 信号 → 查 `isSessionActive(sid)===false`（见 `../../app/frontend/[P0]sse_channel.md §7`） | **session 层**（SessionUnreadOps runtime） | `markUnreadTrue`：CAS `unread: false→true`（await put 落盘）→ return → runtime 直调 `broadcaster.broadcast(sid)`（不发 event，无订阅方） |
| **消除（→false）** | 用户调 `POST /session/:id/read`（**唯一标读入口**） | **server SessionHandler**（调 `SessionUnreadOps.markRead(sid)`） | `markReadAndEmit`：CAS `unread: true→false`（await put 落盘）→ emit `session_read_update`（statusBus wrap fan-out 触发 broadcast） |

> **落盘时序不变量（v0.0.163 明确）**：`markUnreadTrue` / `markReadAndEmit` 必须 **await put 落盘后**再触发 `broadcast(sid)` / `emit(session_read_update)`。理由：`SessionMetaBroadcaster.broadcast(sid)` **同步** `crud.get` 重读 record 组装 SessionMetaView 广播（见 `[P0]sse_channel.md §10.4`）——未落盘就触发 → 广播读到旧 `unread` 值 → 前端红点被清后又被旧值重置回来的 race（v0.0.163 用户实证）。put 落盘阻塞的是同一文件锁下的下一个写（file_write_lock §6.1），POST /read 响应从 fNF-return 变成 write-return 多等 ~ms 级用户无感。

> **关注点分离（v0.0.27 修订核心原则）**：未读（状态）与前台（交互）**都是 session 自己的事**——产生与消除统一在 session 层。
> - **agent-loop = 干活的**：**只调 `markIdle`/`markError`**（还原原始职责），**不碰** SSE、不查前台、不写 unread。**状态机保持纯粹**：只做状态 CAS + emit `session_status_update`（completion 信号），**不感知 SSE/unread/前台**（原「状态机不感知 SSE」原则保留不动）。
> - **session 层自治**：订阅 completion 信号（`session_status_update`→state∈{idle,error}），自己查 `isSessionActive(sid)`、自己 CAS `unread=true`（前台是 session 交互概念，session 层自己持有/查询）。**红点显示**是 UI 读 `session.unread` 渲染（不关 agent-loop/状态机）。
>
> **三种 no-op 情形**（session 层不写 unread）：**前台完成**（`isSessionActive=true` → 不置，用户进入会话期间已 POST /read 清零）/ **abort·interrupted·interrupting**（状态机 emit 的 state∈{interrupting,interrupted}，session 层仅响应 state∈{idle,error}，对齐 §1 仅 idle/error 算完成）/ **崩溃恢复 reconcileOnStartup**（session 层对 reconcile 路径豁免——识别 run 终态=interrupted 跳过，不触发 unread=true，详见 §5 + §6.3 不变量 4）。
>
> **GET /session/:id 纯读 + markIdle/markError 不直接置 unread**：GET 隐式 markRead 已否决、改独立 `POST /session/:id/read`（见 `specs/api/overall/04-agent-session.md §2.3`）；markIdle/markError 需查前台（SSE 维度信号），状态机层不感知 SSE，故只做状态转换 + emit completion 信号，由 session 层决定是否置 unread。

### 4.1 activate 三情况（design §4.3）

| 当前 state | activate 行为 |
|---|---|
| **running** | 返 `already_activated`（消息已 enqueue 排队，不启动新 loop；eager 下轮 drain 处理） |
| **idle / interrupted / error / suspended** | CAS `markRunning(newRunId)` → 成功则启动新 AgentLoop（[v0.0.101] suspended→running 是回填 tool_reply 或新 user query 进 inbox 的激活路径） |
| **interrupting** | **循环等待**（poll 每 100ms 重读 state），直到非 interrupting（→ interrupted/idle/error）再 activate。期间消息已 enqueue，abort 收尾完成后新 loop drain 处理 |

> case3 保证 clear replay 期间无其他 loop 起来写 buffer（design §5.6 竞态由此消除）。

## 5. 崩溃恢复 reconcileOnStartup()

进程被杀 → 内存 AgentLoop Map 丢失 → Session 卡在 running/interrupting、Run 卡在 running。bootstrap 启动时调：

```
reconcileOnStartup():
  1. SELECT id FROM session WHERE state IN ('running', 'interrupting')   → orphan list
  2. 对每个 orphan session:
     - UPDATE session SET state='idle', running=false, currentRunId=null
     - UPDATE run SET status='interrupted', endedAt=now()
       WHERE sessionId=:sid AND status='running'    -- 卡死的活跃 Run 一律标 interrupted
  3. emit session_status_update(state=idle) 通知面板
  4. 返回 { reconciled: [sid...] }
```

**不动项**：`error` / `interrupted` / `idle` 不动（已终态或初始，无需修复）。

> **[v0.0.101] suspended 是合法存活态，reconcile 保留**：suspended 不进 orphan list（WHERE 仅 `running/interrupting`），**不动**。但需校验 `pendingToolCalls` 落盘一致——若 suspended session 的 pendingToolCalls 为空或损坏（异常状态），log warn + 清 pending（保守恢复，避免前端 peek 到脏数据悬空）。recover 靠：前端进 session 时 `GET /session/:id/pending-tool-call`（peek 队首）+ agent_loop SSE sticky replay 重渲染提问卡（d 路径）。INV-3：pendingToolCalls 落盘存活。

> **[v0.0.13] summaryTask 残留清理（与五态 reconcile 正交）**：本节 reconcileOnStartup **不动 summaryTask**。compact 崩溃残留（summaryTask.status=running）由独立的 `reconcileSummaryTaskOnStartup()` 清理（见 §3a.2 + `../../app/start_up/[P0]startup_reconcile.md §2.2`）。两路 reconcile 互不依赖，均在 bootstrap API 监听前执行。

> **触发点**：bootstrap 初始化 store 后、监听 API 前调一次（design §7）。具体 bootstrap 集成见 `../../app/start_up/[P0]startup_reconcile.md`。

## 6. 未读模型（v0.0.27，explicit-bool）

> 设计源：`states/v0.0.27/` 用户需求「session 完成但用户未读 → 会话列表红点」。初版用 watermark 模型（lastReadAt/lastFinishedAt 派生），用户两轮反馈否决，最终采纳 explicit-bool（直接存 `unread: boolean`，离散 timing 置位）。
> 字段定义见 `[P0]session_store.md §2`（`unread: boolean`）；两 timing 详表见 §4.4；事件见 `[P0]session_event.md §2`；模型选型决策见 `specs/tech/version_logs/v0.0.27/unread-model-decision.md`。

### 6.1 核心理念（存储值，非派生）

`unread: boolean` 是**持久化存储字段**——GET 时直接返回 `session.unread`，**无任何 timestamp 比较/派生计算**。产生（markIdle/markError 非前台时 CAS true）与消除（POST /read → markRead CAS false）各写一次，统一在同一字段上。详表见 §4.4。

### 6.2 前台判定（单原语，点查一次；归属 session 层）

- **唯一前台原语**：`SseChannel.isSessionActive(sid)`（查 subs Map 是否含 `session_panel:session_id:<sid>`，见 `../../app/frontend/[P0]sse_channel.md §5/§7`）。
- **归属 session 层（非 agent-loop、非状态机）**：前台是 session 交互概念，**session 层自己持有/查询**「是否在前台」——agent-loop 不查（不碰 SSE），状态机不查（不感知 SSE）。
- **仅在产生 timing 点查一次**：session 层（SessionUnreadOps runtime）收到状态机的 `session_status_update(state→idle|error)` completion 信号后调一次，决定是否 CAS `unread=true`；完成瞬间的快照判定即终止，run 进行中不反复查、不连续追踪前台。
- **零新协议、零心跳**：复用既有 SSE 订阅聚合（chat 页进入会话 subscribe session_panel、切走/离开 unsubscribe，见 `../../app/frontend/[P0]sse_channel.md §9`）。completion 信号复用状态机既有 `session_status_update` event（每次 CAS 后已 emit，零额外协议）。

### 6.3 不变量

1. **`unread` 是存储值，非派生**（GET 直接返回，无 timestamp 比较）。
2. **markRead 是唯一消除未读入口**（POST /session/:id/read → session 层 markRead；无其他写 false 路径；GET /session/:id 纯读无副作用）。
3. **产生未读仅由 session 层自治**（session 层观察到 markIdle/markError CAS 成功后的 `session_status_update` completion 信号 → 查 isSessionActive 非前台 → CAS unread=true）；**agent-loop 与状态机均不参与**（agent-loop 只调 markIdle/markError；状态机只做状态 CAS + emit 信号，不感知 SSE/unread/前台）。仅 idle/error 算完成；abort / interrupted / interrupting / reconcile 不产生未读。
4. **崩溃恢复不产生未读**（reconcileOnStartup 把 running/interrupting → idle 是异常修复，session 层对 reconcile 路径明确豁免，不算完成，不置 unread=true；session 保持崩溃前 unread 值）。
5. **CAS 幂等保护**：置 true 的 SQL `WHERE unread=false`、置 false 的 SQL `WHERE unread=true`（同值不重复写，避免重复 emit 事件）。
6. **[v0.0.27] unread 变更（产生 OR 消除）都触发 `session_meta_update` 广播**（见 session_event.md §3a）：消除（markRead CAS 成功 → emit `session_read_update` 经 statusBus）由 `SessionMetaBroadcaster` 经 statusBus wrap 单点捕获；**产生**（`markUnreadTrue` CAS 成功，**不经 statusBus**）由 `SessionUnreadRuntime` 在 CAS 成功后**直接调** `broadcaster.broadcast(sid)`——保证列表实时见红点出现。**状态机 + agent-loop 仍不感知 session_meta**（broadcaster 是 session 层订阅者，与 SessionUnreadRuntime 同构）。详见 `[P0]sse_channel.md §10` + decision.md §5。
7. **[v0.0.163] unread CAS 落盘时序**：`markUnreadTrue` / `markReadAndEmit` **必须 await put 落盘后再触发 broadcast/emit**（详见 §4.4 落盘时序不变量）。broadcaster 同步重读 crud 组装 payload，未落盘触发会广播旧值 → race。此不变量约束 unread 的两个 CAS 入口，其他 CAS 方法（markRunning/markIdle/... 状态机五态）不受约束（无同步重读 crud 的 broadcaster 挂在其后）。

---

## 7. 不变量（design §11）

1. **状态转换只由 agent loop(run_end) / abort api / activate 三者设置**。
2. **markRunning/markInterrupting/markInterrupted/markIdle/markError 全 CAS 原子**（WHERE 子句防交错）。
3. **running bool 与 state 同步写**（state ∈ {running, interrupting} ⇔ running=true）。
4. **interrupting 时 activate 循环等待**（不并发启动新 loop）→ clear replay 安全。
5. **activate 闸门 = session 持久化状态**（非内存 AgentManager.loops Map，design §11.11）。
6. **崩溃恢复只动 running/interrupting**，已终态 session 不修复。
7. **未读 explicit-bool 模型不变量见 §6.3**（unread 非派生存储值 / 产生+消除都在 session 层 / markRead 唯一消除 / 产生仅 session 层自治 / 崩溃恢复不产生 / CAS 幂等 / **产生+消除都触发 session_meta 广播** / **[v0.0.163] await put 落盘后再 broadcast/emit**）。

## 8. 边界

| 零件 | 归属 |
|---|---|
| 五态定义 + CAS API + reconcile + 转换表 | 本文件 §1-§5 ✅ |
| summaryTask 旁路 CAS（字段/CAS API/转换表/不变量/agentRuns map 关系） | 本文件 §3a ✅（字段声明在 session_store §2） |
| 未读 explicit-bool 模型（unread 字段 + 两离散 timing + 前台点查 + 不变量 + 选型外迁） | 本文件 §6 ✅（字段声明在 session_store §2；markRead API 在 session_store §4） |
| Session 字段（state/running/currentRunId/unread 形态） | `[P0]session_store.md §2`（字段声明） |
| 中断行为（abort api 4 步、loop 单纯退出） | `../agent_interface_and_loop/[P0]agent_interrupt.md` |
| Run.status interrupted 取值 | `[P0]session_store.md §2`（Run 类型） |
| activate 内部实现（loop 创建/启动） | `../agent_interface_and_loop/[P0]agent_manager.md` |
| bootstrap 触发 reconcile 的接入点（五态 + summaryTask） | `../../app/start_up/[P0]startup_reconcile.md` |
| 前台判定（isSessionActive）实现 | `../../app/frontend/[P0]sse_channel.md §5/§7`（订阅聚合查询） |
| 标读端点（POST /session/:id/read）契约 | `specs/api/overall/04-agent-session.md §2.3`（API 契约） |

## 9. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。未读归属层决策史（agent-loop → 状态机注入 SSE → session 层自治）见 `specs/tech/version_logs/v0.0.27/unread-model-decision.md` §6。
