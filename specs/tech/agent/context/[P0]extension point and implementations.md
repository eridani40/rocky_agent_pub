---
type: interface
title: Context Extension Points & Implementations（索引）
priority: P0
status: active
updated: 2026-08-04
since: v0.0.13
---

# Context Extension Points & Implementations（索引）

> 管什么：context 子系统的 **11 个扩展点（EP）+ 57 个内置 ext impl（31 通用基线 + 1 default sink + 1 search 旁路 + 1 side_run_builder + 4 compact + 2 post-compact + 2 session_store（v0.0.66）+ 15 squad/academy-scoped）的整合索引**——各 EP 契约、各 impl 的 description / configSchema 归属、`rocky_context` builtin plugin manifest 结构。
> 不管什么：单个 EP 契约细节（→ 各 detail 文档）、cardinality 三态语义（→ `../../plugin_system/[P0]extension_point_interface.md`）、ext impl 字段（→ `../../plugin_system/[P0]ext_impl_and_manifest_interface.md`）、ContextEngine 怎么调框架（→ `[P0]context_engine.md` §3 + §3.5）。
>
> 本文是**整合索引**：11 EP / impl 的契约都在各 detail spec（§6 出处索引），不重新定义契约；只补「整合视图 + configSchema 显式 JSON Schema 字段 + manifest 结构」spec 缺口。

## 1. 概述

v0.0.13 起 context 引擎**全面 plugin 化**：ingest / assemble / system_prompt / system_reminder 四个执行点全部由 `PluginManager.getExtensionImpls(point)` 驱动跑 ordered 链。**[v0.0.40]** compact 触发也 plugin 化——新增 2 个 `exclusive` context EP（`context_should_compact` 谓词 + `context_do_compact` 动作），首批 exclusive context EP（既有 6 个 context EP 全是 ordered）。**[v0.0.49]** default scope 的 store sink 也 EP 化（`store_sink` impl，对称旁路 run 的 `store_sink`，替代 context-engine.ts 的 `if scopeId` 硬尾）。**[v0.0.51]** 新增 `context_post_compact` ordered EP（compact 完成后触发 memory/skill 整理）。**[v0.0.66]** session store 也 EP 化（`session_store` exclusive EP，main scope=`persistent_session_store` / 旁路 run scope=`in_memory_session_store`）+ 删 4 buffer/system impl（`buffer_sink`/`buffer_reader`/`append_passthrough`/`system_prompt`）+ 删旧 `memory` mapper（v0.0.51 已拆为 `memory_user`+`memory_session`，v0.0.66 manifest 计数对齐）。**[v0.0.126]** 新增 `search_indexing` ingest handler（派生索引旁路 sink，只 main scope active；旁路 run scope 经声明式 yaml 配置 disable）。**[v0.0.173]** 新增 `context_clean_view_reducer` ordered EP（面向 LLM 的清理 reducer 链，6 个清理 reducer 从 `context_assemble_reducer` 迁过来）+ 删 `prev_snapshot` mapper（snapshot 永远 rebuild 不再需要 prevMessages）。**[v0.0.178+v0.0.204]** 新增 `side_run_builder` assemble_reducer impl（v0.0.204 rename 自 `forked_builder`；旁路 run scope 专用，复用固定 parentSnapshot + summaryUpTo 后 in_memory 增量 upsert，替代旁路 run 复用 base_builder 的旧契约——base_builder 永远 rebuild 后无 parent transcript 透传，side_run_builder 修复 v0.0.173 silent regression）。v0.0.8 简化版（append-only ingest / head3+tail3 / 直填 systemPrompt）下沉为 builtin impl 的默认 config 兜底（design [D1.2]）。

所有 context EP 归一个 builtin plugin：`rocky_context`（design [D1.3]），目录 `app/plugins/builtins/rocky_context/`，manifest 声明 **57 个** ext impl（31 通用基线 + 1 main sink（v0.0.49：`store_sink`）+ 1 history search 旁路（v0.0.126：`search_indexing`）+ 4 compact（v0.0.40：`context_should_compact` 谓词 2 个 = threshold + reject dummy；`context_do_compact` 动作 2 个 = summary + noop dummy）+ 2 post-compact（v0.0.51：`memory_skill_consolidation` + `noop_post_compact`）+ **2 session_store（v0.0.66：`persistent_session_store` + `in_memory_session_store`）**+ 1 side_run_builder assemble_reducer（v0.0.178 起，v0.0.204 rename 自 forked_builder）+ 15 squad/academy-scoped；v0.0.173 删 1 mapper（`prev_snapshot`）；squad-scoped impl 详见 `../../squad/[P1]prompt_sections.md`；compact impl 详见 `[P0]context_compact_detail.md §2c`；post-compact impl 详见 `[P0]context_compact_detail.md §2d`；session_store impl 详见 `[P0]context_engine.md §3.6`）。

## 2. 11 个 context EP 清单

全部 `group: "context"`。cardinality **8 个 `ordered` + 3 个 `exclusive`**（[v0.0.40] 新增 2 个 exclusive compact EP；[v0.0.51] 新增 1 个 ordered post-compact EP；[v0.0.66] 新增 1 个 exclusive session_store EP；[v0.0.173] 新增 1 个 ordered clean_view_reducer EP）。`ordered` 按 **effective order 升序**，1 在前（[v0.0.18]，算法 = `ExtImplPolicyData.order` record ?? 末尾补位，见 `../../plugin_system/[P0]plugin_manager_interface.md` §3.1）；`exclusive` ≤1 active（显式 `setExclusive` 标记者胜，无显式 → effective order 最小者，见 `extension_point_interface.md` §2）。

| EP id | group | cardinality | 契约接口 | 定义出处（detail spec） |
|---|---|---|---|---|
| `context_ingest_handler` | context | ordered | `IngestHandler.handle(messages, ctx) → Message[]` | `[P0]context_ingest_detail.md` §3 |
| `context_assemble_mapper` | context | ordered | `AssembleMapper.map(ctx) → Partial<AssembleData>` | `[P0]context_assemble_detail.md` §3 |
| `context_assemble_reducer` | context | ordered | `AssembleReducer.reduce(data, input, ctx) → Message[]`（v0.0.178 起 2 impl：main scope 用 base_builder 永远 rebuild / 旁路 run scope 用 side_run_builder 复用固定 parentSnapshot + 增量 upsert；v0.0.204 rename forked_builder→side_run_builder） | `[P0]context_assemble_detail.md` §3/§5/§5c |
| `context_clean_view_reducer` ★ v0.0.173 | context | ordered | `AssembleReducer.reduce(data, input, ctx) → Message[]`（同 assemble_reducer 契约；input 永远非 null，data 不读用占位） | `[P0]context_assemble_detail.md` §3/§5b |
| `system_prompt_mapper` | context | ordered | `SystemPromptMapper.map(ctx) → PromptFragment[]` | `[P0]system_prompt.md` §3 |
| `system_prompt_reducer` | context | ordered | `SystemPromptReducer.reduce(input, ctx) → PromptFragment[]` | `[P0]system_prompt.md` §3 |
| `system_reminder` | context | ordered | `SystemReminderProvider.provide(ctx) → SystemReminder[]` | `[P0]system_reminder.md` §3 |
| `context_should_compact` ★ v0.0.40 | context | **exclusive** | `ShouldCompactPredicate.check(ctx) → boolean`（谓词） | `[P0]context_compact_detail.md §2c` |
| `context_do_compact` ★ v0.0.40 | context | **exclusive** | `DoCompactAction.run(ctx) → Promise<void>`（动作） | `[P0]context_compact_detail.md §2c` |
| `context_post_compact` ★ v0.0.51 | context | ordered | `PostCompactHandler.handle(ctx) → Promise<void>` | `[P0]context_compact_detail.md §2d` |
| `session_store` ★ v0.0.66 | context | **exclusive** | `SessionStoreContract`（appendMessages/getMessages/getSummary/getRatio/updateContextWindowUsage/releaseSlot 子集） | `[P0]context_engine.md §3.6` + `../../session/[P0]session_store.md §4` |

