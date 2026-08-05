# v0.0.232 变更计划书 — AGENTS.md 注入机制透明化 + 团队 workspace 简化

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 决策基线：PRD `specs/prd/overall/13-agent-definition.md` + `specs/prd/version_logs/v0.0.232/change_log.md`（D1-D8）。
> **存量零迁移（老板拍板）**：本表不含任何数据迁移/清理行；只改新建 session 的新逻辑，旧 `workspaces/{memberId}/` 目录平台不碰。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁模糊描述） |
| 约束 | MUST / MUST NOT |
| 参考 | 依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

### A. squad ws 分配（删个人 ws，仅新建逻辑）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad | app/server/src/services/squad-service.ts | createSquadService() | 修改 | L155 `leaderWorkspaceDir` 从 `join(squadRootDir(...),'workspaces',leaderMemberId)` 改为 `squadRootDir(dataDir, squadId)`；L248 `ensureSquadDirSkeleton` 调用不再传 leaderMemberId | MUST NOT 再创建/引用 `workspaces/{memberId}`；群聊 session 本已指 squadRootDir 不动 | PRD §13.2.3；squad/[P1]squad_workspace.md §5 | +2/-3 |
| squad | app/server/src/services/member-service.ts | createMemberService() | 修改 | L214 `workspaceDir` 改为 `squadRootDir(dataDir, input.squadId)`；删 L265 `ensureMemberWorkspaceDir(...)` 调用及 import | 同上；mate 与 leader 同指团队根 | 同上 | +1/-4 |
| squad | app/server/src/services/member-service.ts | createMemberService() derive_academy 分支 | 修改 | L270-290 seed 调用入参从「member workspace 目录」改为「squad 根 + 个人差异文件名」；失败补偿从「rm workspace 目录」改为「删已写入的 .rocky/agents 文件 + 清理复制的 skills/memory 项」 | 失败补偿 MUST NOT rm 整个 squads/{sid}（团队目录有其他成员数据） | academy/[P1]squad_derive.md §2.4 | +8/-6 |
| squad | app/server/src/services/member-academy-bridge.ts | seedMemberWorkspaceFromVersion() | 修改 | 落点重映射：源 AGENTS.md → `{squadRoot}/.rocky/agents/{memberName}-{memberId}.md`（个人差异文件）；源 `.rocky/skills/**` → `{squadRoot}/.rocky/skills/`（团队层）；源 `.rocky/memory/**` → `{squadRoot}/.rocky/memory/`（团队层）；入参 `targetWorkspaceDir` 改为 `{ squadRoot, memberName, memberId }` | 源缺失仍静默跳过；同名覆盖语义不变；MUST NOT 写 squads 根外路径 | 同上 + PRD §13.2.2/§13.2.3 | +12/-8 |
| squad | app/server/src/stores/squad-store.ts | ensureSquadDirSkeleton() | 修改 | 删 `leaderMemberId?` 参数 + 删 L198-204 `mkdir workspaces/{leaderMemberId}` 分支；subdirs 增 `.rocky/agents`（空目录占位，引导用户放个人差异文件） | 签名变更→两 caller（squad-service L248 + 既有测试）同步 | squad/[P1]squad_workspace.md §1 | +2/-10 |
| squad | app/server/src/stores/squad-store.ts | ensureMemberWorkspaceDir() | 删除 | 整函数删（L208-216；唯一 caller member-service 已删）——hire member 不再建个人 ws | 死代码零遗留（原则#2） | PRD §13.2.3 | -9 |

### B. AGENTS.md 两级读取（context_files）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| context | app/server/src/prompts/handlers/context-files-handler.ts | ContextFilesHandler.build() | 修改 | `PromptHandlerContext` 扩展可选 `personalContextFile?: string`（绝对路径）；主文件（cwd 候选 AGENTS.md→CLAUDE.md，不变）与个人文件各自独立读取/截断/标注，拼接 = 团队段在前、个人段在后（两段各带「来自…：{绝对路径}」来源标注）；两份都不存在 → 返空 content | 个人段截断用 MAX_PERSONAL_FILE_CHARS；MUST NOT 注入空壳段（文件不存在/空 → 该段省略） | context/[P0]prompt_content_files.md §7.7；PRD §13.2.2 | +30/-4 |
| context | 同上 | MAX_PERSONAL_FILE_CHARS | 新增 | 常量 = 8000（个人差异文件截断上限；团队主文件保持 MAX_FILE_CHARS=20000，两级合计 ≤28000 与 memory_session 在 floor 40000 内共存） | — | context/[P0]system_prompt.md §7 | +2 |
| context | 同上 | readPersonalFile() | 新增 | 私有方法：existsSync + 非空 + 8000 截断（超加 `…[context file truncated by context_files handler]`）→ `{name, content} \| null`（复用 readFirst 同模式） | 读失败 → null（不抛） | 同上 | +18 |
| context | app/plugins/builtins/rocky_context/prompt/context_files.ts | ContextFilesMapper.map() | 修改 | studio leader/mate 且 memberId 存在时：调 findPersonalAgentsFile(cwd, memberId) 后缀扫描，命中 → 传 `personalContextFile` 给 handler.build({cwd, personalContextFile}) | 无 cwd / 非 studio leader·mate / 无 memberId → 维持现状单份读取（academy/playground 不回归） | context/[P1]agent_profile.md §4 | +14/-2 |
| context | 同上 | findPersonalAgentsFile() | 新增 | 纯函数 helper：扫 `{cwd}/.rocky/agents/` 下 `*-{memberId}.md` 后缀匹配（readdirSync，目录不存在 → null），命中返回绝对路径 | 后缀锚 = memberId（ULID 不变量，防 member 改名断链）；目录不存在/读失败 → null | 同上 | +16 |

