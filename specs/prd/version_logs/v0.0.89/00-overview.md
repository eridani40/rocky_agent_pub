---
version: v0.0.89
slug: ui_opt
title: 配置页 tab 化重构 + 模型选择器迁移 + dev→app 配置合并
status: working
updated: 2026-07-07
---

# v0.0.89 配置优化 — 版本概览

> 简称：**ui_opt**（不要与 v0.0.47.ui_opt / v0.0.63.ui_opt / v0.0.85.ui_opt 混淆）。
> 本目录 = 本版本 PRD（产品需求 + 关键用户路径）。overall PRD（`specs/prd/overall/04-config-center-ui.md`）的同步交 doc-modifier 阶段 5 处理。
> 设计权威：`reqs/[working] v0.0.89.ui_opt/req.md` + `design-brief.md` + `demo.html`（基于 dev dump 高保真还原）。

## 1. 版本目标（一句话）

把「应用设置」页升级为**左侧 tab 竖排导航树**（通用 4 tab + 收起的系统设置 2 tab），所有 dev_config 数据迁入 app_config 后废弃 dev_config，引入**默认会话/整理模型** + **请求设置**两个新 group，**抽象 model resolve** 统一三态（具体 / `default` 跟随 / 错），**模型选择器**从 chat-topbar 挪到 chat-input-bar 内并重做菜单语义。

## 2. 范围（5 大工作块）

| 工作块 | PRD 文件 | 摘要 |
|---|---|---|
| ① 配置页 tab 化 + 外观合并 + group 视觉规范 | `01-config-page-tab.md` | tab 竖排导航树；通用/模型/工具/记忆 4 tab + 系统设置收起区 2 tab（可观测性/插件）；外观 group 合并（theme+language）；group 视觉统一（title/字体/组件样式/去硬编码 hex） |
| ② 默认模型 + 请求设置 | `02-default-models-and-request.md` | 新 group `app_config.default_models`（chat+summary 两 key，可空 + x 清除）；请求设置 group 暴露 `llm_request/default` 嵌套对象中的 `timeout.stall_tool_s` + `retry.max_attempts` |
| ③ model resolve 抽象 + summaryModelDefault + 保留字 default | `03-model-resolver.md` | 统一 resolve 链：playground session vs studio session × chat vs forked/compact；引入 `default` 保留字；squad 加 `summaryModelDefault`；resolve 不到直接报错（不静默兜底） |
| ④ 模型选择器迁移到 input-bar + 三态交互 | `04-model-picker-migration.md` | chat-topbar ModelPicker 挪到 chat-input-bar（小图标 + tooltip + 菜单左上延伸 + 默认a/固定a 双项语义）；subagent 不展示；新建 session `modelId="default"` |
| ⑤ dev→app 迁移 + 废弃 dev_config | `05-dev-to-app-migration.md` | logs/runtime/observability/sub_agent_templates/web/context/agent 全迁 app_config；外观 group 合并底层；dev_config/llm_request 死数据丢弃；迁移脚本（merge 后用户执行）；消费方改读 |

## 3. 对齐已有概念（MANDATORY — PRD 不发明概念）

PRD 引用的所有现存概念须与 `specs/ui/` + `specs/tech/` 一致；新概念在文末「§6 需 arch 补 ui/tech spec 的概念」标注，由 architect 阶段补 spec 后回 PRD 引用。

