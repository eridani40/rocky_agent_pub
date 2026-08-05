---
type: design
title: 二级整理机制（天级离线「编辑」）
priority: P0
status: active
updated: 2026-08-02
since: v0.0.151.t2_consolidate
---

# 二级整理机制（天级离线「编辑」）

> 主文档：`index.md`（① 是什么，原则 2「笔/编辑分离」）。一级整理见 `[P0]consolidation_tier1.md`（本文件**不复用**其 `ConsolidationRunner`/fork-2 wiring——两者关系见 §1）。调度见 `../../scheduling/[P1]consolidation_job.md`（job type + handler + 生命周期）。skill/memory 工具见 `../skills/[P0]skill_manage_tool.md` + `[P0]memory_manage_tool.md`（本文件不改工具接口，只新增触发时机 C）。side-run 执行机制见 `../agent_interface_and_loop/[P0]agent_loop_side_run.md`。
>
> PRD：`specs/prd/version_logs/v0.0.151.t2_consolidate/change_log.md`（v1.1，已确认）。用户裁决：`states/user_query.md` v0.0.151 段。

## 1. 定位 + 与一级整理的关系

一级整理（tier1，「笔」）是 session 级实时收集：随对话/compact 时机零散写入 skill/memory，**容忍噪声、容忍重复**。二级整理（tier2，「编辑」）是**天级离线深度整合**：合并重复、去重矛盾条目、把 skill/memory 总量收敛回容量上限。二者是**完全独立的两条执行链路**，不共享 runner/wiring：

- tier1 fork-2 挂在 `tryCompact` 的 sibling 触发（`ContextEngine.setConsolidationRunner`），输入 = compact 时刻的完整会话快照。
- tier2 是**app 级天级调度任务**，与任何具体 session 的 compact/EP 时机无关联，直接由 `SchedulerEngine` 到点触发，**不经过 `ContextEngine`**。

两者共享底层写入目标（skill_manage / memory_manage 工具 + 各自的存储层锁），互不感知彼此的触发时机（并发关系见 §7）。

## 2. 触发与调度（复用 SchedulerEngine）

新增 `Job.type = 'consolidation'`（`JobType` 是开放字符串枚举，无需改类型定义——见 `app/server/src/scheduling/types.ts`）。**到点必发射**：`SchedulerEngine.tick` 到点即 `void handler.fire(job, now)`，handler 内部判断「是否有事可做」，**跳过判断在 handler 内部而非引擎层**——即便本次「零处理」（如模型未配置），仍视为「已执行一次」。

- **schedule.kind = 'cron'**：`dailyTime`（HH:mm）→ cron expr `M H * * *`（与 `component-cron-freq-picker.md` 每天预设同公式）。
- **owner = 固定哨兵**（如 `'app'`，因为这是唯一一个 app 级 job，非 per-squad/per-session）。持久化细节见 `../../scheduling/[P1]consolidation_job.md §2`。
- **job 生命周期（enabled/dailyTime/modelId 变化）**：**boot-time-only 注册**——job 只在进程启动时按当前 `app_config.consolidation` 读值注册一次，运行期改配置**不热重载**（不新增 config-change hook）。理由 + 对齐先例见 `../../scheduling/[P1]consolidation_job.md §3`。

## 3. 三段工作 + 严格串行 + 双重 skip 判定

Handler 的 `fire()` 内部顺序执行三个工作块，**块间严格串行**（前一块的 `await` 完成后才开始下一块；不并行）：

```
1. 全局 skill 整理（consolidateGlobalSkills）
2. 全局 memory 整理（consolidateGlobalMemory）
3. 各 session memory 整理（逐个 session 串行，consolidateSessionMemory × N）
```

第 3 块内**session 之间也逐个串行**（不 `Promise.all`），避免同一时刻多个 side-run LLM 调用同时打满速率/预算。

**session 遍历 + 双重 skip 判定**（handler 内部代码逻辑判断，非 LLM 判断）：

