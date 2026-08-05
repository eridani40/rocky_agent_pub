# v0.0.238 变更计划书 — prompt 注入质量 / 整理机制健康化

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 产品契约：`specs/prd/overall/14-prompt-quality-governance.md`（决策基线 D1-D10，见 `specs/prd/version_logs/v0.0.238/change_log.md`）。

## 架构决策（7 个开放点终裁）

| # | 决策 |
|---|------|
| O1 | **consolidation.md 破纯 directive**：`ConsolidationHandler.build(ctx)` 改读 `ctx.vars` 的两个新占位符 `{{agents_paths}}` / `{{scope_table}}`（**静态配置**，非对话历史——旁路不变量不破坏）。vars 由 caller（plugin `startConsolidation`）从 `ctx.config`（SessionConfig 含 kind/workdir/sessionContext/studioContext）计算：agents_paths 复用 `resolveAgentProfileInput`（agent_profile.ts 单源，academy → 固定「不整理 AGENTS.md」行，OUT）；scope_table 由新共享模块 `biz-scope-rules.ts` 渲染。`{{routing_rules}}` 不变。fork-override「默认翻 session」段删除（被 scope 必填取代）。 |
| O2 | **skill 侧暴露 group**：`SkillScopeExternal` 加 `'group'`；内部 scope 扩为三值 `'app'/'workspace'/'group'`，group 根目录 = `groupSkillRoot(groupWsDir)`（resolver 已 export），`groupWsDir` 由 `skill-manage.ts run()` 从 `ctx.config.squadId` 经 `resolveGroupWsDir` 解析后传入 execute*。studio 场景 group 与 workspace 物理同址（写 group 落 squad 目录，resolver 同址双扫按 group 生效）；无 squadId → 报 `not_in_group`。 |
| O3 | **skill 4 层归组映射 + builtin 不计配额**：注入侧物理层映射 = workspace→session 层(≤20) / group→group 层(≤30) / app→global 层(≤50)；**builtin（平台资产）不计入配额、恒全量注入**。catalog 拼接序 = workspace → group → app → builtin（近者优先，修「system→user→agent 方向反」）；层内 user→agent + updatedAt 倒序 + name 升序。memory 同构（层内 manual→agent）。 |
| O4 | **写侧 scope 必填 + 按 biz 校验位置**：工具 run 边界（dispatch 层）单点，新共享模块 `app/server/src/agent/biz-scope-rules.ts` 承载 biz 解析 + 可用表 + 错误文案。memory 侧 write/archive 必填+校验（read 保留缺省 global，list 已必填）；skill 侧 create/patch/disable/enable 必填+校验（read/list 保持）。biz 从 `ctx.config.kind.biz` duck-type 读，缺省兜底 `'playground'`（与 side-run 兜底一致，tier2 三 run 天然落入 session/global 可用表）。错误码 `invalid_input`。 |
| O5 | **报错引导文案**：`routing_decision.md`（ROUTING_DECISION_PROMPT 单一源）Step 2 重写 = scope 三义 + 必填无默认 + **全 biz 静态可用表三行**（工具 description 是模块级静态，无法按 session 渲染，放全表）。动态按 biz 渲染仅两处：agent_profile d) 段 + consolidation `{{scope_table}}`；运行期错误消息含本 biz 可用层（biz-scope-rules.ts 文案函数）。单一源不变量保持：可用表数据在 biz-scope-rules.ts，静态文案在 routing_decision.md，4 个消费方（memory-manage / skill-manage / consolidation-handler / consolidation-tier2-handler）自动同源。 |
| O6 | **UI 手动新建/编辑路径**：本版 **OUT**（工具层 + prompt 先行；scope 必填/按 biz 过滤的 UI 交互后续版本）。例外：memory 长度硬检查落 dir store 服务层单点（`writeLocked`），UI HTTP 写路径自然同款强制（PRD 口径「应加，同一标准对人对 agent 一致」）——`handlers/memory.ts` 错误映射同步更新。skill UI 路径不经 executeCreate/executePatch（市场 install 直写），不受 ≤50 影响。 |
| O7 | **academy AGENTS.md 整理**：**OUT**。T1 指令 agents_paths 仅 squad（团队+个人）/playground（单份）；academy 渲染固定行「本场景不整理 AGENTS.md，仅 memory/skill」。academy 写侧 group 词汇在可用表中（PRD D7），但物理解析仍为 squad-only（不改存储布局）——无 squadId 时按既有 not_in_group 拒绝。 |

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

