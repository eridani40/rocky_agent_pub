# Agent 定义与注入透明化 — 产品需求文档 [v0.0.232]

> version: 1.0 · 引入版本 v0.0.232 · 最后更新：2026-08-01
> 本文承载「agent 自我定义说明 + prompt 注入透明化 + 团队 workspace 简化」全量产品定义。增量见 `specs/prd/version_logs/v0.0.232/change_log.md`。
> 概念权威源（本 PRD 已读对齐）：`specs/tech/agent/`（prompt 组装链：system_prompt_mapper EP / context_files / skills / budget_truncate）+ `specs/tech/squad/[P1]squad_workspace.md` + `specs/prd/overall/09-memory.md`（memory scope = global/group/session）+ `specs/prd/overall/06-skill.md`（skills 4 层 resolver：builtin/app/workspace/group）+ `specs/research/prompt-assembly-chain/research-prompt-assembly-chain.2026-08-01.v1.md`（链路实测）。

## 目录

| 章节 | 说明 |
|------|------|
| §13.1 产品概述 | 背景（.claude 迁移一头雾水 + 实测现象）、定位、目标与非目标 |
| §13.2 功能需求 | 4 个功能：「定义你的 agent」section / AGENTS.md 分层注入 / 团队 workspace 简化 / 来源标注与兜底 |
| §13.3 关键用户路径（MANDATORY） | 8 条核心路径（测试最低覆盖） |
| §13.4 范围边界（IN / OUT） | v0.0.232 scope |
| §13.5 验收标准 | 可验证口径 |
| §13.6 概念落 spec 情况 | architect 已全部落地（新概念 → tech spec 映射 + UI 排查结论） |

---

## 13.1 产品概述

### 13.1.1 背景与问题 [v0.0.232]

用户把一份 Claude Code 的 `.claude/` 配置迁移到 rocky_agent 团队时，**agent 完全不知道自己的定义机制**：个人/团队 AGENTS.md 在哪、memory 怎么管、skills 有几层——「完全一头雾水」。本次配置被纠正 3 次的根因即此。非团队（playground）场景同理。

实测现象（2026-08-01 老板实测 + 调研报告）：

1. AGENTS.md **实际已注入** squad leader 的 system prompt，但排在**最末尾**（context tier 在 stable tier 之后），且注入的是旧「个人 ws」路径（`workspaces/{memberId}/AGENTS.md`）——位置靠后 + 路径语义与「团队」不符。
2. prompt 里各片段**没有来源标注**：skills 只分 system/user/agent 三组，4 层来源（builtin/app/workspace/group）被压缩，出问题无法溯源。
3. 残留断链：3 个 mate 的 `workspaces/{memberId}/AGENTS.md` 缺失；leader 的 session.workspaceDir id 疑似错位（`...V8` vs `...V9`，待架构实证）。
4. 个人 ws 模式（每 member 一个 `workspaces/{memberId}/`）导致「在一个 mate 聊天，很难找到团队 ws 文件」。

### 13.1.2 定位 [v0.0.232]

让每个 session 的 agent **自我可定义、机制可说明、注入可溯源**：

- system prompt 新增「定义你的 agent」section——agent 一读就知道自己的 AGENTS.md（团队/个人）在哪、memory 用什么工具管、skills 有哪几层。
- 团队配置简化为「一个团队 ws + 分层文件」：团队 AGENTS.md / 团队 skills / 团队级 memory 都落在 `squads/{squadId}/` 下，用户「把 .claude 扔过去即可快速配置」。

### 13.1.3 目标与非目标

**目标（IN）**：① 全 session kind 注入「定义你的 agent」section（squad leader/mate/群聊、academy 学员、playground 个人）；② 团队 workspace 简化（删个人 ws，全队共用 `squads/{squadId}/`）；③ AGENTS.md 团队+个人两级注入；④ 注入来源标注 + 未配置兜底。
**非目标（OUT）**：不改 CLAUDE.md 候选读取顺序；不改 skills resolver 4 层优先级语义；不改 memory scope（global/group/session）语义；不做专门的「agent 配置 UI 页面」（配置载体 = 文件 + 现有 memory/skill UI）；不做存量个人 ws 数据的自动迁移（用户手动合并，平台不跑破坏性迁移）。

