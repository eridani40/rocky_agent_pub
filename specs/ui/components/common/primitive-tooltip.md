# primitive-tooltip

> 层级: primitive（最小可复用单元，跨页面/跨组件复用）
> 文件: app/web/src/components/common/primitive-tooltip.tsx
> 关联: specs/ui/components/_conventions.md §2/§5/§9 · specs/ui/components/chat-page/_overview.md §4.13（component-run-finish error detail 展示，首个使用方）

## 职责
提供一个**轻量、hover/focus 触发的 tooltip 浮层**——包裹一个 trigger（子节点），鼠标 hover 或键盘 focus 到 trigger 时弹出一层内容（slot），离开/失焦即隐藏。**仅展示型**，不承载交互按钮（复杂交互请用 modal/popover）。
- 包裹 trigger，hover/focus 显示 content slot。
- 定位（默认上方，溢出自动翻转到下方）。
- 防溢出（max-width 限制 + 内容 pre-wrap）；浮层 ——宽度按内容算，不被窄 trigger 的 containing block shrink-to-fit 压成一列一字，超 max-width 才换行。

## Props
- content: React.ReactNode
- children: React.ReactNode
- side?: 'top' | 'bottom'
- arrow?: boolean
- triggers?: Array<'hover' | 'focus'>
- maxWidth?: number
- className?: string
- testId?: string

## 状态 / 交互
  - **进**（`hidden → visible`）：trigger 被 hover（mouse enter）/ focus（keyboard Tab）。
  - **出**（`visible → hidden`）：mouse leave / blur / Esc 键（Esc 兜底，避免键盘用户被困）。
  - **防抖**：进/出各加 ~100ms 延迟（避免鼠标快速划过抖动）；可用 CSS transition `opacity` 替代显式状态机（实现选其一，coder 决定）。
- **定位**：浮层默认在 trigger **上方**（`side='top'`，距 trigger 6px gap）；若上方空间不足（trigger 距 viewport top < 浮层高度 + 8px），自动翻转到**下方**。
- **水平居中**：浮层 horizontal center 对齐 trigger center；若右侧溢出 viewport，左移贴合 viewport right - 8px；左侧溢出同理右移。
- **不抢占焦点**：浮层本身 （仅展示，鼠标可穿过）；trigger 仍可点（若有 onClick）。
- **不占排版流**：浮层 （或 `fixed`），脱离文档流，**不影响 trigger 及相邻元素布局**——这是硬约束。
- **可访问性（MANDATORY）**：

## 视觉基线
> 无独立设计稿；基线沿用 chat-page 既有 mono meta 视觉（model-tag / KV value / loading 文案）+ dark surface 浮层风格，与 tokens.css 一致。
- **字体**：JetBrains Mono 11px。
- **尺寸**：padding `6px 10px`；max-width 360px（默认）；gap 6px（距 trigger）；圆角 （6px）。
- **边框/圆角**：1px `var(--color-border)` 实线；；arrow（可选）同色三角。

## 复用关系
- **被谁组合**（首用方）：`chat-page/component-run-finish.tsx`（§4.13 error 态，包裹 ⚠️ icon tr
- **后续可复用场景**（不强约束，coder 按需）：
- `framework/nav-rail` hover 图标文字说明。
- 设置页 provider/model 列表项的说明文案 hover。
- tool-call-item KV 长值（如完整 wire body）hover 展开。
