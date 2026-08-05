---
version: v0.0.89
work_block: ④
title: 模型选择器迁移到 chat-input-bar + 三态交互
status: working
updated: 2026-07-07
---

# 工作块 ④ — 模型选择器迁移到 chat-input-bar + 三态交互

> 把 chat-topbar 内的 ModelPicker（非 readOnly 分支）挪到 chat-input-bar 内（小图标 + tooltip + 菜单左上延伸 + 默认a/固定a 双项语义）；subagent 不展示；新建 session `modelId=default`。
> 决策来源：req §「优化模型选择器展现」+ design-brief §2 + §6.8。

## 1. 现状（来自 spec）

- chat-topbar 现有 ModelPicker：testid `chat-model-picker`（非 readOnly 分支）+ `chat-model-tag`（readOnly = subagent 分支，v0.0.63.ui_opt）
- trigger 固定宽度 180px + nowrap + ellipsis + hover title（v0.0.72 UIFix2）
- 模型列表 = 每个 enabled provider 的每个 enabled 文本 model
- 菜单 = dropdown（向右下展开）
- subagent chat page：readOnly 分支，tag 显示 subagent.modelId，不可点选

## 2. 目标 — 模型图标在输入框内

### 2.1 位置迁移

- **从**：`chat-topbar` 右侧 ModelPicker trigger
- **到**：`chat-input-bar` 内，textarea/composer **左下角**（与 send 按钮对侧）
- **subagent 不展示**（req：「subagent 没有输入框？先不展示」）— subagent readOnly 分支保持 `chat-model-tag` 显示在 topbar
- **playground + studio session（leader/mate）**：均迁移到 input-bar
- **squad chat page**（路由器）：保持现有展示（如有），不入本工作块范围

### 2.2 模型图标（trigger）视觉

- **尺寸**：24×24 button，圆角 6px
- **图标**：默认模型 icon（如 sparkles / cube），16px
- **位置**：`chat-input-bar` 内左下角，`position: absolute; left: 12px; bottom: 8px`（不占排版流，避免 textarea resize 时跳动）
- **hover tooltip**（primitive-tooltip）：
  - `modelId === "default"` 且配了 `default_models.chat=modelA` → tooltip 文本「a（默认）」（a = modelA 的 label）
  - `modelId === "default"` 且未配 default_models.chat → tooltip 文本「未配置」
  - `modelId === 具体 modelB` → tooltip 文本「b」（modelB 的 label，或「我的 OpenAI / gpt-4o」复合 label）
- **trigger 文本**：图标右侧紧邻 8px gap 显示简短 model label（不固定宽度，max-width 120px，超长 ellipsis；hover 显完整）
- **不可点选场景**：
  - session 当前 running（避免运行中切模型）
  - subagent readOnly 分支不挂载

### 2.3 菜单交互（**核心**）

#### 触发
- 点击 trigger → 菜单**向左上方延伸**展开（req：「向左上方延伸」）
- 菜单底部右下角对齐 trigger 左上角 + 4px gap
- 菜单宽度 280px，max-height 400px（滚动）

#### 菜单内容（双场景）

**场景 A**：配了 `default_models.chat=modelA`（playground）或 `squad.modelDefault=modelA`（studio）
```
┌──────────────────────────────┐
│ a (默认)              ✓      │  ← 顶部分割区，selected 标记
├──────────────────────────────┤
│ 我的 OpenAI                  │  ← provider 分组 label
│   gpt-4o                     │
│   gpt-4o-mini                │
│ 我的 Anthropic               │
│   claude-sonnet-4-6          │
│   ...                        │
│   a (= modelA，再出现一次)   │  ← 完整列表里 a 重复出现
│   ...                        │
└──────────────────────────────┘
```

- 顶部「a (默认)」：选中 → 写 `session.modelId = "default"`（跟随默认）
- 完整列表里的「a」：选中 → 写 `session.modelId = "<providerId>:<a 的 modelId>"`（固定 a，不跟随默认）
- 默认会话模型变（如 default_models.chat 改 modelB）→ 之前选「默认 a」的 session 自动跟随到 modelB；之前选「a」的 session 不变

**场景 B**：未配 `default_models.chat`（playground）或 `squad.modelDefault` 空（studio）
```
┌──────────────────────────────┐
│ 我的 OpenAI                  │
│   gpt-4o                     │
│ 我的 Anthropic               │
│   claude-sonnet-4-6          │
└──────────────────────────────┘
```

- 无顶部分割区
- 选中任一 → 写具体 ModelRef（用户必须显式选）

#### 选项来源
- 每个 enabled provider（`app_config/providers` filter `enabled === true`）的每个 enabled 文本 model（`models[]` filter `enabled === true && inputModalities.includes('text')`）
- 排除：disabled provider 的所有 model；enabled provider 的 disabled model；非文本 model（如纯 image/audio output）

### 2.4 三态语义（与工作块 ③ 对齐）

| session.modelId 值 | trigger 显示 | tooltip | 菜单 selected 项 |
|---|---|---|---|
| `"default"` + 配了 defaultA | 模型图标 + 简短 a label | 「a（默认）」 | 顶部「a (默认)」✓ |
| `"default"` + 未配 default | 模型图标 + 「未配置」灰 | 「未配置」 | 无 ✓（无顶部分割区） |
| 具体 modelB | 模型图标 + 简短 b label | 「b」或「provider / b」 | 完整列表里 b ✓ |

### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4.1 | 进入 playground session（modelId=default，配了 default_models.chat=modelA）→ 看 input-bar 左下 | 模型图标 + 「a」label 显示；hover tooltip「a（默认）」 |
| UC-4.2 | 承上 → 点图标 → 看菜单 | 菜单向左上展开；顶部「a (默认)」有 ✓；完整列表 a 再出现一次（无 ✓） |
| UC-4.3 | 承上 → 点顶部「a (默认)」 | 菜单关闭；session.modelId 仍为 `"default"`（实际未变） |
| UC-4.4 | 承上 → 点完整列表里的「a」 | 菜单关闭；PUT session `modelId = "<pid>:<aId>"`；trigger tooltip 变「a」（不带「默认」） |
| UC-4.5 | 承上 → 改 default_models.chat = modelB → 回到 session | tooltip 变「b」（之前选固定 a 的 session 不变） |
| UC-4.6 | 新建 session（无 default_models.chat）→ 看图标 + tooltip | 图标 + 「未配置」灰；tooltip「未配置」 |
| UC-4.7 | 承上 → 点图标 → 看菜单 | 无顶部「默认」区；仅完整列表；任选一项 → 写具体 ModelRef |
| UC-4.8 | session running 中 → 看图标 | 图标 disabled（不响应点击，但仍可见） |
| UC-4.9 | 进 subagent chat page → 看 topbar | subagent readOnly 分支：chat-model-tag 显示 subagent modelId；input-bar 不挂模型图标 |
| UC-4.10 | hover 图标 → 等 500ms → tooltip 出现 | tooltip 不导致其他元素位移（fixed/absolute 定位） |

## 3. studio session 行为

- studio leader/mate session：input-bar 模型图标同 playground 规则
- 区别：「默认」= `squad.modelDefault`（per-squad），不是 `app_config.default_models.chat`
- 顶部「a (默认)」：仅当 `squad.modelDefault` 非空时显示
- 选「a (默认)」 → 写 session.modelId = `"default"`
- squad chat page（路由器）：不挂模型图标（无 input-bar）

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

### P6：模型选择器（输入框内图标 → 菜单 → 默认a/固定a）
- 链路：
  1. 配 `default_models.chat=modelA` → 新建 session → 看 input-bar 图标 + tooltip
  2. 点图标 → 菜单顶部「a (默认)」+ 完整列表 a 重复一次
  3. 选「a (默认)」 → session.modelId = "default"（不变）
  4. 选列表里「a」 → session.modelId = 具体固定值
  5. 改 default_models.chat → 选「默认」的 session 跟随；选「固定 a」的不变
- 关键断言：
  - trigger 位置在 input-bar 左下（不在 topbar）
  - 菜单向**左上方**延伸
  - 默认a + 完整列表 a 重复（双项语义正确）
  - tooltip 显示当前 model 状态（a (默认) / 未配置 / 具体 b）
- UC：UC-4.1 + UC-4.2 + UC-4.4 + UC-4.5

### P7（部分覆盖）：新建 session `modelId=default`
- 链路：新建 session → 看 session record `modelId === "default"` → input-bar 图标显示「默认 a」（如配了）或「未配置」
- 关键断言：
  - 新建 session 默认值 `"default"`（不是 undefined）
  - 图标 + tooltip 显示符合三态语义
- UC：UC-4.1 + UC-4.6

## 5. 对齐 ui/tech spec（MANDATORY）

### 5.1 直接复用
- `chat-model-picker` testid（沿用 v0.0.7 — 仅 trigger 位置变，testid 不变）
- `chat-input-bar` 容器（v0.0.8 起存在）
- `primitive-tooltip`（v0.0.25 引入）
- providers group 数据 → enabled provider + enabled 文本 model 过滤逻辑
- `provider-save` 流程（与本工作块无关，仅引用）

### 5.2 需 arch 补/改 ui/tech spec
- **N7**（input-bar 内 ModelPicker）：
  - ui `specs/ui/components/chat-page/component-input-model-picker.md` 新增：定义 trigger 视觉 + tooltip 三态 + 菜单双场景 + 左上展开方向
  - ui `specs/ui/components/chat-page/_overview.md §4.X` 加条：input-bar 内挂 ModelPicker（替代 topbar ModelPicker 在非 readOnly 分支）
  - ui `specs/ui/components/chat-page/_components.md` 组件清单加 `component-input-model-picker`
  - tech 无（resolve 链工作块 ③ 已定义；UI 仅写 modelId）
- **API**：
  - `PUT /session/:id` body.modelId 接受 `"default"` / 具体 ModelRef（保留字语义工作块 ③ 已定义）
- **testid 沿用**：
  - `chat-model-picker`（trigger，沿用 — 仅位置变）
  - `chat-model-tag`（readOnly 分支，沿用）
  - 新增：`model-picker-menu`（菜单容器）/ `model-picker-default-item`（顶部「a (默认)」）/ `model-picker-item-<providerId>-<modelId>`（完整列表项）

## 6. 不在本工作块

- resolve 链具体逻辑（工作块 ③）
- session.modelId 保留字 schema 改动（工作块 ③ N5）
- providers/user_memory/observability 等 group 内容交互（保持现状）
