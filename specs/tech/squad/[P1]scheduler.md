---
type: design
title: Squad Scheduler 子系统
priority: P1
status: active
updated: 2026-07-26
since: v0.0.33.4
---

# Squad Scheduler 子系统（心跳 proactive 唤醒定时器）

> **[v0.0.116 心跳升级通知]**：本文描述的 **per-member 心跳**（每 role 一个 timerState / `member.heartbeat` activeWindow+interval / `heartbeat:<squadId>:<memberId>` job / `PATCH /member/:mid/heartbeat`）已**被 v0.0.116 squad 级统一调度覆盖**——一 squad 一 job（`heartbeat:<squadId>`），配置上收到 `squad.heartbeatConfig`（interval/activeWindows 多段/scope），到点整队按范围逐成员投递固定心跳提示词。**本文仅保留作 v0.0.33.4 per-member 历史基线**（不再是现行设计）；现行权威 = `../scheduling/[P1]heartbeat_handler.md §0`（squad 级）+ `[P1]data_model.md §1.1a`。
>
> **[v0.0.58.cron 迁移通知]**：本文 1s 轮询机制 + SquadScheduler class + tryFire gate chain 已**迁出到 `../scheduling/`**（新顶层 KB）。本文保留作 **v0.0.33.4 心跳设计的迁移基线**（gate 顺序 / window 跨午夜 / budget null 语义 / scheduler.json schema 等不变量的权威描述仍在本文）。v0.0.58 起新设计源：`../scheduling/[P0]engine.md`（公共引擎）+ `../scheduling/[P1]heartbeat_handler.md`（heartbeat 迁移 + 6 项回归红线）+ `../scheduling/[P0]job_registry.md`（Job/JobHandler/Registry/PersistenceAdapter）。
>
> 定位：把 v0.0.33.1 占位的 `member.heartbeat` / `squad.enableHeartBeat` / `squad.budget` 真正接通运行时——让 leader/member 在工作时段定时自主醒来（proactive）。**SquadChat 不接 scheduler**（纯 reactive）。本文是 v0.0.33.4 scheduler 设计的权威源。
> 参考：`[P1]squad_autonomy.md`（唤醒双模 SD4 / 心跳归属 SD5 / budget SD6 / 总开关 SD7）；`../multi_agent/[P1]subagent_derivation.md`（deliverTo = enqueue+activate §4.1）；`refs/claude-code/src/utils/cronScheduler.ts`（1s 轮询 + lastFiredAt + busy 跳过 + killswitch 每 tick 轮询 + .unref + 项目锁）。

---

## 1. 设计选型：1 秒轮询 vs 每角色 setInterval

**决策：1 秒轮询**（单 timer 遍历所有 role），**否决**每角色一个 setInterval。

| 维度 | 1 秒轮询（选） | 每角色 setInterval |
|---|---|---|
| 重启健壮 | 单点重建 + 每 tick 读 lastFiredAt 准确排下次 | N 个 timer 各自重建，漏一个难发现 |
| killswitch 即时 | 每 tick 读 `squad.enableHeartBeat`，toggle 后 ≤1s 生效 | 须每 timer 内部缓存或 N 处 check |
| N 角色管理 | 一个 `Map<roleId, RoleTimerState>` | N 个 timer handle，增删 role 时管理复杂 |
| busy 跳过 | tick 第一步 check session 状态 | timer 触发时再 check，易堆 |
| 资源 | 1 个 interval（.unref） | N 个 interval（N=.unref） |

**实现**（借鉴 claude-code cronScheduler）：
- 单 `setInterval(tick, 1000)`，`.unref()`（不孤立进程）。
- 每 tick 遍历该 squad 所有 role（leader + deployed members），按 `role.heartbeat.interval` + `lastFiredAt` 判定是否到点。
- 到点 → 走 §4 gate chain → 通过则 deliverTo。

---

## 2. SquadScheduler 类（每 squad 一个实例）

