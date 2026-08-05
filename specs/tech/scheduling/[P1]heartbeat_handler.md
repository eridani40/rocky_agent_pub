---
type: design
title: Heartbeat Handler — squad 级统一心跳调度 + gate 链
priority: P1
status: active
updated: 2026-07-15
since: v0.0.58
---

# Heartbeat Handler — squad 级统一心跳调度

> [v0.0.58] 把 v0.0.33.4 `SquadScheduler.tryFire` 的 gate chain 迁到公共引擎上的 heartbeat handler。
> **[v0.0.116] 心跳粒度从 per-member 升级为 squad 级统一调度**：一个 heartbeat job per squad（Job.id=`heartbeat:<squadId>`），到点整队一次，按 `squad.heartbeatConfig.scope` 对符合条件成员逐个 `deliverTo`。**废弃 per-member job**（旧 `heartbeat:<squadId>:<memberId>`）。
> 迁移基线：`../squad/[P1]scheduler.md`（v0.0.33.4，per-member 历史基线）。
> 引用：`[P0]engine.md §3` tick 主循环 / `[P0]job_registry.md` Job interface / `../squad/[P1]data_model.md §1.1a`（SquadHeartbeatConfig）。

---

## 0. [v0.0.116] squad 级统一调度（本版本核心变更）

**决策**：心跳粒度 per-member → **squad 级**。一个 squad = 一个 heartbeat job；到点整队一次，按范围逐成员投递固定心跳提示词。

| 维度 | v0.0.33.4（per-member，废弃） | v0.0.116（squad 级） |
|---|---|---|
| **Job 数** | N（每 deployed member 一个） | 1（每 squad 一个） |
| **Job.id** | `heartbeat:<squadId>:<memberId>` | `heartbeat:<squadId>` |
| **HeartbeatPayload** | `{squadId, memberId, sessionId}` | `{squadId}`（成员在 fire 时按 scope 展开） |
| **调度参数源** | `member.heartbeat`（每人独立 activeWindow/interval） | `squad.heartbeatConfig`（一队一份 interval/activeWindows/scope） |
| **投递** | 单 member.sessionId | 逐成员：scope∩deployed∩非busy 的每个 member.sessionId |
| **tick message** | `[proactive_tick:heartbeat] at {at}` | **固定心跳提示词**（§0.1 权威文案，含 `<EOS>` 出口句） |

**范围（scope）语义**（`squad.heartbeatConfig.scope`）：
- `mode='all'`（默认）：全员（含 leader），benched 除外。
- `mode='whitelist'`：仅 `memberIds` 白名单成员——**后续新增成员不自动纳入**（req）。
- 任何模式 benched 成员都不唤醒；SquadChat 无 member record 天然不在成员列表；非白名单成员本轮跳过。

**<EOS> 零机制改动**（req 决策 3，硬约束）：`<EOS>` 只作为心跳提示词文案里的出口句写进 tick message（§0.1）。**不扩展 stop token、不给 leader/mate 加 EOS 处理、不动 SquadChat 现有 EOS 机制**。成员被唤醒后无工具调用 → 自然 `no_tool_call` 结束 run（现有 loop 行为，不特判）。

### 0.1 心跳提示词权威文案（req 原文，写死进 tick message）

```
这是团队自动工作的提醒。
你可以检查现在属于你的任务、需求、目标等，或者之前被中断的工作。如果无需继续工作，则可以直接输出<EOS>并退出。
```

- 由独立函数 `buildHeartbeatTickMessage`（`tick-message.ts`）承载，正文来自 `HeartbeatTickHandler` 读取 `content/tick_heartbeat.md`（**[v0.0.153]** 文件化，原 `HEARTBEAT_TICK_PROMPT` 内联常量已删，措辞逐字一致；通用机制见 `../agent/context/[P0]prompt_content_files.md §4.2`）。作为 `role:'user'` message content 投递（走 inbox enqueue，sender `{source:'system', system.kind:'heartbeat'}`，同 v0.0.33.4 投递原语）。
- `<EOS>` 是文案里的**软出口引导**，不是程序 token——成员理解后自行决定「无事可做就直接结束」；程序上靠 no_tool_call 自然收尾。

