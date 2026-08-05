---
type: spec
title: agent_profile mapper（「定义你的 agent」section）
priority: P1
status: active
updated: 2026-08-02
since: v0.0.232
related: ["[P0]system_prompt.md", "[P0]prompt_content_files.md", "../../squad/[P1]squad_workspace.md"]
---

# agent_profile mapper（「定义你的 agent」section）

> 产品契约：`specs/prd/overall/13-agent-definition.md` §13.2.1（统一 mapper 铁律 + 5 kind a/b/c 路径表）。
> 主文档：`[P0]system_prompt.md`（mapper/reducer 权威）。实现：`app/plugins/builtins/rocky_context/prompt/agent_profile.ts`。

## 1. 概述

**管什么**：system prompt 的「定义你的 agent」section——告诉 agent 三件事：a) 自己的 AGENTS.md（团队/个人/课程）在哪、叠加关系；b) memory 用什么工具管、可用 scope；c) skills 有哪几层、路径分别是什么。让每个 session 的 agent 自我可定义、机制可说明、注入可溯源。

**不管什么**：AGENTS.md 正文注入（→ `context_files` mapper + `ContextFilesHandler` 两级读取，见 `[P0]prompt_content_files.md`）；skills L0 清单本身（→ `skills` mapper）；memory L0 注入（→ `memory_*` mapper）。本 mapper 只产「路径与机制说明」，不产正文内容。

**与外界如何交互**：注册为 `system_prompt_mapper` EP 的 impl（`rocky_context` plugin.json，implId=`agent_profile`）；各 session kind 的 scope yaml 决定它在不在链上（default.yaml 主链 + playground-rocky.parent.main + academy-student.parent.main 挂载；subagent/summary/consolidate/academy-coach/head_teacher scope 不挂）。

## 2. 统一 mapper + 按 kind 动态渲染（铁律）

**代码层只有 1 个 mapper**（`AgentProfileMapper`），内部按 `ctx.config.kind`（biz/role/derivation/runKind）+ `sessionContext`（squadId/memberId/classroomId 等实例 ID）+ `workdir` + `dataDir` 分支计算路径并渲染 a/b/c。**禁止拆成每个 session kind 一份写死的模板文件**——「每个 kind 一份」只体现在渲染结果，不体现在模板文件数量（防漂移）。配置层（scope yaml）决定该 mapper 在不在自己链上，与现有 academy/playground 覆写 impls 同一机制。

- fragment：`{ id: 'agent_profile', tier: 'stable', priority: 480 }`——stable tier（**永不被 budget_truncate 裁掉**）；tier 内按 priority 降序排在 skills(500) 之后、memory_user(450) 之前（即「identity 之后、context_files 之前」的落点）。
- 未知/未覆盖 kind（defensive）：返回 `[]`（不贡献），不抛错（单 mapper 失败降级原则，system_prompt §9.4）。

## 3. section 结构（统一骨架，行为 kind 分支）

```
# 定义你的 agent

你可以通过以下方式定义和进化自己：

## a) System Prompt（AGENTS.md）
- {按 kind 渲染 1~2 条路径行，每条恒渲染并标状态：已配置｜未配置·可选}
正文注入见本 prompt 的「Project Context」片段（团队在前、个人在后，叠加生效）。

## b) Memories（长期记忆）
用 memory / memory_manage 工具管理（search/read + 增改归档）。可用 scope：{按 biz 渲染}。
已注入条目见「Memories」片段（name+intro，正文按需 memory.read）。

## c) Skills（技能）
你的 skills 来自 {N} 个位置（高层覆盖低层同名）：
{按 kind 渲染实际生效且路径去重后的层，每层一行：层名 + 路径}
已注入清单见「Skills」片段（每条带 [scope=...] 来源层标注；正文按需 skill.read）。

## d) 自律治理（质量标准）
写 AGENTS.md / memory / skill 时遵守：
1. 分层归位：AGENTS.md 只写角色定位与规则；业务流水/过程记录/临时状态下沉 memory 或 outputs 文件。
2. 个人只写差异：个人 AGENTS.md 只写与团队定义不同的部分；团队已有的规则不重复抄写。
3. 描述即路由：skill description / memory intro 是路由语言——写「什么时候该用它」，一句话（≤50 字）；写不好路由就失效。
4. 会删比会写重要：定期清理——过时 memory 归档、失效 skill 禁用、AGENTS.md 保持精简；各 scope 有配额上限（session ≤20 / group ≤30 / global ≤50），写满前先把旧的清掉。

scope 规则（按本 session 的 biz 渲染可用层）：
{biz 可用层 + 三层语义 + 必填无默认 + 错误引导；文本来自 biz-scope-rules.renderScopeTableForPrompt(biz)}
```

**状态标注**：a) 条路径行**恒渲染**——文件存在标「已配置」，不存在标「未配置·可选」（温和中性状态，非错误提示；agent 据此知道可配置但还没配）。存在性检测 = `fs.existsSync`（个人差异文件按 `*-{memberId}.md` 后缀扫描 `.rocky/agents/`，见 §4）。

## 4. 各 session kind 渲染规则（a/b/c 路径表）