```typescript
class SquadScheduler {
  private squadId: string;
  private intervalHandle: NodeJS.Timeout | null;
  private timerStates: Map<string, RoleTimerState>;  // roleId → state
  private state: "running" | "stopped";
  constructor(squadId, deps: { squadStore; memberStore; sessionStore; agentManager; budgetAggregator; stateStore });
  start(): void;        // 建 interval + 从 member.heartbeat 重建 timerStates + 读 lastFiredAt
  stop(): void;         // clearInterval + persist 最终 lastFiredAt
  reloadRole(roleId): void;   // heartbeat 配置变更时实时刷新（PATCH /role/:roleId/heartbeat 调）
  reloadSquad(): void;        // enableHeartBeat/budget/timezone 变更（PATCH /squad/:id 调；killswitch 每 tick 轮询故非必须，但 budget/timezone 即时刷新）
  private tick(): Promise<void>;   // 1s 轮询主循环
}

interface RoleTimerState {
  roleId: string;
  sessionId: string;
  heartbeat: HeartbeatConfig;   // 当前生效配置（reloadRole 时替换）
  lastFiredAt: string | null;   // ISO，从 scheduler.json 读；null=从未触发
}
```

- **每 squad 独立实例**（TBD9 决）：多 squad 隔离，squad 销毁只停自己的 scheduler。
- **SquadChat 无 timerState**（SD5：纯 reactive，不入 Map）。

---

## 3. 重启续接（TBD1 决：重建 + 持久化 lastFiredAt）

**重启流程**（`start()`）：
1. 读 squad record + 所有 deployed members。
2. 对每个有心跳的 role（leader + member.heartbeat≠null），从 `member.heartbeat` 重建 `RoleTimerState`。
3. 读 `.rocky/state/scheduler.json`（§7）→ 回填每个 role 的 `lastFiredAt`。
4. **不立即触发**——等下一 tick 自然到点（除非 §6 in-flight 补偿）。
5. `setInterval(tick, 1000).unref()`。

**到点判定**（每 tick per role）：
```
nextDue = lastFiredAt ? lastFiredAt + interval : <首次排法见下>
if now >= nextDue and withinActiveWindow(activeWindow, now, squad.timezone): 触发   # [v0.0.33.4] now=进程 UTC 瞬时（new Date()，单一时间源，不混进程本地 tz）；withinActiveWindow 内部转 squad.timezone 本地 HH:mm 比对（伪码见 §4 gate1）
```
- **首次排法**：lastFiredAt=null 时，若当前已在 activeWindow 内 → 首个 tick 即触发（不等满一个 interval，TBD8 决：重启后立即补一次）；若在 activeWindow 外 → 等进入窗口后首个 tick 触发。

**防漏一次心跳**：lastFiredAt 持久化保证重启后 `nextDue = lastFiredAt + interval` 准确（不会因重启重置计数）；若重启期间跨过一个到点 → §6 in-flight 补偿。

---

## 4. Gate chain（每 tick check 顺序，TBD3/11 决）

```typescript
async tick(): Promise<void> {
  if (!this.deps.squad.enableHeartBeat) return;          // SD7 killswitch（每 tick 轮询，toggle ≤1s 生效）
  const now = new Date();
  for (const [roleId, ts] of this.timerStates) {
    if (!this.isDue(ts, now)) continue;                  // 未到 interval
    const result = await this.tryFire(ts, now);          // 单 role gate + 投递
    this.recordHistory(roleId, result);                  // §8 history
  }
}

async tryFire(ts, now): Promise<TickResult> {
  // gate1: activeWindow（双保险，跟 squad.timezone）
  if (!withinActiveWindow(ts.heartbeat.activeWindow, now, this.deps.squad.timezone))
    return { kind: "skipped_window" };
  // gate2: budget（§5 / squad_autonomy §6，横向聚合 team sessions）
  // [v0.0.33.4] null-budget 语义分离（Display vs Gate）：
  //   - Display（GET /budget/usage）：budget=null → limit=-1/remaining=-1（UI 显示「无预算限制」），consumed 仍算。
  //   - Gate（本处）：budget=null → 跳过 budget gate（未配=无限制，proactive 正常触发）。
  //   故仅 squad.budget!==null && remaining<=0 才 skip；remaining() 假设 budget≠null（null 在本 gate 侧提前 short-circuit，见 §5）。
  if (this.deps.squad.budget !== null && this.deps.budgetAggregator.remaining(this.squadId) <= 0)
    return { kind: "skipped_budget" };
  // gate3: busy check（TBD11 — deliverTo 前 check session 状态）
  if (await this.deps.isSessionBusy(ts.sessionId))
    return { kind: "skipped_busy" };
  // 全通过 → 投递（复用 v0.0.31 deliverTo，无新机制）
  await this.deps.agentManager.deliverTo(ts.sessionId, tickMessage(now, "heartbeat"));
  ts.lastFiredAt = now.toISOString();
  this.persistLastFiredAt(ts.roleId, ts.lastFiredAt);   // 立即落盘防重启丢
  return { kind: "fired" };
}
```