### A. biz-scope-rules（新共享模块，功能1/2/3 共用）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent | app/server/src/agent/biz-scope-rules.ts | `BizScopeKind` | 新增 | type = `'playground' \| 'studio' \| 'academy'`（写侧 scope 可用表的 biz 键） | 闭合三值 | PRD §14.2.3 可用表；O4 | +5 |
| agent | app/server/src/agent/biz-scope-rules.ts | `AVAILABLE_SCOPES_BY_BIZ` | 新增 | 常量：`playground→['session','global']`、`studio→['group','global']`、`academy→['session','group','global']`（memory/skill 同词表） | MUST 与 PRD D7 一致；数据与文案分离（渲染函数消费本表） | PRD §14.2.3；D7 | +8 |
| agent | app/server/src/agent/biz-scope-rules.ts | `resolveBizScopeKind()` | 新增 | 从 duck-typed config（`config.kind.biz`）解析 biz；缺省/未知 → `'playground'`（与 agent-side-run.ts kind 兜底一致） | MUST NOT 抛错；MUST 容忍 kind 缺失（tier2 run 无 kind） | agent-side-run.ts L91-96；O4 | +12 |
| agent | app/server/src/agent/biz-scope-rules.ts | `renderScopeTableForPrompt()` | 新增 | 按 biz 渲染 prompt 用 scope 规则段：本 biz 可用层 + 三层语义（session=仅本会话/group=本团队共享/global=跨项目全局）+ 必填规则 + 分层配额（20/30/50） | MUST 数据源自 AVAILABLE_SCOPES_BY_BIZ；纯函数 | PRD §14.2.1 d) 段文案方向；O5 | +30 |
| agent | app/server/src/agent/biz-scope-rules.ts | `scopeRequiredErrorText()` | 新增 | scope 缺失错误文案（不含 `[invalid_input]` 前缀，caller 拼）：含本 biz 可用层 + 语义 + 示例调用 | 纯函数；文案引导 LLM 自修正 | O4/O5；UC-8 | +15 |
| agent | app/server/src/agent/biz-scope-rules.ts | `scopeUnavailableErrorText()` | 新增 | 传了本 biz 不可用 scope 的错误文案：指出不可用原因 + 本 biz 可用层 + 语义 | 同上 | O4/O5；UC-9 | +15 |

### B. agent_profile d) 自律治理段（功能1）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent_profile | app/plugins/builtins/rocky_context/prompt/agent_profile.ts | `AgentProfileInput` | 修改 | 加字段 `scopeTable: string`（d) 段按 biz 渲染的 scope 规则文本） | 不新增其他渲染参数 | [P1]agent_profile.md §3；O1 | +3 |
| agent_profile | app/plugins/builtins/rocky_context/prompt/agent_profile.ts | `resolveAgentProfileInput()` | 修改 | ① memoryScopes 改为按 biz 从 `AVAILABLE_SCOPES_BY_BIZ` 取（studio 去 session、academy 加 group、playground 不变）；② 填 `scopeTable = renderScopeTableForPrompt(biz)`（biz 经 resolveBizScopeKind(ctx.config)） | MUST 复用 biz-scope-rules 单源，不在本文件复制可用表；kind 分支结构不变 | PRD §14.2.1 + §14.6 行1；[P1]agent_profile.md §4 | +10/-6 |
| agent_profile | app/plugins/builtins/rocky_context/prompt/agent_profile.ts | `renderAgentProfile()` | 修改 | c) 之后追加 `## d) 自律治理（质量标准）` 段：4 条标准（分层归位/个人只写差异/描述即路由≤50字/会删比会写重要含配额 20/30/50）+ `input.scopeTable` | MUST 同一 mapper 渲染 a/b/c/d（§13.2.1 铁律）；stable/480 不变；具体措辞 coder 落稿但 4 条+可用表+必填缺一不可 | PRD §14.2.1；§13.2.1 | +22 |