> **[v0.0.173] `context_clean_view_reducer` 为何独立 EP（不在 assemble_reducer 里）**：v0.0.173 root cause（prod tool_call 乱序 400）= 清理 reducer 跑在 assemble 链里 → 输出污染 snapshot.messages → 下轮 base_builder.appendNew 基于被污染的 prevSnapshot（role_merge 吞 id → 末尾追加 → 乱序）。**解法**：snapshot = 确定性纯函数（永远 rebuild），清理剥到独立 EP，由 `ContextEngine.getCleanSnapshot` 在深克隆副本上跑——原 snapshot 不被触碰。详见 `[P0]context_engine.md` §3 getCleanSnapshot + `[P0]context_assemble_detail.md` §5b。

> **[v0.0.40] compact EP 用 exclusive 而非 ordered**：谓词（压不压）+ 动作（怎么压）天然 ≤1 active——多个谓词同时返回 true 没意义、多个动作同时跑会冲突。**exclusive EP 在任何 scope 下都「总有人被选中」**（v0.0.40 修复）：`default` scope 选 threshold/summary（current 用），`forked` scope 显式 `setExclusive` 选 dummy（reject/noop）防递归——不靠 disable 唯一实现制造 zero-active（UI radio 单选无法表达/恢复的中间态，见 §3.7 + `context_compact_detail.md §2c.3` 防递归不变量）。

> 10 EP 定义是**代码常量**（EP 是 contract，见 `extension_point_interface.md` §3.8），加在 `extension-point.ts` 的 `BUILTIN_EXTENSION_POINTS`（v0.0.13 前只有 `llm_provider` / `llm_protocol`，group=provider）。bootstrap 的 EP 注册循环自动带上。

## 3. 57 个内置 impl 清单（按 EP 分组）

> 全部归 `rocky_context` plugin。**[v0.0.18]** impl 排序用 `ExtImplPolicyData.order`（per-point 连续 1..n），无 record 时按 manifest 登记序末尾补位；**无 configSchema 的 impl 仅 enable/disable + 调序**；**有 configSchema 的 8 个**见 §4 显式 JSON Schema 字段。manifest 不再有 `priority` 字段（已删），下方表「登记序」列即 manifest 声明顺序（用于补位），不显式写进 manifest。

### 3.1 `context_ingest_handler`（5 个，v0.0.126 新增 `search_indexing`）

| implId | 登记序（补位用） | configSchema | 职责（出处） |
|---|---|---|---|
| `query_truncate` | 1 | ✅ §4.1 | 截断过长 user query（原文 offload raw）；`context_ingest_detail.md` §3 |
| `tool_result_truncate` | 2 | ✅ §4.2 | 截断过大 tool_result（原文 offload tool_result）；同上 |
| `system_reminder_injector` | 3 | — | 跑 `system_reminder` provider 链聚合 reminder，追加到最后一条 user message content 末尾；同上 §3 + `system_reminder.md` §4 |
| `store_sink` ★ v0.0.49 D15 | 4 | — | **default + forked 都 active 的 sink**（写 store transcript / 内存数组）：`ctx.store.appendMessages(ctx.config.sessionId, messages)`；store 由 ContextEngine.ingest 经 session_store EP 按 scope 解析（v0.0.66：default 写持久 transcript / forked 写内存数组，同 impl 透传不同 store 实现）；同上 §3 |
| `search_indexing` ★ v0.0.126 | 5 | — | **派生索引旁路 sink（只 default scope active；forked disable）**：`role∈{user,assistant}` 的 message 从 content ContentBlock[] 提取 `type=text` part 拼纯文本 → 投递 `HistoryIndexer.index({messageId: m.id, sessionId, role, ts: m.id, text})`（不 await、不阻塞 ingest，异常吞掉 + reconcile 兜底）。order=5 紧随 `store_sink`(4) 后：**失败一致性**（store_sink 抛错→chain 中断→不索引→永不孤儿）。message_id 由 ingest 入参 messages 自带（业务生成 ULID），store 不返回；契约同 `IngestHandler.handle(messages, ctx) → Message[]`（透传不 transform）；引擎见 `../../persistence/[P1]search_engine.md §3.3`；PRD `specs/prd/overall/11-history-search.md §11.2.3` |

### 3.2 `context_assemble_mapper`（2 个，v0.0.173 删 prev_snapshot）

| implId | 登记序（补位用） | configSchema | 职责（出处） |
|---|---|---|---|
| `transcript_reader` | 1 | ✅ §4.3 | 读最近 N 条 transcript（store 由 session_store EP 按 scope 解析：default 读持久 / forked 读内存）；`context_assemble_detail.md` §4 |
| `summary_reader` | 2 | ✅ §4.3 | 读 summary + version（forked in_memory store 恒返 null）+ **[v0.0.185]** 同取 head/tail 锚定候选（`AssembleData.headCandidates/tailCandidates`；head=会话真第一条起 `takeFromStart` / tail=summaryUpTo 结尾）；同上 |

> **[v0.0.66] `system_prompt` mapper 已删**：system 由 `context-engine.assemble` 独立调 `buildSystemPrompt`（design §1.3：复用条件满足 → 用 `prevSnapshot.system`，重建 → 调 builder），不再走 context_assemble_mapper 链。
>
> **[v0.0.173] `prev_snapshot` mapper 已删**：snapshot 永远 rebuild（确定性纯函数 f(summary, transcript)），不再需要 prevMessages 作增量基础；`AssembleData.prevMessages` 字段一并删除。详见 `[P0]context_assemble_detail.md` §2。

### 3.3 `context_assemble_reducer`（2 个，v0.0.178 起 base_builder + side_run_builder）

