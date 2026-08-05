# v0.0.238 tech change_log — prompt 注入质量治理（自律段 + T1 整理者化 + 分层配额 + 硬长度检查）

> 类型：prompt 组装层 + 整理机制 + 写入校验（agent 工具层）。无 schema/EP/插件 manifest 变更。
> 权威变更契约见同目录 `change_plan.md`（method 级 A-F 组）。PRD：`specs/prd/version_logs/v0.0.238/change_log.md`（v1.1）。

## 影响子系统 KB

| KB | 改什么 |
|----|--------|
| `specs/tech/agent/context/` | `system_prompt.md §4` mapper 表（skills/memory 分层配额 20/30/50 + builtin 不计 + catalog 序）；`agent_profile.md §3/§6` d) 段 4 条质量标准 + 设计决策（常量提取）；`prompt_content_files.md §4.2/§5` ConsolidationHandler 占位符（agents_paths/scope_table）+ RoutingDecisionHandler 4 处消费方含 tier2；`log.md` v0.0.238 条目 |
| `specs/tech/agent/memory/` | `memory_definition.md §5/§6` 长度口径字符化（intro ≤50 / body ≤500，300 词退役）；`memory_manage_tool.md §1/§2/§5` scope 必填 + biz 校验 + 字符硬限；`memory_tool.md` 错误码注；`memory_injection.md §2` 分层配额签名；`consolidation_tier1.md` T1 整理者化（toolBound 扩 + 指令 + 红线）；`consolidation_tier2.md §6` write_scope 占位符；`index.md` 概念表；`log.md` v0.0.238 条目 |
| `specs/tech/agent/skills/` | `skill_definition.md §2/§3` description ≤50 + builtin 由 scope 派生 injectLayer（SkillRow.group→origin）；`skill_manage_tool.md §2/§3/§11` SkillScopeExternal + group + scope 必填 + biz 校验 + description ≤50；`log.md` v0.0.238 条目 |

## 摘要

### ① agent_profile d) 自律治理段（change_plan A 组）
4 条质量标准（分层归位 / 个人只写差异 / 描述即路由 / 会删比会写重要）+ biz scope 可用表（来自 `biz-scope-rules.ts renderScopeTableForPrompt`）。文案落模块常量 `AGENT_PROFILE_D_STANDARDS`（`agent_profile.ts:215`）——为满足单文件 ≤300 行约束提取，非拆模板（「一个 mapper 按 kind 渲染」铁律不变，仍由 `renderAgentProfile` 渲染 a/b/c/d）。

### ② T1 整理者化（change_plan B 组）
- **toolBound 扩权**：fork-2 整理 agent allowed tools 从 `[skill_manage, memory_manage]` 扩为 `[skill_manage, memory_manage, read, write, edit, glob, grep]`（consolidate profile `runShape.toolBound`），允许 T1 整理 AGENTS.md 等自定义文件。
- **指令加 5 条整理标准 + 红线**：禁删角色定位/用户钦定铁律、不删文件（write/edit 改内容不 rm）、memory 只 archive、skill 只 disable、evolvable=false 不动。
- **新占位符**：`{{agents_paths}}`（按主 session kind 渲染 AGENTS.md 整理对象路径：studio 团队+个人 / playground 单份 / academy 固定 OUT 行）+ `{{scope_table}}`（按主 session biz 渲染可用 scope 表，来自 `biz-scope-rules.renderScopeTableForPrompt`）；删 fork-override 默认翻 session 段（被 scope 必填取代）。

### ③ 注入侧分层配额（change_plan C 组）
- **skills mapper**（`selectSkillsByQuota`）：签名从 `(rows, maxN)` 改为 `(rows, quotas: SkillInjectQuotas)`，`{ session: 20; group: 30; global: 50 }`。物理层归组映射 = workspace→session / group→group / app→global / **builtin 不计配额恒全量殿后**；catalog 序 workspace→group→app→builtin（近者优先）；层内 user→agent + updatedAt 倒序 + name 升序。builtin 由 `injectLayerOf(scope)` 映射到独立 inject layer（不经 origin 分组）。
- **memory_user/group/session mapper**（`selectMemoriesByQuota`）：同构分层配额，各 scope 独立截断；跨 scope 不再共享总量。
- **app_config**：`maxSkillInject`/`maxMemoryInject`（旧 key 语义转为 global 层）+ 新 `maxSkillInjectGroup`/`maxSkillInjectSession`/`maxMemoryInjectGroup`/`maxMemoryInjectSession`（缺省 30/20）。