### C. T1 整理者化（功能2）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| consolidate | app/plugins/session-types/consolidate.yaml | `toolBound` | 修改 | 扩为 `[skill_manage, memory_manage, read, write, edit, glob, grep]` | MUST 用注册名 read/write/edit/glob/grep（file-*.ts 已核实）；scope yaml 不动；触发机制（sibling 双发/锁/fire-and-forget）不变 | PRD §14.2.2；D2 | +5 |
| consolidate | app/server/src/prompts/content/consolidation.md | （模板正文） | 修改 | 新增「整理对象」段（`{{agents_paths}}` 占位符）+ 5 条整理标准（AGENTS.md 只留角色+规则/团队个人不重复/skill description 路由语言≤50字/memory 长期事实非流水+intro≤50 body≤500/控制总体量回配额）+ 红线（禁删角色定位与用户铁律/不删文件/memory 只 archive/skill 只 disable/evolvable=false 不动）+ `{{scope_table}}` 占位符；**删 fork-override「默认翻 session」段** | MUST NOT 加 `{{serialized_transcript}}` 类对话历史占位符（旁路不变量）；纯 directive 语义不变——新占位符只承载静态配置 | PRD §14.2.2；D3/D5；O1 | +45/-6 |
| consolidate | app/server/src/prompts/handlers/consolidation-handler.ts | `ConsolidationHandler.build()` | 修改 | 填三占位符：`routing_rules`（不变）+ `agents_paths`/`scope_table`（读 `ctx.vars`，缺省替空串——降级不抛错） | MUST 保持纯 directive：只经 vars 收静态配置，不读 snapshot；build(ctx) 签名沿用父类 | prompt_content_files §3.2/§3.3；O1 | +8/-2 |
| consolidate | app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts | `startConsolidation()` | 修改 | 从 `ctx.config` 计算 vars 传入 `build({vars})`：`agents_paths` = 按 kind 渲染（studio：团队 `{workdir}/AGENTS.md` + 个人 `findPersonalAgentsFile` 命中/引导行；squad 群聊仅团队；playground：`{workdir}/AGENTS.md`；academy：固定「本场景不整理 AGENTS.md」行）——路径计算复用 `resolveAgentProfileInput`（传 `{config: ctx.config}` duck-type PromptCtx）；`scope_table` = `renderScopeTableForPrompt(resolveBizScopeKind(ctx.config))` | MUST 复用 agent_profile 路径单源（禁平行实现）；MUST NOT 复述对话历史；usage 累计/锁语义不变 | O1/O7；[P1]agent_profile.md §4 | +35 |

