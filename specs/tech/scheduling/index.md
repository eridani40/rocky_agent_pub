---
type: index
title: Scheduling 子系统总起（公共调度引擎）
priority: P0
updated: 2026-07-26
since: v0.0.58
---

# Scheduling 子系统总起（公共调度引擎）

## ① 是什么

scheduling = **进程级公共调度引擎**——一个单例 `SchedulerEngine`，默认 30s 轮询所有 job（可配 `SCHEDULER_TICK_MS`，测试环境设 1000），到点调对应 handler。引擎**只管到点唤醒**，不感知 budget / squad / session / 业务语义（「唤醒的人只管唤醒，额度够不够是被唤醒者的事」）。两种 job type 在引擎之上：`heartbeat`（**[v0.0.116] squad 级统一心跳**——一 squad 一 job，到点整队一次按 scope 逐成员唤醒；v0.0.33.4-v0.0.115 曾为 per-member）+ `cron`（v0.0.58 新增 session 级定时任务）。

| 核心概念 | 一句话 |
|---|---|
| **SchedulerEngine** | 进程单例，默认 30s 轮询 `Map<jobId, Job>`（`SCHEDULER_TICK_MS` 可配），到点 fire-and-forget 调 handler（per-job inFlight 守卫防重入） |
| **Job** | 注册项 `{id, type, schedule, payload, lastFiredAt, enabled}`，type 决定 handler；type ∈ `heartbeat\|cron\|consolidation`（**[v0.0.151.t2_consolidate]** 新增 app 级天级整理任务，`JobType` 开放字符串枚举无需改类型） |
| **Schedule** | discriminated union：`{kind:'interval', ms, activeWindow?}` 或 `{kind:'cron', expr, tz}` |
| **JobHandler** | 接口 `fire(job, now): Promise<void>`，内部含 gate + deliverTo，async 自处理 |
| **JobHandlerRegistry** | `Map<type, JobHandler>`，boot 时注册；engine 按 job.type 路由 |
| **PersistenceAdapter** | 按 owner 持久化 job + lastFiredAt；heartbeat=scheduler.json，cron=cron.json |
| **cron-expr** | 5 字段 cron 解析 + computeNextRun + per-job tz（搬 claude-code，扩 tz） |

## ② 边界

| 管 | 不管（→ 别处） |
|---|---|
| 默认 30s 轮询（`SCHEDULER_TICK_MS`）+ isDue 判定 + lastFiredAt 续接 + fire-and-forget 分发 + per-job inFlight 守卫 | business gate（budget / window / busy → 各 handler 内） |
| Job/JobHandler/Schedule interface + Registry | deliverTo / activate / inbox enqueue（→ `../agent/` + `../multi_agent/`） |
| cron expr 解析 + 下次到点计算 + per-job tz | cron 人话化展示（→ `specs/ui/`，UI 层 cronstrue） |
| cron.json 持久化 schema + 原子写 + 重启续接 | scheduler.json（heartbeat 落盘，归 squad 侧 adapter 管，本目录只定义 PersistenceAdapter 契约） |
| session 销毁注销 cron（hook） | session 销毁本身的事务（→ `../agent/session/`） |
| heartbeat 从 SquadScheduler 迁移的回归不变量 | squad runtime / file-watch / budget aggregator（→ `../squad/`） |

## ③ 与系统的关系

```
   bootstrap.ts
     │
     ▼
   SchedulerEngine (单例, 默认 30s setInterval.unref(), SCHEDULER_TICK_MS 可配)
     │
     ├── HeartbeatHandler  ──gate──→  squad enableHeartBeat + activeWindows + budget
     │   └── [v0.0.116] 逐成员(scope∩deployed∩非busy): deliverTo(memberSessionId, 固定心跳提示词)
     │
     └── CronHandler      ──gate──→  busy + (session.squadId?squad budget:无)
         └── deliverTo(ownerSessionId, cronMessage)
   
   PersistenceAdapter (双实现)
     ├── HeartbeatPersistence → .rocky/state/scheduler.json (squad 分片, [v0.0.116] v2 squad 级 lastFiredAt)
     └── CronPersistence      → .sessions/{sessionId}/cron.json (session 分片)
```

