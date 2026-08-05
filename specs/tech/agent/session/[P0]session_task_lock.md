---
type: interface
title: Session Task Lock（per-session × per-task 内存锁）
priority: P0
status: active
updated: 2026-07-06
since: v0.0.55
---

# Session Task Lock（per-session × per-task 内存锁）

> 主文档：`index.md`（① 是什么 / ④ 第 9 条原则）。compact 触发链路见 `../context/[P0]context_compact_detail.md §2c`。原 compact CAS（summaryTask）见 `[P0]session_state.md §3a`——**本机制 subsumes summaryTask CAS**（取代关系见 §4）。

## 1. 概述

**管什么**：同一 session 同类后台任务（compaction / tier1 整理 / 后续同类）的**并发互斥**——同时只一个在跑，冲突直接跳过（fire-and-forget 不堆积、不排队）。

**不管什么**：
- 跨 session 互斥（不同 session 互不阻塞，正交）。
- 跨 taskType 互斥（同 session 不同 taskType 不互斥，如 compact + tier1 可并行——除非同 taskType）。
- 持久化（**不落盘**，§3.2 决策）。
- agent loop 五态机 / activate 闸门（**完全正交**，不动 `session.state` / `Run` / `currentRunId`）。

**范畴一句话**：内存里的 per-session `Map<taskType, state>` + acquire/release CAS 语义，给所有"同 session 同类后台任务串行化"场景兜底。

**与外界如何交互**：
- 任务触发点（compact / tier1 runner 等）调用 `acquire(sessionId, taskType)` 拿锁；拿到才跑，拿不到直接跳过（fire-and-forget）。
- 任务结束（成功/失败）调 `release(sessionId, taskType)`。
- HTTP 端点（如 `POST /session/:id/compact`）可在 acquire 失败时返 409（保持 v0.0.54 行为，§5）。

## 2. 接口定义

```typescript
/** 任务类型枚举（开放集合，后续可加 tier1_consolidation / tier2_consolidation 等） */
type SessionTaskType = 'compact' | 'tier1_consolidation' | string;

interface SessionTaskLock {
  /**
   * 尝试获取 (sessionId, taskType) 锁。
   * CAS 语义：state ∈ {idle, done, failed} → running 原子切换。
   * @returns true = 抢到（可以跑）；false = 已被占（调用方直接跳过，fire-and-forget）
   */
  acquire(sessionId: string, taskType: SessionTaskType, runId?: string): boolean;

  /** 任务成功结束：CAS running → done。非 running 调用为 no-op（崩溃恢复后 release 安全）。 */
  markDone(sessionId: string, taskType: SessionTaskType): void;

  /** 任务失败结束：CAS running → failed + 设 error。非 running 调用为 no-op。 */
  markFailed(sessionId: string, taskType: SessionTaskType, error: string): void;

  /** 显式释放（不分成功/失败，少见；通常用 markDone/markFailed）。非 running 调用为 no-op。 */
  release(sessionId: string, taskType: SessionTaskType): void;

  /** 查当前状态（idle/running/done/failed + 可选 runId/startedAt/error）。读不持锁。 */
  getState(sessionId: string, taskType: SessionTaskType): SessionTaskState;

  /** 进程启动清理：扫所有 state=running → idle（清孤儿锁，§3.4）。bootstrap 调一次。 */
  reconcileOnStartup(): { reconciled: Array<{ sessionId: string; taskType: SessionTaskType }> };

  /**
   * [v0.0.78.bug] 后置注入 sessionPanel bus（与 ContextEngine.setTaskLock 同模式，避免构造函数耦合）。
   * bootstrap 在 `registerTopic(SESSION_PANEL_TOPIC)` 之后调；UT fixture 不调即不 emit（兼容）。
   * 注入后：CAS 状态变更成功时 emit `summary_task_update` 到 `(session_panel, group=session_id:<sid>)`。
   */
  setSessionPanelBus(bus: ReplayableEventBus): void;
}

interface SessionTaskState {
  status: 'idle' | 'running' | 'done' | 'failed';
  runId?: string | null;       // 触发锁的任务 runId（观测用）
  startedAt?: string | null;   // ISO8601
  error?: string | null;       // failed 时的错误信息
}
```