---

## 1. 实现改造（squad 级 job，废弃 per-member）

**v0.0.58 基线**（保留）：SquadScheduler class 已 retire，改「向 engine register heartbeat jobs」的 adapter；`SquadRuntime.ensureScheduler/reloadSquad/stopAll` 对外接口不变。

**v0.0.116 改造**：
- **per-member job 全废弃**：`listHeartbeatRoles` / `projectMemberHeartbeat` / `buildHeartbeatJob(squadId,memberId,...)` / `reloadRole` / `heartbeatJobId(squadId,memberId)` 删除或改签名为 squad 级（coder 定位）。
- **新 squad 级 job 构造**：`buildSquadHeartbeatJob(squadId, heartbeatConfig, tz, lastFiredAt)` → `{id:'heartbeat:'+squadId, type:'heartbeat', schedule:{kind:'interval', ms:interval*60000, tz}, payload:{squadId}, lastFiredAt, enabled:true, createdAt, owner:squadId}`。**schedule 不带 activeWindows**——engine 纯度守护：多段时段判定全下沉 `HeartbeatHandler.tryFire gate1`（读 `getSquad().heartbeatConfig.activeWindows`），Job.schedule 只承载 interval.ms（开放点1裁决）。
- **HeartbeatHandler.deps 扩展**：`getSquad` 返回含 `heartbeatConfig`（SquadSnapshot 加字段）；新增 `listMembers(squadId)` + `isSessionBusy` 逐成员用；`deliverTo` 逐成员调。
- **`reloadRole` 废弃**（无 per-member 心跳），改由 `reloadSquad` 统一 reload squad job（PATCH /squad 写 heartbeatConfig 后调）。

**风险评估**：中高。需重写 v0.0.33.4 回归 UT（per-member → squad 级）；heartbeat_member_fire / window_skip / busy_skip / budget_skip / killswitch / multi_squad_isolation 全部改为 squad 级语义。

---

## 2. HeartbeatHandler 实现（squad 级 + 逐成员展开）

