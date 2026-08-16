type: component
purpose: chat-input-bar 底部按钮行内的模型选择器（21px 图标 trigger + hover/click 合并菜单 + 菜单右对齐左上延伸 + 前缩略 + 默认a/固定a 双项语义）
since: v0.0.89
updated: 2026-08-15

# component-input-model-picker

> 数据源: 挂载拉 providers (`useProviders`) + `GET /config/app?group=default_models&key=chat`（拉 defaultA，playground 场景）；选中值经父级 PUT /session/:id 持久化；无 SSE。

## 消费方

- `components/academy-page/component-tuple-cards.tsx`
- `components/chat-page/component-chat-session-input.tsx`

## 1. 职责
- **21px 纯图标 trigger**（BrainIcon，无内联文字），位于按钮行最左
- **hover → 单行预览菜单**：只展示「当前选的模型」这一项（菜单样式），或「未配置」——[r2] 取代原 primitive-tooltip 文本
- **click → 完整菜单**：默认项（若配了 defaultA）+ 全部选项
- **hover 与 click 共用同一菜单样式**（同容器 className / 同几何 / 同前缩略），差别仅在内容条数（1 条 vs 全量）
- 双项语义：配了 default → 顶部「a(默认)」+ 完整列表（a 重复）；未配 → 仅完整列表
- **[v0.0.357] 默认语义双维度**：默认 = 默认模型 **or** 挂载方案（T6 互斥，方案优先）。`defaultPlan` prop（chrome.defaultRoutingPlan）提供方案维度默认；`hasDefaultRoute = hasDefault || hasPlan`，方案态 hover/菜单默认项显「方案 · 名（默认）」（i18n `planDefaultLabel`），onClick 复用保留字 `{providerId:'',modelId:'default'}`（写回后端零改动）
- **disabled 语义（v0.0.351）**：prop 保留可禁用；主消费方 `component-chat-session-input.tsx` 恒传 `disabled={false}`——**运行中可编辑**，改模型经 PUT /session/:id 落库、main run 下轮 iteration 边界 `refreshRuntimeConfig` 生效（specs/api/overall/04a-session-chrome.md §5）

## 3. trigger + hover 预览 + click 菜单（四态）
| model 状态 | trigger 图标色调 | hover 预览内容（1 条） | click 菜单 |
|---|---|---|---|
| default + 配了 defaultA | accent/fg | `a（默认）`（selected 态高亮） | 默认项 + 全量 |
| default + 挂方案（无 defaultA，v0.0.357） | accent/fg | `方案 · <名>（默认）`（selected 态高亮） | 默认项（方案态 label）+ 全量 |
| default + 未配 defaultA 且无方案 | muted | `未配置`（muted） | 全量（无默认项） |
| 具体 modelB | accent/fg | `b` 或 `provider / b`（selected 态高亮） | 全量（b 项 selected）+ 默认项（若有 defaultRoute） |
| null（studio inherit 回退态） | accent/fg | 对应 defaultA / 方案名 或 `未配置` | 同 default 态 |
> hover 预览 = 把「当前生效的那一项」单独以菜单项样式展示（selected 高亮），让用户 hover 即知当前模型，**不必读图标色调**。click 才给完整选择列表。

## 复用关系
- **删 `PrimitiveTooltip`**（r2：hover 改预览菜单，不再用文本 tooltip）
- **不复用** `chat/ModelPicker`（保留供 modal/panel 场景）
- 单文件 ≤300 行
- 布局位移：trigger in-flow（占位稳定）+ 菜单脱流（absolute）

## 视觉基线
### 9.1 action-button 尺寸（跨 3 chat section 共享）
- 21px = 原 32px 的 ~2/3（用户 r2 明确定值）
### 9.3 菜单题目行（picker UI 统一）
click 菜单顶部统一题目行（`PickerMenuHeader` 共享子组件，3 个 input picker 共用以保视觉一致）：