| implId | 登记序（补位用） | 激活 scope | configSchema | 职责（出处） |
|---|---|---|---|---|
| `base_builder` | 1 | main | ✅ §4.4 | 框架构建（v0.0.173 永远 rebuild）+ head/tail 选取；`context_assemble_detail.md` §2/§5/§6 |
| `side_run_builder` ★ v0.0.178（v0.0.204 rename 自 forked_builder） | 2 | 旁路 run（summary/consolidate） | — | 框架构建（复用固定 parentSnapshot.messages + summaryUpTo 后 in_memory 增量 upsert，非 rebuild）；`context_assemble_detail.md` §5c |

> **[v0.0.173] 6 个清理 reducer 迁到 `context_clean_view_reducer` EP（§3.10）**：v0.0.173 root cause = 清理 reducer 跑在 assemble 链里污染 snapshot.messages（role_merge 吞 id → appendNew 末尾追加 → tool_call 乱序 400）。剥到独立 EP 后由 `ContextEngine.getCleanSnapshot` 在深克隆副本上跑，原 snapshot 不被触碰。详见 `[P0]context_assemble_detail.md` §5b。
>
> **[v0.0.178] side_run_builder 替代 base_builder 在旁路 run scope 的位置**（v0.0.204 rename 自 forked_builder）：v0.0.66-v0.0.177 旁路 run 复用 base_builder（依赖 v0.0.66 append 分支透传 parent transcript）；v0.0.173 删 append 分支后旁路 run 看不到 parent transcript（silent regression）→ v0.0.178 新建 forked_builder（同 EP，靠 scope 切换；主干 `ContextEngine.assemble` 零 forked 分支）。v0.0.204 implId rename forked_builder→side_run_builder，文件 `app/plugins/builtins/rocky_context/assemble/side_run_builder.ts`，类 `SideRunBuilderReducer`。详见 `[P0]context_assemble_detail.md` §5c。

### 3.4 `system_prompt_mapper`（12 个 = 9 通用 + 3 squad-scoped）

| implId | 登记序（补位用） | tier | configSchema | 职责（出处） |
|---|---|---|---|---|
| `identity` | 1 | stable | — | agent 身份；`system_prompt.md` §4 |
| `rules` | 2 | stable | — | 行为规则；同上 |
| `tool_guidance` | 3 | stable | — | 工具说明（读 config.tools 各 definition name + `intro ?? description`，[v0.0.146] 优先 intro）；同上 |
| `skills` | 4 | stable | — | 技能说明（skills 注册表；L0 带 `[scope=...]` 来源层标注，v0.0.232）；同上 |
| `agent_profile` ★ v0.0.232 | 5 | stable | — | 「定义你的 agent」section（统一 mapper 按 kind 分支渲染 a/b/c；priority 480）；`[P1]agent_profile.md` |
| `context_files` | 6 | context | — | AGENTS.md/项目上下文（读 cwd；squad 两级：团队+个人差异叠加，v0.0.232）；同上 |
| `memory_user` ★ v0.0.51 | 7 | stable | — | stable tier 用户记忆 whole-file 注入（managed-store 受管读取 + archived 跳过）；`../memory/[P0]memory_injection.md` |
| `memory_session` ★ v0.0.51 | 8 | context | — | context tier session 记忆 whole-file 注入（超预算可裁尾部）；同上 |
| `memory_group` | 9 | stable | — | stable tier group（squad/classroom）记忆注入（同址去重见 `../memory/[P0]memory_injection.md` §2.3）；同上 |
| `squad_role` | 10 | stable | — | **squad-scoped**：squad 角色 content fragment（leader/mate/squad_chat）；`../../squad/[P1]prompt_sections.md` |
| `team_roster` | 11 | stable | — | **squad-scoped**：团队成员花名册 reminder；同上 |
| `parent_task` | 12 | context | — | **squad-scoped**：父任务上下文；同上 |

> **[v0.0.66] 旧 `memory` 单 impl 已退役**：v0.0.51 拆为 `memory_user`(stable) + `memory_session`(context) 两个独立 impl 直接登记在 manifest；本表对齐当前 manifest 形态（无聚合 `memory` 行）。

### 3.5 `system_prompt_reducer`（3 个）

| implId | 登记序（补位用） | configSchema | 职责（出处） |
|---|---|---|---|
| `tier_sort` | 1 | — | 按 tier 排序 stable→context→volatile；`system_prompt.md` §3 |
| `dedup` | 2 | — | 同 fragment.id 去重；同上 |
| `budget_truncate` | 3 | ✅ §4.5 | token 预算裁剪（仅裁 context/volatile 动态段）；同上 §3/§7 |

### 3.6 `system_reminder`（9 个 = 5 通用 + 4 squad-scoped）

| implId | 登记序（补位用） | configSchema | 职责（出处） |
|---|---|---|---|
| `env` | 1 | — | 环境（test/dev/prod、平台、模型）；`system_reminder.md` §3 |
| `time` | 2 | — | 系统时间（含时分 + 时区名，[v0.0.64] 修正）；同上 |
| `workspace` | 3 | — | 工作目录、git 状态；同上 |
| `tool_error` | 4 | — | 上轮工具错误；同上 |
| `todo` | 5 | — | task 进度（**[D1.1] 依赖 task_tools 缺失 → no-op 返回空**）；同上 |
| `reachable_agents` | 6 | — | **squad-scoped**：squad clique 可达对象；`../../squad/[P1]prompt_sections.md` |
| `squad_charter` | 7 | — | **squad-scoped**：charter 动态 reminder；同上 |
| `squad_tasks` | 8 | — | **squad-scoped**：工作项进度 reminder；同上 |
| `squad_board` | 9 | — | **squad-scoped**：board 视图 reminder；同上 |

### 3.7 `context_should_compact` + `context_do_compact`（4 个，v0.0.40）

两个 **exclusive** context EP，承担 compact 触发的「谓词 + 动作」分离（详见 `[P0]context_compact_detail.md §2c`）。每个 EP 各 2 个 impl：current 用的「真」实现 + forked 用的 dummy 实现：

| implId | EP | configSchema | 职责（出处） |
|---|---|---|---|
| `threshold_should_compact` | `context_should_compact` | ✅ §4.6 | 谓词：`用量/tokenLimit > 阈值`（默认 0.6，**分母含 maxOutputTokens**，提前压而非撞墙压）；`context_compact_detail.md §2c` |
| `reject_should_compact` ★ | `context_should_compact` | — | 谓词 dummy：`check()` **恒返 false**（永不压）。summary/consolidate scope 显式 `setExclusive` 选中以防递归；`context_compact_detail.md §2c.3` |
| `summary_do_compact` | `context_do_compact` | ✅ §4.7（[v0.0.186] 新增：烘焙参数 tokenCap/candidateLimit） | 动作：`sideRun(summary, NO_TOOLS, maxIter=1)` → extractTag → **bakeSummaryBlock 烘焙** → setSummary（含 `block`）；同上 §2c |
| `noop_do_compact` ★ | `context_do_compact` | — | 动作 dummy：`run()` **空操作**（不压）。summary/consolidate scope 显式 `setExclusive` 选中作 defense-in-depth；同上 §2c.3 |