```typescript
class HeartbeatHandler implements JobHandler {
  constructor(private deps: {
    getSquad(squadId): Promise<SquadSnapshot | undefined>;  // 含 enableHeartBeat/budget/timezone/heartbeatConfig
    listMembers(squadId): Promise<MemberSnapshot[]>;         // [v0.0.116] 逐成员展开（{id,sessionId,state,role}）
    budgetRemaining(squadId): number;                        // sync cache（沿用 v0.0.33.4 squad-runtime 模式）
    isSessionBusy(sessionId): Promise<boolean>;
    deliverTo(sessionId, message): Promise<unknown>;
    stateStore: SchedulerStateStore;                         // scheduler.json 持久化（squad 级 lastFiredAt）
    history: SchedulerHistory;                               // ring buffer + jsonl
    engine: SchedulerEngine;                                 // 反向引用，fire 后 updateJobLastFiredAt
  }) {}

  async fire(job: Job, now: Date): Promise<void> {
    if (job.type !== 'heartbeat') return;
    const p = job.payload as HeartbeatPayload;   // [v0.0.116] {squadId}（去 memberId/sessionId）
    try {
      const result = await this.tryFire(job, p, now);   // squad 级 gate + 逐成员投递
      this.recordHistory(p, now, result);
      // squad 级 gate 全通过（到点）→ fired；更新 job lastFiredAt（逐成员某个 skip 不影响 job 级）
      if (result.kind === 'fired') {
        this.deps.engine.updateJobLastFiredAt(job.id, now.toISOString());
      }
      // scheduler.json 落 squad 级 lastFiredAt/lastResult（[v0.0.116] 去 memberId 分桶，§3）
      this.deps.stateStore.writeSquad(p.squadId, {
        lastFiredAt: result.kind === 'fired' ? now.toISOString() : job.lastFiredAt,
        lastResult: result.kind,
      });
    } catch {
      // best-effort：异常不阻塞 engine 下 tick
    }
  }

  /** squad 级 gate chain（gate0/1/2 队级 → 逐成员 filter + deliverTo） */
  private async tryFire(job: Job, p: HeartbeatPayload, now: Date): Promise<TickResult> {
    const squad = await this.deps.getSquad(p.squadId);
    if (!squad) return { kind: 'skipped_killswitch' };  // squad 不存在当 killswitch
    // gate0: killswitch（每 tick 现取，squad.enableHeartBeat，toggle ≤1s 生效）
    if (!squad.enableHeartBeat) return { kind: 'skipped_killswitch' };
    // gate1: activeWindows 多段（空数组=全天通过；跟 squad.timezone）
    // [v0.0.116] 多段来源 = getSquad().heartbeatConfig.activeWindows（不读 job.schedule.activeWindow）——
    //   engine 纯度守护：activeWindows 业务 gate 全下沉 handler，Job.schedule 只有 interval.ms（无 activeWindows）。
    const windows = squad.heartbeatConfig?.activeWindows ?? [];
    if (windows.length > 0 &&
        !windows.some(w => withinActiveWindow(w, now, squad.timezone ?? 'UTC')))
      return { kind: 'skipped_window' };
    // gate2: budget（null=off=不限量=放行；非 null && remaining<=0 才 skip）
    // budgetRemaining 读 boot.ts 的 sync budgetCache（30s 周期后台刷新；见 §3.1 生效延迟 + lazy-baseline 口径）
    if (squad.budget !== null && this.deps.budgetRemaining(p.squadId) <= 0)
      return { kind: 'skipped_budget' };
    // 队级 gate 全通过 → 逐成员展开投递（[v0.0.116] scope + deployed + busy filter）
    const scope = squad.heartbeatConfig?.scope ?? { mode: 'all', memberIds: [] };
    const members = await this.deps.listMembers(p.squadId);
    for (const m of members) {
      if (scope.mode === 'whitelist' && !scope.memberIds.includes(m.id)) continue;  // 非白名单跳过
      if (m.state !== 'deployed') continue;                                          // benched 不唤醒
      if (!m.sessionId) continue;                                                    // 无 session（SquadChat 无 member 天然排除）
      if (await this.deps.isSessionBusy(m.sessionId)) continue;                      // busy 跳过该成员（不堆 tick）
      await this.deps.deliverTo(m.sessionId, buildHeartbeatTickMessage(m.sessionId, now.toISOString()));  // §0.1 固定文案
    }
    return { kind: 'fired' };   // 到点且队级 gate 通过即 fired（成员级 skip 不改 job lastFiredAt）
  }

  private recordHistory(p, now, result): void {
    // [v0.0.116] squad 级历史一条（roleId 可空/为 squadId，或记 delivered 成员数——coder 定位）
    this.deps.history.append(p.squadId, {
      roleId: p.squadId, at: now.toISOString(), reason: 'heartbeat', result: result.kind,
    });
  }
}
```

**注意**：
- 上述伪码为契约描述，非最终实现；coder 可拆纯函数（`withinActiveWindow` 保留）+ handler。
- **成员级 skip 不产 TickResult**：`skipped_busy` 原是 member 级——v0.0.116 队级 gate 全通过即 `fired`，busy/benched/非白名单只是逐成员循环内 `continue`。若需记录成员级 skip，走 history 细粒度（coder 定位，非 job lastResult）。
- `withinActiveWindow` 纯函数不变（单段判定，跨午夜防御深度保留）；多段是 `windows.some(...)` 外层组合。
- **activeWindows 多段判定在 handler，不在 engine**（开放点1定案）：engine `IntervalSchedule` 保持只有单 `activeWindow?`（heartbeat job 置 undefined，首 tick isDue=true 交 handler gate1）；多段 `activeWindows[]` 全下沉 `tryFire gate1`，来源 = `getSquad().heartbeatConfig.activeWindows`（`squad-runtime.ts.getHeartbeatConfig()→projectSquadHeartbeatConfig()`），不进 payload/engine types。守 engine 不感知业务原则。
- `buildHeartbeatTickMessage`（`squad/scheduler/tick-message.ts`）= 新增独立函数承载 §0.1 固定文案。

