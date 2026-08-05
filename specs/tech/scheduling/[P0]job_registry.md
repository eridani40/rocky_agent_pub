---
type: design
title: Job / JobHandler / Registry / PersistenceAdapter 接口契约
priority: P0
status: active
updated: 2026-07-26
since: v0.0.58
---

# Job / JobHandler / Registry / PersistenceAdapter 接口契约

> 数据驱动 job 模型的核心类型 + 注册机制 + 持久化抽象。引擎（`[P0]engine.md`）与 handler（`[P1]*.md`）共同消费。
> 引用：本目录 `index.md §④` 原则 3（type 决定 handler）+ 6（owner 是持久化寻址键）。

---

## 1. Job（注册项统一形态）

```typescript
interface Job {
  /** 全局唯一（type-prefix + owner，如 [v0.0.116] `heartbeat:<squadId>`（squad 级）/ `cron:<sessionId>:<cronJobId>`） */
  id: string;
  /** handler 路由键：`'heartbeat' | 'cron'`（开放枚举，按需扩） */
  type: 'heartbeat' | 'cron';
  /** 调度配置（discriminated union） */
  schedule: IntervalSchedule | CronSchedule;
  /** handler 业务载荷（type 决定 schema，见下 §2） */
  payload: HeartbeatPayload | CronPayload;
  /** 最近一次 fire 的 ISO；null=从未触发（首次排法，详见 engine.md §4） */
  lastFiredAt: string | null;
  /** enabled 开关；false 则 engine 跳过（cron action=disable / heartbeat pause 用） */
  enabled: boolean;
  /** 创建时刻 ISO（cron 首次 isDue 锚点） */
  createdAt: string;
  /** 持久化分片键（heartbeat=squadId，cron=sessionId） */
  owner: string;
}

interface IntervalSchedule {
  kind: 'interval';
  ms: number;
  /** 可选活跃窗口（heartbeat 用，cron 不用） */
  activeWindow?: { start: string; end: string };
  /** 窗口判定时区（heartbeat=squad.timezone，缺省 UTC） */
  tz?: string;
}

interface CronSchedule {
  kind: 'cron';
  expr: string;             // 5 字段 cron expr
  tz: string;               // IANA，用户时区（必填）
}
```

**Payload schema**：

```typescript
/** heartbeat 业务载荷（[v0.0.116] squad 级：只带 squadId，成员在 fire 时按 scope 展开） */
interface HeartbeatPayload {
  squadId: string;
  // [v0.0.116] 去 memberId/sessionId：一 squad 一 job，handler.fire 时 listMembers + scope 逐成员投递
}

/** cron 业务载荷（cron.json 同字段） */
interface CronPayload {
  sessionId: string;       // owner session（playground / leader / mate）
  name: string;            // 用户可读名
  prompt: string;          // 到点投递的提示词
  squadId: string | null;  // session.squadId 派生；playground=null（无 budget gate）
}
```

---

## 2. JobHandler 接口（fire-and-forget 友好）

```typescript
interface JobHandler {
  /**
   * 到点触发（engine 调，fire-and-forget 不 await return；handler 内部 async 自处理）。
   * - 内部含完整 gate chain + deliverTo
   * - gate 通过 deliverTo 成功 → 调 engine.updateJobLastFiredAt(job.id, now)（reschedule from now）
   * - gate 失败 → 不调 updateJobLastFiredAt（保旧 lastFiredAt，下 tick 重试）
   * - 异常 try/catch 自吞（engine 已 .catch 但 handler 内部仍应 try/catch 防 reject）
   * @param job  当前 job（engine 保证 job.enabled=true 且 isDue=true 才调）
   * @param now  engine 单一时间源
   */
  fire(job: Job, now: Date): Promise<void>;
}
```

**为什么 fire 不返 TickResult**（与 v0.0.33.4 SquadScheduler.fireOne 不同）：
- engine 不感知业务，TickResult（fired/skipped_*）是 handler 私有语义；handler 自己 recordHistory / 落盘 lastResult。
- 减少跨层耦合——engine 只判 isDue + 调 fire，不关心结果（fire-and-forget 本质）。

---

## 3. JobHandlerRegistry

```typescript
class JobHandlerRegistry {
  private handlers = new Map<string, JobHandler>();
  register(type: string, handler: JobHandler): void;  // 同 type 覆盖
  get(type: string): JobHandler | undefined;
  has(type: string): boolean;
}
```

**注册时机**（bootstrap）：
- `'heartbeat'` → `new HeartbeatHandler(deps)`，详 `[P1]heartbeat_handler.md`。
- `'cron'` → `new CronHandler(deps)`，详 `[P1]cron_subsystem.md`。

boot loader 调 `engine.register(job)` 时**必须**确保 job.type 的 handler 已注册（否则 engine.tick 内 `handler === undefined` 跳过 + 记 warn）。

---

## 4. PersistenceAdapter 接口（owner 分片落盘）

