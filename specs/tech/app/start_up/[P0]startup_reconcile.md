---
type: spec
title: App 启动清理（startup reconcile）
priority: P0
status: active
updated: 2026-06-30
since: v0.0.13
related: [../../agent/session/[P0]session_state.md, ../../agent/session/[P0]session_event.md, ../envs/[P0]environments.md]
---

# App 启动清理（startup reconcile）

> 定位：把 app 启动时的"残留态清理"作为独立概念落地（一次性扫描，把残留态复位到 idle）。
> 依赖：`../../agent/session/[P0]session_state.md`（五态 reconcileOnStartup + summaryTask 旁路 CAS 扩展）。

## 1. 定位

进程被杀（崩溃 / 重启）→ 内存中的 AgentLoop / 进行中 compact 丢失 → Session 可能卡在残留运行中态。bootstrap 启动时执行**一次性扫描清理**，把残留态复位到 idle，保证：

- 用户重新打开 session 不卡死（不再显 running/interrupting）。
- summaryTask 残留 running 不阻塞下次 compact（summaryTask 单值，必须 idle 才能再次 markRunning）。

清理分两路，**互不依赖**，均由 bootstrap 在 API 监听前调一次。

## 2. 清理项

### 2.1 五态 reconcileOnStartup（已有，复用）

扫 `session.state ∈ {running, interrupting}` → `idle` + 对应活跃 `Run.status` → `interrupted`。权威定义见 `session_state.md §5`，接入点在 `bootstrap-store-phase.ts:91`（v0.0.156 起，phase 拆分自原 `bootstrap.ts`）。**本文件仅文档化归属**。

```
reconcileOnStartup():
  1. SELECT id FROM session WHERE state IN ('running', 'interrupting')
  2. 对每个 orphan:
     - UPDATE session SET state='idle', running=false, currentRunId=null
     - UPDATE run SET status='interrupted', endedAt=now() WHERE sessionId AND status='running'
  3. emit session_status_update(state=idle)
```

不动项：`error` / `interrupted` / `idle`（已终态或初始）。

### 2.2 summaryTask reconcile

扫 `session.summaryTask.status = 'running'` → `idle`。compact 进行中崩溃时，summaryTask 卡在 running，不清理会阻塞下次 compact（markSummaryRunning CAS WHERE status∈{idle,done,failed}，running 不在内 → 永远失败）。

```
reconcileSummaryTaskOnStartup():
  1. SELECT id FROM session WHERE summaryTask->>'status' = 'running'
  2. 对每个 orphan:
     - UPDATE session SET summaryTask = {status:'idle', runId:null, startedAt:null, error:null}
     - emit summary_task_update(status=idle)   // 见 session_event §2
  3. 返回 { reconciled: [sid...] }
```

> summaryTask 旁路 CAS、独立于五态机，故本清理与 §2.1 五态清理**正交**——一个 session 可能五态已 idle 但 summaryTask 残留 running（compact 在 idle 窗口被杀），反之亦然。两路都扫，互不影响。

## 3. bootstrap 接入点

```
bootstrap():
  ├─ Phase 1-6：plugin/bus 装配（bootstrap-{plugin,bus}-phase.ts）
  ├─ Phase 7（bootstrap-store-phase.ts）：
  │    ├─ FsCrudStore + CompositeStore + SessionStore 构造 + setSessionStoreEpDelegate
  │    ├─ stateMachine.reconcileOnStartup()          // §2.1（bootstrap-store-phase.ts:91）
  │    ├─ taskLock.reconcileOnStartup()              // §2.2（bootstrap-store-phase.ts:97）
  │    └─ unreadRuntime.start()                       // 关键时序：reconcile 在 enabled=false 期间 emit 不产未读
  ├─ Phase 8-11：agent / scheduler / connectors / search
  ├─ 注册 API 路由
  └─ 启动监听
```

**顺序约束**：两路 reconcile 必须在 **API 监听前**完成（避免客户端在残留态下触发新 activate/compact，读到不一致状态）。

> v0.0.156 起，接入点从 `bootstrap.ts:277/281` 迁至 `bootstrap-store-phase.ts:91/97`（phase 拆分，装配顺序等价，INV-C-1）。summaryTask reconcile 的实现路径由 v0.0.55 迁至 `SessionTaskLock.reconcileOnStartup()`（旁路 CAS 权威归 `session-task-lock.ts`）。本文件约束接入点 + 顺序。

## 4. 失败语义

- reconcile 内部 UPDATE 失败（单 session）→ 记日志、跳过该 session、继续下一个（不阻断启动）。
- 整体 reconcile 抛错 → bootstrap 应 fail-fast（启动失败比带残留态服务更安全）。

## 5. 边界

| 零件 | 归属 |
|---|---|
| 启动清理流程 + bootstrap 接入点 + 顺序约束 | 本文件 ✅ |
| 五态 reconcileOnStartup 实现（SQL/CAS） | `../../agent/session/[P0]session_state.md §5` |
| summaryTask 旁路 CAS API（markSummaryRunning/Done/Failed/Idle） | `../../agent/session/[P0]session_state.md §3a` + session_store §2 |
| summaryTask 字段定义 | `../../agent/session/[P0]session_store.md §2` |
| summary_task_update event | `../../agent/session/[P0]session_event.md §2` |
| bootstrap 其他初始化（persistence / store / bus 注入） | `../envs/[P0]environments.md`（待补 bootstrap spec） |