1. 遍历 `sessionStore.listSessions()`。
2. **Skip A（无新对话）**：`session.updatedAt` 早于本次整理窗口起点（见 §3.1）→ 跳过，不计入处理，零 LLM 调用。`session.updatedAt` 是**代理指标**（session 无 `lastMessageAt`/`lastActiveAt` 概念；`updatedAt` 由消息触发的 CAS 状态转换 `markRunning`/`markIdle` 带动——足够指示「今天有真实对话活动」，本文档明确记录这是启发式简化，不追求精确到消息级）。
3. **Skip B（有新对话但 session memory 为空）**：`session.updatedAt` 达标但 `listEntries(wsMemoryDir(session.workspaceDir ?? join(dataDir,'workspace')), {includeArchived:true})`（dir store）返回 `[]` → 跳过，**零 LLM 调用**（这是与 Skip A 不同的独立判定，必须在调用 LLM 之前用代码检查，不能靠 LLM 自己发现"没什么可整理"再空转）。

### 3.1 "今天"窗口定义

窗口起点 = 本次 fire 的 `job.lastFiredAt`（上次成功执行的时刻；`null` 则取 `now - 24h`）。即"自上次整理以来有无新对话"，而非自然日"今天 00:00"——两者在 dailyTime 固定的场景下等价，前者更抗漏跑/重启后补跑场景（复用引擎既有 at-most-once 语义，见 §7）。

## 4. 容量上限与计数口径

| 域 | 上限 | 计数口径 |
|---|---|---|
| 全局 skill | ≤100 | `SkillResolver.resolveAll(dataDir, undefined, enabledStore)` 结果中 `source === 'agent'` 的条目数（`workspaceDir` 传 `undefined` 跳过 session/workspace 层扫描，只取 app 层） |
| 全局 memory | ≤100 | `listEntries(globalMemoryDir(dataDir), {includeArchived:true})`（dir store，`<dataDir>/memory/`）中 `source === 'agent'` 的条目数 |
| 单 session memory | ≤30 | 该 session `listEntries(wsMemoryDir(sessionWsDir))`（dir store）结果中 `source === 'agent'` 的条目数 |

- **三域各自独立上限，无共享池**——全局 skill 超限不影响全局 memory 判定。
- **计数（`source`）与可操作性（`evolvable`）正交**：一个 `evolvable=false` 的条目仍计入上限（因为它确实占着一个位置），但 tier2 不能对它做 patch/disable（skill）或 update-existing/archive（memory）——这是**既有 gate**（`memory_manage_tool.md §5.1` / `skill_manage_tool.md` 治理表），tier2 不新增豁免、不绕过。若超限条目恰好全部 `evolvable=false`，tier2 该轮对该域**收敛不动**（记录在可见性摘要里，不是错误）。
- **`source='user'`（UI 手动创建）的条目不计入上限**，也不在 tier2 整理范围内（tier2 只处理 agent 产出的噪声，不碰用户手写内容）。

## 5. 执行载体：ConsolidationTier2Runner（sideRun 装配）

`runConsolidationTier2(deps): Promise<ConsolidationTier2Result>` 是**自洽的"整理一次"业务函数**（不是调度 glue 的一部分）：**第一步先做 §5.4 的模型反查 + "未配置→fast finish"判定**，模型可用才继续往下跑三个工作块。这样设计是为了让同一个函数可以被两条调用方复用而不重复 skip 逻辑：① 调度层 `ConsolidationJobHandler.fire()`（真实天级触发，见 `../../scheduling/[P1]consolidation_job.md §4`）；② test-only 同步触发端点 `POST /test/consolidation/run`（AT 可测性需要，见 `../../scheduling/[P1]consolidation_job.md §7`）——两条路径共享一份业务逻辑，只在"要不要碰调度层的 `lastFiredAt`/`lastResult`"上分叉（那部分留在各自的调用方，不在本函数内）。

