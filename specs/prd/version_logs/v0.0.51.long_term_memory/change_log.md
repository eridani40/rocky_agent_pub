# v0.0.51 PRD Change Log — long term memory（memory/skill 自演化）

> version: 1.0 · 2026-07-03
> 一句话定位：落地 long term memory 机制 —— **被动**（agent 调 `memory_manage` / `skill_manage` 工具）+ **主动**（compact 后 post-compact EP 触发 fork-2 整理）双路径，让 agent 越用越懂用户/项目、可沉淀可复用工作流。
> 概念权威源：`specs/tech/version_logs/v0.0.51.long_term_memory/change_log.md`（v1+v2 全部设计决策 + 文件清单）+ `specs/tech/agent/memory/`（index + memory_definition + memory_manage_tool + memory_injection + consolidation_tier1）+ `specs/tech/agent/skills/`（index + skill_definition + skill_manage_tool + skill_tool）+ `specs/tech/agent/context/[P0]context_compact_detail.md §2d`（post-compact EP）。
> 设计稿：**无**（仅 spec/PRD + 后续实现）→ 视觉保真度门禁**跳过**。

---

## 1. 版本目标

把 long term memory 机制从前瞻设计推进到**可实现状态**，落地两条互补路径：

1. **被动路径（agent 调工具）**：agent 在对话中自主判断值得沉淀的内容，随时调 `memory_manage` / `skill_manage` 工具直接落盘 —— 无人工审批（self evolution 哲学）。
2. **主动路径（compact 后整理）**：context compact 成功完成后，通过新增的 ordered EP `context_post_compact` 触发 fork-2 整理 agent（allowed tools = `[skill_manage, memory_manage]`），从完整对话 snapshot 直接调工具写入 memory + skill。

配套落地：
- memory native 注入从 no-op 占位升级为实际 impl（`memory_user` = stable tier / `memory_session` = context tier，复用 `system_prompt_mapper` EP）。
- skill `mutable` 字段从「仅记录」升级为「**强制执行**」（immutable skill 拒绝 patch/disable/enable），新增正交维度 `mutableLocked`（UI 改 mutable 的强制点）。
- governance HTTP 端点：UI 改 mutable 走独立 HTTP 路径（受 `mutableLocked` 强制）。
- 写权全局 + per-file 文件锁串行化（跨 agent 并发写不撕裂）。

> **范围性质**：本版本完整版只在 worktree 内做 **spec 改动 + PRD**（tech spec 已落地）；代码实现依赖 v0.0.48 的 `tool_list` 机制 merge 后再进行（见 §5 不覆盖项）。

---

## 2. 核心功能（引用 tech spec，一句话各，不重复细节）

### 2.1 memory_manage 工具 [v0.0.51]
**描述**：agent 写入/归档/列出/读取 memory entry 的工具，**不审批**。
**权威**：`specs/tech/agent/memory/[P0]memory_manage_tool.md`。
**关键**：write（upsert，同 name 更新）/ archive（不删，可恢复）/ list（metadata 级）/ read（单条全文，非注入路径）；写受容量上限 soft-warn 不阻断；写权全局 + per-file 锁串行化。

### 2.2 skill_manage 工具 [v0.0.51]
**描述**：agent create/patch/disable/enable/list/read skill 的工具，**不可 delete**（用 disable 替代，可恢复）。
**权威**：`specs/tech/agent/skills/[P0]skill_manage_tool.md`。
**关键**：create 自动设 `mutable=true`；patch/disable/enable 受 mutable 强制（false 拒绝）；list 含 disabled（防创建撞车重复 skill）；read 可读任意 skill 全文（含 disabled）。

### 2.3 memory native 注入 [v0.0.51]
**描述**：memory 通过 `system_prompt_mapper` EP 的 `memory_user` / `memory_session` impl 自动注入 system prompt，agent 无感。
**权威**：`specs/tech/agent/memory/[P0]memory_injection.md`。
**关键**：whole-file 整体注入（不检索，cache 友好）；`user_memory.md` → stable tier（不裁）/ `session_memory.md` → context tier（超预算可裁尾部）；memory 文件是受管资源，agent 不直接 Read/Edit。

