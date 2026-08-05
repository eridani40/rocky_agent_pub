---
type: log
title: Scheduling KB 变更记录
updated: 2026-07-26
---

# Scheduling KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-26 · v0.0.205.t2_cons（status 端点合成 lock 态 + AppTaskLock 超时接管）

- **`[P1]consolidation_job.md §2.1`**：`GET /consolidation/status` 响应合成写明——`{...lastResult, status, startedAt}`，lastResult 走 adapter 落盘、status/startedAt 来自 AppTaskLock 内存态（done 归 idle，非 running → startedAt=null）；handler 签名 `handleConsolidationStatus(adapter, appTaskLock)`。配套 `AppTaskLock.acquire` 1h 超时接管（STALE_RUNNING_MS，详见 `../agent/session/[P0]app_task_lock.md §3.1`）。

详情：`specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md`（模块 B1）

## 2026-07-17 · v0.0.164.memory_opt（consolidation job 接入 AppTaskLock + 手动触发路径）

- **`[P1]consolidation_job.md §4`**：`ConsolidationJobHandler.fire()` gate chain 加 gate2：读 app_config 成功后 → `AppTaskLock.acquire('tier2_consolidation', 'cron:'+iso)`；失败静默跳过**不推进 lastFiredAt**（本窗口已被别的 caller 承担，无需重复 fire）；成功 markDone，catch 分支 markFailed（否则锁不释放）。
- **`[P1]consolidation_job.md §7`**：加手动触发路径 `POST /consolidation/run`（`handleConsolidationRun`，本版本首个生产端点触发 tier2；不同于既有 test-only `POST /test/consolidation/run`）。fire-and-forget 语义：acquire 成功 → 立即 202 返 `{ok,runId}` + 后台跑 tier2；acquire 失败 → 409 `{error:'consolidation_in_progress'}`。两条触发路径（cron/手动）共用**完全同一段 tier2 job 代码**（`runConsolidationTier2`），仅触发源不同，skip 逻辑（模型未配置/无新对话）对两者一致生效。
- **`[P1]consolidation_job.md §6`** 文件清单补：`handlers/consolidation-run.ts` 新增行 + `routes/misc-routes.ts` POST /consolidation/run 分支行 + `ConsolidationJobHandlerDeps` 加 `appTaskLock` 字段行 + `BootScheduler deps` 透传 appTaskLock 行。
- **依赖新 KB**：`../agent/session/[P0]app_task_lock.md`（本版本新建，形态照抄 SessionTaskLock 扩到 app 级）。

详情：`specs/tech/version_logs/v0.0.164.memory_opt/change_log.md` + `change_plan.md`

## 2026-07-15 · v0.0.153（心跳提示词正文文件化，HEARTBEAT_TICK_PROMPT → content/tick_heartbeat.md）

- `tick-message.ts` 的 `HEARTBEAT_TICK_PROMPT` 内联 TS 常量删除，正文迁移至 `app/server/src/prompts/content/tick_heartbeat.md`（措辞逐字一致，含 `<EOS>` 软出口引导句），经新增 `HeartbeatTickHandler` 读取；`buildHeartbeatTickMessage()` 调用点等价替换，姊妹函数 `buildTickUserMessage()`（file-watch 共享）未文件化、不受影响。
- `[P1]heartbeat_handler.md §0.1` 同步更新为 handler-based 描述（原文写「coder 定位：改 builder text 或加常量」的开放点现已落定）；通用机制归 `../agent/context/[P0]prompt_content_files.md §4.2`。
- 详情：`specs/tech/version_logs/v0.0.153/change_log.md`

## 2026-07-15 · v0.0.151.t2_consolidate（新增 consolidation job type：天级二级整理任务调度接线）