### D. 写侧 scope 必填 + 按 biz 校验（功能3 机制一/二）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory-tool | app/server/src/tools/memory-manage-scope.ts | `parseScope()` | 修改 | 去「缺省 global」：raw 缺失/空 → `null`（纯解析）；合法三值直通 | MUST 保持纯函数；read 调用侧自行 `?? 'global'` 兜底 | O4；PRD §14.2.3 机制一 | +2/-2 |
| memory-tool | app/server/src/tools/memory-manage.ts | `memoryManageTool.definition` | 修改 | description 改「scope 必填无默认」+ 长度口径（intro ≤50 字符 / body ≤500 字符，超限拒绝）；inputSchema.scope description 同步（删 defaults to global） | ROUTING_DECISION_PROMPT 拼接结构不变；intro 字段保留 | PRD §14.2.3/§14.2.4 | +8/-8 |
| memory-tool | app/server/src/tools/memory-manage.ts | `memoryManageTool.run()` | 修改 | ① write/archive：scope 缺失 → `[invalid_input]` + scopeRequiredErrorText(biz)；parseScope null → invalid；`AVAILABLE_SCOPES_BY_BIZ` 不含 → scopeUnavailableErrorText(biz)；② read：parseScope 后 `?? 'global'` 兜底（读侧宽容不变）；③ write catch 换 `MemoryCharLimitError`（替 MemoryWordLimitError） | MUST biz = resolveBizScopeKind(ctx.config)；校验先于 resolveScopeDir/落盘；list 逻辑不动 | O4/O5；UC-8/9/11 | +20/-6 |
| skill-tool | app/server/src/tools/skill-manage.ts | `skillManageTool.definition` | 修改 | description 改「scope 必填无默认」+ description ≤50 字符硬限；inputSchema.scope enum 加 `'group'` + description 更新 | ROUTING_DECISION_PROMPT 拼接结构不变 | PRD §14.2.3/§14.2.4；O2 | +8/-6 |
| skill-tool | app/server/src/tools/skill-manage.ts | `skillManageTool.run()` | 修改 | 写侧 action（create/patch/disable/enable）：scope 必填 + 按 biz 校验（同 memory 侧文案函数，`'skill'` 语义）；解析 `groupWsDir = resolveGroupWsDir(dataDir, {squadId})` 传入 execute*（read/list 不传 biz 校验，仅透传 groupWsDir 供 group 寻址） | MUST biz = resolveBizScopeKind(ctx.config)；校验先于 dispatch；scope=group 且 groupWsDir 缺失 → `[invalid_input] not_in_group` | O2/O4；UC-8/9/10 | +25/-4 |
| skill-tool | app/server/src/tools/skill-manage-actions.ts | `SkillScopeExternal` | 修改 | 加 `'group'`：`'global' \| 'session' \| 'group'` | 对外回显三值闭合 | O2；skill_manage_tool §2 | +1/-1 |
| skill-tool | app/server/src/tools/skill-manage-actions.ts | `toInternalSkillScope()` | 修改 | 三值映射：global→app / session→workspace / group→group；返回 `'app' \| 'workspace' \| 'group'`；不再缺省 app（必填由 run() 保证） | 调用方必先过必填校验 | O2/O4 | +4/-2 |
| skill-tool | app/server/src/tools/skill-manage-actions.ts | `toExternalSkillScope()` | 修改 | workspace→session / app/builtin→global（不变）/ group→group | 输出回显不变量保持 | O2 | +2 |
| skill-tool | app/server/src/tools/skill-manage-actions.ts | `toInternalListScope()` | 修改 | 加 group→group（list scope=group 过滤） | — | O2 | +2 |
| skill-tool | app/server/src/tools/skill-manage-actions.ts | `scopeRootDir()` | 修改 | 三值：app→appSkillRoot / workspace→workspaceSkillRoot / group→`groupSkillRoot(groupWsDir)`；签名加 `groupWsDir?: string` | group 且 groupWsDir 缺失由 run() 先拦，此处防御返 app 路径不可达 | O2；resolver.ts groupSkillRoot L60 | +6/-2 |
| skill-tool | app/server/src/tools/skill-manage-actions.ts | `parseNameScope()` | 修改 | 内部 scope 三值直通（不再 toInternalSkillScope 缺省 app） | 必填/非法值由 run() 先拦 | O4 | +3/-2 |
| skill-tool | app/server/src/tools/skill-manage-actions.ts | `executeCreate()` | 修改 | ① 签名加 `groupWsDir?: string`；② description 必填（已有）+ **≤50 字符硬检查**（trim 后 str.length，超限 `[invalid_input] skill description exceeds 50 chars (current: <n>)`） | MUST 校验先于落盘；group 落 groupSkillRoot | PRD §14.2.4；O2/O6 | +10/-2 |
| skill-tool | app/server/src/tools/skill-manage-actions.ts | `executePatch()` | 修改 | ① 签名加 `groupWsDir?: string`；② payload 带 description 时同 ≤50 硬检查 | 同上；evolvable 强制不变 | PRD §14.2.4；O2 | +8/-2 |
| skill-tool | app/server/src/tools/skill-manage-actions.ts | `executeSetEnabled()` | 修改 | 签名加 `groupWsDir?: string`（group 寻址） | evolvable 强制不变 | O2 | +4/-2 |
| skill-tool | app/server/src/tools/skill-manage-actions.ts | `executeList()` | 修改 | 签名加 `groupWsDir?: string`；`resolveAll` 传第 5 参 groupDir（group 条目可见 + group 过滤生效） | list 含 disabled 语义不变 | O2 | +5/-2 |
| skill-tool | app/server/src/tools/skill-manage-actions.ts | `executeRead()` | 修改 | 签名加 `groupWsDir?: string`；显式 scope=group 直定位 groupSkillRoot；`SkillResolver.lookup` 传第 5 参 groupDir | 含 disabled 语义不变 | O2 | +6/-2 |
| prompts | app/server/src/prompts/content/routing_decision.md | （正文） | 修改 | Step 2 重写：scope 三义（session=仅本会话/group=本团队共享/global=跨项目全局）+ **必填无默认** + 全 biz 静态可用表三行（playground→session/global；studio→group/global；academy→三层）+ 错误引导说明（不传/传错被拒并告知可用层）；Step 1 不动 | MUST 保持 ROUTING_DECISION_PROMPT 单一源（4 消费方自动同源）；不写 per-biz 动态内容（静态全表） | O5；PRD §14.2.3 | +12/-6 |