### 3.1 直接复用（spec 已存在，PRD 不动）
- **AppConfigService / DevConfigService** 通用 KV（`get(group,key)` / `setGroup(group, items[])`）— `specs/tech/config/[P0]app_config.md §5` / `[P0]dev_config.md §7`
- **AppConfig group 集合**：`{ appearance, providers, locale, llm_request, user_memory, web_search }`（`[P0]app_config.md §3`）
- **DevConfig group 集合**：`{ llm_request, observability, logs }`（前端可见）+ schema 保留 `{ agent, llm, context, runtime, web, sub_agent_templates }`
- **`llm_request/default`** 嵌套结构（`timeout/retry/degradation/length/fallback_chain`）— `[P0]app_config.md §3.4`
- **Squad entity**（`modelDefault: string`，建队必填）— `specs/tech/squad/[P1]data_model.md §1.1`
- **Member.model** 三态（空=inherit squad.modelDefault / 具体 modelId）— `data_model.md §1.2`
- **Session**（`providerId?` + `modelId?` string? optional）— `specs/tech/agent/session/[P0]session_store.md §2`
- **resolveProviderModel + validateModelId**（services/model-validation.ts，session-provider-utils.ts:54）
- **应用设置合并页 sidebar + 系统设置 toggle**（`testid=app-settings-system-toggle`）— `04-config-center-ui.md §3.9.10`
- **provider 三级流 + diff-save**（`testid=provider-save`）— `04-config-center-ui.md §3.9.7`
- **providers/observability/user_memory/web_search 自渲染 section**（无 group save-bar）— `04-config-center-ui.md §3.9.2`
- **group 独立保存**（`component-group-save-bar`）— `04-config-center-ui.md §3.9.2`
- **chat-topbar ModelPicker + chat-model-tag**（v0.0.63.ui_opt readOnly 分支）— `specs/ui/components/chat-page/_overview.md §4.3`

### 3.2 本版本引入的概念（需 arch 补 ui/tech spec）

| # | 概念 | 影响层 | 备注 |
|---|---|---|---|
| N1 | `app_config.default_models` 新 group（key=`default`，data=`{chat?: string, summary?: string}`） | tech `app_config.md` += §3.7；ui 加 `key-model-picker` 组件 spec | 与 `llm_request/default` 的 `default` 撞名但语义无关（一个是 record key，一个是模型保留字） |
| N2 | `app_config.logs` + `app_config.runtime/observability` + `app_config.web` + `app_config.sub_agent_templates` + `app_config.context` + `app_config.agent`（迁自 dev_config） | tech `app_config.md` 扩组集合；`dev_config.md` 收缩 | 命名零冲突直迁 |
| N3 | `app_config.appearance.language`（吸收 `locale/language`）；`locale` group 废弃 | tech `app_config.md §3.1/§3.3` 修订 | 数据迁移把 locale record 挪到 appearance group |
| N4 | Squad += `summaryModelDefault?: string`（空=回退 modelDefault） | tech `squad/[P1]data_model.md §1.1`；`schema_defs/squad/squad.ts` | PRD §3 仅定语义，schema 走 arch |
| N5 | Session.modelId += 保留字 `default`（=未手动选/跟随默认） | tech `session/[P0]session_store.md §2`；`resolveProviderModel` 改造识别保留字 | 不改 schema 类型；新建 session 默认 `default` |
| N6 | model resolve 统一抽象（per-session × per-task 类型，4 条 fallback 链） | tech 新增 `session/[P0]model_resolve.md` 或 `agent/providers_and_models/[P0]model_resolve.md` | 取代散落在 `session-config.ts` + `session-compact.ts` + `session-provider-utils.ts` 的回退逻辑 |
| N7 | chat-input-bar 内的 ModelPicker trigger（小图标 + tooltip + 左上延伸菜单） | ui `chat-page/component-input-model-picker.md` 新增；`_overview.md §4.X` 增条 | 替代 chat-topbar ModelPicker（非 readOnly 分支） |
| N8 | 配置页 tab 竖排导航树（通用区 4 tab + 系统设置区 2 tab） | ui `app-dev-config-page/page-app-settings-merged.md` 修订（v0.0.47 sidebar → tab 树） | 升级既有合并页 sidebar |

## 4. 全局约束（req 硬要求）