> **防递归不变量**：forked scope **显式选中** `reject_should_compact`（恒返 false）→ `getExtensionImpls("context_should_compact","forked")` 返 `RejectShouldCompactPredicate` → `tryCompact` 在谓词检查处 return → summary run 自己永不会 compact（结构上不可能递归，见 `[P0]context_compact_detail.md §2c.3`）。
>
> **default scope 配置**：threshold/summary 在 `default` scope 被选中（current 用；无 exclusive 标记 → effective order 最小者胜，二者注册在 reject/noop 之前）；`forked` scope 显式 `setExclusive` 选 reject/noop（防递归 + defense-in-depth）。**v0.0.40 修复**：forked 不靠 disable 唯一实现制造 zero-active（UI radio 单选无法表达/恢复的中间态），改用 dummy 实现显式选中——exclusive EP 在所有 scope 都「总有人被选中」。**v0.0.49 起 `tryCompact(ctx)` 由骨架 `runReActLoop` 统一调**（drainMode='eager' 路径，删 ContextPort 包装后不再下沉到 recordAssistant；forked scope reject 谓词恒 false 自动跳过，骨架无 if main/forked 分支），loop 骨架对 compact 零感知（见 `../agent_interface_and_loop/[P0]agent_loop_unified.md §2`）。

### 3.8 `context_post_compact`（2 个，v0.0.51 新增）

一个 **ordered** context EP，compact 成功完成后触发（详见 `[P0]context_compact_detail.md §2d`）。default scope 用 `memory_skill_consolidation`（启动整理 forked agent），forked scope 用 `noop_post_compact`（空操作防递归）：

| implId | EP | configSchema | 职责（出处） |
|---|---|---|---|
| `memory_skill_consolidation` | `context_post_compact` | — | handler：启动 fork-2 整理 forked agent（allowed tools = [skill_manage, memory_manage]），直接调工具落盘；`context_compact_detail.md §2d` + `../memory/[P0]consolidation_tier1.md` |
| `noop_post_compact` ★ | `context_post_compact` | — | handler dummy：`handle()` **空操作**。forked scope 选中防递归（整理 fork 不再触发 post-compact → 再整理）；`context_compact_detail.md §2d.4` |

> **防递归不变量**：forked scope 需跳过 `context_post_compact` handler，防止整理 fork 再触发 compact → 再整理的递归。`context_post_compact` 是 ordered EP（非 exclusive），forked scope 的跳过方式 = disable `memory_skill_consolidation` 或注册 noop handler 选中。spec 约定 forked scope **必须跳过** post-compact handler。

### 3.9 `session_store`（2 个，v0.0.66 新增）

一个 **exclusive** context EP，承载 per-session 上下文存储实现（详见 `[P0]context_engine.md §3.6`）。default scope 选中 `persistent_session_store`（包装真实持久 SessionStore），forked scope 选中 `in_memory_session_store`（per-session Map）：

| implId | EP | configSchema | 职责（出处） |
|---|---|---|---|
| `persistent_session_store` ★ v0.0.66 | `session_store` | — | main scope 选中：包装真实持久 SessionStore 实例（delegate holder，plugin → server import，全方法子集）；`context_engine.md §3.6` + `../../session/[P0]session_store.md §4` |
| `in_memory_session_store` ★ v0.0.66 | `session_store` | — | 旁路 run scope 选中：per-runId `Map<runId, Message[]>`；只实现 appendMessages + getMessages + getSummary（恒 null 不 throw）+ getRatio（恒 1.0）+ updateContextWindowUsage（no-op）+ releaseSlot（清 Map slot）；同上 |

> **`in_memory_session_store.getSummary` 恒返 null 是关键**（不 throw）：v0.0.66-v0.0.172 让旁路 run curVersion 永远 null → 永远不触发 base_builder rebuild → 永远 append 复用 prevSnapshot（纯数据驱动无 isForked 判断）；**[v0.0.173] base_builder 永远 rebuild**（无 shouldRebuild 分支）——但 v0.0.178 起旁路 run 改用 `side_run_builder`（v0.0.204 rename 自 forked_builder，不再走 base_builder），旁路 run 不依赖此特性，base_builder 现仅 main scope 用。
>
> **`releaseSlot` 命名分离**（v0.0.66）：`SessionStoreContract.releaseSlot` 仅清旁路 run 内存槽（旁路 run 结束 caller 调）；与 `SessionStore.clearSession`（删整 session 返 Session）命名分离，避免误删真实 session。

### 3.10 `context_clean_view_reducer`（8 个，v0.0.173 新增 EP）

一个 **ordered** context EP，承载喂 LLM 前的「清理视图」reducer 链（详见 `[P0]context_assemble_detail.md §5b`）。8 个 impl = v0.0.173 从 `context_assemble_reducer` 迁来的 6 个清理 reducer（implId / impl 路径 / configSchema / 实现代码都不变，只改 EP 归属）+ v0.0.207 新增 `dedup_tool_result` + v0.0.256 新增 `bubble_text_before_tool_call`；由 `ContextEngine.getCleanSnapshot(snapshot, scopeId)` 在 `structuredClone(snapshot.messages)` 副本上跑，原 snapshot 不被 mutate：

| implId | EP | 登记序（补位用） | configSchema | 职责（出处） |
|---|---|---|---|---|
| `dedup_tool_result` ★ v0.0.207 | `context_clean_view_reducer` | 1 | — | 同 toolCallId 多 tool_result 去重（挑 keeper，非 keeper 从 content 过滤）；`context_assemble_detail.md §5b` |
| `orphan_tool_call` | `context_clean_view_reducer` | 2 | — | 清理无配对 tool_use/tool_result block；同上 |
| `bubble_text_before_tool_call` ★ v0.0.256 | `context_clean_view_reducer` | 3 | — | assistant content block 级重排：三段稳定分区 `[reasoning][text][其余]`，text 冒泡到 tool_call 前 + 丢 trim 空 text（修 provider 400）；同上 |
| `empty_message` | `context_clean_view_reducer` | 4 | — | 剔除空 content message；同上 |
| `think_remove` ★ v0.0.98 | `context_clean_view_reducer` | 5 | — | 删除 reasoning(think) content block；同上 |
| `fill_empty_text` ★ v0.0.171 | `context_clean_view_reducer` | 6 | — | 兜底 user/success tool_result 嵌套 `text===''` 为 'empty' 防 LLM 400；同上 |
| `role_merge` | `context_clean_view_reducer` | 7 | — | 合并相邻同 role message（v0.0.173 关键：合并只发生在深克隆副本，原 snapshot 不被触碰 → 不再吞 id → 不再乱序）；同上 |
| `snip_handler` | `context_clean_view_reducer` | 8 | — | snip 标记替换为占位；同上 |