### E. 注入侧分层配额（功能3）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory-inject | app/server/src/memory/inject-quota.ts | `MemoryInjectQuotas` | 新增 | interface `{ global: number; group: number; session: number }`（各 scope 独立配额） | — | PRD §14.2.3；O3 | +5 |
| memory-inject | app/server/src/memory/inject-quota.ts | `selectMemoriesByQuota()` | 修改 | 签名 `maxN: number` → `quotas: MemoryInjectQuotas`；按 scope 独立截断：各 scope 内 manual(source=user)→agent 两分组各自 updatedAt 倒序 + name 升序拼接后 slice(0, quota[scope])；输出形态不变 | MUST 层内 manual→agent 顺序（原 6 类顺序的层内投影）；跨 scope 不再共享总量 | O3；memory_injection §2.2 | +15/-20 |
| memory-inject | app/plugins/builtins/rocky_context/prompt/memory.ts | `resolveMaxMemoryInject()` → `resolveMemoryQuotas()` | 修改 | 改名并返 MemoryInjectQuotas：`global=maxMemoryInject ?? 50`（旧 key 语义转为 global 层）、`group=maxMemoryInjectGroup ?? 30`、`session=maxMemoryInjectSession ?? 20` | app_config 缺失回退默认值模式不变 | O3；app_config §3.14 | +12/-8 |
| memory-inject | app/plugins/builtins/rocky_context/prompt/memory.ts | `MemoryUserMapper.map()` / `MemorySessionMapper.map()` / `MemoryGroupMapper.map()` | 修改 | 调 `selectMemoriesByQuota(global, session, group, quotas)` 新签名（各自仍取本 scope 切片） | 三 mapper 协同/同址去重/tier/priority 不变 | O3 | +6/-6 |
| skill-inject | app/plugins/builtins/rocky_context/prompt/skills.ts | `SkillInjectQuotas` | 新增 | interface `{ global: number; group: number; session: number }`（skill 侧自带，plugin 不反向依赖 memory 模块类型） | — | O3 | +5 |
| skill-inject | app/plugins/builtins/rocky_context/prompt/skills.ts | `selectSkillsByQuota()` | 修改 | 签名 `(rows, maxN)` → `(rows, quotas: SkillInjectQuotas)`；物理层归组映射：workspace→session 层 / group→group 层 / app→global 层，各层独立截断（层内 user→agent + updatedAt 倒序 + name 升序）；**builtin 层不计配额恒全量**；catalog 拼接序 = workspace → group → app → builtin | MUST builtin 恒注入（裁掉破坏基础能力）；MUST NOT 改 resolver 4 层优先级（归组只在配额函数内） | O3；PRD §14.2.3 | +25/-18 |
| skill-inject | app/plugins/builtins/rocky_context/prompt/skills.ts | `resolveMaxSkillInject()` → `resolveSkillQuotas()` | 修改 | 改名并返 SkillInjectQuotas：`global=maxSkillInject ?? 50`、`group=maxSkillInjectGroup ?? 30`、`session=maxSkillInjectSession ?? 20` | 同上 | O3 | +10/-6 |

