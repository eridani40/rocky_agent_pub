# component-chat-right-overlay（聊天区右缘统一 overlay 容器）

> 层级: component
> 文件: app/web/src/components/chat-page/component-chat-right-overlay.tsx
> （coder T2 前置产出）
> 视觉参考: 无设计稿——纯定位容器，无自身视觉外观（承载内容各自有基线）。

## 1. 定位 + 设计意图（一句话）

## Props
- sessionId: string
- hideCron?: boolean
- bars: MinimapBar[]
- anchorTestid: (messageId: string) => string
- children?: ReactNode

## 3. 布局 / 定位（MANDATORY）
- 容器 `absolute inset-y-0 right-3 z-[var(--z-floating)] flex flex-col items-end pointer-events-none`——**纵向铺满定位上下文（ = top:0 + bottom:0）**、右缘 12px 贴边；`pointer-events-none` 容器。仍为 **absolute 悬浮**（不做实体 gutter 列，用户硬约束）。
- **内部纵向分配（ 改，原  堆顶）**：
  - 悬浮菜单（`children` 插槽）包裹 ——贴顶部、与 topbar 留 12px 距。 插槽 div 去 `pointer-events-auto`（Invariant B：仅 footprint auto，由 `chat-float-menu` 根显式 auto）。
  - minimap 包裹 ——占满菜单下方剩余纵向空间、**纵向居中**、贴右； 打通 flex 链允许收缩。**修复 v0.0.131 遗留「minimap 堆顶应在中间」问题（F1）。** 插槽 div 去 `pointer-events-auto`。
- **定位上下文前提（ 改）**： 的定位基准**不再是各 chat root 的 section 根**，而是**消息区 wrapper**——3 处 chat root 把 `{empty 占位 / ComponentMessageStream} + {Overlay}` 同包进一层 `<div className="flex-1 flex flex-col relative min-h-0 min-w-0 overflow-hidden">`（input-bar 留 wrapper 外）。wrapper 的  = overlay 定位基准（ 指 wrapper 高 = 消息区高度）； 杀横向滚动（F3）； 打通 flex 链。3 处 root统一该 wrapper 形态。

## 复用关系
- 组合（child）：`component-chat-float-menu`（上，通过 `children` 插槽传入，见 §7）+ `component-h
