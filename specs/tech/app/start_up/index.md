---
type: index
title: Start-Up 子系统总起（启动清理）
priority: P0
updated: 2026-07-16
---

# Start-Up 子系统总起（启动清理）

## ① 是什么

start_up = **app 启动时的「残留态清理」（startup reconcile）契约**——进程被杀（崩溃/重启）后，内存中的 AgentLoop / 进行中 compact 丢失，session 可能卡在残留运行中态；bootstrap 启动时执行一次性扫描清理，把残留态复位到 idle。本 KB 只文档化「清理什么、何时清、顺序约束」，清理 API 的实现权威在 `../../agent/session/`。

| 核心概念 | 一句话 |
|---|---|
| **startup reconcile** | bootstrap 启动时一次性扫描，把残留 running/interrupting 态复位到 idle |
| **五态 reconcile** | 扫 `session.state ∈ {running, interrupting}` → `idle` + 活跃 `Run.status` → `interrupted` |
| **summaryTask reconcile** | 扫 `session.summaryTask.status = 'running'` → `idle`（旁路 CAS，独立于五态机） |
| **两路正交** | 一个 session 可能五态已 idle 但 summaryTask 残留 running（compact 在 idle 窗口被杀），故两路都扫、互不影响 |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| 启动清理流程 + bootstrap 接入点 + 顺序约束 + 失败语义 | 五态 reconcileOnStartup 实现 SQL/CAS（→ `../../agent/session/[P0]session_state.md §5`） |
| summaryTask reconcile 的概念与触发 | summaryTask 旁路 CAS API + 字段定义 + event（→ `../../agent/session/`） |
| 清理必须在 API 监听前完成的顺序约束 | bootstrap 其他初始化（persistence/store/bus 注入） |

## ③ 与系统的关系

```
   bootstrap():
     ├─ Phase 1-6：plugin/bus 装配（bootstrap-{plugin,bus}-phase.ts）
     ├─ Phase 7（bootstrap-store-phase.ts）：
     │    ├─ FsCrudStore + CompositeStore + SessionStore 构造
     │    ├─ stateMachine.reconcileOnStartup()          // 五态（bootstrap-store-phase.ts:91）
     │    ├─ SessionTaskLock.reconcileOnStartup()       // summaryTask（bootstrap-store-phase.ts:97）
     │    └─ unreadRuntime.start()                       // 关键时序：reconcile 在 enabled=false 期间 emit 不产未读
     ├─ Phase 8-11：agent / scheduler / connectors / search
     ├─ 注册 API 路由
     └─ 启动监听
   ▲
   │ 两路 reconcile 必须在「API 监听前」完成（避免客户端在残留态触发新 activate/compact）
```

**对外协作点**：接入点在 `app/server/src/bootstrap-store-phase.ts.bootstrapStorePhase()`（v0.0.156 拆自原 bootstrap.ts）——`stateMachine.reconcileOnStartup()`（行 91）+ `taskLock.reconcileOnStartup()`（行 97）；SessionState 的 CAS 实现权威在 `app/server/src/agent/session-state-machine.ts.reconcileOnStartup()`；SessionTaskLock（旁路 CAS，取代原 `reconcileSummaryTaskOnStartup`）在 `app/server/src/agent/session-task-lock.ts`。

## ④ 核心设计原则（跨文件不变量）

1. **两路清理正交，互不依赖**——五态机与 summaryTask 旁路 CAS 是独立状态机；一个 session 可能五态 idle 但 summaryTask 残留 running（反之亦然），故两路都扫。→ `startup_reconcile.md §2.2`
2. **reconcile 必须在 API 监听前完成**——避免客户端在残留态下触发新 activate/compact，读到不一致状态。→ `startup_reconcile.md §3`
3. **单 session 失败不阻断启动，整体失败 fail-fast**——reconcile 内部 UPDATE 失败记日志跳过；整体抛错则 bootstrap fail-fast（启动失败比带残留态服务更安全）。→ `startup_reconcile.md §4`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| `[P0]startup_reconcile.md` | 启动清理流程（五态 reconcile + summaryTask reconcile）+ bootstrap 接入点（`bootstrap-store-phase.ts:91/97`，v0.0.156 起）+ 顺序约束 + 失败语义 | P0 | [link]([P0]startup_reconcile.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