### 2.4 post-compact handler EP → memory_skill_consolidation [v0.0.51]
**描述**：compact 成功完成后触发的新 ordered EP（`context_post_compact`），默认 impl `memory_skill_consolidation` 启动 fork-2 整理 forked agent。
**权威**：`specs/tech/agent/context/[P0]context_compact_detail.md §2d` + `specs/tech/agent/memory/[P0]consolidation_tier1.md`。
**关键**：fork-2 allowed tools = `[skill_manage, memory_manage]`，直接调工具落盘（不产出结构化 ops）；输入 = compact 前完整 snapshot（与 fork-1 同源，已含本次工具调用记录）；forked scope 显式跳过此 handler 防递归；fork-2 失败不影响 compact 已完成的 summary（旁路隔离）。

### 2.5 mutable 双维度治理 [v0.0.51 v2]
**描述**：skill frontmatter 的两个正交治理字段。
**权威**：`specs/tech/agent/skills/[P0]skill_definition.md §6/§8`。
**关键**：
- 维度 A `mutable`（agent 可改性）：`skill_manage` 路径强制，false 拒绝 patch/disable/enable；mutable 字段本身不可被 agent 修改。
- 维度 B `mutableLocked`（UI 可改性 mutable）：UI 改 mutable 走另一路径，强制 true 拒绝。
- 默认值表：用户手写/下载 `mutable=false, mutableLocked=false`；agent create `mutable=true, mutableLocked=false`；系统内置 `mutable=false, mutableLocked=true`。

### 2.6 governance HTTP 端点 [v0.0.51 v2]
**描述**：UI 改 skill `mutable` 字段的独立 HTTP 路径（不经 `skill_manage` 工具）。
**权威**：`specs/tech/agent/skills/[P0]skill_definition.md §8`。
**关键**：调 SkillsService 改 mutable，先检查 `mutableLocked`，true 则拒绝并提示「此 skill 已锁定 mutable，需手编辑 frontmatter」。

### 2.7 写权全局 + 文件锁串行化 [v0.0.51 v2]
**描述**：`memory_manage` + `skill_manage` 注册给所有 agent（playground-rocky / studio-leader / studio-mate，依赖 v0.0.48 tool_list）；写操作 per-file 文件锁（`proper-lockfile`）序列化，读操作 + native 注入不持锁。
**权威**：`memory_manage_tool.md §7` + `skill_manage_tool.md §7`。

---

## 3. 关键用户路径（MANDATORY — 每条 ≥1 AT/ET case）

| 路径 | 用户操作链路 | 预期结果 | 覆盖方式 |
|---|---|---|---|
| **路径 1 · 被动 memory** | 多轮对话 → agent 判断某用户偏好值得记 → 调 `memory_manage.write(scope=user)` → 落盘 user_memory.md → 下次 session `memory_user` mapper 注入 system prompt | user_memory.md 出现新 entry；新 session system prompt 含该 memory（stable tier） | AT（真 LLM 真服务，禁 mock） |
| **路径 2 · 主动 compact 整理** | 多轮对话 context 满阈值 → compact 触发 → fork-1 完成 summary → post-compact EP 触发 fork-2 → fork-2 调 skill_manage/memory_manage 落盘 | compact 后磁盘出现新 memory entry 或 skill；compact summary 不受 fork-2 失败影响（旁路隔离） | AT（真 LLM 真服务） |
| **路径 3 · skill 自演化** | agent 判断某可复用工作流 → 调 `skill_manage.create` → 沉淀 SKILL.md → 下次 session resolver 扫到 → L0 catalog（带 `mutable=true`）注入 system prompt 可见 | SKILL.md 落盘到 app/workspace scope；新 session L0 catalog 含新 skill 条目 | AT（真 LLM 真服务） |
| **路径 4 · mutable 强制** | mutable=false 的 skill → agent 调 `skill_manage.patch` / `disable` / `enable` | 三个调用全部返回 REJECT（isError 带稳定 code）；磁盘 skill 不变 | AT（真服务工具调用） |
| **路径 5 · governance** | UI PATCH 改 mutable → (a) `mutableLocked=false` 允许改；(b) `mutableLocked=true` 拒绝并提示「需手编辑 frontmatter」 | (a) skill frontmatter mutable 字段更新落盘；(b) HTTP 错误响应 + 提示文案 | AT（curl 真服务） |

