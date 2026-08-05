# component-empty-state

> 层级: component
> 文件: app/web/src/components/chat-page/component-empty-state.tsx

## 职责
会话空态（idle hero）：品牌 orb + Playground eyebrow + 引导副文案 + 主 CTA「新建对话」+ 3 个 quick-chip 快捷入口。承载两种状态（无 active 会话 / active 空会话）——input-bar 是否伴随由父级决定。
边界：无装饰动画（严肃基调）；不依赖业务 store；hex 归零（配色全走 token）；chip 点击 = 新建会话，不预填 prompt / 不发明新功能。

## Props
- onNewConversation: () => void

## 状态 / 交互
- 无状态。
- 点 CTA → `onNewConversation`。
- 点任一 quick-chip → `onNewConversation`。
- 无移动 / 弹跳 / 呼吸动画（严肃基调）；CTA hover 只切背景色 `--btn-primary-bg → --btn-primary-hover`；chip hover 只切 border 颜色（`--border → --border-2`）+ 加 `--shadow-xs`。

## 视觉基线
- **设计稿**：（idle hero 权威源，main :85-105 + style :12-35）。
- **布局**：，垂直堆叠 orb → eyebrow → sub → CTA → quick-row。
- **quick-row**：（28px）。
- **字体**：Inter 14px/600 sans（CTA） + JetBrains Mono 11px（eyebrow）；无衬线字（INV-4）。

## 复用关系
- 被组合: `page-chat`（playground 空态，经 `SectionChatSession` 的 `emptyStateSlot` 注入）；其他消费方走 SectionChatSession 缺省空文案，不使用本组件