- **新增 `[P1]consolidation_job.md`**：`Job.type` 新增第 3 种 `'consolidation'`（app 级单例，owner=固定哨兵，非 squadId/sessionId）。`schedule.kind='cron'`（`dailyTime` HH:mm → `M H * * *`，服务器本地时区）。
- **boot-time-only 注册**（§3）：`enabled`/`dailyTime`/`modelId` 改动不热重载，对齐 `app_config.observability` 既定"重启生效"先例；`enabled=false` 时 boot 根本不注册该 job。
- **持久化两处分离**（§2.1）：`app_config.consolidation`（用户配置）与 `ConsolidationPersistenceAdapter`（`{dataDir}/consolidation/state.json`，落 `lastFiredAt`+`lastResult` 轻量可见性摘要）完全独立，防 UI 保存配置时覆盖系统写入的执行状态。
- **`lastFiredAt` 推进语义显式偏离原则 2**（§4，新增 index.md 原则 13）：consolidation 无可重试业务 gate，"模型未配置"是合法执行结果非 gate 失败，`lastFiredAt` 几乎每次 fire 都推进。
- 业务侧完整设计（三段串行/双重 skip/容量/sideRun 装配）见 `../agent/memory/[P0]consolidation_tier2.md`。

详情：`specs/tech/version_logs/v0.0.151.t2_consolidate/change_plan.md`

## 2026-07-11 · v0.0.116（心跳从 per-member 升级为 squad 级统一调度）

- **heartbeat job 粒度 per-member → squad 级**（`[P1]heartbeat_handler.md §0/§1`）：一 squad 一 job（`Job.id=heartbeat:<squadId>`，去 memberId 后缀），`HeartbeatPayload` 收敛为 `{squadId}`。到点整队一次，`tryFire` 队级 gate（killswitch→activeWindows 多段→budget）通过后**逐成员展开**（scope: all/whitelist ∩ deployed ∩ 非 busy）各 `deliverTo`。
- **心跳配置上收到 squad 级**（`../squad/[P1]data_model.md §1.1a`）：新增 `squad.heartbeatConfig{interval(5/15/30/60,默认15), activeWindows[](多段/不重叠/不跨0点), scope{mode:all/whitelist, memberIds}}`；`member.heartbeat` 标 dead（schema 留字段停读写）。budget `null=off=不限量` 语义显式化（现有 gate 天然对齐）。
- **tick message 固定心跳提示词**（§0.1，req 原文，含 `<EOS>` 出口句）——**`<EOS>` 零机制改动**（只写文案，成员无工具调用自然 no_tool_call 结束，不扩 stop token/不动 SquadChat EOS）。
- **scheduler.json v1→v2**（§3）：`{version:2, lastFiredAt, lastResult}`（去 roles memberId 分桶）；旧 v1 数据**读取时忽略 + 保存时自然收敛**（不运行时破坏性清理，memory `runtime-no-ext-policy-write`）。
- `reloadRole` 废弃（`reloadSquad` 成唯一心跳配置实时刷入口）；`PATCH /squad/:id/member/:mid/heartbeat` 端点删除（`11a §4.2`）。
- **[架构 pass 裁决]**（`version_logs/v0.0.116/change_plan.md §0`）：① `activeWindows[]` 多段业务 gate **全下沉 `HeartbeatHandler.tryFire` gate1**（多段来源=`getSquad().heartbeatConfig`），engine `isDue`/`IntervalSchedule` **保持单 activeWindow 不引多段**（守引擎纯度）；② `loadJobs` 建 job 不静态判 enableHeartBeat——killswitch 每-tick 现取的动态 gate0，开关切换 ≤1s 生效无需 reload（§3 loadJobs 注释收敛）；③ tick message 走**新增** `buildHeartbeatTickMessage`（不改 file-watch 共享的 `buildTickUserMessage`）。

详情：`specs/tech/version_logs/v0.0.116/change_log.md`（发布说明 + 设计原则）+ 同目录 `change_plan.md`(+part2)（method 级变更契约）

## 2026-07-10 · v0.0.104（cron agent 工具合并：6 → 1）

- **6 个 cron agent 工具合并为单工具 `cron` + action enum**（仿 browser 范式）：cron_create/list/update/disable/enable/delete → 单工具 `cron`，`input.action` enum 6 值，参数平铺。`run()` 加 action 前置校验（缺失/非法 → errorResult）→ dispatch(input, ctx, action) 分流到原 6 操作实现（cron-tool-shared.ts 未动，行为 1:1 等价）。
- registry defaultTools 从 6 个 `cron_*` 缩为 1 个 `cron`；tool-policy bound playground/leader/mate 各绑 `'cron'`（原绑 6 个）。
- **HTTP 6 端点 + scheduling 底层不动**（agent 工具与 UI HTTP 正交，共享 CronStore + SchedulerEngine 不变）。
- spec 同步：`[P1]cron_subsystem.md §6`（6 工具表 → 单工具 action 矩阵）+ §11（bound 名缩为单 `cron`）。

