---
type: design
title: consolidation job type（天级二级整理任务调度接线）
priority: P1
status: active
updated: 2026-07-26
since: v0.0.151.t2_consolidate
---

# consolidation job type（天级二级整理任务调度接线）

> 主文档：`index.md`（① 是什么 / ④ 核心原则）。业务侧完整设计（三段串行/双重 skip/容量/sideRun 装配/prompt）见 `../agent/memory/[P0]consolidation_tier2.md`——本文件只管**调度层接线**（job 契约 + handler gate chain + 持久化 + boot 装配 + 生命周期）。参考实现模板：`[P0]cron_subsystem.md` 的 `CronHandler`（gate chain 结构）+ `[P0]job_registry.md`（Job/JobHandler/PersistenceAdapter 契约）。

## 1. 是什么

`Job.type = 'consolidation'`——**app 级、单例、天级**调度任务（新增第 3 种 job type，`JobType` 是开放字符串枚举 `string`，无需改类型定义）。与 `heartbeat`（squad 级）、`cron`（session 级）不同，consolidation 全进程只有**一个** job 实例，owner 是固定哨兵而非某个 squad/session 的 id。

## 2. Job 定义 + 持久化（两处分离）

```typescript
interface ConsolidationPayload {
  // 空——三段工作的所有输入（模型/容量上限等）都从 app_config.consolidation 现读，不进 payload 快照
}
```

- **`Job.id`**：固定字符串（如 `'consolidation:app'`），全局唯一。
- **`Job.owner`**：固定哨兵 `'app'`（非 squadId/sessionId，因为这是唯一一个 app 级 job）。
- **`Job.schedule`**：`{kind:'cron', expr: dailyTimeToCron(dailyTime), tz: <见 §2.2>}`。
- **`Job.payload`**：`ConsolidationPayload`（空对象——刻意不缓存 modelId/容量上限到 payload，每次 fire 现读 `app_config`，避免 payload 与配置出现两份真相）。

### 2.1 两处分离存储（MANDATORY 设计决策）

**`app_config.consolidation`（用户可编辑配置）** 与 **调度执行状态**（`lastFiredAt` + 轻量可见性摘要）是**两个独立的持久化位置**，不共享一个 record：

- `app_config` group `consolidation`（详见 `../config/[P0]app_config.md §3.16`）：`{enabled, dailyTime, modelId?}`，用户在 UI 编辑保存，走既有 `AppConfigService.setGroup`。
- **`ConsolidationPersistenceAdapter`**（实现 `PersistenceAdapter` 接口）：落盘 `{dataDir}/consolidation/state.json`，内容 = `{ jobs: [{id, lastFiredAt, enabled, ...Job 其余字段}], lastResult?: {lastRunAt, summary} }`（对齐 `HeartbeatPersistence`/`CronPersistence` 的 `Job[]` 落盘范式，见 `[P0]job_registry.md §4`）。

**为什么分离**：若把 `lastFiredAt`/执行摘要也塞进 `app_config.consolidation` 的 `data`，用户在 UI 编辑 `dailyTime` 后点保存（`setGroup` 整组提交）会用旧的 draft 覆盖掉系统刚写入的 `lastFiredAt`/摘要（read-modify-write 时序竞态：UI draft 基于旧 snapshot，不含系统侧最新执行状态）。分离后，用户配置的读写路径（`/config/app?group=consolidation`）与系统执行状态的读写路径（`ConsolidationPersistenceAdapter`）完全独立，互不覆盖。**轻量可见性**（§consolidation_tier2.md §8 的"上次整理时间+摘要"）走后者，随 `lastResult` 一起落盘。

**`GET /consolidation/status` 响应合成**：`handleConsolidationStatus(adapter, appTaskLock)` 返回 `{...lastResult, status, startedAt}`——`lastResult`（lastRunAt/summary）来自 adapter 落盘；`status: 'running'|'idle'|'failed'` + `startedAt: string|null` 来自 **AppTaskLock 内存态**（lock running→'running'、failed→'failed'、done/idle→'idle'，done 的完成态由 lastResult.lastRunAt 承载；startedAt 直接透传 lock state，非 running 态为 null）。配套：`AppTaskLock.acquire` 加 1h 超时接管（`STALE_RUNNING_MS`，详见 `../../agent/session/[P0]app_task_lock.md §3.1`）。契约见 `specs/api/overall/03-config-center.md §2.7`。