---

## 3. HeartbeatPersistenceAdapter（[v0.0.116] squad 级 lastFiredAt + 旧数据清理）

```typescript
class HeartbeatPersistenceAdapter implements PersistenceAdapter {
  constructor(private stateStore: SchedulerStateStore, private getHeartbeatConfig(squadId): Promise<{config, tz} | null>) {}

  async loadJobs(squadId: string): Promise<Job[]> {
    const hb = await this.getHeartbeatConfig(squadId);   // squad.heartbeatConfig + timezone（null 走默认 interval=15/[]/all）
    if (!hb) return [];   // [v0.0.116 架构裁决] getHeartbeatConfig 仅 squad 不存在返 null → []；heartbeatConfig=null 时 projectSquadHeartbeatConfig 走默认值仍建 1 job。**enableHeartBeat 开关不在 loadJobs 静态拦**——killswitch 是每-tick 现取的动态 gate0（handler.tryFire），开关切换 ≤1s 生效，无需 reload/重建 job。
    const state = this.stateStore.readSquad(squadId);    // [v0.0.116] squad 级读（去 memberId）
    const cfg = hb.config;
    return [{
      id: `heartbeat:${squadId}`,                        // [v0.0.116] 一 squad 一 job
      type: 'heartbeat',
      schedule: { kind:'interval', ms:(cfg.interval ?? 15)*60000, activeWindows:cfg.activeWindows ?? [], tz:hb.tz },
      payload: { squadId },                              // [v0.0.116] 只带 squadId（成员 fire 时展开）
      lastFiredAt: state?.lastFiredAt ?? null,
      enabled: true,
      createdAt: state?.lastFiredAt ?? new Date().toISOString(),
      owner: squadId,
    }];
  }

  async upsertJob(squadId, job): Promise<void> {
    // scheduler.json squad 级：只存 lastFiredAt/lastResult；schedule/payload 由 squad.heartbeatConfig 单一源驱动
    this.stateStore.writeSquad(squadId, {
      lastFiredAt: job.lastFiredAt,
      lastResult: 'fired',  // 仅 fire 成功才 upsert（caller 保证，详 handler.fire）
    });
  }

  async removeJob(squadId, jobId): Promise<void> {
    // enableHeartBeat 关 / heartbeatConfig 清 → engine.unregister（caller 处理）；stateStore 不删 lastFiredAt（续接）
  }

  async removeAllJobs(squadId): Promise<void> {
    // squad 硬删 teardown 走 disposeSquad（engine.unregister 按 registeredJobIds）；本方法 no-op（兼容接口）
  }
}
```

**scheduler.json schema 演进（v1 → v2）+ 旧数据清理方案**（不运行时无条件清数据，memory `runtime-no-ext-policy-write`）：
- **v1（v0.0.33.4，废弃）**：`{version:1, roles:{<memberId>:{lastFiredAt, lastResult}}}`（per-member 分桶）。
- **v2（v0.0.116）**：`{version:2, lastFiredAt, lastResult}`（squad 级单条；去 roles 分桶）。
- **清理方案（读取时忽略 + 保存时自然收敛，非运行时破坏性迁移）**：
  1. `SchedulerStateStore.readSquad(squadId)`：读文件——若见 v2 平铺 `lastFiredAt` 直接用；若见 v1 旧 `roles{}` 结构则**忽略旧 member 分桶**（不 migrate、不删），返 `lastFiredAt=null`（心跳从当前重排，最多漏一次，可接受）。
  2. `SchedulerStateStore.writeSquad`：首次 fire 落盘即写 v2 结构，**自然覆盖**旧文件为 v2（旧 roles entries 随之消失——是「保存时收敛」不是「运行时主动删」）。
  3. **不做启动期扫库清 member entries**（runtime 启动路径绝不破坏性清理）。若需开发期一次性 migration，带 version marker（v1→v2），非本版本必需。