详情：`specs/tech/version_logs/v0.0.104/change_log.md`

## 2026-07-04 · v0.0.58.cron-fix2（cron schedule.tz 时区源修复）

- **BUG：北京用户建「每天 9:00」按 server 时区（可能 UTC）算 → 17:00 北京触发**
  - 根因：`resolveTz`（cron-tool-shared.ts:69-86）fallback 链 `session.timezone → squad.timezone → server 进程本地`，但 **session.timezone 实际没实现**（schema/handler/前端都没写入路径）→ 永远命中 server 进程时区。北京用户期望 9:00 北京，server 跑 UTC → schedule.tz=UTC → 9:00 UTC = 17:00 北京。前端 `getHours()` 本地展示本身正确，问题在 schedule.tz 用了 server 时区。
  - 修复：**「全局用本地 timezone 随时取用」**——UI 建 cron 时前端取客户端本地 tz（`Intl.DateTimeFormat().resolvedOptions().timeZone`，IANA）传 server，`schedule.tz = client local`。不存 session（随时取用 = 每次建 cron 现取当前 client tz）。
  - 改动：
    - 后端 `CreateCronBody` 加 `timezone?: string`（IANA optional）。`handleCreate`（UI HTTP）优先用 `body.timezone` → 否则 `resolveTz` fallback；`squadId` 始终派生自 session（payload.squadId 用于 budget gate）。`runCreate`（agent 工具）**不改**：agent 不感知 client tz，仍用 resolveTz fallback。
    - 前端 `createCronJob` 透传 `input.timezone`；`section-cron-panel.tsx` `handleCreate` 传 `timezone: Intl.DateTimeFormat().resolvedOptions().timeZone`。`component-cron-job-card` 展示（fmt）不改（已用 `getHours()` 本地）。
  - spec 同步：`[P1]cron_subsystem.md §5` timezone 来源改（UI client local 优先 / 不存 session）+ §6 表 cron_create 行改「resolveTz fallback」措辞；`api/overall/16-cron.md §1/§2.2/§4` CreateCronBody 加 timezone + tz 来源说明。

## 2026-07-04 · v0.0.58.cron-fix（BUG-001 + BUG-002 修复）

- **BUG-001：cron disable/delete/update "job not found"**（UI HTTP 路径）
  - 根因：UI `disableCronJob(sessionId, job.id)` 把 `cron:sid:eid` 整体当 URL path segment，`encodeURIComponent` 把 `:` 编码成 `%3A`；router `new URL(req.url).pathname` 不解码 → `findJob` 收到 `cron%3Asid%3Aeid`，与 j.id（decoded）不等 → "job not found"。
  - 修复：在 `cron-tool-shared.ts` 加 `jobMatches(job, jobIdInput)` 共用 helper（兼容 full decoded / full encoded / suffix entryId 三形态），`findJobById` 便利封装。UI HTTP `findJob`/`handleToggle`/`handleDelete` + agent 工具 `runUpdate`/`runToggle`/`runDelete` 全部改用。`handleDelete`/`runDelete` 的 `engine.unregister`/`cronStore.removeJob` 改用 `job.id`（canonical decoded），不再传 raw jobId（可能 encoded）。HTTP 响应 `id` 字段用 `job.id`，与 GET list summary.id 一致。