---

## 13.2 功能需求

### 13.2.1 「定义你的 agent」section（agent_profile）[v0.0.232]

**描述**：system prompt 新增一个 section「定义你的 agent」，含三条权威说明：a) system prompt（个人/团队 AGENTS.md 路径 + 叠加关系）；b) memories（memory / memory_manage 工具管理）；c) skills（位置 + 层级）。**所有 session kind 都注入**。
**优先级**：P0（本版本核心交付）
**用户故事**：作为 agent（任何 session kind），我希望 system prompt 里有一段明确告诉我「我的定义文件在哪、记忆怎么管、技能有几层」，以便我知道如何定义和进化自己，而不是对用户给的配置一头雾水。

#### 统一 mapper + 按 kind 动态渲染（铁律）

- **代码层只有 1 个 mapper**（暂名 `agent_profile`），挂进现有 `system_prompt_mapper` 链（位于 identity 之后、context_files 之前，属 stable tier——**永不被 budget_truncate 裁掉**）。mapper 内部按 `session.kind` + workspaceDir + squad 上下文**分支计算路径**并渲染 a/b/c。**禁止拆成每个 session kind 一份写死的模板文件**。
- **配置层**：各 kind 的 scope yaml 决定该 mapper 在不在自己的 impls 列表上（与现有 academy/playground 覆写 impls 同一机制）。主 session（parent:main）全部必须挂；subagent / summary / consolidate 等辅助 runKind 默认不挂（保持 prompt 精简），是否挂由对应 scope yaml 决定。
- 「每个 kind 一份」只体现在**渲染结果**不同，不体现在模板文件有多份。

#### section 模板结构（统一骨架，行为 kind 分支）

```
# 定义你的 agent

你可以通过以下方式定义和进化自己：

## a) System Prompt（AGENTS.md）
- {团队 AGENTS.md 行 — 仅 squad 类 kind 渲染}：squads/{squadId}/AGENTS.md（已配置｜未配置·可选）——全队共享的角色与规则，对全员注入
- {个人 AGENTS.md 行 — squad leader/mate 渲染}：squads/{squadId}/.rocky/agents/{名字}-{id}.md（已配置｜未配置·可选）——你的差异化定义，叠加在团队定义之上
- {课程 AGENTS.md 行 — 仅 academy-student 渲染}：academy/{cid}/students/{sid}/versions/{label}/ws/AGENTS.md（已配置｜未配置）
- {个人 AGENTS.md 行 — 仅 playground 渲染}：{workspaceDir}/AGENTS.md（已配置｜未配置·可选）
正文注入见本 prompt 的「Project Context」片段（团队在前、个人在后，叠加生效）。

## b) Memories（长期记忆）
用 memory / memory_manage 工具管理（search/read + 增改归档）。可用 scope：{按 kind 渲染}。
已注入条目见「Memories」片段（name+intro，正文按需 memory.read）。

## c) Skills（技能）
你的 skills 来自 {N} 个位置（高层覆盖低层同名）：
{按 kind 渲染实际生效的层，每层一行：层名 + 路径}
已注入清单见「Skills」片段（每条带来源层标注；正文按需 skill.read）。
```

#### 各 session kind 渲染规则（a/b/c 路径表）

| session kind | a) AGENTS.md 行 | b) memory scope | c) skills 层（高→低） |
|---|---|---|---|
| squad leader（studio-leader） | 团队 `squads/{sid}/AGENTS.md` + 个人 `squads/{sid}/.rocky/agents/{名字}-{id}.md`（可选） | session / **group（团队级，全队共享）** / global | 团队 `squads/{sid}/.rocky/skills/` → app `<dataDir>/skills/` → builtin |
| squad mate（studio-mate） | 同 leader | 同 leader | 同 leader |
| squad 群聊（studio-squad） | 仅团队行（无个人行） | 同 leader | 同 leader |
| academy 学员（academy-student） | 仅课程行 `versions/{label}/ws/AGENTS.md`（无团队/个人行） | 按现有 memory scope 机制，本版本不变 | 按 academy scope 现状渲染，本版本不变 |
| playground 个人（playground-rocky） | 仅个人行 `{workspaceDir}/AGENTS.md`（无团队行） | session / global | workspace `{ws}/.rocky/skills/` → app → builtin（无 group 层） |

