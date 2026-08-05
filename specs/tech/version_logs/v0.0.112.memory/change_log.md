# v0.0.112 长期记忆增强 — Tech 变更日志

> 引入版本 v0.0.112 · 2026-07-10
> 一句话：让 memory 复刻 skill 已落地的 **L0/L1 progressive disclosure + evolvable 治理 + 纯读/管理分离**，补齐 300 词硬限、路由提示词、scope 统一命名。非从零发明。
> method 级变更契约见同目录 `change_plan.md`。

## 1. 概念/原则变更（tech spec）

| spec | 变更 |
|------|------|
| `agent/memory/index.md ④` | 原则 4 翻转（whole-file 注入 → L0 注入 + 按需读）；新增原则 11（evolvable 治理）、12（300 词硬限 + scope 统一命名） |
| `agent/memory/[P0]memory_tool.md`（新增） | `memory` 纯读工具契约（read/search），对称 `skill_tool.md`；§4 说明「有 L0 仍加 search」的理由 |
| `agent/memory/[P0]memory_injection.md` | §1/§3 翻转 L0 注入（formatL0，session mapper 用 listMetas）；§5 budget_truncate 语义弱化注记 |
| `agent/memory/[P0]memory_definition.md` | entry schema 加 `evolvable`（§3）；§5 file-total soft-warn 退役 → per-entry 300 词硬限；§5.1 evolvable 治理（存量默认 true） |
| `agent/memory/[P0]memory_manage_tool.md` | §2 scope global/session + 默认 global；§5 300 词硬限；§5.1 evolvable gate（进化性写）；§5.2 路由提示词 |
| `agent/memory/[P0]consolidation_tier1.md §6` | fork-2 prompt 两步路由规则落地（`{{routing_rules}}` ← ROUTING_DECISION_PROMPT） |
| `agent/skills/[P0]skill_manage_tool.md` | §2 scope global/session + 默认 global（订正 spec 落后）；§2.1 session=项目级消歧；§11 路由提示词 |
| `agent/skills/[P0]skill_definition.md §4` + `skill_architecture.md §3` | scope 对外命名映射 + session=项目级消歧注记 |

## 2. API 契约变更

- `api/overall/14-self-evolution-tool-ref.md`：新增 `memory` 纯读工具（read/search）；memory/skill 工具 scope 统一 global/session + 默认 global；memory_manage list 透出 evolvable；新增 300 词/evolvable/scope AT 可测点。**订正 drift**：`mutable`/`mutableLocked` → `evolvable`（代码 v0.0.55 已改，文档落后）；write 持久化路径订正为 v0.0.55 介质分流。
- `api/overall/15-memory-ui.md`：entry schema 加 `evolvable`；path scope `user`→`global`；POST/PATCH body 300 词 >限 400 + evolvable 字段（UI 全开）。§12 OUT 订正（per-entry 300 词现为 IN，file-total OUT）。

## 3. spec-code drift（grep 核对发现，供 doc-modifier 对齐）

1. **`14-self-evolution-tool-ref.md` 用 `mutable`/`mutableLocked`**——代码自 v0.0.55 用单维度 `evolvable`（删 mutableLocked）。本版本已订正该 API 文档。
2. **`14` §2.2 memory write 持久化路径 `<dataDir>/memory/{user_memory|session_memory}.md`**——v0.0.55 已介质分流（app_config record + per-session md）。本版本已订正。
3. **`skill_manage_tool.md §2` scope 标必填**——代码 `parseNameScope`（非 workspace 即 app）**已默认 global**。本版本订正为可选、默认 global。
4. **`ToolErrorCode` 无 `INTERNAL`**（含 invalid_input/not_found/runtime_error 等 11 值）——本版本 memory 错误码用 `invalid_input`（300 词 + non-evolvable）/`not_found`/`runtime_error`，不引入新枚举值（避免闭合性失败）。
5. **`change_plan.md` row 74 误指订正**（doc-modifier 事后核实，change_plan 冻结不改，订正记此）：row 74 把 `app/web/src/components/studio-page/component-member-panel-memory.tsx` 列为「对接 memory-api 新 scope 类型（member 会话 memory）」——**误指**。该组件实为 member 面板**摘要/压缩**面板，import `chat-api`（`getSummary` / `postCompact`），**无 memory-api / memory scope 对接点**（member session summary = 角色长期记忆走 v0.0.18 summary 机制，非 memory entry CRUD；见 `specs/ui/components/studio-page/member-panel-memory.md`——该 UI spec 描述正确，仅 change_plan row 74 误指）。studio/chat 的**成员 memory scope CRUD** 实由 `app/web/src/components/chat-page/section-memory-panel.tsx`（`useMemoryCrud('session', sessionId)`）+ `app/web/src/components/app-dev-config-page/section-user-memory.tsx`（`useMemoryCrud('global')`）承接。故 row 74 声明的 memory scope 改动实际无对象——本版本 memory scope 前端对接点 = memory-api.ts + section-memory-panel + section-user-memory（均已落 global/session）。
6. **[BUG-001] `memory_manage.write` 更新既有可省 `type`（继承既有）**：`memory-manage.ts` write 分支加 `probeExistingType`——更新既有条目时若省 `type` 则探测继承既有条目的 type，使进化性写抵达 service 层 evolvable gate（否则被 `entry.type invalid` 抢先拦，non-evolvable 条目误报为 type 错误）。已补进 `memory_manage_tool.md §5.1`。创建仍需显式 type。

## 4. 范围边界

- **IN**：memory 纯读工具（read/search）+ 注入翻转 L0 + memory evolvable 治理 + per-entry 300 词硬限 + 路由提示词三处同源 + memory/skill 工具 scope 统一 global/session + memory HTTP/UI scope 统一。
- **OUT**：memory 检索排序/相关度（P1）；二级整理/矛盾检测（P1）；session→user 提升（P1）；file-total 容量硬限；**skill UI HTTP（06/06a）+ 管理页 scope 统一**（bounded，保 app/workspace，open 项）。

## 5. 开放决策（见 change_plan「开放决策」）

1. evolvable 存量默认 = true（保 agent 可写，分歧 skill）。
2. 进化性写 gate = 更新既有 + archive（新建不 gate）。
3. `memory` 读工具 4 角色 bound（含 subagent，对齐 skill）。
4. skill UI/HTTP scope 统一 deferred（本版本仅统一工具）。