- **BUG-002：cron fire 消息 SSE 离线/在线不统一**（正确修复，替代早前 sender.source='user' 伪装方案）
  - 根因：`drainAndPartition`（`agent-loop-stage-pre.ts`）按 `sender.source` 分流——`source !== 'user'` 不触发 `emitUserMessageBlocks`，导致 system-source 消息（cron / heartbeat tick / a2a）入主对话 store（GET /messages 能看到）但 SSE 实时看不到 → 离线/在线不一致。
  - **早前方案被回退**：曾把 `buildCronUserMessage` 改 `sender.source='user'` 绕过分流——这违反原则 1（SSE 发的 = store 存的，sender 语义不能为「让前端看到」而伪装）。已回退到 `sender.source='system'`。
  - **正确修复**：`drainAndPartition` 加 `systemMessages: Message[]` 字段（rewritten id），`emitDrainResult` 对 user + system/agent/approval 所有 message 都 emit SSE message_start/blocks/end。**SSE 发的 = store 存的**（源头统一），前端 filter 决定展示（system_reminder 已是此模式）。`buildCronUserMessage` 保留 `sender.source='system' + system.kind='cron' + metadata.cron` 语义不变。
  - 影响范围：cron / heartbeat tick / a2a / file-changed 等 system-source 消息现在都 SSE 实时发。前端 `message-flatten.ts` 已按 `m.role='user'` 分支处理（cron/tick role 都是 'user'）→ 默认展示，与 GET 行为一致。
- **spec 同步**：`[P1]cron_subsystem.md §4` 更新 cronMessage 契约（sender.source='system' 保留 + 走统一 SSE）；`agent_loop_eager_drain.md §5.1` 更新 drain 契约（所有 source 都 emit message_*）。

## 2026-07-04 · v0.0.58.cron 阶段 5（实现落地同步 + 代码-spec 校准）

- **代码-spec 校准**：
  - `[P0]engine.md §4`：isDue cron 分支锚点 `job.payload.createdAt` → **`job.createdAt`（顶层字段）**——引擎纯度约束（engine 不解释 payload），与 engine.ts:73 实现一致。
  - `[P1]cron_subsystem.md §4`：buildCronUserMessage 的 `import CronPayload from './types'` → **`from './payloads'`**——payload schema 在 v0.0.58 实施时已从 types.ts 拆出独立 payloads.ts（保持 types.ts grep 纯度约束，业务字段不入纯调度契约），cron-message.ts:16 / cron-handler.ts:19 / cron-adapter.ts:18 实现一致。
- **index.md §④ 原则补强**：补 carry-based computeNextCronRunMs（无外部 dep）+ CronHandler 用 budgetAggregator fresh / HeartbeatHandler 用 sync cache（30s prime）双源 budget 模式 + boot.ts 双源 loadJobs 顺序——对齐 boot.ts:127-261 实现。
- **实现交付**：27 次 fire 全成功（CronHandler + deliverTo），cron crud AT 8/8 PASS，restart 续接 PASS（cron.json 持久化 + 双源 loadJobs），ET 渲染 DOM 20/20 + vision 11/12。mate/fire 2 个 AT case fail 经查非 cron 实现 BUG（BUG-001 LLM usage 丢失致 budget 不计费，疑 v0.0.61 langfuse opt 回归，用户确认带 known-issue 合并）。

## 2026-07-03 · v0.0.58.cron（建 KB：调度器抽象 + cron 子系统）

- **建本 KB**（`index.md` + 本 `log.md`）——从 `../squad/[P1]scheduler.md` 抽出公共调度逻辑，沉淀为进程级单例引擎。`squad/[P1]scheduler.md` 保留作迁移基线，新增顶部指针指向本 KB。
- **`[P0]engine.md`**：SchedulerEngine 单例 + 1s 轮询 + isDue（双分支：interval+activeWindow / cron-expr+tz）+ fire-and-forget（不 await handler）。
- **`[P0]job_registry.md`**：Job `{id,type,schedule,payload,lastFiredAt,enabled,createdAt,owner}` + JobHandler `fire(job,now)` + Registry + PersistenceAdapter（heartbeat=scheduler.json / cron=cron.json 双实现）。
- **`[P0]cron_expr.md`**：5 字段 cron 解析（搬 claude-code `refs/claude-code/src/utils/cron.ts`）+ 扩 per-job tz + computeNextCronRunMs + dom/dow OR 语义；UI 人话化选型 cronstrue (zh_CN)。
- **`[P1]heartbeat_handler.md`**：heartbeat 从 SquadScheduler.tryFire 迁移，gate 全下沉 handler；回归红线 §4 列 v0.0.33.4 6 项不变量。
- **`[P1]cron_subsystem.md`**：cron handler（gate=busy + session.squadId?squad budget:无）+ cron.json schema + buildCronUserMessage（子类 "cron"）+ session 销毁注销 + 重启续接。

详情：`specs/tech/version_logs/v0.0.58.cron/change_log.md`