**withinActiveWindow 时间源语义 + 伪码**（[v0.0.33.4] 权威，§4 gate1 引用）：
- `now` = 进程 UTC 瞬时（`new Date()`，单一时间源，不混进程本地 tz）。
- 函数内部把 now 转 `squad.timezone` 本地 HH:mm，再与 `activeWindow.start/end`（"HH:mm" 24h，跟 squad.timezone）比较。
- **跨午夜窗口支持**（start>end，如 22:00-06:00，leader 夜班场景，合法 case）：localHHmm>=start **或** localHHmm<end。
  > **`[v0.0.33.4]` drift 订正（cross-midnight 口径）**：本函数**防御性支持**跨午夜（start>end）。但 **PATCH /squad/:id/member/:mid/heartbeat HTTP handler 契约更严**——校验 `activeWindow.start >= activeWindow.end` 直接 `400`（`handlers/squad-heartbeat-handler.ts.validateHeartbeat`，AT `patch_heartbeat_400_start_ge_end`）。即 **API 不暴露跨午夜配置**（仅接受同日窗口 start<end），而 scheduler 内部仍保留跨午夜判定作为防御深度（直接写库的跨午夜 heartbeat 配置仍能正确调度，二者不冲突）。

```typescript
function withinActiveWindow(activeWindow: {start:string; end:string}, now: Date, tz: string): boolean {
  const localHHmm = toTimeZoneHHmm(now, tz);   // now(UTC 瞬时) → tz 本地 "HH:mm"
  if (activeWindow.start <= activeWindow.end)
    return localHHmm >= activeWindow.start && localHHmm < activeWindow.end;   // 同日窗口（start<=end）
  return localHHmm >= activeWindow.start || localHHmm < activeWindow.end;     // 跨午夜窗口（start>end）
}
```

**gate3 busy check 必要性**（TBD11）：`deliverTo = enqueue(msg) + activate(sessionId)`（agent-manager.ts:377）。activate 幂等——session running 时返现有 AgentRun（agent-manager.ts:199-204 静默返回），但 **enqueue 已执行** → tick 消息进 inbox → running loop 当前 turn 结束后会 drain 该 tick → **tick 堆积**。故须 deliverTo **前** check `session.state === 'running'`，busy 则跳过当周期（不堆，下次到点重来）。

**killswitch 每 tick 轮询**（非 timer 内缓存）：每秒读 `squad.enableHeartBeat`，toggle 后下一 tick（≤1s）即时生效，不依赖 reloadSquad（reloadSquad 仅刷新 budget/timezone 缓存）。

---

## 5. Budget helper（横向聚合，TBD3/10 决）

**详见 `[P1]squad_autonomy.md §6`**。本节列 scheduler 依赖的契约：

