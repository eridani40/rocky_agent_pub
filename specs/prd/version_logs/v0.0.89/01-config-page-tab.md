---
version: v0.0.89
work_block: ①
title: 配置页 tab 化 + 外观合并 + group 视觉规范
status: working
updated: 2026-07-07
---

# 工作块 ① — 配置页 tab 化 + 外观合并 + group 视觉规范

> 升级 v0.0.47 合并页（`spec prd/overall/04-config-center-ui.md §3.9.10`）的 sidebar 为**左侧 tab 竖排导航树**；通用/模型/工具/记忆 4 tab 常驻，可观测性/插件 2 tab 收起在「系统设置」分割线下；外观合并 appearance+locale；group 视觉统一。

## 1. 现状（来自 dump）

- 应用设置合并页（v0.0.47）：左侧 sidebar flat group-list，含 5 个 app config 常驻 group（appearance/providers/user_memory/web_search/locale）+ 系统设置 toggle 分割线 + dev config group（llm_request/observability/logs）+ 插件 group
- providers 走三级流（list→detail→model 弹层，`spec §3.9.7`），独立 diff-save
- observability 走 list+detail（`spec §3.9.8`），独立 save-bar
- user_memory / web_search 自渲染 section（无 group save-bar）
- 硬编码 hex 混用（`#26241f`/`#4a4640`/`#e3dccd`/`#fbfaf6`/`#3a3733`/`#ebe5d8`）；字体 weight 5 种（font-serif/mono / bold/medium/semibold）
- 现状 group 5+3 个，但用户视角是「6 大类」：外观 / 模型 / 工具 / 记忆 + 可观测性 / 插件

## 2. 目标布局（tab 竖排导航树）

```
┌──────────────┬───────────────────────────────────┐
│ 应用设置     │                                   │
│              │  外观 ─────────────────────────   │
│  通用        │   主题     [ 深色 ▾ ]             │
│  模型        │   语言     [ 简体中文 ▾ ]         │
│  工具        │                                   │
│  记忆        │  ─────────────────────────────    │
│ ───────────  │                                   │
│ ⚙ 系统设置 ▾ │   [ 保存 ]   ✓ 已保存             │
│   可观测性   │                                   │
│   插件       │                                   │
└──────────────┴───────────────────────────────────┘
```

- **左侧 tab 树**（256px，可收起为 56px rail）：分**通用区**（4 tab，默认展开）+ **系统设置区**（2 tab，收起在 `app-settings-system-toggle` 分割线下）
- **右侧配置面板**：选中 tab 下所有 group 上下排列（每 group title + 区域间隔 + 下方 keys）
- **保存粒度**：**page(tab)级保存/取消**（替代 per-group save-bar）— 见 §3.2
- **provider 编辑器例外**：独立 diff-save，不进页面级 dirty

## 3. tab → group → key 映射

| tab | group | key（组件） | 数据源 |
|---|---|---|---|
| **通用** | 外观 | 主题（`key-select` 深色/浅色）<br>语言（`key-select`） | `app_config/appearance`（合并 theme+language，**N3**） |
| **模型** | 供应商和模型 | provider/model 编辑器（保持现状三级流） | `app_config/providers` |
| | playground 默认模型 | 默认会话模型（`key-model-picker` + x 清除）<br>默认整理模型（`key-model-picker` + x 清除） | **新建 group** `app_config/default_models`（**N1**），详见工作块 ② |
| | 请求设置 | stall 超时（`key-number`）<br>重试次数（`key-number`） | `app_config/llm_request/default` 嵌套对象的 `timeout.stall_tool_s` + `retry.max_attempts`（暴露已有字段，**N5**） |
| **工具** | 网络搜索 | 保持现状（自渲染 `<SectionWebSearchConfig/>`） | `app_config/web_search`（v0.0.72） |
| **记忆** | 长期记忆 | 保持现状（自渲染 `<SectionUserMemory/>`） | `app_config/user_memory`（v0.0.55） |
| **可观测性** | langfuse | list+detail（保持 `section-observability`） | `app_config/runtime/observability`（迁自 dev_config，**N2**） |
| | 日志 | 4 toggle（`key-toggle`） | `app_config/logs`（迁自 dev_config，**N2**） |
| **插件** | （独特交互） | 整页 `<PagePluginConfig/>`（保留插件/扩展点 子 tab + scope 切换器，不拆散） | `plugin_config`（不动） |

> 系统设置 toggle（testid `app-settings-system-toggle`，v0.0.47 既有）控制「可观测性 + 插件」两 tab 的展开/收起。收起时若当前选中 ∈ {可观测性/插件}，回落到「通用」tab。