- **c) 条渲染通则**：列出该 kind **实际生效且路径去重后**的层；squad 类因 workspace 层与 group 层同址（简化后都是 `squads/{sid}/.rocky/skills/`），合并渲染为一行「团队」。
- **b) 条与「memory 只留团队级」拍板的关系**：squad 场景不再有「个人 ws 级」memory 概念，团队共享记忆落 group scope；session/global 为机制层，不变。
- **未配置兜底**：a) 条的路径行**恒渲染**并标注状态（已配置｜未配置·可选）——这是温和的中性状态说明，非错误提示；agent 据此知道「这里可以配置但还没配，按默认行为走」。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 新建 squad mate session → 查看其 system prompt | 含「定义你的 agent」section；a 条含团队行（`squads/{sid}/AGENTS.md`）+ 个人行（`.rocky/agents/{名字}-{id}.md`）；b 条说明 memory/memory_manage；c 条列 3 层 skills 位置 |
| UC-2 | 新建 playground session → 查看 system prompt | section 只含个人 AGENTS.md 行（无团队行）；c 条无 group/团队层 |
| UC-3 | 新建 academy 学员 session → 查看 system prompt | section 只含课程 AGENTS.md 行（`versions/{label}/ws/AGENTS.md`），无团队行 |
| UC-4 | 团队 AGENTS.md 不存在时新建 squad session | a 条团队行标注「未配置·可选」，无错误提示，prompt 其余部分正常 |

### 13.2.2 AGENTS.md 分层注入（团队 + 个人两级）[v0.0.232]

**描述**：squad session 的 AGENTS.md 正文注入升级为两级：**团队 AGENTS.md（`squads/{sid}/AGENTS.md`）对全员注入**；**个人差异文件（`squads/{sid}/.rocky/agents/{名字}-{id}.md`）按需存在**，存在则叠加注入（团队在前、个人在后）。academy 学员维持课程级单份注入（`versions/{label}/ws/AGENTS.md`，现有机制不回归）；playground 维持个人 ws 单份注入。
**优先级**：P0
**用户故事**：作为团队配置者，我希望团队规则写一份（团队 AGENTS.md）全队生效、个别 mate 的差异化定义单独写一份小文件，以便配置既统一又有个人粒度。

#### 功能交互细节

- **读取规则显式化**：每个 session 启动时，按 kind 明确读取上述路径表中的 1~2 份文件（替代「隐式读 cwd 下 AGENTS.md/CLAUDE.md 候选」的单一语义；CLAUDE.md 候选行为不变）。squad session 因 workspaceDir 已指向 `squads/{sid}/`（§13.2.3），团队文件即 cwd 的 AGENTS.md，个人文件为其 `.rocky/agents/` 下的对应文件。
- **叠加关系**：个人文件正文注入排在团队文件之后，语义为「个人叠加团队」；两份各自带来源标注（§13.2.4）。
- **断链消解**：实测残留的 3 个 mate 缺 AGENTS.md、leader ws id 疑似错位问题，随「删个人 ws」整体消解（不再有 per-member ws 路径）；修到「团队 ws 里有 AGENTS.md → 全员 prompt 里就有」。
- **正文截断可见性**：AGENTS.md 正文片段（context tier）若被 budget_truncate 截断/丢弃，截断标记必须注明被丢弃的 fragment，不得静默（产品口径；具体 tier/priority/budget 参数调整交架构）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-5 | 在 `squads/{sid}/AGENTS.md` 写入团队规则 → 新建 leader + 1 个 mate session | 两人 prompt 均含该正文（Project Context 片段），且带来源路径标注 |
| UC-6 | 给某 mate 建 `.rocky/agents/{名字}-{id}.md` → 新建其 session | prompt 同时含团队 + 个人两份正文，团队在前、个人在后，分别标注来源 |
| UC-7 | 修改团队 AGENTS.md 内容 → 新建 session | 新 session 的 prompt 可见更新后内容 |
| UC-8 | academy 学员 session 启动 | 课程 AGENTS.md 注入行为与上一版本一致（不回归） |