```typescript
// budget-aggregator.ts
// [v0.0.33.4] 两个消费者，语义分离（权威，squad_autonomy §6 同步）：
//   - remaining()（Gate 用）：假设 squad.budget!==null，直接返 limit-consumed。caller（§4 gate2）已对 null short-circuit，故本函数永不被 budget=null 调用。
//   - displayUsage()（GET /budget/usage 用）：budget=null 时返 limit=-1/remaining=-1（UI 显示「无限制」），consumed 照算。
squadBudgetRemaining(squadId, now): Promise<number> {   // Gate 用，前提 squad.budget!==null
  const squad = await squadStore.getSquad(squadId);
  const members = await memberStore.listMembers(squadId);   // [v0.0.33.4 drift] 含 leader（memberIds 含 leaderId）
  // [v0.0.33.4 drift] SquadRecord 无 leaderSessionId/memberSessionIds 字段——
  //   schema 仅 leaderId + memberIds(含 leader) + squadChatSessionId（schema_defs/squad/squad.ts）；
  //   各 role sessionId 经 memberStore.listMembers → member.sessionId 取（data_model §1.1 双向之一）。
  const sids = [...members.map(m => m.sessionId), squad.squadChatSessionId];
  const windowStart = startOfDayInTz(now, squadTimezone(squad));
  const consumed = await sumOver(sids, sid => getUsageTotalTokens(sid, windowStart));  // 当窗口 delta
  return squad.budget.limit - consumed;
}
displayUsage(squadId, now): Promise<BudgetUsage> {       // Display 用（GET /budget/usage）
  // 同上聚合；budget===null → { limit: -1, consumed, remaining: -1, /* window... */ }
}
```

> **`[v0.0.33.4]` drift 订正（2 处，编码中发现 spec 与实现不符）**：
> 1. **SquadRecord 字段**：spec 旧措辞 `[leaderSessionId, ...memberSessionIds, squadChatSessionId]` 不准——`SquadSchema`（`schema_defs/squad/squad.ts`）仅 `leaderId` + `memberIds`（json，**含 leader**）+ `squadChatSessionId`，**无 `leaderSessionId`/`memberSessionIds`**。各 role 的 sessionId 经 `memberStore.listMembers(squadId)` → `member.sessionId` 取（member entity 持 sessionId，建队/hire 时双向回填，data_model §1.1/§2.1）。
> 2. **`getUsageView` 签名**：spec 旧文 `getUsageView(sid, windowStart)` 为 aspirational——真签名 `getUsageView(sessionId): Promise<SessionUsageView>`（`session-store.ts:488`），**无 windowStart 参数**，返 AccumulatedUsage 全时累计 total。daily 窗口靠 **budget baseline-delta**：`budget-state.json`（`squad/budget-state.ts`，落 `.rocky/state/`）维护 per-session baseline（= windowStart 时刻的全时 total），`consumed = 当前全时 total − baseline`；窗口翻转（跨 squad tz 0 点，`windowStart` 变化）→ 重置 baselines 为当前各 session 全时 total。wiring 在 `squad-runtime.ts`（包装 `sessionStore.getUsageView(sid).total.total_tokens` → `BudgetState.getConsumed(squadId, sid, windowStartISO, total)`）。budget-aggregator 把数据源抽象为注入点 `getUsageTotalTokens(sid, windowStart): Promise<number>`，UT mock 该注入点模拟跨日窗口差异。

- **无 sub_total 字段**——squad 成员是顶层 peer（parentSessionId=null），无自动 usage 提升；`getUsageView(sid).total` 已含 sub-agent 递归上报（usage 模块内部完成），squad 层横向 Σ 即可。
- **daily 窗口**（squad timezone 0 点回血）：日期分桶——23:59 tick 与 00:00 tick 属不同窗口（TBD4/5）。实现 = baseline-delta（见上 drift 订正 2）；`startOfDayInTz(now, tz)` 算窗口左界（DST 安全，迭代对齐 wall clock 到 00:00）。
- **consumption vs budget 分离**：consumption always-on（reactive 也计，显示/审计）；budget 仅 gate proactive（§4 gate2）。
- **实时刷新**：`session_usage_update` event（session-store.ts:452 emit）→ UI budget meter SSE 推送（reactive 消耗也实时反映，P11）。

---

## 6. 重启 in-flight tick（TBD8 决：立即补一次 + 从当前重排，无堆）

重启后 `start()` 完成，若发现某 role 满足「lastFiredAt + interval 已过 且 当前在 activeWindow」→ 首个 tick 立即触发一次（补重启期间漏的心跳），随后 `lastFiredAt = now`，下次 `nextDue = now + interval`（从当前重排，不追溯补多次）。**无堆**（claude-code 模式）。