模型可用时，三个工作块（全局 skill / 全局 memory / 单 session memory）**各自是一次独立的 `agentManager.sideRun(...)` 调用**（三次调用，非一次调用做三件事）——因为三者的 system prompt 侧重点、上下文供给、目标 session 都不同。

### 5.1 synthetic SessionConfig + ContextSnapshot

`sideRun` 要求调用方自行构造完整的 `ContextSnapshot`（`system`/`messages`/`tools`/`contextWindowUsage`/`summary`/`inputCharCount`）与 `SessionConfig`。side-run 模式**不会重跑 system-prompt-builder 的 mapper 管线**（不注入 skill catalog / memory L0 目录），因此"无 skill 注入"这一约束是**天然满足**的——只要调用方构造的 `snapshot.system` 是一段自定义 system message（纯文本，不含 catalog 段），而不是去调常规装配路径。

- **`snapshot.system`**：t2 专用 system prompt（见 §6），纯文本常量 + 少量占位符替换，**不经过** `buildSessionConfigFromDeps`/system_prompt_mapper 管线。
- **`snapshot.messages`**：空数组（同 tier1 fork-2 惯例，任务内容走 task message 而非预置对话）。
- **`snapshot.tools` / `contextWindowUsage` / `summary` / `inputCharCount`**：占位/最小合法值（side-run 侧不对这些字段做业务判断——见 `agent_loop_side_run.md` 不变量：所有副作用默认关闭，不写 transcript/不触发 compact）。
- **`userMessage`（task message）**：由 `ConsolidationTier2PromptHandler.build()` 产出（见 §6），携带该工作块的**预取数据**（entry 列表 + session memory 全文/summary，见 §5.3）。

`SessionConfig` 最小字段集（手工构造，**不走** `buildSessionConfigFromDeps`——那条路径会触发 skill catalog resolve，违反"无注入"约束）：

```typescript
{
  sessionId: <见 §5.2>,
  systemPrompt: '',              // 未使用（side-run 走 snapshot.system）
  client: buildLlmClient(providerId, modelId, appConfig, pluginManager),
  modelId,
  dataDir,                       // skill_manage 读 <dataDir>/skills/；memory global/group 寻址数据根
  workdir,                       // memory_manage session scope 落 <workdir>/.rocky/memory/（dir store；单 session 块=目标 session 的 workspaceDir）
  appConfig,                     // llm client 构建/配额读取等（memory 读写不再消费）
  maxIterations: <预算，如 10>,
  observability: <独立 trace，见 §8>,
}
```

### 5.2 sessionId 语义（三种取值）

| 工作块 | sessionId | 理由 |
|---|---|---|
| 全局 skill | 虚拟哨兵（如 `'consolidation:global'`） | `skill_manage` global scope 不读 `ctx.config.sessionId`；`sideRun` 本身不调 `sessionStore.getSession()`（已验证），虚拟 id 不会触发"session not found" |
| 全局 memory | 同上虚拟哨兵 | `memory_manage` global scope 同理不读 sessionId |
| 单 session memory | 真实目标 session 的 id | `memory_manage` scope=session 的 ws 取自 sideRun config 注入的 `workdir`（= 目标 session 的 `workspaceDir`，缺省回退 `<dataDir>/workspace`，与 session-config 同规则）；sessionId 仍需真实（观测/归属语义） |

### 5.3 Context 供给（开放点 1 —— 最终选型：预组装注入，无 disable 开关）

单 session 整理子任务的上下文供给采用**预组装注入**：handler 代码预取该 session 的 `listEntries(wsMemoryDir(sessionWsDir), {includeArchived:false})`（dir store）全文 + `sessionStore.getSummary(sid)`（若存在），拼入 task message 文本（§6 Prompt 的 Phase 1/2 部分）。**不给 tier2 agent 一个"读历史消息"的工具**——预组装已覆盖所需信号（当前 session memory 全量 + 摘要），额外给读历史工具会引入不必要的多轮往返和上下文膨胀风险，且当前无具体场景证明需要读原始对话逐字内容才能做合并/去重决策（session memory 本身就是对话的萃取结果）。