**单值 per (sessionId, taskType)**——同 session 同 taskType 同时只有 1 个锁，CAS 只防"同 session 同 taskType 重复触发"。

## 3. 设计决策

### 3.1 CAS 语义（与 summaryTask CAS 同模式）

`acquire` 内部等价 `markRunning` CAS：state ∈ {idle, done, failed} → running。返回 bool 表达抢到/没抢到，调用方 fire-and-forget：

```
acquire(sid, taskType, runId):
  CAS state IN ('idle','done','failed') → 'running' + runId + startedAt
  return affected_rows === 1   // 0 = 已被占 → 跳过
```

**理由**：复用 v0.0.13 起 summaryTask 验证过的 CAS 模式（`session_state.md §3a`），原子性 + 无并发交错。

### 3.2 不落盘（内存 only）—— 客户端产品决策

**结论**：锁状态**只存内存**，不进 CrudStore / 不写 session 表。

**理由**：
1. **客户端产品语义**——磁盘锁会被认为"应用挂了留下幽灵锁"。内存锁简单有效，进程重启自然清空，无幽灵锁风险。
2. **崩溃恢复即"全部释放"**——进程被杀 → 内存丢失 → 所有锁自然 idle。下次启动 `reconcileOnStartup` 仅扫内存（实际为 no-op，因为内存已空），与"内存丢失=全部释放"等价。
3. **不破坏 v0.0.54 的"任何 session 任何时间都能 compact"原则**——内存锁只在"任务正在跑"时短期存在（compact 几秒到几十秒），不持久化跨进程。

**反例**：若落盘，进程崩溃后磁盘残留 `running` 锁 → 下次启动看到"已锁定"，需额外的 reconcile 逻辑清理，复杂度膨胀且语义可疑（"锁了但任务早死了"）。

> **取舍**：内存锁的代价是"进程重启期间任务状态丢失"——但任务本来就是临时的（compact / tier1），重启后用户/loop 重新触发即可，无业务损失。

### 3.3 subsumes summaryTask CAS（取代关系）

**结论**：v0.0.55 起，compact 互斥由本统一锁承担；`session_state.md §3a` 的 summaryTask CAS（持久化字段 `Session.summaryTask` + `markSummaryRunning/Done/Failed`）**废弃**。

**理由**：
1. **统一抽象**——compact + tier1 + 后续同类任务共用一套机制，不再每来一个新任务类型造一个特定 CAS。
2. **不落盘决策的副作用**——统一锁改不落盘后，summaryTask 也跟着不落盘（与 §3.2 一致）；session 表少一个 JSON 字段。
3. **行为等价**——HTTP 端点 `POST /session/:id/compact` 仍返 409 `compact_in_progress`（§5），用户/前端零感知。

**迁移路径**：
- 删 `Session.summaryTask` 字段（schema + SessionStore API + reconcileSummaryTaskOnStartup）。
- `markSummaryRunning/Done/Failed` → 调 `SessionTaskLock.acquire/markDone/markFailed('compact')`。
- 启动清理 `reconcileSummaryTaskOnStartup` → `SessionTaskLock.reconcileOnStartup`（内存 only，实际为 no-op）。

> **out of scope**：v0.0.55 只接入 compact（taskType='compact'），tier1 整理如触发也接入（taskType='tier1_consolidation'）；后续任务类型增量加。

### 3.4 reconcileOnStartup（no-op 但保留契约）

**结论**：`reconcileOnStartup` 接口保留（与五态机 reconcile / summaryTask reconcile 同范式），但实现是 no-op（内存已空=全部释放）。

**理由**：契约完整性——调用方（bootstrap）不需要知道"锁在内存还是磁盘"，统一调 reconcile 即可。未来若改回落盘（极不可能），实现可改，调用方零改动。

### 3.5 不阻塞 agent loop（与五态机正交）