- **member.heartbeat 字段清理**：schema 保留字段（dead，data_model §1.2），代码停读——旧 member record 的 heartbeat 值静默留盘不影响调度（squad.heartbeatConfig 单一源）。

### 3.1 budget gate 的 cache 时序 + lazy-baseline 口径（v0.0.33.4 沿用，实证补记）

gate2 的 `budgetRemaining(squadId)` 是 **sync 契约**读 `boot.ts` 装配的 `budgetCache`（`boot.ts:budgetCache` Map），非每 tick 现算：

- **cache 生效延迟最长 30s**：`boot.ts` 启动时 prime 一次 + `setInterval(refreshBudgetCache, 30_000).unref()` 周期后台刷新（`index.md §④ 原则10`）。故 `PATCH /squad budget`（改 limit）后，**最长 30s** cache 才刷新到新 limit → 心跳 gate2 才用新值判定。心跳 tick 高频，用 cache 换 sync 契约（不每 tick 拉全 squad usage）。
- **budget=null 不入 cache → cache-miss 放行**：`refreshBudgetCache` 跳过 `budget===null` 的 squad（`boot.ts` 内 `if (s.budget === null) return`）；`budgetRemaining` cache-miss 返 `Number.POSITIVE_INFINITY`（放行）。故 budget `null→非null` 切换后、cache 首次刷进该 squad 前的窗口，gate2 因 `squad.budget !== null` 条件为真会去查 cache，miss → Infinity 放行——**同样受 30s 延迟**。
- **consumed = lazy-baseline 语义（非 always-on）**：`squadBudgetRemaining = limit - Σ consumed`，`consumed` 走 `budget-state.ts.getConsumed` 的 **baseline-delta**（`squad-budget-wiring.ts.makeGetUsageTotalTokens()→BudgetState.getConsumed()`）——**窗口内首次查某 session 时补 baseline=当前全时 total、consumed 从 0 起算**（v0.0.33.4 起）。即 budget 不是「进程启动即持续累计」，而是「首次被 gate 查询播下 baseline，之后 delta 才计入 consumed」。跨 daily 窗口（squad tz 0 点）翻转重置 baseline。

---

## 4. 回归红线（v0.0.33.4 不变量 — [v0.0.116] squad 级重表述）

心跳升级 squad 级后，以下不变量语义保留但落点从 per-member 改 squad 级（AT/UT 全量重写）：

| # | 不变量 | v0.0.33.4 来源 | [v0.0.116] squad 级落点 |
|---|---|---|---|
| 1 | **interval + activeWindow(s) 时段限制** | `[P1]scheduler.md §3/§4` | `Job.schedule={kind:'interval', ms}`（**不带 activeWindows**，engine 纯度）+ `HeartbeatHandler.tryFire gate1` 读 `getSquad().heartbeatConfig.activeWindows`（多段 `windows.some`，空数组=全天） |
| 2 | **gate 顺序：killswitch→window→budget→(逐成员)busy→deliverTo** | `[P1]scheduler.md §4 / autonomy §5` | `HeartbeatHandler.tryFire` gate0→gate1→gate2→逐成员(scope∩deployed∩非busy) |
| 3 | **killswitch（squad.enableHeartBeat）每 tick 现取** | `[P1]scheduler.md §4 / SD7` | `HeartbeatHandler.tryFire` gate0（每 fire 现取，toggle ≤1s 生效） |
| 4 | **lastFiredAt 续接语义（重启不丢）** | `[P1]scheduler.md §3/§7` | scheduler.json v2 squad 级 lastFiredAt + `HeartbeatPersistenceAdapter` 回填 `Job.lastFiredAt` |
| 5 | **null-budget Gate 放行（off=不限量）** | `[P1]scheduler.md §4 gate2 / autonomy §6` | `HeartbeatHandler.tryFire gate2`（budget=null 短路，语义即 req「off=不限量」） |
| 6 | **多 squad 隔离** | `[P1]scheduler.md §9` | `Job.id = heartbeat:<squadId>` 全局唯一；engine 单例遍历但 job 独立 |
| 7 | **[v0.0.116 新增] scope 范围 + benched 不唤醒** | req 决策 6 | 逐成员 filter：whitelist∩deployed∩非busy；benched 任何模式跳过；新增成员不入白名单 |