### C. agent_profile mapper（「定义你的 agent」section，本版本核心）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| context | app/plugins/builtins/rocky_context/prompt/agent_profile.ts | AgentProfileMapper | 新增 | `class AgentProfileMapper extends ContextImplBase implements SystemPromptMapper`（default export）；map(ctx) 读 `config.kind`/`sessionContext`/`studioContext`/`workdir`/`dataDir` → renderAgentProfile → 返 `[{id:'agent_profile', tier:'stable', priority:480, content}]`；未覆盖 kind（subagent/coach/head_teacher/summary/consolidate）→ 返 `[]` | MUST 单 mapper 按 kind 分支（铁律，禁每 kind 一模板文件）；MUST NOT 抛错（任何依赖缺失降级返 []） | context/[P1]agent_profile.md §2；PRD §13.2.1 | +40 |
| context | 同上 | renderAgentProfile() | 新增 | 纯函数：入参 {kind 分支标签, a 行路径+配置状态, b scope 列表, c 层列表} → section 文本（PRD §13.2.1 模板骨架）；a) 条路径行恒渲染标「已配置｜未配置·可选」 | 文案骨架一份，kind 差异只是数据；c) 条 squad 合并「团队」一行；builtin 层不渲染绝对路径 | context/[P1]agent_profile.md §3/§4 | +60 |
| context | 同上 | resolveAgentProfileInput() | 新增 | 纯函数：从 ctx.config 算 kind 分支 + 各路径（团队/个人/课程 AGENTS.md、skills 层、memory scope 列表）+ 存在性（existsSync 团队/个人/课程文件；个人按 `*-{memberId}.md` 后缀扫描，复用 context_files 的 findPersonalAgentsFile 逻辑——抽共享 helper 或各自实现，coder 定位） | squad leader/mate 个人文件名 = `{member.name}-{memberId}.md`（member.name 经 studioContext.member 取，缺失回退 session title）；academy/playground 仅 `{workdir}/AGENTS.md` 一行 | context/[P1]agent_profile.md §4/§5 | +50 |
| context | app/plugins/builtins/rocky_context/plugin.json | extImpls（agent_profile 条目） | 修改 | 注册 `{implId:'agent_profile', point:'system_prompt_mapper', impl:'./prompt/agent_profile.ts'}`，位置在 skills 条目之后 | 一 implId 一文件一 default export（builtin-loader 约定） | context/[P0]extension point and implementations.md §3.4 | +6 |
| config | app/plugins/scopes/default.yaml | system_prompt_mapper impls | 修改 | skills 之后、context_files 之前插 `agent_profile`（studio-leader/mate/squad 经 extends default 继承） | 位置即顺序（ordered EP） | context/[P1]agent_profile.md §1 | +1 |
| config | app/plugins/scopes/playground-rocky.parent.main.yaml | system_prompt_mapper impls | 修改 | 同位插 `agent_profile`（覆写链不继承 default，须显式加） | MUST NOT 加到 subagent/summary/consolidate scope | 同上 | +1 |
| config | app/plugins/scopes/academy-student.parent.main.yaml | system_prompt_mapper impls | 修改 | 同位插 `agent_profile`（academy-coach/head_teacher 不加） | 同上 | 同上 | +1 |
| i18n | app/web/src/i18n/locales/zh-CN/plugin-config.json | plugin.builtin.rocky_context.impl.agent_profile | 新增 | `{description: '「定义你的 agent」section（AGENTS.md/memory/skills 路径说明）'}` | MUST 两语言都加（i18n-key-add-checklist：缺 key 渲染成【资源X不存在】） | i18n 惯例 | +3 |
| i18n | app/web/src/i18n/locales/en/plugin-config.json | 同上 | 新增 | `{description: 'Agent self-definition section (AGENTS.md/memory/skills paths)'}` | 同上 | 同上 | +3 |