---

## 7. 持久化 state（scheduler.json）

**路径决策（拍板）**：`.rocky/state/scheduler.json`（squad-store.ts:163 建队时已建此目录，零新 mkdir）。counters 继续走 `.state/counters.json`（board-shared.ts:200，不动，out of scope）。两系统内部目录并存——统一进单一目录留 backlog（非本版本）。

```json
{
  "version": 1,
  "roles": {
    "<memberId>": {
      "lastFiredAt": "<ISO>",
      "lastResult": "fired|skipped_busy|skipped_budget|skipped_window|skipped_killswitch"
    }
  }
}
```

- 每 fire/skip 立即落盘（防重启丢 lastFiredAt）。
- **仅 lastFiredAt 参与决策**（排下次）；history 另存（§8），不进此文件（防膨胀）。

---

## 8. 自动工作历史（GET /squad/:id/scheduler/history 后端）

- 内存 ring buffer（最近 N=100 条）+ 可选落盘 `.rocky/state/history.jsonl`（append-only，重启不丢）。
- 每条：`{roleId, at, reason:"heartbeat", result, actionSummary?}`。
- `actionSummary` 由 role run 结束后回填（从 run 事件摘要，best-effort）。
- 存量 history.jsonl 里历史 file-changed 条目（功能已删）读盘时过滤，不再展示。
- **`[v0.0.33.4]` drift 订正（entry id）**：内部 `HistoryEntry` **自身无 id 字段**；`SchedulerHistoryEntry.id`（GET /squad/:id/scheduler/history 出参，11a §4.4）由 **handler 层合成** `makeHistoryEntryId(at, roleId)` = `${sanitize(at)}_${sanitize(roleId)}`（sanitize 非 `[A-Za-z0-9_]` 为 `_`）。**不用 ulid**（随机 → 同 entry 每次 GET 返不同 id，UI testid `auto-work-item-{id}` 错位）；**不用数组 idx**（history 增长后同 entry 在倒序列表中 idx 偏移 → 跨 GET id 不稳定，BUG-003 教训）。at+roleId 是稳定唯一键（scheduler 1s 轮询，同 role 不会同毫秒触发两次）。backlog：让 HistoryEntry 自带 ulid（schema + jsonl 持久化改动，后续版本）。

---

## 9. 多 squad 避免冲突 + per-squad teardown（disposeSquad）

- 每 squad 独立注册的 heartbeat jobs（v0.0.58 起走公共 `SchedulerEngine`，非独立 interval）→ `SquadRuntime` 持 `registeredJobIds: Map<squadId, Set<jobId>>` 跟踪本 squad 注册的 job，`ensuredSquads`/`schedulerFacades` 各按 squadId 分片；独立 scheduler.json（按 squadId 分片）。
- **`SquadRuntime.disposeSquad(squadId)`（v0.0.111，team 硬删 teardown 单一入口）**：停掉该 squad 内存里的调度/在跑 run，根除「潜伏调度」（数据删掉后 timer/job 仍照点 fire 烧钱）。顺序：① 枚举该 squad 会话（`squadChatSessionId` + 各 `member.sessionId`）→ `agentManager.abortSession(sid)` 停在跑的 leader/mate loop（best-effort）→ ② `unregisterHeartbeatJobs(squadId)`（复用私有方法，内部 `engine.unregister` + `registeredJobIds.delete`）→ ③ 清 `ensuredSquads.delete` / `schedulerFacades.delete`。**幂等**（未 ensure / squad 不存在 / 无 run 均安全 no-op）；**MUST NOT `engine.stop`**（进程单例，会停全局调度）。代码：`squad-runtime.ts.disposeSquad()`。
- **disposeSquad 只停调度不删数据**——删数据（session/record/目录）由 `dissolveSquad` 编排在 disposeSquad **之后**（`squad-dissolve.ts`，见 `[P1]data_model.md §1.1`）。teardown 必须先于删数据（否则删完数据 timer 仍 fire）。
- **跨进程锁**（多进程部署，claude-code 借鉴）：`.rocky/state/scheduler.lock`（pid + mtime），启动时检测 stale lock 抢占。单进程部署（当前）可不做，留 hook。

