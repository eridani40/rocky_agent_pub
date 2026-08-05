---
version: v0.0.89
slug: ui_opt
title: 配置页 tab 化重构 + 模型选择器迁移 + dev→app 配置合并
status: working
updated: 2026-07-07
---

# v0.0.89.ui_opt — PRD 增量记录

> PRD 增量（产品视角）。tech / api / ui 的增量由各自 spec owner 在阶段 5 doc-modifier 同步。
> 本目录 5 个 PRD 文件 + 本文 = 本版本 PRD 全量；overall PRD（`specs/prd/overall/04-config-center-ui.md`）的同步在 doc-modifier 阶段。

## 用户原始需求摘要

来源：`reqs/[working] v0.0.89.ui_opt/req.md` + `design-brief.md`（已确认 8 决策）。

| # | 用户诉求 | 工作块 |
|---|---|---|
| 1 | 所有配置融入 app_config，废弃 dev_config（一次性迁移 + 用户手动删） | ⑤ |
| 2 | 引入 tab 管理概念（仍保持系统设置收起模式） | ① |
| 3 | yaml 管理（tab/group/key 分层结构化） | ① |
| 4 | 通用 tab：外观 group（theme + language 合并） | ① |
| 5 | 模型 tab：供应商（保持）+ playground 默认模型 group（chat + summary，可空+清除）+ 请求设置 group（stall_tool_s + max_attempts） | ② |
| 6 | 工具 tab：网络搜索（保持） | ① |
| 7 | 记忆 tab：长期记忆（保持） | ① |
| 8 | 系统设置区：可观测性 tab（langfuse + 日志）+ 插件 tab（独特交互） | ① |
| 9 | group title + 区域间隔 + 字体统一 + 同类型组件只有一种样式 | ① |
| 10 | 页面级保存（非点击生效） | ① |
| 11 | 抽象 model resolve（playground session / studio session × chat / compact/forked） | ③ |
| 12 | resolve 不了报错（不静默） | ③ |
| 13 | 默认整理模型（playground: app_config.default_models.summary；studio: squad.summaryModelDefault） | ② + ③ |
| 14 | studio 完全不受 app_config 的 playground 默认模型影响 | ③ |
| 15 | 模型选择器：chat-topbar → chat-input-bar；图标小；tooltip 显示当前；点击菜单左上延伸；默认a + 完整列表 a 重复一次（双项语义） | ④ |
| 16 | subagent 无 input-bar → 不展示模型图标（保持 readOnly tag） | ④ |
| 17 | 新建 session modelId=`"default"`（保留字，跟随默认） | ③ + ④ |

## 8 项已确认决策（design-brief §6）

1. tab 布局=左侧竖排导航树（通用 4 tab + 收起系统设置 2 tab）
2. 模型保留字 `default`（=未选/跟随默认）；不引入「显式无模型抛错」语义
3. 请求设置 group 只暴露 `timeout.stall_tool_s` + `retry.max_attempts`，不引入新配置
4. 外观 group 合并 appearance+locale → `appearance`（theme+language）
5. 保存交互=page(tab)级保存/取消；provider 编辑器独立保存
6. 网络搜索/langfuse/日志保持现有交互，整体结构格式统一
7. dev→app 迁移零命名冲突直迁；dev_config/llm_request 死数据丢弃
8. 模型选择器：chat-topbar→chat-input-bar；菜单左上延伸；默认a + 完整列表 a 重复；新建 session `modelId=default`

## 范围纪律（明确不做）

- plugin_config + ext impl scope + scope 切换器（完全不动）
- providers/observability/user_memory/web_search 各 section 内部交互（仅随 tab 化搬位置）
- 设计 token 体系重建（仅清硬编码 hex + 字体 weight 收敛）
- 任何 YAGNI 优化

## 待 arch 补 ui/tech spec 的概念清单（MANDATORY — 概念先行）