**未采纳"可 disable"选项**：预组装注入是唯一路径，没有独立开关——因为它是子任务能正确工作的必要输入，关闭等于让 LLM 盲整理，没有实际价值，故不设配置项（YAGNI）。

全局 skill / 全局 memory 的上下文供给同构：handler 预取 `SkillResolver.resolveAll(dataDir, undefined, enabledStore)` / `listEntries(globalMemoryDir(dataDir), {includeArchived:true})`（dir store）全量 entry 列表（含 `source`/`evolvable`/`updatedAt` 字段），序列化进 task message。

### 5.4 模型解析

不复用 `resolveModel()`（session/squad/member 驱动的 6 行 fallback 链，无适用语境）。改为最小反查：

```
modelId = appConfig.get('consolidation', 'default')?.modelId
若 modelId 未设置 → 跳过（fast finish，见 §9"模型未配置"skip）
providerId = listEnabledProviders(appConfig).find(p => p.models.some(m => m.modelId === modelId))?.id
若找不到 providerId → 同样视为"模型不可用" → 跳过
```

`listEnabledProviders`（`handlers/session-deps.ts`，已导出，无需改动）足够完成这次反查，不新增 `model-resolver.ts` 改动。

## 6. Prompt 设计（4 阶段，独立于既有 `consolidation.md`）

参考 claude-code `consolidationPrompt.ts` 的 4 阶段结构，映射到本项目 skill_manage/memory_manage 的 entry 模型（无自由格式 index 文件概念，故 Phase 4 收敛为纯容量收敛）：

1. **Orient（定向）**：列出该域当前全部 `source='agent'` 条目（name/intro/updatedAt/evolvable），告知本域容量上限与当前占用数。
2. **Gather（收集信号）**：（仅单 session 整理块）附带该 session 的 memory 全文 + summary，供发现"哪些条目其实在讲同一件事/已被 summary 取代"。
3. **Consolidate（整合）**：合并重复条目（写一条更完整的，`archive` 旧的）、修正矛盾（保留更新的 `updatedAt`，archive 过时的）——只对 `evolvable=true` 的条目可操作；`evolvable=false` 条目只读不动。
4. **Prune & 容量收敛**：若整合后仍超容量上限，按 `updatedAt` 由旧到新在 `evolvable=true` 子集中依次 `archive`/`disable`，直到回到上限内；`evolvable=false` 条目不可被此步骤触碰（哪怕它是最旧的——这是既定 tension，§4 已注明）。

**Phase 2.5 · Quality review（v0.0.164 新增，插在 Phase 2 与 Phase 3 之间）**：Consolidate 之前先按 routing 判据审查每条 `source='agent'` 条目的**质量**（不只是数量收敛），发现 3 类质量问题即 archive：
- **process-snapshot**：进展快照/里程碑/当前状态类（如"全书 100 章定稿"），不该进 memory（routing_decision 反例清单）→ archive
- **scope-picked-wrong**：scope 选错（如 squad 内规则误落 global 污染跨 squad）→ 建议调整 scope（无跨 scope 物理移动工具，先 archive 旧的，agent 下轮自动 rewrite 到对的 scope）
- **superseded-by-newer**：已被更新条目覆盖 → archive 旧的

判据引用 `{{routing_rules}}` 占位符（复用 `routing_decision.md` 单一源，防漂移；同一份 routing 文案在 memory_manage / skill_manage / tier1 fork prompt / tier2 quality review 四处共享，改一处四处生效）。**`evolvable=false` entries 依旧 read-only**（Phase 3 铁律不动，与 Phase 3 语义完全一致）。Output `<result>` action 可选 `quality_archived` 值（`parseResult` 兜底 processed 分类）。