> **scope 配置**：仅 `app/plugins/scopes/default.yaml` 自有该链（`context-assemble` group 下 `context_clean_view_reducer` 节点显式列 8 个 impl；其它 scope yaml 均无此节点，per-EP 继承 default）。yaml 生效序 = reducer 依赖序：`dedup_tool_result → snip_handler → orphan_tool_call → bubble_text_before_tool_call → think_remove → fill_empty_text → empty_message → role_merge`（dedup 先去重 orphan 才能正确判配对；orphan 先配对过滤 + message 级邻接，bubble 再处理配对齐全但 content 内 block 乱序；think_remove 在 empty_message 前；role_merge 排最后）。
>
> **fallback**（无 pluginManager / 链空）：`ContextEngine.getCleanSnapshot` 返 messages 深克隆 fallback（不阻塞 LLM 调用）。

> 合计 5+2+2+8+20+3+9+4+2+2 = **57** 个 impl（按 `plugin.json` manifest 实测）。31 通用基线 + 1 default+forked active sink（v0.0.49 `store_sink`）+ 1 history search 旁路（v0.0.126 `search_indexing`）+ 1 side_run_builder assemble_reducer + 4 compact + 2 post-compact + 2 session_store（v0.0.66）+ 15 squad/academy-scoped（§3.4/§3.6 表未逐行单列全部 scoped impl，契约归各业务 KB——squad 见 `../../squad/[P1]prompt_sections.md`、academy 见 `../../academy/`；scoped impl 不带 configSchema）；compact impl 契约归 `[P0]context_compact_detail.md §2c`；post-compact impl 契约归 `[P0]context_compact_detail.md §2d`；session_store impl 契约归 `[P0]context_engine.md §3.6` + `../../session/[P0]session_store.md §4`；search_indexing impl 契约归 `../../persistence/[P1]search_engine.md §3.3`；clean_view_reducer impl 契约归 `[P0]context_assemble_detail.md §5b`）。
>
> **[v0.0.66] 已退役 impl（manifest 不再登记，forked-scope-bootstrap disable 仅作幂等防御清历史 scope 残留 enabled）**：`system_prompt`（context_assemble_mapper，§3.2 已删，system 由 context-engine 独立调 builder）；`buffer_sink`（context_ingest_handler，由 `store_sink` + session_store EP 取代）；`buffer_reader`（context_assemble_mapper，由 `transcript_reader` + session_store EP 取代）；`append_passthrough`（context_assemble_reducer，forked 改用 `base_builder`）。
>
> **[v0.0.173] 已退役 impl**：`prev_snapshot`（context_assemble_mapper，§3.2 已删——snapshot 永远 rebuild 不再需要 prevMessages 作增量基础）。**已迁移 EP（非退役，代码不变只换 point）**：6 个清理 reducer（`snip_handler`/`orphan_tool_call`/`think_remove`/`fill_empty_text`/`empty_message`/`role_merge`）从 `context_assemble_reducer` 迁到 `context_clean_view_reducer`，由 `getCleanSnapshot` 在深克隆副本上跑。

## 4. 8 个 impl 的显式 configSchema（JSON Schema 字段）

> 这 8 个是 spec 点名需带 `ExtImpl.configSchema`（JSON Schema 校验）+ `schemaConfig`（per-key UI 控件）的 impl。阈值归各 impl 自身（不归全局 config 调参组，见各 detail spec「谁用归谁」）。单位 char（按 char×ratio 估算 token，见 `context_usage_detail §4`）。

### 4.1 `query_truncate`（context_ingest_handler）

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "queryTruncateChars": { "type": "integer", "default": 8000, "minimum": 100 }
  }
}
```

- schemaConfig: `{ "queryTruncateChars": { "type": "number", "default": 8000, "description": "user query 截断阈值（char）" } }`
- 出处：`context_ingest_detail.md` §3 表。

### 4.2 `tool_result_truncate`（context_ingest_handler）

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "toolResultTruncateChars": { "type": "integer", "default": 25000, "minimum": 100 }
  }
}
```

- schemaConfig: `{ "toolResultTruncateChars": { "type": "number", "default": 25000, "description": "tool_result 截断阈值（char）" } }`
- 出处：`context_ingest_detail.md` §3 表。

### 4.3 `transcript_reader`（context_assemble_mapper）

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "limit": { "type": "integer", "default": 500, "minimum": 1 }
  }
}
```

- schemaConfig: `{ "limit": { "type": "number", "default": 500, "description": "读最近 N 条 transcript" } }`
- 出处：`context_assemble_detail.md` §4（N=500，归本 mapper config `limit`）。

`summary_reader`（同 EP，**[v0.0.185]** 新增 configSchema）：

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "candidateLimit": { "type": "integer", "default": 500, "minimum": 1 }
  },
  "required": ["candidateLimit"]
}
```

- schemaConfig: `{ "candidateLimit": { "type": "number", "default": 500, "description": "head/tail 候选各取条数上限（锚定会话真第一条 / summaryUpTo）" } }`
- 出处：`context_assemble_detail.md` §6（head/tail 候选锚定，prompt 缓存前缀稳定）。

### 4.4 `base_builder`（context_assemble_reducer）

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "tokenCap": { "type": "integer", "default": 10000, "minimum": 1 }
  },
  "required": ["tokenCap"]
}
```

- schemaConfig: 1 个 key（integer），default 10000，description：「head/tail 各自的 token 上限（char×ratio 估算；超过即停止累加，至少保底 1 条）」。
- 出处：`context_assemble_detail.md` §6。算法：候选锚定（head=会话真第一条起 / tail=summaryUpTo 结尾，summary_reader 贡献），从头/尾累加 char×ratio，超 cap 弃当前条并停止；head/tail 独立预算不合计。
- 旧版（v0.0.13-0.0.184）6 字段（headMin/Max/Fraction + tailMin/Max/Fraction）**[v0.0.185] 已删**（schema 直接替换，无兼容层）。

### 4.5 `budget_truncate`（system_prompt_reducer）

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "budgetFraction": { "type": "number",  "default": 0.06, "exclusiveMinimum": 0, "maximum": 1 },
    "floor":          { "type": "integer", "default": 20000, "minimum": 1 },
    "ceiling":        { "type": "integer", "default": 500000, "minimum": 1 }
  }
}
```

- schemaConfig: `{ "budgetFraction": {...0.06}, "floor": {...20000}, "ceiling": {...500000} }`，description：「阈值 = clamp(contextWindow × budgetFraction, floor, ceiling) token，仅裁 context/volatile 动态段尾部，char 用 ratio 转」。
- 出处：`system_prompt.md` §3（默认 6%，20K floor / 500K ceiling token）+ §7。

