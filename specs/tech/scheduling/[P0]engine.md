---
type: design
title: SchedulerEngine — 公共调度引擎（单例）
priority: P0
status: active
updated: 2026-07-26
since: v0.0.58
---

# SchedulerEngine — 公共调度引擎

> 进程级单例。默认 30s 轮询所有 job（可配 `SCHEDULER_TICK_MS`），到点 fire-and-forget 调 handler。**不感知业务**（无 budget/squad/session 字样）。
> 引用：本目录 `index.md §④` 核心原则 / `[P0]job_registry.md`（Job/JobHandler/Registry 接口）/ `[P0]cron_expr.md`（cron schedule 解析）。
> 迁移自：`../squad/[P1]scheduler.md`（v0.0.33.4 SquadScheduler，1s 轮询机制不变，从 per-squad 实例提升为进程单例）。

---

## 1. 设计选型：进程单例 + 默认 30s 轮询

**决策**：进程级**单例**（一个 `setInterval(tick, SCHEDULER_TICK_MS).unref()` 遍历 `Map<jobId, Job>`）。默认 tick 间隔 **30_000ms**（最小调度粒度分钟级——heartbeat ≥5min、cron 分钟粒度——30s 保证每分钟至少一次检查；`isDue` 是 `now >= 到点` 比较，拉长 tick 只影响最坏迟到 30s，无漏拍）。可通过 `SCHEDULER_TICK_MS` 环境变量覆盖（测试环境设 1000，见 `tests/test.env`）。

**为什么从 per-squad 多实例变单例**：
- v0.0.33.4 SquadScheduler 是 per-squad 多实例（每 squad 一个 interval）。公共化后所有 job 进同一引擎——单 interval 遍历 Map 即可。
- 资源更省（1 个 interval.unref() vs N 个），killswitch/reschedule 语义统一。
- 多 squad 隔离不再依赖多实例，改为 job.owner 字段 + PersistenceAdapter 按 owner 分片落盘。

**否决**：setTimeout 自适应 rearm（openclaw 模式）——状态机复杂、rearm 链易出 bug，与现有 SquadScheduler 1s 模式不一致，回归风险大。

**否决**：每 job 一个 setInterval——重启重建复杂（N 个 timer 各自重建，漏一个难发现），claude-code 已否决。

---

## 2. SchedulerEngine 类

```typescript
class SchedulerEngine {
  private jobs: Map<string, Job> = new Map();
  private intervalHandle: NodeJS.Timeout | null = null;
  private runState: 'running' | 'stopped' = 'stopped';
  constructor(deps: {
    registry: JobHandlerRegistry;
    now?: () => Date;                  // UT seam
    intervalMs?: number;               // default = SCHEDULER_TICK_MS env ?? 30_000（UT 显式注入优先）
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
  });
  start(): void;                       // 建 interval.unref()，幂等
  stop(): void;                        // clearInterval，幂等
  register(job: Job): void;            // 加/替换 job（reload 调）
  unregister(jobId: string): void;     // 删 job（session 销毁/cron action=delete 调）
  has(jobId: string): boolean;
  getJob(jobId: string): Job | undefined;
  snapshot(): ReadonlyMap<string, Job>; // UT introspect
  private tick(): void;                // 主循环（默认 30s，fire-and-forget，不 await；per-job inFlight 守卫）
}
```

**接口契约**：
- `register(job)` 同 id 替换（用于 reload）；不查 handler 是否存在（caller 保证 registry 已注册 type handler）。
- `unregister(jobId)` 不存在静默 no-op。
- `tick()` **同步函数**（不返 Promise）；内部对每个 due job `void handler.fire(job, now)`（fire-and-forget）。fire 的副作用（gate check / deliverTo / 落盘 lastFiredAt）在 handler 内 async 自处理。
- `now()` 单一时间源（UT seam；缺省 `() => new Date()`，每 tick 调用一次后传给 isDue + 所有 handler）。

---

## 3. tick() 主循环（fire-and-forget 核心）

```typescript
private tick(): void {
  if (this.runState !== 'running') return;
  const now = this.now();
  // snapshot 防 register/unregister 在 fire 期间并发改 Map
  const snapshot = Array.from(this.jobs.values());
  for (const job of snapshot) {
    if (!job.enabled) continue;
    if (!isDue(job, now)) continue;
    const handler = this.deps.registry.get(job.type);
    if (!handler) continue;            // 未注册 type handler 跳过（best-effort，记 warn）
    // fire-and-forget：不 await，handler 内 async 自处理
    void handler.fire(job, now).catch(() => {
      // best-effort：handler 异常不阻塞下一 tick
    });
  }
}
```