### ④ 写侧 scope 必填 + 按 biz 校验（change_plan D 组）
- `memory_manage` write/archive + `skill_manage` create/patch/disable/enable：不传 scope → `[invalid_input]` + `scopeRequiredErrorText(biz)`；传本 biz 不可用 scope → `[invalid_input]` + `scopeUnavailableErrorText(biz, scope)`。
- 可用层（来自单源 `biz-scope-rules.ts AVAILABLE_SCOPES_BY_BIZ`）：playground=session/global、studio=group/global、academy=session/group/global。biz 由 `resolveBizScopeKind(ctx.config)` 读 `kind.biz`，缺省 `'playground'`。
- `skill_manage` 工具 input scope 对外加 `'group'`（暴露 squad 团队层，与 memory 同词表）。
- `ROUTING_DECISION_PROMPT` Step 2 重写（三层语义 + scope 必填无默认 + 全 biz 静态可用表三行 + 错误引导）；4 处消费方（memory-manage / skill-manage / consolidation.md / consolidation-tier2-handler.ts）自动同源更新。

### ⑤ 写入硬长度检查（change_plan E 组）
- **memory**：intro ≤50 字符 / body ≤500 字符（trim 后 `str.length`，CJK 与 ASCII 均计 1）。`policy.ts` 删 `countWords`/`WORD_LIMIT`/`MemoryWordLimitError`，新增 `INTRO_CHAR_LIMIT=50`/`BODY_CHAR_LIMIT=500`/`MemoryCharLimitError`（携 field/current/limit）。落 dir store `writeLocked` 服务层单点（覆盖 agent 工具 + UI HTTP 两路径）；handlers/memory HTTP 400 映射 `charLimitTo400`。
- **skill**：description ≤50 字符（agent 写侧 executeCreate/executePatch 硬检查；UI 市场安装走 `executeMarketInstall` 直写 SKILL.md，**不受硬限影响**——第三方 description 是源数据）。

### ⑥ tier2 prompt 加 `{{write_scope}}` 占位符（偏离 change_plan 最小补丁）
scope 必填后，tier2 的 memory_manage/skill_manage 调用由 LLM 发起（非代码直调），必须在 prompt 显式告知该传哪个 scope（全局块='global'/单 session 块='session'）。`ConsolidationTier2PromptHandler.build()` 从 `ctx.vars.write_scope` 读（caller 传入；缺省 `'global'`）；三个 run caller 各传值（global-skill/global-memory='global'、session-memory='session'）。

### ⑦ 3 处偏离 architect change_plan 的实现决策（已落 spec）

| 偏离 | 落点 | 理由 |
|------|------|------|
| tier2 prompt `{{write_scope}}` 占位符 | `[P0]consolidation_tier2.md §6` | scope 必填后须告知 LLM 该传哪个 scope |
| `SkillRow.group`→`origin`（builtin 由 scope 派生 injectLayer） | `[P0]skill_definition.md §2` | 旧 group 字段语义含混；origin 二值（user/agent）+ scope 四值分离；builtin 不计配额靠 injectLayerOf 而非 origin 分组 |
| d) 段文案落 `AGENT_PROFILE_D_STANDARDS` 常量 | `[P1]agent_profile.md §6.1` | 为满足 `agent_profile.ts ≤300 行`约束提取常量，**非拆模板**（统一 mapper 铁律不变） |

## 不变（明确保留）

- skills resolver 4 层优先级（group > workspace > app > builtin）不变。
- memory/skill 三层存储模型与目录布局不变（本版只限定各 biz 写侧可用 scope 词汇）。
- T1 触发机制（sibling 双发 / 锁 / fire-and-forget）不变。
- EP 契约 / mapper / reducer / manifest 不变。
- UI HTTP 端点（skill/memory）仍用内部 `app`/`workspace`（UI 同步是后续一致性项，本版 OUT）。