**对外协作点**：
- `app/server/src/scheduling/engine.ts` 单例，bootstrap 装配（wire heartbeat jobs + cron jobs + handlers）。
- `app/server/src/squad/squad-runtime.ts` 改为「向 engine register heartbeat jobs」的 adapter（保留 ensureScheduler/reloadSquad 对外接口）。
- `app/server/src/handlers/cron-handler.ts` UI 专用 HTTP（CRUD），调 CronStore 直接读写 + 调 engine.register/unregister。
- `app/server/src/tools/cron/cron-tool.ts` agent 工具（单工具 `cron` + action enum），同样调 CronStore + engine。
- `app/server/src/agent/session-store.ts` deleteSession 时调 `cronStore.removeSessionJobs(sessionId)`。

## ④ 核心设计原则（跨文件不变量）

1. **引擎纯调度，不感知业务**——engine 只判 isDue + 调 handler.fire(job, now)。budget/window/busy/killswitch 全下沉 handler。引擎代码不含 squad/budget 字样。**实施约束**：types.ts 是纯调度契约（不含业务字段），业务 payload schema 在独立 payloads.ts；engine.ts/registry.ts 仅依赖 types.ts + active-window.ts + cron-expr.ts。
2. **fire-and-forget + per-job inFlight 守卫**——engine.tick 内 `void handler.fire(job, now)`，不 await。handler 内部 async 自处理 gate + deliverTo + 落盘 lastFiredAt，try/catch 自吞错误（不阻塞下一 tick）。engine 持 `Set<jobId> inFlight`：同一 job 上一次 fire 未 settle 时本 tick 跳过（防重入堆 fire，与业务 gate 正交——engine 仍不感知业务）。**gate skip 不更新 lastFiredAt**：handler 仅在队级 gate 全通过（fired）后调 `engine.updateJobLastFiredAt`；window/budget/killswitch skip 保留旧 lastFiredAt（下 tick 重试）。
3. **type 决定 handler**——Job.type ∈ `'heartbeat' | 'cron' | 'consolidation'`（开放枚举，**[v0.0.151.t2_consolidate]** 新增第 3 种），Registry 按 type 路由。重启续接按 type 重建 handler 依赖（squad store / session store / budget / consolidation = app_config + agentManager）。
4. **lastFiredAt 是续接唯一锚**——engine 不持 nextFireAt 内存（claude-code 教训：daemon despawn 后丢失），每 tick 从 job.lastFiredAt + schedule 重算 isDue。fire 后**立即**落盘（防重启丢）。cron 分支锚点用 `job.createdAt`（**顶层字段**，非 payload）。
5. **reschedule from now（不追溯）**——错过多次只跑一次（at-most-once）。fire 后 `lastFiredAt = now`，下次 isDue 从 now 重排。无堆。
6. **owner 是持久化寻址键**——heartbeat owner=squadId（**[v0.0.116] 一 squad 一 job 一份 scheduler.json，squad 级 lastFiredAt**），cron owner=sessionId（每 session 一份 cron.json）。两套独立持久化，engine 通过 PersistenceAdapter 抽象。
7. **[v0.0.116] heartbeat = squad 级统一调度**——一 squad 一 job（`heartbeat:<squadId>`），到点整队一次。gate 链：killswitch → activeWindows 多段（空=全天）→ budget（null=off=不限量放行）→ **逐成员展开**（scope: all/whitelist ∩ deployed ∩ 非 busy）→ 各 deliverTo 固定心跳提示词（含 `<EOS>` 出口句）。scope=whitelist 时新增成员不自动纳入；benched 任何模式不唤醒。**`<EOS>` 零机制改动**（只写进提示词文案，成员无工具调用自然 no_tool_call 结束）。**消耗只记团队总量/天**（不新增调度分桶）。详 `[P1]heartbeat_handler.md §0/§4`。历史 per-member 基线见 `../squad/[P1]scheduler.md`（v0.0.33.4）。
8. **工具/UI 不复用**——agent `cron` 工具（单工具 + action enum）与 UI HTTP 端点**正交**（同操作两入口，对齐 v0.0.55 长期记忆模式）；底层共用 CronStore + engine。
9. **cron 用户时区 + carry-based compute**——Job.schedule.tz 字段（IANA），`computeNextCronRunMs`（搬 claude-code 自实现，0 npm 依赖 + carry-based 分钟级迭代 + dom/dow OR 语义）内部用 Intl.DateTimeFormat 转 tz 本地字段比对。不依赖进程本地时区。
10. **budget 双源 wiring（boot.ts 装配）**——HeartbeatHandler 注入 sync `budgetCache`（boot 时 prime + 30s setInterval.unref 后台刷新，缺省 Infinity 放行）；CronHandler 注入 async `budgetAggregator.squadBudgetRemaining`（fresh 调用，不走 cache——cron 触发稀疏，每 fire 现取可接受）。两 handler 不同的 budget 入口是为对齐各自语义（heartbeat tick 高频→cache；cron 触发稀疏→fresh）。
11. **session 销毁双保注销**——`sessionStore.onSessionDestroyed` hook（注入式 callback 避免 session-store→scheduling 循环依赖）→ `cronStore.removeAllJobs` + engine.unregister loop（扫内存 cron job table）；外加 CronHandler gate0 `sessionExists` 自检 + orphan auto-clean 双保险（防 hook 漏调）。
12. **双源 loadJobs（boot.ts）**——boot 时遍历 squadStore.listSquads（heartbeat 源，经 squadRuntime.startAll 内部 load heartbeat jobs → engine.register）+ sessionStore.listSessions（cron 源，cronStore.loadJobs per session）。best-effort：单源/单 owner 失败不阻塞其他。
13. **[v0.0.151.t2_consolidate] consolidation = app 级单例 job + boot-time-only 注册 + lastFiredAt 几乎恒推进**——owner 固定哨兵（非 squadId/sessionId）；`enabled`/`dailyTime`/`modelId` 改动**不热重载**（对齐 `app_config.observability` 既定"重启生效"先例，见 `[P1]consolidation_job.md §3`）；**显式偏离原则 2**——"模型未配置"不是可重试业务 gate 而是合法执行结果，故 `lastFiredAt` 在该情形下仍推进（唯有读配置本身失败这类灾难性故障才不推进）。详 `[P1]consolidation_job.md §4`。

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **核心引擎** | | |
| `[P0]engine.md` | SchedulerEngine 单例 + 默认 30s 轮询（SCHEDULER_TICK_MS）+ per-job inFlight + isDue + fire-and-forget | [link]([P0]engine.md) |
| `[P0]job_registry.md` | Job/JobHandler/Schedule 接口 + Registry + PersistenceAdapter 契约 | [link]([P0]job_registry.md) |
| `[P0]cron_expr.md` | cron expr 5 字段解析 + computeNextRun + per-job tz + 人话化选型 | [link]([P0]cron_expr.md) |
| **Job Handlers** | | |
| `[P1]heartbeat_handler.md` | heartbeat 从 SquadScheduler 迁移 + 回归红线 | [link]([P1]heartbeat_handler.md) |
| `[P1]cron_subsystem.md` | cron job handler + cron.json + cronMessage + session 销毁注销 | [link]([P1]cron_subsystem.md) |
| `[P1]consolidation_job.md` | **[v0.0.151.t2_consolidate]** consolidation job type：app 级单例 + boot-time-only 注册 + gate chain + 状态持久化分离 | [link]([P1]consolidation_job.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 心跳迁移前的 SquadScheduler 历史设计见 `../squad/[P1]scheduler.md`（v0.0.33.4，迁移基线）。