PRD 已标注 N1-N8 共 8 个新概念。architect 阶段需先在 ui/tech spec 落概念定义，再让 coder 实现：

| # | 概念 | spec 落点 |
|---|---|---|
| N1 | `app_config.default_models` 新 group | `specs/tech/config/[P0]app_config.md` += §3.7；`specs/ui/components/common/component-key-model-picker.md` 新增 |
| N2 | dev→app 迁组（logs/runtime/web/sub_agent_templates/agent/context） | `specs/tech/config/[P0]app_config.md` 扩 §3 group 集合 + 各 group shape；`[P0]dev_config.md` 标 deprecated |
| N3 | `appearance` group 合并 `locale/language` | `[P0]app_config.md §3.1/§3.3` 修订；`[P0]dev_config.md` 该段同步删 |
| N4 | Squad += `summaryModelDefault?: string` | `specs/tech/squad/[P1]data_model.md §1.1`；`schema_defs/squad/squad.ts`；api squad 端点 |
| N5 | Session.modelId += 保留字 `"default"` | `specs/tech/agent/session/[P0]session_store.md §2` 加注；`services/model-validation.ts` 白名单 |
| N6 | model resolve 统一抽象（fallback 表 + ModelNotConfiguredError） | tech 新增 `[P0]model_resolve.md`（落 session 或 providers KB） |
| N7 | chat-input-bar 内 ModelPicker trigger（替代 chat-topbar ModelPicker 在非 readOnly 分支） | ui `specs/ui/components/chat-page/component-input-model-picker.md` 新增 + `_overview.md §4.X` 加条 |
| N8 | 配置页 tab 竖排导航树（替代 v0.0.47 flat sidebar） | ui `specs/ui/components/app-dev-config-page/page-app-settings-merged.md` 大改 + 新增 `component-tab-tree-item` spec + 新增 `component-tab-save-bar` spec |

## overall 文档同步（doc-modifier 阶段 5）

- `specs/prd/overall/04-config-center-ui.md`：
  - §3.9.2 修订（appearance group 含 language；删 locale 单独 group；新增 default_models + 暴露 llm_request 子字段作为模型 tab group）
  - §3.9.10 大改（应用设置合并页 sidebar flat → tab 竖排导航树；page-tab 级 save bar 替代 per-group save bar）
  - 新增 §3.9.X（模型选择器迁移到 input-bar + 三态交互）
  - 新增 §3.9.Y（model resolve 抽象 + 保留字 default + summaryModelDefault）
- `specs/api/overall/`：
  - 删 dev 相关路由（`/config/dev/*`）；`/config/app/sub_agent_templates/*` 改路径
  - `POST /squad` / `PUT /squad/:id` body += `summaryModelDefault?`
  - `POST /session/:id/chat` 错误体 += `code: "MODEL_NOT_CONFIGURED"`
  - `PUT /session/:id` body.modelId 接受 `"default"`

## 关键用户路径汇总（MANDATORY — 10 条）

| ID | 路径名 | 文件 |
|---|---|---|
| P1 | tab 切换 + 各 group 保存/取消 | `01-config-page-tab.md` |
| P2 | provider 编辑器独立保存 | `01-config-page-tab.md` |
| P3 | 外观 group 合并 + 迁移 | `01-config-page-tab.md` |
| P4 | 默认模型 group 配置 | `02-default-models-and-request.md` |
| P5 | 请求设置 group 暴露 + 保存 | `02-default-models-and-request.md` |
| P6 | 模型选择器（默认a/固定a） | `04-model-picker-migration.md` |
| P7 | 新建 session `modelId=default` + resolve | `03-model-resolver.md` |
| P8 | playground compact 走默认整理模型 fallback | `03-model-resolver.md` |
| P9 | studio squad 配默认整理模型 + 不受 app_config 影响 | `03-model-resolver.md` |
| P10 | dev→app 迁移后消费方读 app_config 正确 | `05-dev-to-app-migration.md` |
