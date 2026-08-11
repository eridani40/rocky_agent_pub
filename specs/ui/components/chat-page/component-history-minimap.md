# component-history-minimap（历史 query minimap）

> 层级: component
> 文件: app/web/src/components/chat-page/component-history-minimap.tsx
> 本文是历史 query minimap 的**概念权威源**：数据契约（bar 派生）+ 交互（Dock 悬停 / 预览 / 跳转）+ testid + 视觉基线。

## 消费方

- `components/chat-page/component-chat-right-overlay.tsx`

## 1. 定位 + 设计意图（一句话）
聊天区（chat-detail）右缘一列纵向堆叠的小横条（bar），每条对应会话中一条「渲染为**右侧 user 气泡**的历史消息」。悬停 Dock 放大 + 左侧预览气泡（query + 回答头部截断），点击滚动跳转到该 query 消息。**仅作定位辅助，不展全文**。三处 chat 页（playground / studio 单聊 / studio 群聊）统一复用同组件（由 `component-chat-right-overlay` 承载，见 §7）。

## 复用关系
- **为什么按侧别而非 kind**：a2a inbox 消息 `role:'user'` 也产 `user-text` 元素（`squad-chat-hel
- 单聊（`memberSideResolver`）：a2a inbox→**左侧（assistant 侧）**→**不产 bar**（与 assistant 消息一致，minimap 只索引右侧 user 气泡）；群聊（默认 `sideOfMessag
- `DEFAULT_BLOCK_FILTER` 已在 flatten 层滤 `isSystemReminder` text block（不产 user-tex

## Props
- bars: MinimapBar[]
- anchorTestid: (messageId: string) => string

## 4. 状态 / 交互
- **常态**：bar 竖排（时间序上→下 = 旧→新），等高（约 3px 高）小横条，右对齐（贴右缘，向左延伸）。muted 底色。
- **悬停 Dock 放大（CSS width transition，MANDATORY 布局稳定）**：`hoverIndex` state（`onMouseEnter`/`Leave` 每 bar 记录）。每 bar 宽度按到 hoverIndex 的距离梯度：`dist=0→28px / 1→24px / 2→20px / 3→16px / 其余→常态 6px`。bar **右对齐向左延伸**（ / 容器右锚），放大**绝不推动相邻/外部元素**——bar 在固定宽 overlay 容器内、宽度变化只吃容器内留白。hover bar 变 accent 色。移开恢复常态（transition 0.15s）。
- **悬停预览气泡（`history-minimap-preview`，bar 左侧弹出）**：hoverIndex 非空时渲染，绝对定位于 hovered bar 左侧（`right: 100%` + 垂直对齐该 bar）。白底 rounded-12 shadow（复用现有 popover 同源风格，如 usage-expand 的 ）。
  - 出现/消失用 `visibility`/`opacity`（overlay 脱离流），不推动布局。
- **点击跳转（footprint 任意位置命中， 改）**：只要 `hoverIndex != null`（区域内有 bar 被放大激活），点击 minimap footprint（`pointer-events-auto` 根容器）内任意位置 → 跳转到当前 `hoverIndex` 对应的 bar（`jumpTo(bars[hoverIndex].messageId)`）。命中区从单 bar ≈6×3px 扩大到整个 footprint（w-8 列），解决「bar 太小须精确命中」问题。`hoverIndex == null`（未 hover 任何 bar）时点击不跳转（no-op）。点击事件由 footprint 根容器 `onClick` 统一处理，per-bar 不再绑 `onClick`（避免双触发）；per-bar `onMouseEnter` 仍按 bar 精度设定 `hoverIndex`，容器 `onMouseLeave` 清空。

## 视觉基线
- bar：常态  muted 小横条（`bg-[var(--color-muted)]` 透明度低）；hover → `bg-[var(--color-accent)]`；圆角 ；Dock 宽度 CSS transition。
- 预览气泡：（复用 popover 同源）；行1 fg 加粗；行2 muted 小字； 防遮正文。
- idle 空态（无 bar）：不渲染 bar（无独立空态图，minimap 空 = 无内容）。
- 无 vision_check compare（无设计稿）。
