# component-chat-topbar-back-btn

> 层级: primitive（共享 chat 基质）
> 文件: app/web/src/components/chat-page/component-chat-topbar-back-btn.tsx

## 职责
chat-topbar 左侧的「返回」按钮 primitive——ghost 型灰底 + ChevronLeftIcon + i18n `common:action.back` 文案。被各板块 chat topbarLeft slot 消费，消费方门控是否渲染（如 from='seats' 时）。
边界：纯 stateless UI + onClick 回调；不感知板块语义（消费方门控渲染时机）；不处理 back 逻辑（onClick 上抛父级）。

## Props
- onClick: () => void
- testId?: string;                  // 默认 'chat-topbar-back-btn'
- actionKey?: string;               // ET 稳定语义锚点 data-action-key（命名见 _conventions §12.8）；共享基质由消费方按板块语义传入，缺省不渲染属性

## 状态 / 交互
- **布局稳定 INV-6**：出现/消失前后 title 元素 x-offset 不变—— 固定高度 + flex gap-1（父级 slot 用 flex 序列，back 前置不推挤）
- 12px 文案，14px ChevronLeftIcon

## 视觉基线
- 图标：ChevronLeftIcon 14px（来自 `chat-page/icons.tsx`，SVG path `M15 18l-6-6 6-6`）

## 复用关系
- `chat-page/section-chat-session.tsx`（`onBack` 存在即前置渲染，actionKey 由消费方经 `backActionKey` prop 传入，缺省 `chat.session.back`）
- studio `component-panorama-route.tsx` / `component-token-stats-route.tsx`（板块级返回）