### 2.2 时区

沿用 `[P1]cron_subsystem.md` 的 `resolveTz` 精神，但 consolidation 无 session/squad 概念可挂——简化为**服务器本地时区**（`Intl.DateTimeFormat().resolvedOptions().timeZone`，boot 时取一次），不提供每用户时区配置（PRD 未要求，YAGNI）。

## 3. 生命周期：boot-time-only 注册（不热重载）

`enabled`/`dailyTime`/`modelId` 三个配置字段的变化**只在下次进程重启时生效**，运行期修改 `app_config.consolidation` 不触发任何 job 的 register/unregister/reschedule。

**理由**：
1. **既有先例**：`app_config.runtime.observability` 已明确文档化"配置改动不热更新，需重启进程或下个 session 生效"（`[P0]app_config.md §3.9` 末尾注记）。consolidation 是同量级的"后台系统级技术配置"，采用相同心智模型对用户/开发者认知负担最小。
2. **PRD 自身文案**：PRD UC-3（校验持久化）的验证步骤本身包含"重启应用"一步，说明 PRD 起草时已默认这是重启生效语义，非热更新。
3. **实现复杂度权衡**：热重载需要在 `kv-config-handlers.ts` 的 PUT 路径挂一个"若 group===consolidation 则调 engine.unregister/register"的 hook，这类 config→scheduling 的反向耦合目前只有 cron/heartbeat 通过专用 handler 承担（它们有 UI 直接 CRUD 单 job 的场景），consolidation 只有一个全局配置项，不值得为此新增耦合面。

**boot 装配语义**：
- `enabled === true` 且 `modelId` 已配置 且能反查到 `providerId`：boot 时构造 `Job` 并 `engine.register(job)`。
- `enabled === false`：boot 时**根本不注册这个 job**（引擎 `jobs` Map 里没有它，等价于关闭——不是"注册了但 disabled 标记"，两者效果一致，选更简单的"不存在"表达）。
- `modelId` 未配置（`enabled=true` 但 `modelId` 缺失）：**仍然注册 job**（因为"模型未配置"是 handler 内部的业务级 skip 判定，见 §4，不是 boot 装配层该拦的——用户可能先开 enabled 再补模型，job 存在但每天 fire 时 fast-finish 记录跳过原因，直到某天用户补上模型配置后**下次重启**才会真正生效整理，这与"配置不热重载"是同一决策的自然推论）。

## 4. ConsolidationJobHandler（gate chain 极简 + fire() 语义）

对齐 `CronHandler`/`HeartbeatHandler` 的 gate chain 结构（`[P1]cron_subsystem.md` 参考实现），但 consolidation 的 gate 链**远比 cron/heartbeat 短**。**v0.0.164 起在 gate1（读配置）后加 gate2 AppTaskLock acquire**：

```
fire(job, now):
  1. gate1: 读 app_config.consolidation → 若读取本身失败（灾难性）→ 不推进 lastFiredAt，return（下 tick 重试）
  2. gate2 (v0.0.164): appTaskLock.acquire('tier2_consolidation', 'cron:'+now.toISOString())
       失败 → 静默跳过（有别的 caller 正跑，如 POST /consolidation/run 手动触发） + 不推进 lastFiredAt（本窗口已被承担，避免多次算这次 fire）
       成功 → 继续 step 3
  3. 调用 runConsolidationTier2(deps) —— 模型反查/skip 判定（consolidation_tier2.md §5.4）+ 三段串行编排全部内聚在此函数内部（业务判断不下沉到调度 glue）
       成功 → appTaskLock.markDone('tier2_consolidation')
       抛异常 → appTaskLock.markFailed('tier2_consolidation', err.message) 释放锁（catch 必须 markFailed 否则锁永不释放）
  4. 无论内部各子任务/skip 成败 → 写 lastResult（`ConsolidationPersistenceAdapter`）→ 推进 lastFiredAt（gate2 acquire 成功的情形）
```