**`{{write_scope}}` 占位符**（scope 必填配套）：tier2 prompt 模板另含 `{{write_scope}}` 占位符——告知 LLM 本次整理块调用 `memory_manage`/`skill_manage` 做 archive/disable/patch 时必须传的 scope 值。三工作块各自传值：全局 skill/memory 块 = `'global'`、单 session memory 块 = `'session'`。`ConsolidationTier2PromptHandler.build()` 从 `ctx.vars.write_scope` 读（caller 传入；缺省 `'global'`）。**必要性**：scope 改必填后，tier2 的 memory_manage/skill_manage 调用由 LLM 发起（非代码直调），必须在 prompt 中显式告知该传哪个 scope，否则 LLM 不传 scope 触发 `invalid_input` 拒绝导致整理失败。

与 tier1 `consolidation.md` 的关系：**不复用同一模板文件**（tier1 是"实时收集"语气，t2 是"离线深度整理"语气，职责不同）。新建独立 prompt handler + content 文件（见 §10 文件清单），但沿用同一套「never 物理删除、只 archive/disable」的安全约束文案（与 tier1 一致的措辞）。

## 7. 并发防护与失败处理

**engine per-job `inFlight` Set + AppTaskLock 双重防护**（v0.0.164 手动触发上线后升级）：

1. **engine per-job `inFlight` Set** 只防同 `fire()` Promise 重入——只要上一次 `fire()` Promise 未 settle，下一 tick 即跳过。tier2 的三段串行本身就是一个长 Promise 链，被这个 guard 天然保护。
2. **AppTaskLock（`app/server/src/agent/app-task-lock.ts`）——防跨调用方碰撞**（v0.0.164 新增）：cron `fire()` 到点 + 手动 `POST /consolidation/run` 到达 = 两条**独立 Promise 链**，engine inFlight 只防同 Promise 重入不防跨调用方；`AppTaskLock` 在 gate1（读 app_config）后加 gate2 `acquire('tier2_consolidation', runId)`：CAS `idle|done|failed → running`（**广播 SSE `consolidation_task_update` 到 `(app_task, _all)` group**）+ 成功 `markDone` + catch `markFailed`（**catch 必须 markFailed 否则锁永不释放**——`writeLastResult` 抛错 best-effort 吞掉不阻塞 markDone）。cron acquire 失败静默跳过 + **不推进 `lastFiredAt`**（不算这次 fire，因已有别的 caller 承担本窗口）；手动 acquire 失败 → HTTP 409 `{error:'consolidation_in_progress'}`。**runId 契约**：cron=`'cron:'+now.toISOString()` / 手动=`'manual:'+ulid()`（供 lock 观测/事件区分来源）。详见 `../session/[P0]app_task_lock.md`。
3. **与 tier1 fork-2 的互斥评估**：不新增互斥。tier1 fork-2 在 compact 时机触发，与 tier2 天级调度在时间上几乎不重叠，即便偶然重叠，存储层既有的锁足以保证数据不损坏——skill 走 per-file 锁（`skill_manage` 既有实现），memory 三介质统一 per-entry 文件锁（`memory-dir-write.ts withFileLock` 锁 `<dir>/<name>.md`）。两个整理层即便都写，最坏结果是"t2 archive 了 tier1 刚写的一条"这类语义交错，属于良性、下一天自我纠正的现象，不是数据损坏。

**失败处理 + `lastFiredAt` 语义（与 cron/heartbeat 的既定偏离）**：cron/heartbeat 的既有原则是"gate 失败不推进 `lastFiredAt`"（业务 gate 如 busy/budget，下 tick 重试）。tier2 **没有**这类可重试的业务 gate 概念——它唯一的"跳过"场景（模型未配置）本身就是 PRD 认定的合法业务结果（"到点必执行一次，即便没做实际改动"），因此 **`lastFiredAt` 在几乎所有 `fire()` 调用后都应推进**（包括三段全部 skip 的情形）。只有真正的前置灾难性失败（如读不到 `app_config` 本身、`sessionStore.listSessions()` 抛异常导致连第一步都无法判定）才不推进 `lastFiredAt`，留给下一 tick 重试。此偏离在 `../../scheduling/[P1]consolidation_job.md §4` 明确记录为**文档化的、有意的例外**，不是对既有原则的破坏。