---

## 4. UT/AT/ET 范围

### 4.1 UT（白盒，`bun run test`）
- **memory_manage 工具逻辑**：write upsert / archive 不删 / list metadata-only / read 全文 / 容量 soft-warn。
- **skill_manage 工具逻辑**：create 自动 mutable=true / patch 全文替换 / disable+enable 复用 skill_state。
- **mutable 强制规则**：false → patch/disable/enable 全拒绝；true → 全允许；mutable 字段本身不可改。
- **per-file 文件锁**：同文件并发写串行化；不同文件不互斥；读不持锁。
- **SkillResolver.resolveAll()**：含 disabled skill（区别于 resolve() 只返回 enabled）。
- **memory 注入 mapper**：user=stable / session=context；空文件返回空 fragment。

### 4.2 AT（黑盒真 LLM 真服务，禁 mock）
> 实现依赖 v0.0.48 tool_list merge；merge 后按本范围设计 case。
- **路径 1 case**：playground-rocky session 多轮对话触发 `memory_manage.write(scope=user)` → 查真落盘 `user_memory.md` → 新 session 启动抓 system prompt 含该 memory。
- **路径 2 case**：构造超阈值 context → compact 真触发 → fork-2 真调工具 → 查真落盘 memory/skill 文件 + summary 完整。
- **路径 3 case**：session 内 agent 真调 `skill_manage.create` → 查真落盘 SKILL.md（frontmatter mutable=true）→ 新 session system prompt L0 catalog 含新 skill。
- **路径 4 case**：手写 immutable skill（mutable=false）→ agent 调三个写 action → 三次工具结果均 isError（带稳定 code）+ 磁盘不变。
- **路径 5 case（governance 端点 curl）**：(a) mutableLocked=false PATCH mutable 成功；(b) mutableLocked=true PATCH 拒绝 + 错误文案。

### 4.3 ET
**本版本无新 UI 页面**（governance 是现有 skill 管理 UI 的扩展）。
→ **ET 视 governance UI 改动范围定**：若 governance 仅新增一个 toggle/按钮，**最小可不覆盖 ET**（AT 已黑盒覆盖 HTTP 契约）；若改动 skill 管理 UI 整体布局/视觉，则按改动页面对应补 ET。
→ 最终 ET 范围在阶段 2.5 test-plan.md 按实际 UI 改动确定。

---

## 5. 不覆盖项（OUT-OF-SCOPE，明确排除）

| 项 | 原因 | 后续 |
|---|---|---|
| **二级整理（离线深度整合）** | merge/prune/矛盾解决/容量回收 — 非本版本目标 | P1（`memory/[P1]consolidation_tier2.md` 占位） |
| **memory 检索（向量召回子集）** | 当前 whole-file 注入足够（容量上限控体量） | P1（`memory_injection.md §6`） |
| **session_memory 归档/提升策略** | session 结束 entry 是否提升到 user_memory / 何时清空 / 是否随 session 持久化 — 未定 | P1（`memory_definition.md §7`） |
| **skill 供应链安全** | 非本版本目标 | roadmap |
| **代码实现** | 本版本完整版仅 spec + PRD；实现依赖 v0.0.48 tool_list merge | 后续版本 |
| **fork-2 prompt 模板 + 工具部分失败策略 + maxIterations + fork-2 aux model 优化** | 实现侧细节，model 已 resolve 为复用 session 当前 model | `consolidation_tier1.md §6 待定` |

---

## 6. 设计稿说明

**无设计稿**（本版本为 spec/PRD + 后续实现的内部能力版本）。
→ 视觉保真度门禁**跳过**（CLAUDE.md 原则 15：无设计稿时本原则跳过）。
→ E2E 视觉判定（`vision_check.py compare`）无需执行；如 §4.3 最终有 ET，仅做单图功能检查（dom + 视觉功能判定）。