| session kind | a) AGENTS.md 行 | b) memory scope | c) skills 层（高→低） |
|---|---|---|---|
| studio-leader / studio-mate | ① 团队 `{workdir}/AGENTS.md`（= `squads/{sid}/AGENTS.md`，全员共享）② 个人 `{workdir}/.rocky/agents/{名字}-{memberId}.md`（可选，叠加团队之上） | **group**（团队级，全队共享）/ **global**（squad 场景无 session 层——团队记忆唯一事实源） | 团队 `{workdir}/.rocky/skills/`（workspace 与 group 同址，合并一行）→ app `<dataDir>/skills/` → builtin（随 app 发版，只读） |
| studio-squad（群聊） | 仅团队行（无个人行） | 同 leader | 同 leader |
| academy-student | 仅课程行 `{workdir}/AGENTS.md`（= `academy/{cid}/students/{sid}/versions/{label}/ws/AGENTS.md`） | **session / group / global**（三层都有；group 物理解析仍走 squad-only `resolveGroupWsDir`，academy 无 squadId 时写 group 报 not_in_group） | workspace `{workdir}/.rocky/skills/` → app → builtin（机制不变） |
| playground-rocky | 仅个人行 `{workdir}/AGENTS.md`（无团队行） | session / global | workspace `{workdir}/.rocky/skills/` → app → builtin（无 group 层） |

- **b) memory scope 列表 + d) 段 scope 可用表**：数据来自单源 `biz-scope-rules.ts AVAILABLE_SCOPES_BY_BIZ`（`app/server/src/agent/biz-scope-rules.ts`），不在本 mapper 复制可用表。biz 由 `resolveBizScopeKind(ctx.config)` duck-type 读 `ctx.config.kind.biz`，缺省 `'playground'`。d) 段文本由 `renderScopeTableForPrompt(biz)` 产出（含本 biz 可用层 + 三层语义 + 必填规则 + 配额 20/30/50）。

- **c) 层渲染通则**：只列该 kind 实际生效且路径去重后的层；builtin 层不渲染绝对路径（app 安装目录/asar 内，用户不可操作），只标「内置（随 app 发版）」。
- **个人差异文件定位**：squad leader/mate 的个人行路径 = `{workdir}/.rocky/agents/{member.name}-{memberId}.md`（member.name 经 `ctx.config.studioContext.member` 取；缺失回退 `*-{memberId}.md` 后缀锚引导——SessionConfig 无 title/label 字段可用，memberId（ULID）是不变锚，与已配置检测同一后缀锚防 member 改名断链）。检测已配置时不拼死名字——扫描 `{workdir}/.rocky/agents/` 下 `*-{memberId}.md` 后缀匹配（防 member 改名后断链）；命中即标「已配置」并用实际文件名渲染。
- **subagent / summary / consolidate / academy-coach / academy-head_teacher**：scope yaml 不挂本 mapper（保持 prompt 精简），不渲染。

## 5. 数据来源（PromptCtx 字段）

| 渲染需要 | 来源 |
|---|---|
| kind 分支 | `ctx.config.kind`（SessionKind：biz/role/derivation/runKind） |
| squadId / memberId | `ctx.config.sessionContext`（SessionContext 实例 ID 投影） |
| 团队/课程/个人 AGENTS.md 路径 | `ctx.config.workdir`（= session.workspaceDir；squad 全 kind 指向 `squads/{sid}/`，见 `../../squad/[P1]squad_workspace.md`） |
| app skills 层路径 / 全局 memory | `ctx.config.dataDir` |
| member.name（个人文件名） | `ctx.config.studioContext.member`（MemberRecord） |
| 文件存在性 | `fs.existsSync` / 后缀扫描（mapper 内直读文件系统，与 context_files 同级） |

## 6. 设计决策

1. **统一 mapper 不拆模板（铁律）**：若每 kind 一份模板文件，5+ 份文案必然漂移（改一处漏四处）；单 mapper 内分支渲染，文案骨架一处维护，kind 差异只是数据（路径行/scope 列表）。d) 段 4 条质量标准文案落模块常量 `AGENT_PROFILE_D_STANDARDS`（为满足 `agent_profile.ts` ≤300 行约束提取，非拆模板），仍由同一 `renderAgentProfile` mapper 渲染 a/b/c/d——「一个 mapper 按 kind 渲染」铁律不变。
2. **stable tier 而非 context tier**：本 section 是 agent 的「自我定义机制」，属行为契约级内容，必须与 identity/rules 同级永不被 budget_truncate 裁掉；且内容随 session 创建即固定，cache 友好。
3. **路径行恒渲染 + 状态标注**：「未配置·可选」是引导（用户/agent 据此知道把配置放哪），不是错误；正文片段（context_files）在文件不存在时保持不注入（不注空壳），两处职责不重复。
4. **个人文件后缀扫描而非精确路径**：member 改名后精确路径 `{旧名}-{id}.md` 会静默断链；id（ULID）是不变锚点，后缀匹配鲁棒。渲染「未配置」时引导路径优先用 `{当前名}-{id}.md`（member.name 经 studioContext.member 取），member.name 缺失时回退 `*-{id}.md` 后缀锚（与检测同一锚，SessionConfig 无 title 字段可借用）。
5. **不挂辅助 runKind**：subagent/summary/consolidate 的 prompt 保持精简（它们是短任务执行者，不需要自我定义说明）；scope yaml 机制天然支持（不加入 impls 即不渲染）。

## 7. 边界

| 零件 | 归属 |
|---|---|
| 「定义你的 agent」section 渲染（本 mapper） | 本文 ✅ |
| AGENTS.md 正文两级读取与注入 | `[P0]prompt_content_files.md` §4.1（ContextFilesHandler）+ `[P0]system_prompt.md` §4（context_files mapper） |
| skills L0 清单 + [scope=...] 标注 | `../skills/[P0]skill_definition.md` §3 + `[P0]system_prompt.md` §4（skills mapper） |
| memory 三 mapper 注入 + session/group 同址去重 | `../memory/[P0]memory_injection.md` §2 |
| squad workspace 布局（删个人 ws） | `../../squad/[P1]squad_workspace.md` |
| budget_truncate 截断标注 | `[P0]system_prompt.md` §3 |

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