**结论**：任务锁**不动 session.state / Run / currentRunId**，与五态机零耦合。

**理由**：与 v0.0.54 summaryTask 同设计——compact / tier1 是 forked agent 触发的"agent loop 之外"任务（forked agent 无副作用、不持 Run 句柄、不写 session.state）。把任务进度塞进五态机会污染主状态机语义（"running"专指 AgentLoop 活跃）。

### 3.6 SSE emit（v0.0.78.bug 恢复 — bus 注入 + CAS 成功后推送）

**结论**：`acquire/markDone/markFailed/release` 在 CAS 成功（state 真正变更）后调私有 `emitTaskUpdate(sid, nextState)`，emit `summary_task_update` 事件到 `(session_panel, group=session_id:<sid>)`。前端 CompactBtn 据此渲染 spinner / disabled / 失败态。

**bus 注入**（后置 setter 模式）：
- `setSessionPanelBus(bus: ReplayableEventBus): void`——与 `ContextEngine.setTaskLock` 同模式，避免构造函数耦合（bootstrap 顺序不可控）。
- bootstrap 装配序列：`hub.registerTopic(SESSION_PANEL_TOPIC, sessionStatusBus)` → ... → `taskLock.setSessionPanelBus(sessionStatusBus)`（用同一 bus 实例，不新建）。
- UT fixture 不调 `setSessionPanelBus` 即不 emit（兼容现有测试）。

**emit 3 种 no-op 情形**（必须严格守）：
1. **bus 未注入**：`if (!this.sessionPanelBus) return;`（UT 兼容）。
2. **CAS 失败**：`acquire` 返 false 时**不 emit**（state 未变，无信号可推）；`markDone/markFailed/release` 在非 running 调用时 no-op 同时不 emit（幂等保护）。
3. **emit 异常吞错**：try/catch + `console.warn('[session-task-lock] emitTaskUpdate failed (suppressed): ...')`——observability 链路自治，不污染调用方 CAS 返回值。

**emit payload**：
```ts
{
  id: ulid(),
  type: 'summary_task_update',
  sessionId,
  createdAt: ts,
  data: nextState,        // 调用方传入的 CAS 后 state（acquire=running / markDone=done / markFailed=failed / release=idle）
}
```

**事件名复用 `summary_task_update`**（不改 `compact_task_update`）：见 `session_event.md §2` + change_log §决策。

**理由**：
1. v0.0.55 误删 SSE emit 是 UX 回归（CompactBtn spinner 信号丢失），前端订阅代码一直就绪；v0.0.78.bug 由 lock 自己承担 emit（不再依赖 SessionStateMachine 的 markSummary*——那些已被废弃）。
2. emit 由 lock 自治而非 caller 显式调，保证「锁状态变更 ↔ SSE 推送」原子语义——caller 不会忘记 emit。
3. emit 失败不影响锁的语义（observability 链路 fail-silent，与 v0.0.30 observability wrap 原则一致）。

## 4. 与 summaryTask 的取代映射

| summaryTask CAS（旧） | SessionTaskLock（新） | 备注 |
|---|---|---|
| `Session.summaryTask` 字段 | （内存 Map，不持久化） | schema 删字段 |
| `markSummaryRunning(sid, runId)` | `acquire(sid, 'compact', runId)` | 返 bool，false = 已被占 |
| `markSummaryDone(sid)` | `markDone(sid, 'compact')` | — |
| `markSummaryFailed(sid, err)` | `markFailed(sid, 'compact', err)` | — |
| `reconcileSummaryTaskOnStartup()` | `reconcileOnStartup()`（no-op） | 内存已空 |
| `Session.summaryTask.status` 查询 | `getState(sid, 'compact').status` | HTTP 端点 409 判定用 |

## 5. HTTP 端点行为（保持 v0.0.54 兼容）

`POST /session/:id/compact`：

