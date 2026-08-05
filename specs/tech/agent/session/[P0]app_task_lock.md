---
type: interface
title: App Task Lock（app 级 × per-task 内存锁）
priority: P0
status: active
updated: 2026-07-26
since: v0.0.164.memory_opt
---

# App Task Lock（app 级 × per-task 内存锁）

> 主文档：`index.md`（① 是什么 / ④ 第 11 条原则）。tier2 手动/cron 撞车语义见 `../memory/[P0]consolidation_tier2.md §7`。姊妹机制（per-session）见 `[P0]session_task_lock.md`——本机制**形态照抄**它扩到 app 级（去 sessionId 维度）。

## 1. 概述

**管什么**：app 级同类后台任务（tier2 天级整理 / 未来 backup/cleanup 等）的**并发互斥**——同时只一个在跑，冲突直接跳过（fire-and-forget 不堆积、不排队）。

**不管什么**：
- per-session 任务互斥（→ `[P0]session_task_lock.md`，正交）。
- 跨 taskType 互斥（同 app 不同 taskType 不互斥，如未来 tier2_consolidation + backup 可并行——除非同 taskType）。
- 持久化（**不落盘**，同 SessionTaskLock §3.2 决策）。
- 调度器 engine 的 per-job `inFlight` Set（那是同 job 不被重入的机制；本锁是**跨触发源撞车**保护——engine.inFlight 只查同一 Promise 未 settle，AppTaskLock 查同 taskType 跨 caller 撞车）。

**范畴一句话**：内存里的 `Map<taskType, state>` + acquire/release CAS 语义，给「手动 POST + cron 到点」这类跨触发源撞车兜底。

**与外界如何交互**：
- 任务触发点（cron `ConsolidationJobHandler.fire()` / 手动 `POST /consolidation/run` handler）调 `acquire(taskType, runId?)` 拿锁；拿到才跑，拿不到直接跳过（cron: 静默；HTTP: 返 409）。
- 任务结束（成功/失败）调 `markDone(taskType)` / `markFailed(taskType, error)`。
- CAS 成功后自动 emit `consolidation_task_update` 到 `(app_task, _all)` group（广播，非 per-sid），设置页组件订阅刷新按钮状态。

## 2. 接口定义

```typescript
/** app 级任务类型枚举（开放集合，本版本仅 tier2_consolidation，未来可加 backup/cleanup 等） */
export type AppTaskType = 'tier2_consolidation' | string;

/** 任务状态（与 SessionTaskState 完全同构，心智对齐） */
export interface AppTaskState {
  status: 'idle' | 'running' | 'done' | 'failed';
  runId?: string | null;       // 触发锁的任务 runId（观测用；手动 = 'manual:<ulid>' / cron = 'cron:<iso>'）
  startedAt?: string | null;   // ISO8601
  error?: string | null;       // failed 时的错误信息
}

/** reconcileOnStartup 返回形态 */
export interface AppReconcileResult {
  reconciled: Array<{ taskType: AppTaskType }>;
}

/**
 * app 级 × per-task 内存锁。
 * 数据结构：`Map<taskType, AppTaskState>`（单层，与 SessionTaskLock 的外层 Map<sessionId, ...> 相比少 1 维）。
 * 单值 per taskType——同 taskType 同时只 1 个锁。
 */
export class AppTaskLock {
  /** 尝试获取 taskType 锁。CAS 语义：state ∈ {idle, done, failed} → running 原子切换。
   *  @returns true = 抢到（可以跑）；false = 已被占（调用方直接跳过，fire-and-forget） */
  acquire(taskType: AppTaskType, runId?: string): boolean;

  /** 任务成功结束：CAS running → done。非 running 调用为 no-op（幂等）。 */
  markDone(taskType: AppTaskType): void;

  /** 任务失败结束：CAS running → failed + 设 error。非 running 调用为 no-op。 */
  markFailed(taskType: AppTaskType, error: string): void;

  /** 显式释放（少见；通常用 markDone/markFailed）。非 running 调用为 no-op。 */
  release(taskType: AppTaskType): void;

  /** 查当前状态（读不持锁）。未 acquire 过的 taskType → 返 idle 状态（不写 Map，避免查询污染）。 */
  getState(taskType: AppTaskType): AppTaskState;

  /** 进程启动清理（no-op，内存已空 = 全部释放；接口保留与 SessionTaskLock 同范式）。 */
  reconcileOnStartup(): AppReconcileResult;

  /** 后置注入 app_task topic 的 bus（与 SessionTaskLock.setSessionPanelBus 同模式）。
   *  bootstrap 在 `registerTopic(APP_TASK_TOPIC)` 之后调；未注入即不 emit（UT 兼容）。 */
  setAppTaskBus(bus: ReplayableEventBus): void;
}
```

## 3. 设计决策

### 3.1 CAS 语义（照抄 SessionTaskLock §3.1）