### 4.6 `threshold_should_compact`（context_should_compact，v0.0.40 新增）

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "compactRatio": { "type": "number", "default": 0.6, "exclusiveMinimum": 0, "maximum": 1 }
  }
}
```

- schemaConfig: `{ "compactRatio": { "type": "number", "default": 0.6, "description": "用量/tokenLimit 占比超此阈值触发 compact（提前压，非撞墙压）" } }`
- **分母含 maxOutputTokens**（与现状 `remainingTokens = tokenLimit − totalTokens − maxOutputTokens` 口径一致）：`predicate = (totalTokens + maxOutputTokens) / tokenLimit > compactRatio`。否则只盯输入到 60% 时实际已逼近溢出。
- 出处：`context_compact_detail.md §2c.2`（默认 0.6；现状「remainingTokens<0（=100% 溢出）」升级为「>60% 提前压」）。

### 4.7 `summary_do_compact`（context_do_compact，[v0.0.186] 新增 configSchema）

```json
{
  "type": "object", "additionalProperties": false,
  "properties": {
    "tokenCap": { "type": "integer", "default": 10000, "minimum": 1 },
    "candidateLimit": { "type": "integer", "default": 500, "minimum": 1 }
  }
}
```

- schemaConfig: 2 个 key（integer）——`tokenCap` default 10000（烘焙 head/tail 各自 token 上限，char×ratio 估算，保底 1 条）；`candidateLimit` default 500（烘焙 head/tail 候选各取条数上限）。
- 用途：compact 时 `bakeSummaryBlock` 烘焙 summary block 的选取参数（经 `runCompact` 第 8 参透传）；与 `base_builder.tokenCap` / `summary_reader.candidateLimit` 同默认值——烘焙与 fallback 两路径口径一致。
- 出处：`context_compact_detail.md §2 step 5` + `context_assemble_detail.md §6`。

## 5. `rocky_context` plugin manifest 结构

单 plugin，目录 `app/plugins/builtins/rocky_context/`，manifest 文件 `plugin.json`。`extImpls[]` 装 57 个 impl（31 通用 + 1 sink（v0.0.49 `store_sink`）+ 1 search 旁路（v0.0.126 `search_indexing`）+ 1 side_run_builder + 4 compact + 2 post-compact（v0.0.51）+ 2 session_store（v0.0.66 `persistent_session_store`/`in_memory_session_store`）+ 15 squad/academy-scoped），每个 impl 一个模块文件（导出类，非 activate；见 `plugin_manager_interface.md §3.4`）。impl 模块路径相对 plugin 目录。squad-scoped impl（`squad_role`/`team_roster`/`parent_task`/`reachable_agents`/`squad_charter`/`squad_tasks`/`squad_board`）的契约文档归 squad KB（`../../squad/[P1]prompt_sections.md`），manifest 仅登记 impl 模块路径。compact impl（`threshold_should_compact`/`reject_should_compact`/`summary_do_compact`/`noop_do_compact`）契约归 `[P0]context_compact_detail.md §2c`；post-compact impl（`memory_skill_consolidation`/`noop_post_compact`）契约归 `[P0]context_compact_detail.md §2d`；session_store impl（`persistent_session_store`/`in_memory_session_store`）契约归 `[P0]context_engine.md §3.6`。

```jsonc
{
  "id": "rocky_context",
  "extImpls": [
    // context_ingest_handler (4) — 同 point 内数组顺序即 manifest 登记序（无 order record 时的补位序）
    { "implId": "query_truncate",          "point": "context_ingest_handler",   "impl": "./ingest/query_truncate.ts",          "description": "截断过长 user query，原文 offload",  "configSchema": {/* §4.1 */}, "schemaConfig": {/* §4.1 */} },
    { "implId": "tool_result_truncate",     "point": "context_ingest_handler",   "impl": "./ingest/tool_result_truncate.ts",    "description": "截断过大 tool_result，原文 offload", "configSchema": {/* §4.2 */}, "schemaConfig": {/* §4.2 */} },
    { "implId": "system_reminder_injector", "point": "context_ingest_handler",   "impl": "./ingest/system_reminder_injector.ts","description": "聚合 reminder 追加到末条 user message" },
    { "implId": "store_sink",              "point": "context_ingest_handler",   "impl": "./ingest/store_sink.ts",              "description": "main+旁路 run 都 active 的 sink：appendMessages 写 store（v0.0.66 session_store EP 按 scope 切实现）" },
    { "implId": "search_indexing",         "point": "context_ingest_handler",   "impl": "./ingest/search_indexing.ts",         "description": "★v0.0.126 派生索引旁路：role∈{user,assistant} 的 message 提取 text 投递 HistoryIndexer.index（order 5，紧随 store_sink；只 main scope active，旁路 run disable；不 await/不阻塞/异常吞+reconcile 兜底）" },

    // context_assemble_mapper (2) — v0.0.66 删 system_prompt mapper（system 由 context-engine.assemble 独立调 builder）；v0.0.173 删 prev_snapshot mapper（snapshot 永远 rebuild 不再需要 prevMessages）
    { "implId": "transcript_reader",        "point": "context_assemble_mapper",  "impl": "./assemble/transcript_reader.ts",     "description": "读最近 N 条 transcript（store 由 session_store EP 按 scope 解析）",            "configSchema": {/* §4.3 */}, "schemaConfig": {/* §4.3 */} },
    { "implId": "summary_reader",           "point": "context_assemble_mapper",  "impl": "./assemble/summary_reader.ts",        "description": "读 summary + version（旁路 run in_memory 恒 null）" },

    // context_assemble_reducer (2, v0.0.178; v0.0.204 rename forked_builder→side_run_builder) — v0.0.173 起 6 清理 reducer 迁 context_clean_view_reducer EP；assemble 链 main scope 用 base_builder（永远 rebuild）、旁路 run scope 用 side_run_builder（复用固定 parentSnapshot + summaryUpTo 后 in_memory 增量 upsert），靠 scope 切换
    { "implId": "base_builder",             "point": "context_assemble_reducer", "impl": "./assemble/base_builder.ts",          "description": "★v0.0.173 永远 rebuild（删 append 分支 + appendNew）；构建 [summaryMsg?, ...recent] 框架 + head/tail 选取；不再构 systemMsg", "configSchema": {/* §4.4 */}, "schemaConfig": {/* §4.4 */} },
    { "implId": "side_run_builder",         "point": "context_assemble_reducer", "impl": "./assemble/side_run_builder.ts",      "description": "★v0.0.178 旁路 run scope 专用（main 用 base_builder）；v0.0.204 rename 自 forked_builder；复用固定 parentSnapshot.messages + summaryUpTo 后 in_memory 增量 upsert；非 rebuild" },

    // context_clean_view_reducer (8：v0.0.173 新增 EP 迁 6 清理 reducer；v0.0.207 加 dedup_tool_result；v0.0.256 加 bubble_text_before_tool_call)
    { "implId": "dedup_tool_result",        "point": "context_clean_view_reducer", "impl": "./assemble/dedup_tool_result.ts",       "description": "★v0.0.207 同 toolCallId 多 tool_result 去重（由 getCleanSnapshot 在深克隆副本上跑）" },
    { "implId": "snip_handler",             "point": "context_clean_view_reducer", "impl": "./assemble/snip_handler.ts",          "description": "snip 标记替换为占位（由 getCleanSnapshot 在深克隆副本上跑）" },
    { "implId": "orphan_tool_call",         "point": "context_clean_view_reducer", "impl": "./assemble/orphan_tool_call.ts",      "description": "清理无配对 tool_use/tool_result block（由 getCleanSnapshot 在深克隆副本上跑）" },
    { "implId": "bubble_text_before_tool_call", "point": "context_clean_view_reducer", "impl": "./assemble/bubble_text_before_tool_call.ts", "description": "★v0.0.256 assistant text 块冒泡到 tool_call 前（三段稳定分区 + 丢空 text，修 provider 400；由 getCleanSnapshot 在深克隆副本上跑）" },
    { "implId": "think_remove",             "point": "context_clean_view_reducer", "impl": "./assemble/think_remove.ts",          "description": "删除所有 message 的 reasoning(think) content block（v0.0.98.think_remove；由 getCleanSnapshot 在深克隆副本上跑）" },
    { "implId": "fill_empty_text",          "point": "context_clean_view_reducer", "impl": "./assemble/fill_empty_text.ts",       "description": "★v0.0.171 兜底 user/success tool_result 嵌套 text==='' 为 'empty' 防 LLM 400（由 getCleanSnapshot 在深克隆副本上跑）" },
    { "implId": "empty_message",            "point": "context_clean_view_reducer", "impl": "./assemble/empty_message.ts",         "description": "剔除空 content message（由 getCleanSnapshot 在深克隆副本上跑）" },
    { "implId": "role_merge",               "point": "context_clean_view_reducer", "impl": "./assemble/role_merge.ts",            "description": "★v0.0.173 合并相邻同 role message（只发生在深克隆副本，原 snapshot 不被触碰 → 不再吞 id → 不再乱序）" },

    // system_prompt_mapper (7 通用基线，v0.0.51 memory 拆为 user+session)
    { "implId": "identity",                 "point": "system_prompt_mapper",     "impl": "./prompt/identity.ts",                "description": "agent 身份" },
    { "implId": "rules",                    "point": "system_prompt_mapper",     "impl": "./prompt/rules.ts",                   "description": "行为规则" },
    { "implId": "tool_guidance",            "point": "system_prompt_mapper",     "impl": "./prompt/tool_guidance.ts",           "description": "工具说明（读 config.tools）" },
    { "implId": "skills",                   "point": "system_prompt_mapper",     "impl": "./prompt/skills.ts",                  "description": "技能说明（skills 注册表）" },
    { "implId": "context_files",            "point": "system_prompt_mapper",     "impl": "./prompt/context_files.ts",           "description": "AGENTS.md/项目上下文（读 cwd）" },
    { "implId": "memory_user",              "point": "system_prompt_mapper",     "impl": "./prompt/memory-user.ts",             "description": "stable tier 用户记忆 whole-file 注入（v0.0.51）" },
    { "implId": "memory_session",           "point": "system_prompt_mapper",     "impl": "./prompt/memory-session.ts",          "description": "context tier session 记忆 whole-file 注入（v0.0.51）" },

    // system_prompt_reducer (3)
    { "implId": "tier_sort",                "point": "system_prompt_reducer",    "impl": "./prompt/tier_sort.ts",               "description": "按 tier 排序 stable→context→volatile" },
    { "implId": "dedup",                    "point": "system_prompt_reducer",    "impl": "./prompt/dedup.ts",                   "description": "同 fragment.id 去重" },
    { "implId": "budget_truncate",          "point": "system_prompt_reducer",    "impl": "./prompt/budget_truncate.ts",         "description": "token 预算裁剪（仅裁 context/volatile）", "configSchema": {/* §4.5 */}, "schemaConfig": {/* §4.5 */} },

    // system_reminder (5)
    { "implId": "env",                      "point": "system_reminder",          "impl": "./reminder/env.ts",                   "description": "环境（test/dev/prod、平台、模型）" },
    { "implId": "time",                     "point": "system_reminder",          "impl": "./reminder/time.ts",                  "description": "系统时间（含时分 + 时区名，[v0.0.64] 修正）" },
    { "implId": "workspace",                "point": "system_reminder",          "impl": "./reminder/workspace.ts",             "description": "工作目录、git 状态" },
    { "implId": "tool_error",               "point": "system_reminder",          "impl": "./reminder/tool_error.ts",            "description": "上轮工具错误" },
    { "implId": "todo",                     "point": "system_reminder",          "impl": "./reminder/todo.ts",                  "description": "task 进度（D1.1 缺失时 no-op）" },

    // context_should_compact + context_do_compact (4, v0.0.40，首批 exclusive context EP；各 EP = 真实现 + forked dummy)
    // 注册序：真实现在 dummy 之前 → default scope 无 exclusive 标记时 effective order 最小者（真实现）胜出
    { "implId": "threshold_should_compact", "point": "context_should_compact",   "impl": "./compact/threshold_should_compact.ts","description": "谓词：用量/tokenLimit > 阈值（默认 0.6，分母含 maxOutputTokens）", "configSchema": {/* §4.6 */}, "schemaConfig": {/* §4.6 */} },
    { "implId": "reject_should_compact",    "point": "context_should_compact",   "impl": "./compact/reject_should_compact.ts",  "description": "谓词 dummy：恒返 false（summary/consolidate scope setExclusive 选中防递归）" },
    { "implId": "summary_do_compact",       "point": "context_do_compact",       "impl": "./compact/summary_do_compact.ts",     "description": "动作：sideRun(summary,NO_TOOLS,maxIter=1)→extractTag→烘焙→setSummary", "configSchema": {/* §4.7 */}, "schemaConfig": {/* §4.7 */} },
    { "implId": "noop_do_compact",          "point": "context_do_compact",       "impl": "./compact/noop_do_compact.ts",        "description": "动作 dummy：空操作（summary/consolidate scope setExclusive 选中作 defense-in-depth）" },

    // context_post_compact (2, v0.0.51，ordered EP；compact 成功完成后触发 memory/skill 整理)
    { "implId": "memory_skill_consolidation", "point": "context_post_compact",  "impl": "./compact/memory_skill_consolidation.ts", "description": "handler：启动 fork-2 整理 forked agent（allowed tools = [skill_manage, memory_manage]）" },
    { "implId": "noop_post_compact",          "point": "context_post_compact",  "impl": "./compact/noop_post_compact.ts",         "description": "handler dummy：空操作（forked scope 选中防递归）" },

    // session_store (2, v0.0.66，exclusive EP；session_store EP 按 scope 选 impl，default 持久 / forked 内存)
    { "implId": "persistent_session_store", "point": "session_store",            "impl": "./store/persistent_session_store.ts","description": "default 选中：包装真实持久 SessionStore（delegate holder，全方法子集）" },
    { "implId": "in_memory_session_store",  "point": "session_store",            "impl": "./store/in_memory_session_store.ts", "description": "forked 选中：per-session Map，appendMessages + getMessages + getSummary(恒 null) + getRatio(恒 1.0) + updateContextWindowUsage(no-op) + releaseSlot" }
  ]
}
```

> **[v0.0.18]** manifest **无 `priority` 字段**（已删除）；impl 排序由 `ExtImplPolicyData.order`（per-point 连续 1..n，无 record 时按数组登记序末尾补位）决定。`description`（impl 级三级 description 之一）代码硬编码，inventory 透传给 UI 只读呈现（见 `extension_point_interface.md` §3.9）。
> 目录建议（不强制，impl 路径归 manifest 决定）：`ingest/` `assemble/` `prompt/` `reminder/` `compact/` 五个子目录按 EP 归类。`configSchema` / `schemaConfig` 字段实际写完整 JSON Schema（本文 §4 各小节），上例用 `{/* §4.x */}` 占位省篇幅。
>
> **[v0.0.40] compact impl scope 配置**：`threshold_should_compact` + `summary_do_compact` 在 `default` scope 被选中（current 用）；`forked` scope **显式 `setExclusive` 选 `reject_should_compact` + `noop_do_compact`**（防递归 + defense-in-depth，见 §3.7 + `[P0]context_compact_detail.md §2c.3`）。**修复要点**：forked 不靠 disable 唯一实现制造 zero-active（UI radio 单选无法表达/恢复的中间态），改用 dummy 实现显式选中——exclusive EP 在所有 scope 都「总有人被选中」。
>
> **[v0.0.49 历史] sink impl scope 配置**（**已被 v0.0.66 取代，见紧接的下方配置，此处保留作演进记录**）：v0.0.49 D15 时 `store_sink` 仅在 `default` scope activate、`forked` scope `disableImplInForked('context_ingest_handler', 'store_sink')`、forked chain 尾是 `buffer_sink` 写 buffer；`IngestCtx.store` 仅 default 注入 wireStore。v0.0.40-0.0.48 default sink 是 context-engine.ts 的 `if (scopeId !== FORKED) store.appendMessages` 硬尾；v0.0.49 D15 把 default sink 也 EP 化（`store_sink` impl），contextEngine 删 if 硬尾——default/forked sink 当时对称（都走 chain 尾 impl，由 scope 配置选）。**v0.0.66 起 default+forked 都 active `store_sink` + `session_store` EP 按 scope 切 store impl，`buffer_sink` 退役，见下。**
>
> **[v0.0.66] sink + session_store EP scope 配置**（v0.0.49 buffer_sink/buffer_reader/append_passthrough 已退役，manifest 不再登记）：
> - `store_sink` 在 `main` + 旁路 run scope 都 active（chain 尾 sink 写 store）：store 经 `ContextEngine.resolveStore(scopeId)` → session_store EP 按 scope 选 impl（main=`persistent_session_store` / 旁路 run=`in_memory_session_store`），store_sink 透传不同 store 实现写
> - 旁路 run scope 经声明式 yaml 激活 `side_run_builder`（v0.0.178 forked_builder，v0.0.204 rename；替代 base_builder）+ `store_sink` + `transcript_reader`（在 `app/plugins/scopes/session-type-scopes/*.summary.yaml` / `*.consolidate.yaml` 的 `context-assemble` / `context-ingest` group 下显式列 impl id；ScopeConfigLoader 解析为 enabled+order）。main scope 激活 `base_builder`（同一 EP，靠 scope 切换）。
> - 旁路 run scope `setExclusive('in_memory_session_store', summary/consolidate scope)`（session_store EP 选内存 impl）
> - 旁路 run scope 6 清理 reducer（orphan/empty/role_merge/snip/think_remove/fill_empty_text）**v0.0.173 起挂在 `context_clean_view_reducer` EP**（v0.0.173 前挂在 assemble_reducer），main + 旁路 run 都 active（与 main 对齐；旧 v0.0.49「关 4 清理 reducer 削减 chain 遍历」基于 append_passthrough 丢弃 input 的前提，v0.0.66 旁路 run 改用 base_builder 后 input 不丢弃，前提失效）
> - **[v0.0.126]** 旁路 run scope 经**声明式 yaml 配置** disable `search_indexing`：`app/plugins/scopes/session-type-scopes/*.summary.yaml` / `*.consolidate.yaml` 的 `context-ingest` group → `context_ingest_handler` point → `impls: [{ implId: search_indexing, enabled: false }, { implId: system_reminder_injector, enabled: false }]`（旁路 run 是临时派生会话，不进历史索引 + in_memory store 无 transcript 可锚；与 store_sink scope 配置解耦——store_sink 仍 main+旁路 run 都 active 写各自的 store，search_indexing 仅 main active 投递历史索引）。**disable 走声明式 yaml + ScopeConfigLoader**（非 `disableImplInForked` API——后者不存在，spec 早期草稿的概念虚构；实际机制 = yaml 声明 `{ implId, enabled: false }` + loader 按 enabled=false 跳过该 impl 不赋 order）

## 6. EP 契约出处索引（不重定义，仅指路）

| EP | 契约 interface | detail spec 章节 |
|---|---|---|
| context_ingest_handler | `IngestHandler` / `IngestCtx` | `context_ingest_detail.md` §3 |
| context_assemble_mapper | `AssembleMapper` / `AssembleData` / `AssembleCtx` | `context_assemble_detail.md` §3 |
| context_assemble_reducer | `AssembleReducer`（v0.0.178 起 2 impl：main scope=base_builder / 旁路 run scope=side_run_builder〔v0.0.204 rename 自 forked_builder〕） | `context_assemble_detail.md` §3/§5/§5c |
| context_clean_view_reducer ★ v0.0.173 | `AssembleReducer`（同 assemble_reducer 契约；input 永远非 null） | `context_assemble_detail.md` §3/§5b |
| system_prompt_mapper | `SystemPromptMapper` / `PromptFragment` / `PromptCtx` | `system_prompt.md` §2-§3 |
| system_prompt_reducer | `SystemPromptReducer` | `system_prompt.md` §3 |
| system_reminder | `SystemReminderProvider` / `SystemReminder` / `ReminderCtx` | `system_reminder.md` §2-§3 |
| context_should_compact ★ v0.0.40 | `ShouldCompactPredicate` / `CompactCtx` | `context_compact_detail.md` §2c |
| context_do_compact ★ v0.0.40 | `DoCompactAction` / `CompactCtx` | `context_compact_detail.md` §2c |
| context_post_compact ★ v0.0.51 | `PostCompactHandler` / `PostCompactCtx` | `context_compact_detail.md` §2d |
| session_store ★ v0.0.66 | `SessionStoreContract` | `context_engine.md` §3.6 + `../../session/[P0]session_store.md` §4 |

## 7. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