| 触发时锁状态 | 行为 |
|---|---|
| `getState(sid, 'compact').status === 'running'` | `409 Conflict` + `{ error: 'compact_in_progress', message: '正在压缩中，请等待' }`（前端按钮 disabled） |
| `status ∈ {idle, done, failed}` | `202 Accepted` + `{ ok: true }` + 调 `acquire(sid, 'compact', runId)`（成功才进入 forked compact 流程；理论上 CAS 不会失败因为已查过，double-check 防极端并发） |

tier1 整理如暴露 HTTP 端点（未来），同模式。

## 6. 实现落点

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/agent/session-task-lock.ts` | 新增 | `SessionTaskLock` class + 内存 `Map<sessionId, Map<taskType, SessionTaskState>>` + acquire/markDone/markFailed/release/getState/reconcileOnStartup |
| `app/server/src/agent/session-store.ts` | 修改 | 删 `Session.summaryTask` 字段引用（schema + 类型）；删 `markSummaryRunning/Done/Failed/Idle` 方法 |
| `app/server/src/agent/session-state-machine.ts` | 修改 | 删 summaryTask CAS 段（§3a 实现）+ `reconcileSummaryTaskOnStartup` 调用点改 `SessionTaskLock.reconcileOnStartup` |
| `app/server/src/agent/context-compact-runner.ts`（或 summary_do_compact impl） | 修改 | `markSummaryRunning` → `lock.acquire('compact')`；`markSummaryDone/Failed` → `lock.markDone/markFailed('compact')` |
| `app/server/src/handlers/session-compact.ts` | 修改 | 409 判定改读 `lock.getState(sid, 'compact').status === 'running'` |
| `app/server/src/agent/schema_defs/session.ts` | 修改 | 删 `summaryTask` field |
| `app/server/src/index.ts`（bootstrap） | 修改 | 构造 `SessionTaskLock` 单例注入；调 `reconcileOnStartup`（no-op 占位） |
| `app/server/src/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts` | **[v0.0.80.t1] 已接入**（旧 spec 标「如 tier1 接入」从未接） | `MemorySkillConsolidationHandler.handle` 内部 `acquire('tier1_consolidation')`：锁失败静默 return（fire-and-forget）；fork-2 完成 `markDone` / 异常 `markFailed`（与 `compact` 锁对称）。emit 由 SessionTaskLock 内部 emitTaskUpdate 自动承担（v0.0.78.bug 已实装） |

## 7. 不变量

1. **任务锁不动 session.state / Run / currentRunId**（与五态机正交，§3.5）。
2. **任务锁不落盘**（内存 only，§3.2），重启 = 全部释放。
3. **CAS 原子**（acquire 一次只一个 caller 拿到，§3.1）。
4. **同 session 同 taskType 同时只 1 个 active**（不同 session × 不同 taskType 互不阻塞）。例：`compact` 与 `tier1_consolidation` **同 session 可并行**（不同 taskType，互不阻塞）——v0.0.80.t1 sibling 双发后这是常态（fork-1 acquire `compact` + fork-2 acquire `tier1_consolidation` 同时跑，写入域正交：summary 写 `setSummary`，consolidation 写 skill/memory 独立 store）。
5. **HTTP 409 行为不变**（`POST /compact` 锁占用时返 `compact_in_progress`，§5）。
6. **release/markDone/markFailed 幂等**（非 running 调用为 no-op，崩溃恢复后 release 安全）。
7. **[v0.0.78.bug] SSE emit 三不原则**：bus 未注入 no-op / CAS 失败不 emit / emit 异常吞错不影响锁语义（§3.6）。

## 8. 边界

| 零件 | 归属 |
|---|---|
| acquire/markDone/markFailed/release/getState/reconcileOnStartup + 内存 Map + CAS 语义 + 不落盘决策 + subsumes summaryTask | 本文件 ✅ |
| compact 触发链路（forked agent / tryCompact / summary_do_compact impl） | `../context/[P0]context_compact_detail.md §2c` |
| HTTP 409 `compact_in_progress` 端点契约 | `specs/api/overall/04-agent-session.md §7` |
| 五态机 CAS（与任务锁正交） | `[P0]session_state.md §2/§3` |
| tier1 整理触发链路 | `../memory/[P0]consolidation_tier1.md` |

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