`acquire` 内部等价 `markRunning` CAS：state ∈ {idle, done, failed} → running。返回 bool 表达抢到/没抢到，调用方 fire-and-forget。

**理由**：完全对齐 SessionTaskLock 已验证的模式，只是缩减 1 维（去 sessionId）。

**[v0.0.205.t2_cons] 超时接管（STALE_RUNNING_MS = 1h）**：`acquire` CAS 前先查超时——`state==='running' && startedAt 距今 > 1h` → 视为可获取（覆盖写新 running + emit，等价 release+re-acquire 原子一步）。解决同进程 hang 永久卡死（重启天然释放已由 §3.2 满足，本机制只补同进程 hang 场景）；仍**内存 only 不落盘**。配套：`GET /consolidation/status` 响应加 `status: 'running'|'idle'|'failed'` + `startedAt`（done 归 idle，完成态由 lastResult.lastRunAt 承载），前端 onInit 不再写死 isRunning=false。

### 3.2 不落盘（内存 only）—— 照抄 SessionTaskLock §3.2 客户端产品决策

**结论**：锁状态**只存内存**。进程重启 = 全部释放（内存丢失 = 全部释放）。

**理由**：
1. 客户端产品语义——磁盘锁被视为"应用挂了留下幽灵锁"。内存锁简单有效。
2. tier2 整理是天级触发（一天 1 次 cron + 用户主动手动），重启窗口远小于触发周期，几乎不会撞上"重启前正在跑"的场景；即便撞上，next tick / 用户重点也会重新触发。
3. 与 SessionTaskLock 同款决策保持心智一致。

### 3.3 独立 class（不复用 SessionTaskLock 扩 sid='__app__'）

**结论**：v0.0.164.memory_opt 起，app 级任务互斥用独立 `AppTaskLock` class，不共用 SessionTaskLock。

**理由**（详见本版本 `change_log §2`）：
1. **语义清晰**：SessionTaskLock API `acquire(sessionId, taskType, runId?)` 强制 sessionId 入参，扩 sid='__app__' 每个 caller 需造/传哨兵字符串，缺类型层强制。
2. **emit 目标不同**：SessionTaskLock emit `(session_panel, session_id:<sid>)` = per-sid group；AppTaskLock emit `(app_task, _all)` = 全局广播。若共用会污染 session_panel 订阅者（group=`session_id:__app__` 语义错乱）。
3. **bootstrap 装配天然分离**：SessionTaskLock 在 store-phase 已装配；AppTaskLock 新增 topic `app_task` + 独立单例，同 phase 装配（与 SessionTaskLock 相邻）。
4. **未来扩展性**：app 级任务未来可能加 backup/periodic cleanup 等，独立 class 更清爽。
5. **代码复用零成本**：内部 Map/CAS/emit 结构照抄 SessionTaskLock，仅去 sessionId 维度。

### 3.4 SSE emit（照抄 SessionTaskLock §3.6 恢复 — bus 注入 + CAS 成功后推送）

**结论**：`acquire/markDone/markFailed/release` 在 CAS 成功后调私有 `emitTaskUpdate(nextState)`，emit `consolidation_task_update` 事件到 `(app_task, _all)` group。前端设置页组件据此渲染「立即整理」按钮 disabled/running/失败态。

**bus 注入**（后置 setter 模式）：
- `setAppTaskBus(bus: ReplayableEventBus): void`——bootstrap 装配序列：`hub.registerTopic(APP_TASK_TOPIC, new ReplayableEventBus({replayable:false}))` → `appTaskLock.setAppTaskBus(bus)`（同一 bus 实例，不新建）。
- UT fixture 不调 setAppTaskBus 即不 emit（兼容现有测试）。

**emit 3 种 no-op 情形**（严格守，对齐 SessionTaskLock 三不原则）：
1. **bus 未注入**：`if (!this.appTaskBus) return;`。
2. **CAS 失败**：acquire 返 false / markDone/markFailed 在非 running 调用（幂等保护）→ 不 emit（state 未变，无信号可推）。
3. **emit 异常吞错**：try/catch + `console.warn('[app-task-lock] emitTaskUpdate failed (suppressed): ...')`。

**emit payload**：
```ts
{
  id: ulid(),
  type: 'consolidation_task_update',
  createdAt: ts,
  data: nextState,        // CAS 后 state
  // 无 sessionId 字段——app 级事件
}
```

**为何 non-replayable topic**：app 级状态刷新走 HTTP 端点（`GET /consolidation/status`）拉取初始态，SSE 事件只作实时刷新——新连接订阅时不需 replay 历史事件（历史状态由 HTTP 端点单点保证）。对比 session_panel replay 是因为 chat 页依赖历史事件重建 message 序列。

## 4. HTTP 端点行为

`POST /consolidation/run`：

| 触发时锁状态 | 行为 |
|---|---|
| `getState('tier2_consolidation').status === 'running'` | `409 Conflict` + `{ error: 'consolidation_in_progress' }`（前端按钮 disabled） |
| `status ∈ {idle, done, failed}` | `202 Accepted` + `{ ok: true, runId }` + acquire 成功 → fire-and-forget 跑 `runConsolidationTier2` |

