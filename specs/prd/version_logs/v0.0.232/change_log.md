# v0.0.232 — AGENTS.md 注入机制透明化 + 团队 workspace 简化

> 类型：prompt 组装层功能新增（用户可感知：agent 自我定义说明）+ squad workspace 模型简化
> 权威 req：`reqs/[working] v0.0.232.agents_md_injection/req.md`（主仓库版）+ 详细需求 v2（`~/.rocky_agent_prod/squads/<squad-id>/outputs/topics/agents-md-injection-mechanism/requirement-agents-md-injection.2026-08-01.v2.md`）
> 调研：`specs/research/prompt-assembly-chain/research-prompt-assembly-chain.2026-08-01.v1.md`（链路全图 + budget_truncate 分析 + 实测定位）
> 全量定义：`specs/prd/overall/13-agent-definition.md`（本版本新增 overall 文件）

## 0. 决策基线（老板已拍板，本 PRD 不推翻）

| # | 决策 | 出处 |
|---|------|------|
| D1 | 「定义你的 agent」section = **1 个 `agent_profile` mapper 按 session.kind 动态渲染 a/b/c**，禁止每 kind 一份死模板；挂 system_prompt_mapper 链（identity 之后、context_files 之前，stable tier） | 老板 09:20 + 协调者补充铁律 |
| D2 | 团队 AGENTS.md 路径 = `squads/{squadId}/AGENTS.md`，对全员注入 | 老板 09:25 |
| D3 | 删个人 ws：全队（含 leader）共用团队 ws，session.workspaceDir 全指向 `squads/{squadId}/`，删除所有创建/引用 `workspaces/{memberId}` 的地方 | req.md L26 |
| D4 | 个人差异 = `squads/{squadId}/.rocky/agents/{名字}-{id}.md`（按需存在，非每 mate 必有），叠加在团队定义之上 | req.md L27 |
| D5 | 团队 skills = `squads/{squadId}/.rocky/skills/`；memory 只留团队级（group scope） | req.md L28-29 |
| D6 | 范围 = 全量：注入透明化（断链消解 + agent section + 来源标注 + 兜底）+ workspace 简化，两件事都做 | 老板 09:05 |
| D7 | 所有 session kind 都需要注入和说明（squad leader/mate/群聊、academy 学员、playground 个人） | req.md L14 |
| D8 | AGENTS.md 实测**已注入**但在 prompt 最末尾（context tier 在 stable 后）——真问题是位置/排序 + 多份目录说明打架，不是「没注入」 | 老板实测 09:05 + 调研 §8 |

## 1. 背景

### 1.1 问题

- 用户迁移 `.claude/` 配置到 rocky 团队时，agent 不知道自己的定义机制（AGENTS.md 在哪、memory 怎么管、skills 几层）——「完全一头雾水」，配置被纠正 3 次。
- 实测：AGENTS.md 注入了但排在 prompt 末尾、注入路径是旧个人 ws 语义；skills 无来源标注；3 个 mate 缺 AGENTS.md；个人 ws 模式导致「mate 聊天难找团队 ws 文件」。

### 1.2 产品解法（对应 overall §13.2）

1. **「定义你的 agent」section**（P0，核心）：a) AGENTS.md 路径+叠加关系 b) memory/memory_manage 工具 c) skills 位置+层级；统一 mapper 按 kind 渲染（D1），全 kind 注入（D7）。
2. **AGENTS.md 两级注入**（P0）：团队 `squads/{sid}/AGENTS.md` 全员注入 + 个人 `.rocky/agents/{名字}-{id}.md` 按需叠加；academy/playground 单份不回归；断链随删个人 ws 消解。
3. **团队 workspace 简化**（P0）：删个人 ws、全队共用 `squads/{sid}/`；分层布局（AGENTS.md / .rocky/agents / .rocky/skills / group 级 memory）。
4. **来源标注 + 兜底**（P1/P2）：AGENTS.md 片段标路径（保留现有样式，团队/个人分别标）；skills L0 每条标来源层；未配置走 a) 条「未配置·可选」温和状态行（非错误、不注空壳片段）。

## 2. 各 session kind 渲染路径表（a/b/c）

见 overall `13-agent-definition.md` §13.2.1「各 session kind 渲染规则」表：squad leader/mate = 团队+个人行、group 级 memory、3 层 skills（团队同址合并）；studio-squad 群聊 = 仅团队行；academy-student = 仅课程行；playground = 仅个人行、无 group 层。subagent/summary/consolidate 默认不挂（scope yaml 决定）。

## 3. 关键用户路径（= 测试最低覆盖）

8 条，见 overall §13.3（新 mate/leader 注入、个人差异叠加、未配置兜底、academy 不回归、playground 无团队行、改文件新 session 生效、落团队 ws）。

## 4. 范围边界

IN/OUT 见 overall §13.4。要点：不改 CLAUDE.md 候选顺序 / skills resolver 优先级 / memory scope 语义；不做配置专用 UI；不做存量个人 ws 自动迁移；budget_truncate 参数调优交架构。

## 5. 待架构实证事项（PRD 不决策，交架构阶段）

1. leader session.workspaceDir id 疑似错位（`...V8` vs `...V9`）——用 `GET /session/:id/debug/system-prompt` 实证；删个人 ws 后该问题预期整体消解。
2. context_files 正文片段的 tier/priority 与 budget floor（memory_session 被挤掉问题）——产品要求「截断必须可溯源（标注被丢 fragment）」，参数由架构定。
3. squad UI 是否引用旧个人 ws 路径展示（成员面板/文件面板），需排查对齐。