### 13.2.3 团队 workspace 简化（删个人 ws）[v0.0.232]

**描述**：squad 全部 session（leader/mate/群聊）的 workspaceDir 统一指向**团队 workspace `squads/{squadId}/`**；删除所有创建/引用个人 ws（`workspaces/{memberId}`）的地方。团队 skills 保持在 `squads/{sid}/.rocky/skills/`；memory 只留团队级（group scope）。
**优先级**：P0
**用户故事**：作为团队成员，我在任何一个 mate 会话里操作文件，都落在团队 workspace 里，以便不再「在一个 mate 聊天，很难找到团队 ws 文件」；作为配置者，我把 .claude 目录扔进团队 ws 即可快速完成配置。

#### 功能交互细节

- **统一指向**：新建 squad session 的 workspaceDir 一律 = `squads/{squadId}/`；不再创建 `workspaces/{memberId}/` 目录。
- **分层配置布局**（团队 ws 内）：
  - 团队 AGENTS.md：`squads/{sid}/AGENTS.md`（全员注入）
  - 个人差异：`squads/{sid}/.rocky/agents/{名字}-{id}.md`（按需存在，非每 mate 必有）
  - 团队 skills：`squads/{sid}/.rocky/skills/`
  - 团队级 memory：group scope（机制不变，语义 = 本团队共享）
- **存量数据**：平台不做自动迁移/清理（防破坏性运行时迁移）；用户自行把旧个人 ws 内容合并进团队 ws，agent_profile 的 a) 条路径说明即迁移引导。
- **academy / playground 不受影响**：academy 学员 ws（`versions/{label}/ws/`）、playground 个人 ws 维持现状。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-9 | 新建 squad leader/mate session → 在会话里写文件 | 文件落在 `squads/{sid}/` 下；不再出现 `workspaces/{memberId}/` 新目录 |
| UC-10 | mate 会话中查看/定位团队文件 | 工作目录即团队 ws，团队文件可直接访问（解决找文件难） |

### 13.2.4 注入来源标注 + 未配置兜底 [v0.0.232]

**描述**：注入 prompt 的关键片段带来源标注，让 agent/用户一眼溯源：AGENTS.md 片段标注来源文件路径（团队/个人分别标注）；skills 清单每条标注来源层（builtin/app/workspace/group）；AGENTS.md 未配置时给温和兜底说明。
**优先级**：P1（兜底文案 P2）
**用户故事**：作为配置者，当注入内容不符合预期时，我希望每段内容都标了来源，以便直接定位到该改哪个文件，而不是靠猜。

#### 功能交互细节

- **AGENTS.md 片段**：保留现有「来自本会话工作目录：{绝对路径}」标注样式；团队/个人两份分别标注各自路径。
- **skills 片段**：L0 清单每条增加来源层标注（4 层：builtin/app/workspace/group）；路径不在每行重复（路径说明统一由「定义你的 agent」c) 条承担），避免清单冗长。resolver 4 层优先级语义不变。
- **兜底口径**：兜底由 agent_profile 的 a) 条「未配置·可选」状态行承担（恒渲染）；AGENTS.md 正文片段在文件不存在时保持不注入（不注入空壳片段），避免重复说明。
- **其他内置片段**（identity/rules/tool_guidance 等平台内置 mapper）：来源天然明确，本版本不逐一标注。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-11 | squad session prompt 查看 skills 清单 | 每条 skill 带来源层标注（如团队/app/builtin） |
| UC-12 | 团队 AGENTS.md 缺失的 squad session | prompt 无 Project Context 空壳片段，a) 条团队行标「未配置·可选」 |

---

## 13.3 关键用户路径（MANDATORY — 测试最低覆盖）