**cron 触发（`ConsolidationJobHandler.fire()`）**：
- gate1（读 app_config）→ gate2 `acquire('tier2_consolidation', 'cron:'+now.toISOString())` → 成功才跑；失败静默跳过（**不推进 lastFiredAt**——本窗口已被别人承担）。
- 成功 markDone；失败 markFailed（catch 分支必须调，否则锁永不释放）。

详见 `../memory/[P0]consolidation_tier2.md §7`（撞车语义 + tier2 handler 接入）+ `../../scheduling/[P1]consolidation_job.md §4`（gate chain 加 lock 步骤）。

## 5. 实现落点

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/agent/app-task-lock.ts` | 新增 | `AppTaskLock` class + 内存 `Map<AppTaskType, AppTaskState>` + acquire/markDone/markFailed/release/getState/reconcileOnStartup + setAppTaskBus + emitTaskUpdate（三不原则） |
| `app/server/src/agent/session-event-types.ts` | 修改 | 新增 `APP_TASK_TOPIC='app_task'` + `APP_TASK_BROADCAST_GROUP='_all'` + `ConsolidationTaskUpdateEvent` interface |
| `app/server/src/bootstrap-bus-phase.ts` | 修改 | 新增 `hub.registerTopic(APP_TASK_TOPIC, new ReplayableEventBus({replayable:false}))` |
| `app/server/src/bootstrap-store-phase.ts` | 修改 | 构造 AppTaskLock 单例 + reconcileOnStartup（no-op 占位）+ 加返回值 `appTaskLock` |
| `app/server/src/bootstrap-agent-phase.ts` | 修改 | `appTaskLock.setAppTaskBus(appTaskBus)`（与 SessionTaskLock.setSessionPanelBus 同相邻装配） |
| `app/server/src/bootstrap.ts` | 修改 | BootstrappedServer interface 加 `appTaskLock: AppTaskLock`；主装配透传到 agent-phase + scheduler-phase |
| `app/server/src/handlers/consolidation-run.ts` | 新增 | `handleConsolidationRun` handler（fire-and-forget + acquire/markDone/markFailed + 202/409） |
| `app/server/src/routes/misc-routes.ts` | 修改 | 新增 `POST /consolidation/run` 路由分支 |
| `app/server/src/scheduling/handlers/consolidation-handler.ts` | 修改 | `ConsolidationJobHandlerDeps` 加 `appTaskLock`；`fire()` gate1 后加 gate2 acquire + 成功 markDone/失败 markFailed |
| `app/server/src/scheduling/consolidation-boot.ts` | 修改 | RegisterConsolidationJobDeps 加 appTaskLock，透传到 ConsolidationJobHandler |
| `app/server/src/bootstrap-scheduler-phase.ts` + `app/server/src/scheduling/boot.ts` | 修改 | BootScheduler deps 加 appTaskLock 透传 |

## 6. 不变量

1. **AppTaskLock 不动 session.state / SessionTaskLock 状态**（与 per-session 机制正交，同 SessionTaskLock 原则）。
2. **AppTaskLock 不落盘**（内存 only），重启 = 全部释放（§3.2）。
3. **CAS 原子**（acquire 一次只一个 caller 拿到，§3.1）。
4. **同 taskType 同时只 1 个 active**（不同 taskType 互不阻塞）。
5. **HTTP 409 行为**（`POST /consolidation/run` 锁占用时返 `consolidation_in_progress`，§4）。
6. **release/markDone/markFailed 幂等**（非 running 调用为 no-op）。
7. **SSE emit 三不原则**：bus 未注入 no-op / CAS 失败不 emit / emit 异常吞错不影响锁语义（§3.4）。
8. **emit 到 `app_task` topic `_all` group**（广播非 per-sid）；事件类型 `consolidation_task_update`（PRD 定案 3 事件名）。

## 7. 边界

| 零件 | 归属 |
|---|---|
| acquire/markDone/markFailed/release/getState/reconcileOnStartup + 内存 Map + CAS 语义 + 不落盘决策 + SSE emit | 本文件 ✅ |
| tier2 handler 接入 lock（cron/手动触发共走） | `../memory/[P0]consolidation_tier2.md §7` + `../../scheduling/[P1]consolidation_job.md §4` |
| POST /consolidation/run 端点契约 | `specs/api/overall/03-config-center.md §2.8` |
| 「立即整理」按钮 UI + SSE 订阅 | `specs/ui/components/app-dev-config-page/section-consolidation-config.md` |
| session 级 × per-task 锁（compact / tier1 用） | `[P0]session_task_lock.md`（姊妹机制） |

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/v0.0.164.memory_opt/change_log.md`](../../version_logs/v0.0.164.memory_opt/change_log.md)（跨版本发布说明）。