1. **plugin 不影响** — 插件配置（plugin_config + ext impl scope）整体不动（保持现状「独特交互」），仅在 tab 树中作为「插件」tab 复用整页 `<PagePluginConfig/>`
2. **yaml 管理** — 配置仍走 KV（不引入文件型 yaml 编辑 UI）；指 req 列表里"yaml 管理"是对**结构化**的描述（按 tab/group/key 分层），不是 yaml 文本编辑
3. **group 视觉统一** — 所有 group title 字体一致；所有 key label 字体一致；同类型组件只有一种样式（清硬编码 hex + 字体 weight 收敛到 1-2 种）
4. **页面级保存** — 单个 tab 内统一「保存 / 取消」（非 per-group）；例外：provider 编辑器独立保存（不触发页面级 dirty）
5. **dev→app 迁移零命名冲突直迁** — dev_config/llm_request 两条死数据（`stall_timeout_s` / `max_retry_times`，v0.0.25 前遗留）**丢弃**（不在 `app_config/llm_request/default` 字典里，是 dev_config 旧 record）
6. **删除 dev_config 由用户手动执行** — PRD 只产出迁移脚本（merge 后用户跑），代码侧删 service/schema/路由由本版本承担

## 5. 关键用户路径索引（MANDATORY — 9 条，每条至少 1 个 API/E2E case）

详见各 PRD 文件「关键用户路径」段。

| 路径 ID | 路径名 | 文件 |
|---|---|---|
| P1 | tab 切换 + 各 group 保存/取消（页面级） | `01-config-page-tab.md` |
| P2 | provider 编辑器独立保存（不触发页面 dirty） | `01-config-page-tab.md` |
| P3 | 外观 group（主题/语言）合并后配置 + 迁移 | `01-config-page-tab.md` |
| P4 | 默认模型 group 配置（chat/summary，可空+清除） | `02-default-models-and-request.md` |
| P5 | 请求设置 group 暴露 + 保存（stall_tool_s + max_attempts） | `02-default-models-and-request.md` |
| P6 | 模型选择器（输入框图标 → 菜单 → 默认a/固定a） | `04-model-picker-migration.md` |
| P7 | 新建 session `modelId=default` + resolve fallback | `03-model-resolver.md` |
| P8 | playground compact 走默认整理模型 fallback 链 | `03-model-resolver.md` |
| P9 | studio squad 配默认整理模型 + 不受 app_config 影响 | `03-model-resolver.md` |
| P10 | dev→app 迁移后消费方读 app_config 正确（web/log/observability） | `05-dev-to-app-migration.md` |

## 6. 已确认的 8 项设计决策（design-brief §6，硬约束）

1. tab 布局=**左侧竖排导航树**（通用区：通用/模型/工具/记忆 + 收起「系统设置」区：可观测性/插件）
2. 模型保留字 `default`（=未选/跟随默认）；`none` 等价 `default`，不引入「显式无模型抛错」语义
3. 请求设置 group 只暴露 `timeout.stall_tool_s` + `retry.max_attempts`，**不引入新配置**，不暴露 degradation/length/fallback_chain
4. 外观 group 合并 appearance+locale → `appearance`（theme+language 两 key），数据迁移
5. 保存交互=**page(tab)级保存/取消**（非 per-group）；provider 编辑器**独立保存**
6. 网络搜索/langfuse/日志保持现有交互，整体结构格式统一（key-card 容器/字体/组件样式一致）
7. dev→app 迁移零命名冲突直迁；dev_config/llm_request 两条死数据**丢弃**
8. 模型选择器：chat-topbar→chat-input-bar；菜单向左上延伸；配了默认会话模型 a → 菜单「a(默认)」+ 完整列表 a 重复一次（选「默认a」=`default`，选「a」=固定 a）；新建 session `modelId=default`

## 7. OUT OF SCOPE

- 插件配置（plugin_config + ext impl scope + scope 切换器）— 完全不动
- 设计 token 体系重建（仅清硬编码 hex + 字体 weight 收敛，不重做 token 命名）
- providers/observability/user_memory/web_search 各自 section 的内部交互（仅随 tab 化搬位置，不改交互）
- 任何不在本目录 5 个工作块范围内的优化（YAGNI）