### D. skills L0 来源层标注

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| context | app/plugins/builtins/rocky_context/prompt/skills.ts | SkillRow | 修改 | interface 加 `scope: string`（底层 SkillScope 原值 builtin/app/workspace/group） | — | skills/[P0]skill_definition.md §3 | +2 |
| context | 同上 | readSkillEntries() | 修改 | 读 `e.scope`（string 才收，缺省回退 'app'）入 row | scope 恒由 resolver 盖章（parseSkillDir 必传 scope 参数），回退值实际不可达纯防御；MUST NOT 改 selectSkillsByQuota 分组语义（deriveGroup 三分组照旧用于配额） | 同上 | +4 |
| context | 同上 | SkillsMapper.map() | 修改 | L66 行格式：`- {name} [evolvable={bool}] [scope={scope}]: {description}` | 格式只加 [scope=...] 一段，其余逐字不变；路径不逐行重复 | PRD §13.2.4；skills/[P0]skill_definition.md §3 | +2/-1 |

### E. budget_truncate 截断标注

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| context | app/plugins/builtins/rocky_context/prompt/budget_truncate.ts | BudgetTruncateReducer.reduce() | 修改 | 收集全部被丢 dynamic fragment id（第一个放不下的 + break 之后全部剩余），tailNote content 改为 `…[dynamic context truncated by budget_truncate reducer; dropped: {id1, id2, ...}]`；未触发截断不追加（现状不变） | MUST 列全（含 break 后剩余，不是只列第一个）；id 列表为空时保持原 TRUNCATE_NOTE；floor=40000 已在 dev1 落地（merge 带入，本行不动参数） | context/[P0]system_prompt.md §3；PRD §13.2.2「截断可见性」 | +10/-2 |

### F. memory session/group 同址去重

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| context | app/plugins/builtins/rocky_context/prompt/memory.ts | readMemorySources() | 修改 | `workdir === groupWs`（路径字符串相等）时跳过 session 源（session=[]）——同址目录只经 group 源读一次，memory_session mapper 空贡献不产 fragment | MUST NOT 改写侧 resolveScopeDir / query.ts（自然同址无重复池化）；存量旧 session（workdir≠groupWs）行为不变 | memory/[P0]memory_injection.md §2.3 | +5 |

### G. squad prompt 文案单盘化（删「个人盘→团队盘搬运交付」模型）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad | app/server/src/prompts/content/squad/leader.md | 「团队和个人工作目录结构与维护」section（L68-150） | 修改 | 双盘模型重写为单盘：开头改「你的工作目录就是团队盘 squads/{squadId}/，直接在团队盘干活」；删「个人盘 workspaces/{memberId}/」结构树、「交付=个人盘→团队盘」搬运段、「个人盘 vs 团队盘分工」表、双盘同步命令；outputs/reports 结构与命名/版本/frontmatter 规范保留；交付语义改「成果直接落 outputs/ 对应目录（在位演进 v1→v2，旧版 _history/）」；个人日记落 `outputs/diary/{我的名字}/` | MUST 保留 outputs/tasks/{T-id} 子结构节与 OKF 命名/版本/frontmatter 规范；MUST NOT 再出现 workspaces/{memberId}/个人盘 | PRD §13.2.3；squad/[P1]squad_workspace.md §1 | +35/-45 |
| squad | app/server/src/prompts/content/squad/mate.md | 同名 section（L68-150） | 修改 | 同 leader.md 的重写（mate 视角：认领→在团队盘干活→成果落 outputs/ + reports/tasks/{id}.md） | 同上 | 同上 | +35/-45 |
| squad | app/plugins/builtins/skills/teamwork-leader/SKILL.md | 可见性/工作目录相关行（L123 等） | 修改 | 「所有 workspaces/{memberId}/」行改为团队根语义（leader 全队可见范围=团队根）；删个人工位表述 | 只改 ws 相关行，不重写 skill 其余部分 | 同上 | +6/-6 |
| squad | app/plugins/builtins/skills/teamwork-mate/SKILL.md | workspaces/{self} 相关行（L17/33/105/146-153） | 修改 | 「在 workspaces/{self}/ 写产物」改为「在团队盘干活，产出落 outputs/{self.name}/ 前缀」；可见性矩阵行去个人工位；L160 `outputs/` owner 前缀约定保留（本来就是团队盘约定） | 同上；MUST NOT 动 okf-skill（无个人 ws 引用） | 同上 | +10/-10 |