## 3.1 group 视觉规范（req 硬要求）

1. **group title** 字体统一：14px/600，无 serif/mono 混用
2. **key label** 字体统一：12.5px/500
3. **同类型组件只有一种样式**：`key-select` / `key-number` / `key-toggle` / `key-model-picker`（与既有 `component-key-card` 的 primitive 一致，不另起样式）
4. **清硬编码 hex**：`#26241f`/`#4a4640`/`#e3dccd`/`#fbfaf6`/`#3a3733`/`#ebe5d8` 全替换为 `var(--color-bg)` / `var(--color-surface)` / `var(--color-accent)` 等 token
5. **字体 weight 收敛**：保留 400（body）/ 600（title/label）两档，删 500/700/serif/mono-italic 混用
6. **区域间隔**：group 间 `margin-top: 32px`；group title 与首个 key 间 `margin-top: 16px`；key 间 `margin-top: 12px`

## 3.2 保存交互（page-tab 级，非 per-group）

- **保存按钮位置**：右下角固定（`position: sticky; bottom: 0`），不随滚动消失
- **保存粒度**：当前 tab 内**所有 group 的 keys**作为一个 draft 提交（一次 PUT/POST 多 group）
- **dirty 检测**：tab 内任一 key 改动 → 显示「● 有未保存的改动」+ 保存按钮高亮；无改动 → 灰态「✓ 已保存」
- **取消按钮**：在保存按钮左侧，仅 dirty 时可见（`visibility:hidden` 预留空间避免位移）；点击 = 重置 draft 到 snapshot
- **例外（不进页面 dirty）**：
  - provider 编辑器（走 `provider-save` 二级页独立 diff-save）
  - observability list+detail（保持 list+detail 独立 save-bar）
  - user_memory / web_search 自渲染 section（保持现有 saveMode='item'）
- **切 tab 行为**：dirty 未保存时切 tab → 弹确认 modal「丢弃改动 / 取消」（不直接丢弃，与 v0.0.47 既有「切 group 改动保留」不同，因 tab 切换成本更高）

### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1.1 | 打开应用设置 → 看 tab 树 | 左侧 tab 树渲染；通用区 4 tab + 系统设置收起 toggle；默认选中「通用」tab，右栏渲染「外观」group |
| UC-1.2 | 切到「模型」tab → 看右侧 | 右栏渲染三个 group 上下排列：供应商和模型 / playground 默认模型 / 请求设置 |
| UC-1.3 | 点「系统设置」toggle → 下方露出「可观测性 + 插件」两 tab | toggle 展开，2 tab 露出，布局零位移（分割线 + chevron rotate） |
| UC-1.4 | 通用 tab 改 theme → 改 language → 不保存切到「模型」tab | 弹确认 modal「丢弃改动 / 取消」；点取消停留在通用 tab；点丢弃 → 切到模型 tab，通用改动重置 |
| UC-1.5 | 通用 tab 改 theme + language → 点保存 | 后端 PUT `app_config/appearance` group 含 `{theme, language}` 两 key（合并 group，**N3**）；UI 显「✓ 已保存」 |
| UC-1.6 | 模型 tab 改 default_models.chat + llm_request.stall_tool_s → 点保存 | 后端 PUT `app_config/default_models` + `app_config/llm_request/default` 两组原子提交；UI 显「✓ 已保存」 |
| UC-1.7 | 在「模型」tab 进 provider 二级页改字段 → 看页面级 dirty 指示 | 页面 dirty 指示**不变**（provider 编辑器独立 dirty，不污染 tab 级） |
| UC-1.8 | 系统设置 toggle 收起时当前选中「可观测性」→ 自动回落「通用」tab + 右栏渲染外观 group | 回落正确，无空状态 |
| UC-1.9 | 任意 tab 视觉检查 | group title 字体一致；key label 字体一致；无硬编码 hex；字体 weight 仅 400/600 |

## 4. 外观 group 合并（appearance + locale → appearance）

### 4.1 数据迁移（一次性，落盘即生效）

- 现状：两条 record — `{group:"appearance", key:"theme"}` + `{group:"locale", key:"language"}`
- 新：一条 group 两条 record — `{group:"appearance", key:"theme"}` + `{group:"appearance", key:"language"}`
- 迁移：把 `locale/language` record 的 group 字段改写为 `appearance`（key 名不变）；落盘迁移把 `dev_config/locale/*.json` 文件改名到 `app_config/appearance/`（保留 id 不变，或重新生成 ULID — 由 arch 决策，**待 arch 定**）
- 迁移后 `locale` group 在 app_config 下空目录，删除空目录