---

## 10. 优雅关闭（trap 清理）

- `process.on('SIGTERM'/'SIGINT')` → 遍历所有 SquadScheduler → `stop()` → persist lastFiredAt → exit。
- 所有 interval `.unref()`（不阻塞进程退出）。
- memory: test-process-cleanup-or-crash——测试环境 env_shutdown 必须 pkill scheduler interval（防孤儿进程撑爆内存）。

---

## 11. tickMessage 格式（TBD2 决）

```typescript
interface TickMessage {
  kind: "proactive_tick";
  at: string;                              // ISO
  reason: "heartbeat";
}
```

- role prompt（squad_role fragment）加 tick handling rule：识别 `proactive_tick` 后自主决定做不做（"啥都不做就 idle"也合法，loop no_tool_call → markIdle）。
- v0.0.33.3 已注入 board/tasks 上下文（reminder provider），心跳醒来有上下文判断。
- 投递为 `role:'user'` 消息（走 inbox enqueue），sender 标 `{source:'system'}`。

---

## 12. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| 1s 轮询 + timerStates + 重启续接 + gate chain + tickMessage + 多squad隔离 + 优雅关闭 + scheduler.json + history | 本文 ✅ |
| 唤醒双模 / 心跳归属 / budget 概念 / enableHeartBeat 总开关 | `[P1]squad_autonomy.md` |
| budget 横向聚合 helper 契约 | `[P1]squad_autonomy.md §6` + 本文 §5 |
| deliverTo（enqueue+activate）幂等性 | `../multi_agent/[P1]subagent_derivation.md §4.1` + agent-manager.ts:377/199 |
| usage view（budget 数据源） | `../agent/session/[P0]session_usage.md` |
| HeartbeatConfig / member.heartbeat schema | `[P1]data_model.md §1.2` |

---

## 13. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/squad/scheduler/scheduler.ts` | 新增 | `SquadScheduler` class：start/stop/reloadRole/reloadSquad/tick（1s 轮询主循环 + timerStates Map） |
| `app/server/src/squad/scheduler/gate-chain.ts` | 新增 | `tryFire()` + `withinActiveWindow(activeWindow, now, tz)` + `isDue(ts, now)` 判定函数 |
| `app/server/src/squad/scheduler/tick-message.ts` | 新增 | `tickMessage(at)` builder + TickMessage interface |
| `app/server/src/squad/scheduler/scheduler-state.ts` | 新增 | `read/write scheduler.json`（lastFiredAt 持久化，路径 `.rocky/state/scheduler.json`） |
| `app/server/src/squad/scheduler/scheduler-history.ts` | 新增 | ring buffer + append history.jsonl + `getHistory(squadId, limit)` |
| `app/server/src/squad/budget/budget-aggregator.ts` | 新增 | `squadBudgetRemaining(squadId)` 横向 Σ team sessions total.total_tokens（daily 窗口按 squad.timezone） |
| `app/server/src/squad/squad-runtime.ts` | 新增 | squad 启动/销毁时 wire scheduler 生命周期 |
| `app/server/src/agent/agent-manager.ts` | 修改 | 暴露 `isSessionBusy(sessionId): Promise<boolean>`（check `session.state==='running'`），gate-chain gate3 调用 |
| `app/server/src/agent/schema_defs/squad/squad.ts` | 修改 | 加 `timezone: {type:'string', required:false}`（TBD4/5 单一 squad timezone，默认 user local） |
| `app/server/src/stores/squad-store.ts` | 修改 | createSquadService 不变（`.rocky/state/` 已建）；squad 启动 hook 调 squad-runtime 启 scheduler |
| HTTP handlers（`app/server/src/handlers/squad-*.ts`） | 修改 | 4 新端点（见 API change_log）；PATCH /squad/:id 写后调 scheduler.reloadSquad；PATCH /role/:roleId/heartbeat 调 reloadRole |

---

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