### F. 写入硬长度检查（功能4）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| memory-core | app/server/src/memory/policy.ts | `INTRO_CHAR_LIMIT` / `BODY_CHAR_LIMIT` | 新增 | 常量 50 / 500（字符数，trim 后 str.length，中英文统一按字符计） | 单点口径 | PRD §14.2.4 | +4 |
| memory-core | app/server/src/memory/policy.ts | `MemoryCharLimitError` | 新增 | class extends Error `{ field: 'intro' \| 'body'; current: number; limit: number }`；message = `memory <field> exceeds <limit> chars (current: <n>)` | 与 MemoryNonEvolvableError 同模式 | PRD §14.2.4；UC-11 | +12 |
| memory-core | app/server/src/memory/policy.ts | `countWords()` / `WORD_LIMIT` / `MemoryWordLimitError` | 删除 | 300 词口径整体退役（被字符口径取代）；消费方同步切换（本表 F/D 行） | MUST 全量删除不留死代码；grep 残留归零 | PRD §14.2.4 覆盖旧口径；原则2 | -55 |
| memory-core | app/server/src/memory/memory-dir-write.ts | `writeLocked()` | 修改 | intro（trim 后）>50 → throw MemoryCharLimitError('intro')；body >500 → throw MemoryCharLimitError('body')；删 countWords/WORD_LIMIT 调用 | MUST 服务层单点（agent 工具 + UI HTTP 两路径同款）；锁内原子执行不变；存量不追溯 | PRD §14.2.4；O6 | +8/-4 |
| memory-api | app/server/src/handlers/memory.ts | `wordLimitTo400()` → `charLimitTo400()` | 修改 | 改名 + `MemoryCharLimitError` → HTTP 400（携 field/current/limit 文案） | 非该错误重新抛出语义不变 | O6 | +4/-4 |

## 影响面评估

- **跨模块**：agent（新 biz-scope-rules）→ tools（memory/skill manage）→ prompts（consolidation/routing_decision）→ plugin rocky_context（agent_profile/skills/memory mapper/post-compact）→ memory core（policy/dir-write）→ handlers（memory HTTP）。依赖顺序：A(biz-scope-rules) + F(policy) 先行，B/C/D/E 并行可。
- **破坏性变更**：① `selectMemoriesByQuota` / `selectSkillsByQuota` 签名变（消费方仅 plugin mapper + UT，已全部列出）；② `parseScope` 去缺省（消费方仅 memory-manage.ts 三处，已列出）；③ `MemoryWordLimitError` 删除（消费方 memory-manage.ts / handlers/memory.ts / policy.test.ts 等 UT）；④ `SkillScopeExternal` 加值（闭合 union，re-export 消费方 skill.ts/测试需核对）；⑤ app_config 旧 key `maxMemoryInject`/`maxSkillInject` 语义从「三源总量」转为「global 层配额」——既有用户配置行为变化（总量 50 → 分层 20/30/50），属 PRD 认可的覆盖语义。
- **UT 同步**（coder 负责，不占本表行）：`inject-quota.test.ts`、`memory-quota.test.ts`、`skills-quota.test.ts`、`policy.test.ts`、`memory-dir-store.test.ts`、routing-decision/consolidation handler 相关 UT、agent_profile UT、skill-manage/memory-manage 工具 UT——断言按新契约重写；改 assemble reducer 链/配额结构须全量 `bun run test`（防下游顺序断言漂移）。
- **AT 影响**：写侧 scope 必填是行为 breaking——依赖「不传 scope 默认 global」的存量 AT case 会假 fail，coder/orchestrator 需排查 `tests/api` 中 memory_manage/skill_manage 调用补 scope 参数（字段值变更护栏：重命名后显式批量更新 AT 订阅+断言）。
- **tier2 兼容**：tier2 三 run 无 kind → biz 兜底 playground（session/global 可用，与其全局/单 session 整理职责匹配）；tier2 prompt 经 `{{routing_rules}}` 自动获得新 Step 2 文案；tier2 snapshot.tools 白名单不含文件工具（toolBound ∩ snapshot），T1 扩权不溢到 tier2。
- **OUT 确认**：resolver 4 层优先级不变；memory/skill 三层存储模型与目录布局不变；budget_truncate 接线不动；academy classroom group ws 不新建；UI 手动新建 scope 交互后续版本。
- **风险点**：① 存量 prompt cache——agent_profile d) 段 + skills catalog 顺序变化使 stable 段文本变化，cache 前缀失效一次（可接受）；② T1 拿到 write/edit 后改 AGENTS.md 的质量依赖 prompt 红线约束力（本版红线为指令层，PRD 已声明）；③ squad 场景 skill 写 group 与 workspace 同址——resolver 同址双扫幂等已有约定，不新增代码路径。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