**关键点**（`index.md §④` 原则 1/2/4）：
1. **engine 不 await handler** —— 单 tick 内 N 个 due job 并发 fire（Promise.all 语义），互不阻塞。
2. **handler 内部 updateLastFiredAt** —— engine 不主动改 job.lastFiredAt（不知道 fire 是否真成功，因 gate 可能 skip）。fire 完成（无论 fired/skipped）后 handler 调 `engine.updateJobLastFiredAt(jobId, now.toISOString())`，engine 落内存 + 透传给 PersistenceAdapter 落盘。
3. **isDue 是纯函数**（`isDue(job, now): boolean`，详见 §4）—— engine 不持有 nextFireAt 内存状态（claude-code `cronTasks.ts:38-46` 不变式：内存 nextFireAt 与磁盘 lastFiredAt 必须一致，否则 despawn 后误触发）。

---

## 4. isDue 判定（纯函数，双 schedule kind）

```typescript
function isDue(job: Job, now: Date): boolean {
  switch (job.schedule.kind) {
    case 'interval': {
      // heartbeat 模式（v0.0.33.4 不变量）
      // lastFiredAt=null：首次排法——在 activeWindow 内则首 tick 即触发（TBD8）
      //                   外窗口则 false（不进 handler 不污染 history）
      // lastFiredAt!=null：now >= lastFiredAt + interval.ms
      if (job.lastFiredAt === null) {
        if (job.schedule.activeWindow) {
          return withinActiveWindow(job.schedule.activeWindow, now, job.schedule.tz ?? 'UTC');
        }
        return true;                  // 无 activeWindow 的 interval（无 heartbeat 配置场景，预留）
      }
      const lastMs = Date.parse(job.lastFiredAt);
      if (Number.isNaN(lastMs)) return false;
      return now.getTime() >= lastMs + job.schedule.ms;
    }
    case 'cron': {
      // cron 模式：lastFiredAt=null → 锚 createdAt（job.createdAt 顶层字段，引擎纯度不能 dig payload）
      //           lastFiredAt!=null → 锚 lastFiredAt
      // 计算从锚时刻起的下一次 cron 到点，若 ≤ now 则 due
      const anchorMs = job.lastFiredAt ? Date.parse(job.lastFiredAt) : Date.parse(job.createdAt);
      if (Number.isNaN(anchorMs)) return false;
      const next = computeNextCronRunMs(job.schedule.expr, new Date(anchorMs), job.schedule.tz);
      if (next === null) return false; // cron expr 不合法（不应该进 Map，registry 装载时已校验）
      return next <= now.getTime();
    }
  }
}
```

**注意**：
- `withinActiveWindow` 复用 `../squad/[P1]scheduler.md §4` 算法（同日/跨午夜，跟 tz 本地 HH:mm 比对），代码迁移到 `app/server/src/scheduling/active-window.ts`，gate-chain.ts 改 import。
- cron 的 `computeNextCronRunMs(expr, from, tz)` 详见 `[P0]cron_expr.md`。锚 lastFiredAt/createdAt，**不锚 now**（claude-code/hermes/openclaw 一致，at-most-once）。

---

## 5. fire-and-forget 不变量（与 v0.0.33.4 对齐）

- v0.0.33.4 SquadScheduler.tick 是 `async` 函数 `await fireOne`（per-role 串行）；公共化后变同步 tick + fire-and-forget。**行为等价**：handler.fire 内部仍是 gate → deliverTo 顺序，engine 不破坏 gate 顺序。
- **per-job 不重入**（[v0.0.116]）：engine 持 `Set<jobId> inFlight`——一个 job 上一次 `fire` 未 settle（promise 未 resolve/reject）时，本 tick 对该 job `continue` 跳过（不堆 fire）。fire 前 `inFlight.add(id)`，`fire().catch().finally(() => inFlight.delete(id))` 无论 resolve/reject 都清除。这是**分发去重**（engine 仍不感知业务语义），不是业务 gate；成员级 busy skip 仍由 handler 内部逐成员 `continue` 处理。lastFiredAt 由 handler 在 gate 全通过后经 `updateJobLastFiredAt` 写入（gate 失败保旧值）。
- **handler 实现约束**（MANDATORY）：
  - gate 通过 deliverTo 成功 → 调 `engine.updateJobLastFiredAt(jobId, now)`（lastFiredAt=now，reschedule from now）
  - gate 失败（window/budget/busy/killswitch）→ **不调 updateJobLastFiredAt**（保留旧 lastFiredAt，下次 tick 重新 isDue=true 重试，但 cron interval 模式不会 spin-loop，因 isDue 用 `lastFiredAt + ms ≤ now` 单调推进）