```typescript
interface PersistenceAdapter {
  /** 读 owner 全量 jobs（boot loader 调） */
  loadJobs(owner: string): Promise<Job[]>;
  /** 写/替单 job（fire 后 lastFiredAt 更新 + cron action=create/update 调） */
  upsertJob(owner: string, job: Job): Promise<void>;
  /** 删单 job（cron action=delete / heartbeat disable 永久删时调） */
  removeJob(owner: string, jobId: string): Promise<void>;
  /** 删 owner 全部 jobs（session 销毁 / squad 删除时调） */
  removeAllJobs(owner: string): Promise<void>;
}
```

**双实现**：

| 实现 | 落盘路径 | schema | 调用方 |
|---|---|---|---|
| `HeartbeatPersistenceAdapter` | `{root}/squads/{squadId}/.rocky/state/scheduler.json` | [v0.0.116] v2 squad 级（`{version:2, lastFiredAt, lastResult}`；旧 v1 `{roles:{memberId:...}}` 读时忽略 + 保存时收敛，`../scheduling/[P1]heartbeat_handler.md §3`） | squad-runtime ensure/reload |
| `CronPersistenceAdapter` | `{root}/sessions/{sessionId}/cron.json` | `{version, jobs: CronJobEntry[]}`，详 `[P1]cron_subsystem.md §3` | cron-handler / cron-tool / cron-handler (UI) |

**注意**：
- [v0.0.116] HeartbeatPersistenceAdapter schema v1→v2（squad 级 lastFiredAt）；旧 v1 数据读时忽略 + 保存时自然收敛（非破坏性迁移）。Adapter 把 `Job`（squad 级）↔ `scheduler.json v2 + squad.heartbeatConfig` 双向转换。
- CronPersistenceAdapter 是新文件，schema 由本版本定义。
- 所有 adapter 写操作用 `atomicWriteSync`（`app/server/src/persistence/fs-io.ts`），原子写防半写。

---

## 5. boot loader 装载语义（owner 双源）

boot 时遍历两个 owner 源（squad list + session list）：

```typescript
// 伪码——详 engine.md §6
for squadId in squadStore.listSquads():
  # [v0.0.116] 仅装载符合条件：squad.enableHeartBeat=true（squad 级 job，无 per-member 判定）
  if shouldSchedule(squadId):
    for job in heartbeatAdapter.loadJobs(squadId):   # 返 0 或 1 squad 级 job
      engine.register(job)

for sessionId in sessionStore.listSessions():
  # 仅装载有 cron.json 的 session（无文件=无 cron，跳过）
  for job in cronAdapter.loadJobs(sessionId):
    engine.register(job)
```

**性能**：N squad + M session 列表查询 + 文件 read，单进程 boot 顺序执行；预期 N/M < 100，加载 < 1s。

---

## 6. owner 生命周期挂钩

| 事件 | engine 操作 | PersistenceAdapter 操作 |
|---|---|---|
| cron action=create（agent / UI） | engine.register(newJob) | cronAdapter.upsertJob(sessionId, job) |
| cron action=update | engine.register(updated) | cronAdapter.upsertJob |
| cron action=disable | engine.register({...job, enabled:false}) | cronAdapter.upsertJob |
| cron action=enable | engine.register({...job, enabled:true}) | cronAdapter.upsertJob |
| cron action=delete | engine.unregister(jobId) | cronAdapter.removeJob(sessionId, jobId) |
| [v0.0.116] heartbeat config change（PATCH /squad heartbeatConfig/timezone） | reloadSquad：unregister 旧 squad job → register 新 | heartbeatAdapter.upsertJob(squadId, job)（v2 squad 级） |
| heartbeat disable（squad.enableHeartBeat=false） | jobs 仍 register，handler 内 killswitch gate skip | 不动 scheduler.json |
| **session delete** | engine.unregister(cronJobId ∀ owned by session) | cronAdapter.removeAllJobs(sessionId) |
| squad delete（硬删 disposeSquad，data_model §1.1） | engine.unregister(`heartbeat:<squadId>`) | N/A（teardown 走 disposeSquad） |

**session 销毁 hook 接线**：`session-store.ts:deleteSession()` 末尾调 `cronAdapter.removeAllJobs(sessionId)` + engine unregister all（claude-code teammate orphan 清理模式，参考 researcher §5）。

---

## 7. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/scheduling/types.ts` | 新增 | `Job` / `JobHandler` / `Schedule`（Interval+）/ `JobHandlerRegistry` / `PersistenceAdapter` interface |
| `app/server/src/scheduling/registry.ts` | 新增 | `JobHandlerRegistry` class 实现（Map + register/get/has） |
| `app/server/src/scheduling/persistence/heartbeat-adapter.ts` | 新增 | `HeartbeatPersistenceAdapter`（包装现有 `SchedulerStateStore` + member.heartbeat 投影 → Job 双向转换） |
| `app/server/src/scheduling/persistence/cron-adapter.ts` | 新增 | `CronPersistenceAdapter`（详 `[P1]cron_subsystem.md`） |
| `app/server/src/agent/session-store.ts` | 修改 | `deleteSession()` 末尾调 `cronAdapter.removeAllJobs(sessionId) + engine.unregister`（注入回调，避免循环依赖） |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