**附加不变量（cross-midnight）**：`withinActiveWindow` 单段跨午夜算法（start>end）保留作防御深度；但 HTTP 写入校验拒 `start>=end`（API 不暴露跨午夜，`11a §1.4`），多段间不重叠 + 单段不跨 0 点。

---

## 5. squad-runtime.ts 改造点（[v0.0.116] squad 级）

**保留**（对外接口）：
- `SquadRuntime.startAll/stopAll/ensureScheduler/reloadSquad/registerShutdownTrap` 签名不变。
- **`reloadRole` 废弃**（无 per-member 心跳，PATCH /member/:mid/heartbeat 端点删除，`11a §4.2` 删）。原 `reloadRole` caller（heartbeat HTTP handler）随端点一起删。

**内部改造**：
- `ensureScheduler(squadId)`：`heartbeatAdapter.loadJobs(squadId)` 现返 **0 或 1 个 squad 级 job**（原返 N 个 per-member）→ `engine.register`。`registeredJobIds` 仍 `Map<squadId, Set<jobId>>`（每 squad 至多一个 jobId）。
- `registerHeartbeatJobs`：调 adapter 拿 squad job（读 `squad.heartbeatConfig`）→ register（tz 已在 adapter.loadJobs 从 `getHeartbeatConfig` 的 tz 注入 schedule）。`listHeartbeatRoles` / `projectMemberHeartbeat` **删除**（改私有 `getHeartbeatConfig(squadId)`→`projectSquadHeartbeatConfig` 读 squad.heartbeatConfig）。
- **killswitch = job 恒注册 + handler gate0 动态判（无 `shouldSchedule` 静态门）**：`startAll`/`reloadSquad` 对每个存在的 squad **恒注册** 1 个 heartbeat job，**不静态判 `enableHeartBeat`**（`SquadRuntime.shouldSchedule` 已删除）。开关关时 job 仍在 engine，每 tick `tryFire` gate0 现取 `squad.enableHeartBeat=false` → `skipped_killswitch`（history 有记录 + toggle ≤1s 生效，无需 unregister/reload）。`enableHeartBeat` 变更不需要 reload——只有 interval/activeWindows/scope/tz 变才 reload 重建 schedule。
- `reloadSquad`：PATCH /squad 写 `enableHeartBeat` / `budget` / `timezone` / **`heartbeatConfig`** 后调——已 ensure 则 `unregisterHeartbeatJobs → registerHeartbeatJobs`（含新 interval/activeWindows/scope/tz）；未 ensure 则 `ensureScheduler`。这是 v0.0.116 心跳配置变更的**唯一实时刷入口**（取代 reloadRole）。
- **lastFiredAt 重排语义（reload 从文件恢复；运行期只认内存）**：任何 PATCH /squad 触发 `reloadSquad` → unregister + 重新 `loadJobs`，新 job 的 `lastFiredAt` 从 **scheduler.json 文件**（`stateStore.readSquad`）恢复（v1 忽略返 null=从当前重排）。运行期 engine 只认**内存** lastFiredAt（fire 成功后 `updateJobLastFiredAt` 写内存 + writeSquad 落盘）；reload 是唯一把文件值拉回内存的路径。含义：`fired` 推进 lastFiredAt（下次隔 interval）、gate skip 不推进（下 tick 重试）；PATCH 后 job 从文件 lastFiredAt 重新排（若文件仍是上次 fired 值则接着排，若首次/ v1 则立即到点）。
- `HeartbeatHandler.deps.listMembers`：squad-runtime 注入 `listMembersSnapshot(squadId)`（`memberStore.listMembers` 投影 `{id, sessionId, state, role}`），供 handler 逐成员展开。
- `stopAll`/`disposeSquad`：不变（按 registeredJobIds unregister；squad 级 jobId 更简单）。