1. **新 mate 加入 squad → 启动 session**：system prompt 含「定义你的 agent」section，a 条含团队 + 个人两行路径；团队 AGENTS.md 正文注入且带来源标注。（UC-1/5）
2. **squad leader 启动 session**：同路径 1（leader 与 mate 同机制）。（UC-5）
3. **配置个人差异文件 → mate 新 session**：团队 + 个人两份正文叠加注入、分别标注。（UC-6）
4. **团队 AGENTS.md 未配置 → 新 session**：a) 条标「未配置·可选」，无错误，其余正常。（UC-4/12）
5. **academy 学员启动**：section 只含课程 AGENTS.md 行；课程注入不回归。（UC-3/8）
6. **playground 个人 session**：section 只含个人行，无团队行/无 group skills 层。（UC-2）
7. **修改团队 AGENTS.md → 新 session**：新 session 可见更新。（UC-7）
8. **mate 会话内文件操作落团队 ws**：workspaceDir = `squads/{sid}/`，解决找文件难。（UC-9/10）

## 13.4 范围边界

**IN（v0.0.232）**：agent_profile section 全 kind 注入；squad 团队+个人两级 AGENTS.md 注入；删个人 ws、团队 ws 共用；skills 来源层标注；未配置兜底文案；注入断链消解。
**OUT**：不改 CLAUDE.md 候选顺序；不改 skills resolver 优先级语义；不改 memory scope 语义；不做 agent 配置专用 UI 页面；不做存量个人 ws 自动迁移；subagent/summary/consolidate 的 section 挂载保持默认不挂（scope yaml 机制保留）；budget_truncate 的参数调优（floor/fraction）由架构决策，不属产品需求。

## 13.5 验收标准

1. squad leader + 至少 1 个 mate 的 system prompt（经 `GET /session/:id/debug/system-prompt` 验证）含「定义你的 agent」section + 团队 AGENTS.md 正文 + 来源路径标注。
2. 个人差异文件场景：配置了 `.rocky/agents/{名字}-{id}.md` 的 mate，prompt 含团队+个人两份、团队在前。
3. academy 学员 prompt：section 仅课程行，课程 AGENTS.md 注入不回归。
4. playground session prompt：section 仅个人行，无团队行。
5. 未配置场景：团队 AGENTS.md 缺失时 a) 条标「未配置·可选」，无错误提示。
6. 改团队 AGENTS.md → 新 session 可见更新。
7. 新建 squad session 的 workspaceDir = `squads/{sid}/`；不再新建 `workspaces/{memberId}/`。
8. skills 清单每条带来源层标注。

## 13.6 概念落 spec 情况（architect 已全部落地）

> v0.0.232 架构阶段全部落 spec 完成。下表新概念均已落对应 tech spec，UI 影响排查结论 = 前端零改动。

| 新概念 | 落 spec 位置 | 状态 |
|---|---|---|
| `agent_profile` mapper | `specs/tech/agent/context/[P1]agent_profile.md`（新建） | ✅ 统一 mapper 按 kind 分支渲染 a/b/c；stable tier priority 480 |
| AGENTS.md 两级读取规则（团队+个人） | `specs/tech/agent/context/[P0]prompt_content_files.md` §7.7 + `[P0]system_prompt.md` §4 | ✅ 按 kind 读 1~2 份、团队在前个人在后叠加、各带来源标注 |
| squad workspace 简化模型 | `specs/tech/squad/[P1]squad_workspace.md` §1/§2/§5 | ✅ 删 `workspaces/{memberId}` 新建；session.workspaceDir 全指向 `squads/{sid}/`；分层布局 |
| skills L0 来源层标注格式 | `specs/tech/agent/skills/[P0]skill_definition.md` §3 | ✅ 每条 `[scope=builtin\|app\|workspace\|group]` |
| budget_truncate 截断标注 | `specs/tech/agent/context/[P0]system_prompt.md` §3 | ✅ 截断标记列出全部被丢 fragment id（`dropped: id1, id2`） |
| UI 影响排查 | grep 实证 app/web/src + app/electron/src | ✅ 前端零 `workspaces` 硬编码；UI 全跟随 session.workspaceDir 通用渲染，无需改 |