### H. 测试（UT）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test | app/plugins/builtins/rocky_context/__tests__/agent_profile.test.ts | 全文件 | 新增 | 5 kind 渲染 UT（squad leader/mate 双行+状态标注、squad 群聊仅团队行、academy 仅课程行、playground 仅个人行）；未覆盖 kind 返 []；依赖缺失降级 | 纯函数注入 fake ctx，不真读盘（存在性检测可注临时目录） | context/[P1]agent_profile.md §4 | +120 |
| test | app/plugins/builtins/rocky_context/__tests__/prompt-mappers-reducers.test.ts | context_files / skills / budget_truncate describe | 修改 | context_files 加两级读取 case（团队+个人叠加、仅团队、都不存在返空）；skills 加 [scope=...] 断言；budget_truncate 加 dropped id 列表断言 | 同文件既有结构内扩 | 对应 spec 节 | +60/-10 |
| test | app/plugins/builtins/rocky_context/__tests__/memory-injection-l0.test.ts | readMemorySources 相关 | 修改 | 加同址去重 case（workdir==groupWs → session 源空、group 单份注入） | — | memory/[P0]memory_injection.md §2.3 | +25 |
| test | app/server/src/services/__tests__/squad-service.test.ts | workspaceDir 断言 | 修改 | leader session workspaceDir 断言改 `squads/{sid}`（去 workspaces/{leaderMemberId}） | — | PRD §13.5.7 | +3/-3 |
| test | app/server/src/services/__tests__/member-service.test.ts | workspaceDir 断言 | 修改 | mate session workspaceDir 断言改 `squads/{sid}`；删 ensureMemberWorkspaceDir 相关断言 | — | 同上 | +3/-5 |
| test | app/server/src/services/__tests__/member-service-academy.test.ts | derive_academy seed 断言 | 修改 | seed 落点断言改 `.rocky/agents/{name}-{id}.md` + 团队 skills/memory | — | A 节 | +8/-8 |
| test | app/server/src/stores/__tests__/squad-store.test.ts | ensureSquadDirSkeleton 断言 | 修改 | 删 leaderMemberId 参数与 workspaces 目录断言；加 `.rocky/agents` 骨架断言 | — | squad/[P1]squad_workspace.md §1 | +3/-4 |

## 影响面评估

- **跨模块**：squad（ws 分配 + 文案）+ context（prompt 组装链 5 个文件）+ config（3 个 scope yaml）+ i18n（2 个 json）+ memory（1 个文件）。无 protocol/plugin-sdk 契约变更，无 API 端点变更，无 DB schema 变更。
- **破坏性变更**：行为级——新建 squad session 的 workspaceDir 改变（存量 session 不动）；squad prompt 文案模型改变（双盘→单盘）；skills L0 文本格式变化（加 [scope=]）。均为本版本目标行为。
- **依赖顺序**：A（ws 分配）与 B/C/D/E/F（prompt 链）互不阻塞可并行；G（文案）独立；H 随各模块。
- **风险点**：① derive_academy seed 落点重映射（A3/A4）——补偿逻辑必须只删自己写入的文件，不能 rm 团队目录；② memory 同址去重（F1）——路径字符串相等判定（两边都经 squadRootDir/resolveGroupWsDir 同一 helper 产出，无 trailing slash 分歧；coder 验证）；③ per-session watcher（v0.0.17）监听面从个人工位扩大到团队根——功能正确（UI 文件面板即团队盘视图，PRD UC-10 所要），事件噪声可接受，本版本不改；④ squad_workspace reminder 与 workspace reminder 对 squad session 注入同一路径（冗余不矛盾），留作 follow-up 候选，本版本不动。
- **前端零改动（已实证）**：grep app/web/src + app/electron/src 无 `workspaces` 硬编码；UI 全部跟随 session.workspaceDir + SSE 通用渲染；AGENTS.md 相关前端引用仅 academy-page（本版本不动 academy）。
- **dev1 合流注意**：`budget_truncate.ts` floor=40000 在 dev1 已落地（commit 25ab91f8），merge 时带入；本表 E1 行只做标注增强、不动参数，merge 冲突风险低（同文件不同区域）。

## 待实证 3 项的架构结论（PRD version_log §5）

1. **leader ws id 错位（...V8 vs ...V9）**：非 bug。squad-service 连续生成 `leaderMemberId`(ulid) 与 `leaderSessionId`(ulid)，workspace 目录按 **memberId** 命名（`workspaces/{leaderMemberId}`=...V8），session id=...V9——调研把 sessionId 当目录名比对致误。本版本 workspaceDir=squads/{sid} 后该困惑整体消解。
2. **budget floor 挤掉 memory_session**：floor=40000（dev1 已落地）+ 个人差异文件 cap 8000 → 两级 AGENTS.md ≤28000 + memory_session L0（通常 <2000 char）在 40000 内共存。**不做**「最后 fragment 部分保留」机制（复杂化且无必要）；可溯源性由 E1 截断标注（dropped id 列表）承担。
3. **squad UI 旧个人 ws 引用**：grep 实证前端零 `workspaces` 硬编码，无排查项遗留。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