**budget cache refresh 模式保留**：HeartbeatHandler.deps.budgetRemaining 仍 sync closure 读 cache；refresh 在 `getSquad` side-effect（同 v0.0.33.4）。

---

## 7. 文件级变更清单（[v0.0.116]）

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/scheduling/handlers/heartbeat-handler.ts` | 修改 | `tryFire` 改 squad 级 gate（gate0/1/2 队级 + 逐成员 scope∩deployed∩非busy 展开投递）；`HeartbeatHandlerDeps` 加 `listMembers`；`fire` 落 squad 级 lastResult；tick message 改 §0.1 固定文案 |
| `app/server/src/scheduling/payloads.ts` | 修改 | `HeartbeatPayload` 去 `memberId`/`sessionId`，仅留 `{squadId}` |
| `app/server/src/scheduling/persistence/heartbeat-adapter.ts` | 修改 | `loadJobs` 返 0/1 squad 级 job（读 squad.heartbeatConfig，去 listHeartbeatRoles）；`upsertJob` 走 squad 级 writeSquad |
| `app/server/src/squad/scheduler/scheduler-state.ts` | 修改 | scheduler.json v2 squad 级：加 `readSquad/writeSquad`（去 memberId 分桶）；`readRole/writeRole` **删除**（旧 v1 结构读时忽略返 null，§3 清理方案） |
| `app/server/src/squad/scheduler/tick-message.ts` | 修改 | 加 `HEARTBEAT_TICK_PROMPT` 常量 + `buildHeartbeatTickMessage`（§0.1 固定文案，独立函数） |
| `app/server/src/squad/scheduler/types.ts` | 修改 | `SquadSnapshot` 加 `heartbeatConfig`；`RoleHeartbeat` 废弃（改 squad 级配置投影 `SquadHeartbeatConfig`）；新增 `MemberSnapshot`（handler listMembers 用） |
| `app/server/src/squad/squad-runtime.ts` | 修改 | `registerHeartbeatJobs` 读 squad.heartbeatConfig 建 1 job（**恒注册**，killswitch 走 handler gate0 动态）；删 `listHeartbeatRoles`/`reloadRole`/`shouldSchedule`（不再静态判 enableHeartBeat）；新增私有 `getHeartbeatConfig` + `listMembersSnapshot`（注入 handler deps）；`reloadSquad` 成为唯一心跳配置实时刷入口 |
| `app/server/src/squad/squad-runtime-helpers.ts` | 修改 | `buildHeartbeatJob(squadId,memberId,...)` → `buildSquadHeartbeatJob(squadId,config,tz,lastFiredAt)`；`heartbeatJobId(squadId,memberId)` → `heartbeatJobId(squadId)`；删 `projectMemberHeartbeat` |
| `app/server/src/agent/schema_defs/squad/squad.ts` | 修改 | 加 `heartbeatConfig: {type:'json', required:false}`（SquadHeartbeatConfig） |
| `app/server/src/agent/schema_defs/squad/member.ts` | 修改 | `heartbeat` 标 dead（保留 schema，停读写）；加 `currentWork: {type:'json', required:false}`（presence，data_model §1.2b） |
| `app/server/src/handlers/squad-heartbeat-handler.ts` | 删除 | PATCH /member/:mid/heartbeat 端点废弃（member 无独立心跳，squad 级配置走 PATCH /squad） |
| `app/server/src/scheduling/**/__tests__/*` + squad-runtime.test.ts | 修改 | 全量重写 UT（per-member → squad 级 + scope 逐成员展开 + v2 state） |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