### 4.2 消费方调整（读路径改 app_config）

- 旧：`AppConfigService.get("locale", "language")` / `set("locale", "language", val)`
- 新：`AppConfigService.get("appearance", "language")` / `setGroup("appearance", [{key:"theme",...},{key:"language",...}])`
- 影响文件：i18n service（`specs/tech/i18n/[P0]i18n_overview.md` 引用），由 arch change_plan 列出 grep 点

### 4.3 UI 变更

- 删除 sidebar 的 `locale` 单独 group item；language key 并入「外观」group 内
- 选择器组件：`key-select`（替代 v0.0.59 的 `primitive-key-choice-cards`，统一 select 样式；choice-cards 仅在 web_search type 选择保留）
- 切语言：保持 v0.0.59 既有「切即生效 + PUT 持久化」语义（不进 page-tab 级 dirty 流）

### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1.10 | 迁移前：旧 `locale/language=zh-CN` → 升级 → 打开通用 tab 外观 group | 主题 = 原 theme；语言 = zh-CN（迁移透明） |
| UC-1.11 | 改语言 English → 即时切换 + PUT `app_config/appearance/language=en-US` | 全应用 locale 切换；落盘 record 在 `appearance` group 下 |
| UC-1.12 | 改 theme dark → 改 language English → 点页面级保存 | 一次 PUT `app_config/appearance` group 含 theme + language 两 key（原子） |

## 5. 关键用户路径（MANDATORY — 测试最低覆盖）

### P1：tab 切换 + 各 group 保存/取消
- 链路：选 tab → 改 tab 内多 group keys → 点页面级保存 → 仅该 tab 的 group 全部 key 提交；其他 tab 改动不串扰
- 关键断言：
  - tab 切换 dirty 未保存 → 弹确认 modal（不静默丢）
  - 保存只影响当前 tab 的 group 集合
  - 取消按钮重置 draft 到 snapshot
- UC：UC-1.5 + UC-1.6 + UC-1.11 + UC-1.12

### P2：provider 编辑器独立保存（不触发页面 dirty）
- 链路：模型 tab → 进 provider 二级页 → 改字段 → 看 tab 级 dirty 不动 → provider-save 落库 → 退出二级页回到 tab → tab dirty 仍干净
- 关键断言：
  - provider 二级页的改动**不**触发页面级 dirty 指示
  - provider-save 仍走原 diff-save 链路（POST/PUT/DELETE 三端点，`spec §3.9.7`）
- UC：UC-1.7

### P3：外观 group（主题/语言）合并后配置 + 迁移
- 链路（新建用户）：通用 tab → 外观 group → 改 theme + language → 保存 → 一次 PUT `app_config/appearance` group 含两 key
- 链路（迁移用户）：升级前 `locale/language` 已配 → 升级后 record 在 `appearance/language`，UI 显示正确
- 关键断言：
  - 合并后 `app_config/appearance` group 同时含 theme + language
  - 旧 `locale` group 在 app_config 下空目录已删
  - i18n service 改读 `appearance/language`
- UC：UC-1.10 + UC-1.11 + UC-1.12

## 6. 对齐 ui/tech spec（MANDATORY）

### 6.1 直接复用（不动）
- `app-settings-system-toggle` testid + 收起语义（v0.0.47）
- providers 三级流 + `provider-save` testid（v0.0.7）
- observability list+detail + 独立 save-bar（v0.0.11）
- user_memory 自渲染 section（v0.0.55）
- web_search 自渲染 section + choice-cards（v0.0.72）

### 6.2 需 arch 补/改 ui/tech spec
- **N3**（外观合并）：`specs/tech/config/[P0]app_config.md §3.1/§3.3` 改：`appearance` group 含 theme + language；`locale` group 标 deprecated 后删；`specs/ui/components/app-dev-config-page/page-app-settings-merged.md` 改：sidebar 删 `locale` group item
- **N8**（tab 树）：`specs/ui/components/app-dev-config-page/page-app-settings-merged.md` 大改：sidebar flat list → tab 竖排导航树（通用区 4 tab + 系统设置区 2 tab）；新增 `component-tab-tree-item` 组件 spec
- **page-tab 级 save bar**：新增 `component-tab-save-bar` 组件 spec（替代 per-group save-bar 在多 group tab 的角色）；provider/observability 例外保留原 save-bar