单个子任务（如某个 session 的整理）抛异常 → try/catch 吞掉、记录、继续下一个 session（best-effort，一个 session 失败不阻塞其余 session 或全局块）。

## 8. 可观测性 + 轻量可见性

- **独立 langfuse trace**：每次 `sideRun` 走独立 observability trace（同 tier1 fork-2/auto-naming 惯例），**不出现在任何用户可见的 session 对话流**（具体 emit/trace 隔离方式由 coder 按 `agent_loop_side_run.md` 的 side-run 契约实现）。
- **轻量可见性（"上次整理时间 + 一句话摘要"）**：存储位置 = `../../scheduling/[P1]consolidation_job.md §2` 定义的**执行状态文件**（与 `app_config.consolidation` 用户配置分离，见该文件 §2 的分离理由），不新建独立存储机制。每次 `fire()` 结束（无论是否真正执行了整理）写入 `{lastRunAt: ISO, summary: string}`——`summary` 是一句话（如"全局 skill 归档 2 条 / memory 无变化 / 3 个 session 已整理"或"未配置模型，跳过"）。

## 9. 边界（不做什么）

- 不新增批量 skill/memory 操作接口（复用既有单条 action，多次调用）。
- 不物理删除任何条目（只 `archive`/`disable`）。
- 不绕过/放松 `evolvable` gate（超限也不豁免不可操作条目；Phase 2.5 quality review 同样约束）。
- 不给 tier2 agent 读历史消息的工具（§5.3 已论证）。
- 不做 session 间并行、不做三段间并行。
- 不做配置热重载（`enabled`/`dailyTime`/`modelId` 改动需重启生效，理由见 `../../scheduling/[P1]consolidation_job.md §3`）。
- 不与 tier1 互斥加锁（§7 已论证足够安全）。
- **不在 tier2 中做 scope 物理迁移**（Phase 2.5 scope-picked-wrong 只 archive 旧的，让 agent 下轮自动 rewrite 到对的 scope；无跨 scope move 工具存在）。

## 10. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|---|---|---|
| `app/server/src/agent/consolidation-tier2/runner.ts` | 新增 | `runConsolidationTier2(deps): Promise<ConsolidationTier2Result>`——第一步模型反查+skip 判定（§5.4），可用时三段串行编排；供调度 glue 与 test-only 端点共同复用（§5） |
| `app/server/src/agent/consolidation-tier2/global-skill.ts` | 新增 | `consolidateGlobalSkills(deps): Promise<BlockResult>` |
| `app/server/src/agent/consolidation-tier2/global-memory.ts` | 新增 | `consolidateGlobalMemory(deps): Promise<BlockResult>` |
| `app/server/src/agent/consolidation-tier2/session-memory.ts` | 新增 | `consolidateSessionMemory(deps, session): Promise<BlockResult \| 'skipped'>`（含 Skip A/B 判定） |
| `app/server/src/agent/consolidation-tier2/model-resolve.ts` | 新增 | `resolveConsolidationModel(appConfig): {providerId, modelId} \| null`（§5.4 反查逻辑） |
| `app/server/src/prompts/handlers/consolidation-tier2-handler.ts` | 新增 | `ConsolidationTier2PromptHandler extends PromptHandler`（三个 build 变体或三个子类，coder 定位） |
| `app/server/src/prompts/content/consolidation_tier2.md` | 新增 | t2 prompt 模板正文（4 阶段文案 + 占位符） |

> 调度层（`ConsolidationJobHandler`、job 持久化、boot 装配）见 `../../scheduling/[P1]consolidation_job.md §6` 文件清单，不在本文件重复列出。

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/v0.0.151.t2_consolidate/change_log.md` + `change_plan.md`。