**分层（v0.0.151.t2_consolidate 定稿 + v0.0.164 lock 接入）**：模型反查 + "未配置→fast finish"判定**收进 `runConsolidationTier2` 内部**（作为其第一步），不放在 `ConsolidationJobHandler.fire()` 里——原因：这样 `runConsolidationTier2` 是一个自洽的"整理一次"业务函数，`ConsolidationJobHandler` 退化为纯调度 glue（读配置→gate2 acquire→调用→写 lastResult→markDone/markFailed→推进锚点）。**gate2 AppTaskLock 是 v0.0.164 手动触发上线后必要的跨调用方撞车保护**——engine per-job inFlight 只防同 Promise 重入，不防"cron 到点 + 手动 POST 同时到达"两条独立 Promise chain 撞车。同一个 `runConsolidationTier2` 被三条路径复用：① cron `ConsolidationJobHandler.fire()`（带 gate2）；② 手动 `POST /consolidation/run` handler（带 gate2）；③ test-only `POST /test/consolidation/run` 端点（**不带** gate2——test 场景独立控制，不与生产锁交互）。

**`lastFiredAt` 推进语义（与 cron/heartbeat 既定原则的文档化偏离）**：`index.md §④ 原则 2` 写"gate skip 不更新 lastFiredAt"，这条原则针对的是 cron/heartbeat **可重试的业务 gate**（busy/budget/window，下 tick 重试有意义）。consolidation 的 gate1 skip（模型未配置）是 PRD 认定的合法执行结果，仍推进 lastFiredAt；**gate2 skip（AppTaskLock acquire 失败）不推进 lastFiredAt**——理由：本窗口已被别的 caller（手动 POST）承担了执行，cron 不应重复算作本窗口 fire 过，下 tick 再评估 due（可能仍在跑继续跳过，也可能已结束就 acquire 成功）。此偏离作 v0.0.164 补充例外声明，不是实现遗漏。

## 5. dailyTime → cron expr

复用既有 `computeNextCronRunMs`（`app/server/src/scheduling/cron-next.ts`，无需改动）+ 沿用 `[P1]cron_subsystem.md` 的"每天 HH:mm"预设公式：`dailyTime="04:00"` → `expr="0 4 * * *"`（分钟 分 时 * * *）。转换函数（新写，见 §6）只做这一种固定形态的字符串拼接，不需要通用 cron 构造器。

## 6. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/scheduling/payloads.ts` | 修改 | 新增 `ConsolidationPayload` 类型（空 payload，见 §2） |
| `app/server/src/scheduling/handlers/consolidation-handler.ts` | 新增 | `ConsolidationJobHandler implements JobHandler`（§4 gate chain + fire()，纯调度 glue：读配置→调用 `runConsolidationTier2`→写 `lastResult`→推进 `lastFiredAt`），依赖注入 `runConsolidationTier2` |
| `app/server/src/handlers/test-consolidation-run.ts` | 新增 | `handleTestConsolidationRun(deps): Promise<Response>`（§7 test-only 同步触发：调 `runConsolidationTier2` + 写 `lastResult`，不动 `lastFiredAt`） |
| `app/server/src/scheduling/persistence/consolidation-adapter.ts` | 新增 | `ConsolidationPersistenceAdapter implements PersistenceAdapter`（落盘 `{dataDir}/consolidation/state.json`，含 `lastResult` 读写方法）——与 `persistence/cron-adapter.ts`/`heartbeat-adapter.ts` 同目录同范式 |
| `app/server/src/scheduling/consolidation-cron.ts` | 新增 | `dailyTimeToCron(dailyTime: string): string`（§5 固定公式转换） |
| `app/server/src/scheduling/boot.ts` | 修改 | `BootSchedulerDeps` 新增 `appConfig`/`pluginManager`/`dataDir` 字段（consolidation 装配需要）；`bootScheduler()` 新增第 6 步：读 `appConfig.get('consolidation','default')`，`enabled=true` 时构造 job + `registry.register('consolidation', handler)` + `engine.register(job)`（§3 boot-time-only 语义） |
| `app/server/src/bootstrap.ts` | 修改 | `bootScheduler(...)` 调用点透传新增的 `appConfig`/`pluginManager`/`dataDir` 依赖 |
| `app/server/src/handlers/kv-config-handlers.ts` | 不修改 | consolidation group 走既有通用 `/config/app?group=consolidation` GET/PUT 路径，无需专用 handler（§3 决策：不热重载，无需 hook） |
| `app/server/src/router.ts` | 修改 | 新增 `path.startsWith('/test/consolidation')` 分支（`NODE_ENV!=='test'`→404，对齐 `/test/stub`/`/test/llm-mode` 既有 gate 位置），路由 `POST /test/consolidation/run` → `handleTestConsolidationRun`（§7） |