> **special case**：cron `lastFiredAt=null` 首次排法 + 锚 createdAt。如果 cron 到点但 handler 因 gate 失败（如 busy），下 tick 仍 isDue=true（anchor 不变），handler 再次尝试——**这是 desired**（首 fire 必须成功才落 lastFiredAt，否则永远没触发过该 cron）。等 handler 终于 gate 通过 fire 成功后，lastFiredAt=now 重排。

---

## 6. 重启续接（boot loader）

```typescript
async function bootScheduler(deps: BootDeps): Promise<SchedulerEngine> {
  const registry = new JobHandlerRegistry();
  registry.register('heartbeat', new HeartbeatHandler(deps.heartbeatDeps));
  registry.register('cron', new CronHandler(deps.cronDeps));
  const engine = new SchedulerEngine({ registry, ... });
  // 1. load heartbeat jobs（遍历所有 squad）
  for (const squadId of await deps.listSquadIds()) {
    for (const job of await deps.heartbeatPersistence.loadJobs(squadId)) {
      engine.register(job);
    }
  }
  // 2. load cron jobs（遍历所有 session，读 cron.json）
  for (const sessionId of await deps.listSessionIds()) {
    for (const job of await deps.cronPersistence.loadJobs(sessionId)) {
      engine.register(job);
    }
  }
  engine.start();
  return engine;
}
```

**注意**：
- boot 不立即触发 due job（v0.0.33.4 §6 决：等下一 tick 自然到点判 isDue）。若重启期间跨过到点，首 tick isDue=true → handler.fire（无堆，at-most-once）。
- heartbeatPersistence.loadJobs(squadId) 从 `.rocky/state/scheduler.json`（[v0.0.116] v2 squad 级）读 lastFiredAt，按 `squad.heartbeatConfig`（interval/activeWindows/scope）重建 schedule/payload，返 0 或 1 个 squad 级 `Job`。
- cronPersistence.loadJobs(sessionId) 从 `.sessions/{sessionId}/cron.json` 读 jobs，原样返（cron.json 已含 schedule/payload/lastFiredAt）。

---

## 7. 优雅关闭

- `engine.stop()` clearInterval（fire-and-forget 不需 flush；落盘每 fire 即时写）。
- bootstrap 注册 SIGTERM/SIGINT trap：`engine.stop()`（与 v0.0.33.4 squad-runtime.registerShutdownTrap 同模式）。
- interval `.unref()`（不孤立进程，test-process-cleanup-or-crash 教训）。

---

## 8. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| SchedulerEngine 单例 + 默认 30s tick（SCHEDULER_TICK_MS）+ per-job inFlight 守卫 + isDue + fire-and-forget + start/stop/register/unregister | 本文 ✅ |
| Job/JobHandler/Schedule/Registry/PersistenceAdapter 接口 | `[P0]job_registry.md` |
| cron expr 解析 + tz + computeNextCronRunMs | `[P0]cron_expr.md` |
| heartbeat handler 实现（gate chain 迁移）+ v0.0.33.4 回归红线 | `[P1]heartbeat_handler.md` |
| cron handler 实现 + cron.json + cronMessage + session 销毁注销 | `[P1]cron_subsystem.md` |
| withinActiveWindow 纯函数（迁出 squad/scheduler/gate-chain.ts） | `app/server/src/scheduling/active-window.ts` |
| v0.0.33.4 SquadScheduler 历史设计 | `../squad/[P1]scheduler.md` |

---

## 9. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/scheduling/engine.ts` | 新增 | `SchedulerEngine` class：start/stop/register/unregister/tick + isDue（双分支） |
| `app/server/src/scheduling/active-window.ts` | 新增 | `withinActiveWindow()` + `toTimeZoneHHmm()`（从 `squad/scheduler/gate-chain.ts` 迁出，纯函数） |
| `app/server/src/scheduling/types.ts` | 新增 | `Job` / `JobHandler` / `Schedule` / `JobHandlerRegistry` interface（详见 `[P0]job_registry.md`） |
| `app/server/src/bootstrap.ts` | 修改 | 新增 `bootScheduler()` 调用：注册 handlers + load jobs + engine.start() + SIGTERM trap |
| `app/server/src/squad/squad-runtime.ts` | 修改 | `ensureScheduler()` 改为「向 engine register heartbeat jobs」；`stopAll()` 改为 engine.unregister(squadId:*) |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