## 7. Test-only 同步触发端点（AT 可测性——v0.0.151.t2_consolidate 补）

**问题**：PRD 明确排除手动"立即整理"触发（生产 UI 无此入口），但 AT（黑盒 HTTP，`case.yaml` 纯静态 DSL）无法可靠等一个 `HH:mm` 粒度的 cron 到点——`wait`/`poll` 上限 60s，且 case 无法动态算"下一次 04:00 还有多久"。若完全没有同步触发手段，consolidation 的收敛逻辑（合并/去重/容量收敛/双重 skip）将**无法被 AT 覆盖**，只能靠 UT。

**方案**：新增 **`POST /test/consolidation/run`** —— test-only 同步 wrapper，**直接调用 `runConsolidationTier2(deps)` 并 await 到完成，同步返回完整结果**（含各工作块的 `BlockResult`/`'skipped'` + 汇总 `summary`）。命名/gate 模式对齐既有 test-only 先例（`POST /session/:id/run` / `POST /test/stub` / `POST /test/llm-mode`）：

- **Gate（双重，生产绝不暴露）**：router 层 `process.env.NODE_ENV !== 'test'` → 404（对齐 `router.ts` 既有 `/test/llm-mode`/`/test/stub`/`/session/:id/run` 三处同款 gate 位置）；handler 层同样二次 gate（防被其他模块 import 绕过 router 直调）。
- **不经调度器**：不通过 `SchedulerEngine`/`ConsolidationJobHandler.fire()`，不受 `job.enabled`/`schedule` 影响——即便 `app_config.consolidation.enabled=false`（boot 时根本没注册 job），本端点仍可被调用（AT 场景通常就是 `enabled=false` 的默认态下测试收敛逻辑本身，不依赖调度是否开着）。
- **`lastFiredAt`：不动**。理由：`lastFiredAt` 是**真实调度 job** 的 at-most-once 续接锚点（§4 `isDue` 从它重算下次到点）。若测试触发也推进它，会**静默扰动**同进程内若恰好 `enabled=true` 时真实 job 的下次到点计算（AT env 的 `SchedulerEngine` 是活的，`SCHEDULER_TICK_MS` 在 test.env 里被调快）——这是一个测试路径污染调度状态的隐蔽副作用，故明确不碰。
- **`lastResult`：会写**（走同一个 `ConsolidationPersistenceAdapter.writeLastResult`）。理由：AT 的典型验证序列是"seed 数据 → POST 触发 → 断言收敛结果 + `GET /consolidation/status`"——后者要能看到本次触发的 `lastRunAt`/`summary`，所以必须落这一份轻量可见性状态；这部分状态本身只读投影、无调度语义，写它不产生上一条所述的副作用问题。
- **响应体**：`200` + `ConsolidationTier2Result`（三块各自的 `BlockResult | 'skipped'` + `summary: string`），供 AT 断言逐块收敛结果，而不只是一句话摘要。

**不进 `specs/api/overall/`**：对齐 `POST /session/:id/run` 先例（该端点同样是 test-only 同步 wrapper，只记录在 `specs/api/version_logs/v0.0.69.test_refactor/change_log.md`，明确注记"不进 `04-agent-session.md`"）——完整请求/响应契约记录在 `specs/api/version_logs/v0.0.151.t2_consolidate/change_log.md`，本文件只做架构层面的落点说明。

## 8. 边界（不做什么）

- 不改 `SchedulerEngine`/`isDue`/`JobHandlerRegistry` 本体（纯度不破，`type` 已是开放枚举）。
- 不给 consolidation job 引入 UI 直接 CRUD（不像 cron 那样有 `/session/:id/cron` 端点族）——它是单例系统级 job，配置走 `app_config.consolidation`，不走 job 级 CRUD API。
- 不做热重载 hook（§3 已论证）。
- 不新增互斥锁（业务侧论证见 `../agent/memory/[P0]consolidation_tier2.md §7`）。
- test-only 端点（§7）不做鉴权/白名单以外的额外功能——纯粹是"同步跑一次 + 返回结果"，不接受任何覆盖 `app_config.consolidation` 的参数（避免它变成隐藏的第二套配置入口）。

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/v0.0.151.t2_consolidate/change_plan.md`。
