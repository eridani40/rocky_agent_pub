# component-scroll-guide-bubble（聊天滚动引导气泡）

> 层级: component
> 文件: app/web/src/components/chat-page/component-scroll-guide-bubble.tsx
> 版本: v0.0.262（新组件）

## 职责

用户不在消息流底部（`nearBottom=false`）且会话非空时，在消息区底部（输入框上方）**浮动**显示引导气泡——LLM 生成中提示「新消息」、空闲/已结束提示「回到底部」，点击平滑滚到底部。

边界：**不占文档流**（absolute 定位，出现/消失不得致任何元素位移——布局稳定性 MANDATORY）；**不引入 runActive 之外的「是否有新内容」判定字段**（PRD §6 边界，文案 = runActive 二元）；不负责 nearBottom 的计算（消费 hook 暴露值）。

## Props

```ts
interface ScrollGuideBubbleProps {
  /** 是否在底部附近（false = 用户翻走，气泡显示） */
  nearBottom: boolean;
  /** run 进行中（决定文案：新消息 vs 回到底部；不决定显隐） */
  runActive: boolean;
  /** 会话是否有消息（空会话不显示气泡，走既有空态分支） */
  hasMessages: boolean;
  /** 点击滚底回调（装配层传 scrollToBottom('smooth')） */
  onScrollToBottom: () => void;
}
```

## 状态 / 交互

- **显示条件**：`visible = !nearBottom && hasMessages`（PRD §2.2）。
- **文案**：`label = runActive ? t('scrollGuide.newMessage') : t('scrollGuide.backToBottom')`（「新消息」/「回到底部」）。
- **aria-label**：`runActive ? t('scrollGuide.ariaLabel.newMessage') : t('scrollGuide.ariaLabel.backToBottom')`（「查看新消息」/「回到底部」——比可见文案更完整的可访问语义）。
- **点击**：调 `onScrollToBottom()`（装配层 = `scrollToBottom('smooth')` 平滑滚底）。
- **过渡**：visible 用 `opacity + pointer-events + translate-y` 控制（fade + 轻微上移，`transition-all duration-200`），**不 unmount**（隐藏态仅 `opacity-0 pointer-events-none translate-y-1`，按钮始终在 DOM，保动画平滑）。
- **可访问**：`<button type="button">` 语义 + aria-label（E2E 定位契约 = 可见文案「新消息」/「回到底部」+ aria-label）。

## 复用关系

- **组合**：由 `component-message-stream.tsx` 装配（`nearBottom`/`scrollToBottom` 来自 `useMessageScrollPagination` hook，`runActive` 来自 props，`hasMessages = messages.length > 0`）；挂载点 = scroll 容器外包 relative wrapper 内（absolute 定位上下文）。
- **消费方**：所有经 `SectionChatSession` 接入的聊天页（playground / studio 单聊群聊 / academy×4）自动生效——滚动逻辑与气泡在共享内核（ComponentMessageStream + useMessageScrollPagination），不逐页接入。
- **数据源**：`useMessageScrollPagination`（`_overview.md §4.5`）+ `useMessages` ctx `runActive`（`specs/tech/app/frontend/[P0]chat_area_hooks.md §3`）。
- **icon**：`ChevronIcon`（chat-page/icons.tsx，默认向下箭头 = 「下方有内容」语义）。

## 视觉基线

> 无设计稿（PRD §7 视觉保真门禁跳过 vision_check compare）——走既有 design system 胶囊基线（参照 tool-batch / run-state pill）。

- **定位**：`absolute left-1/2 -translate-x-1/2 bottom-3 z-20`（贴消息流可视区底部边缘、水平居中于消息区，对齐 820px 内容列中心）。
- **容器**：`inline-flex items-center gap-1.5 border border-border rounded-full px-3 py-1.5`（轻量胶囊）。
- **字体**：`text-[11px] font-mono font-medium`（JetBrains Mono 族）。
- **配色**：文字/图标 `text-accent`（主色）；底 `bg-surface-2`；边框 `border-border`；阴影 `shadow-md`；hover `hover:bg-surface-2 hover:border-[var(--color-muted)]`。
- **尺寸**：紧凑（高约 28px 量级），不遮挡消息内容主区；`cursor-pointer` 指示可点。
- **INV 对齐**：全 token/tailwind utility，零字面 hex（INV-2）；无 keyframes 动画（INV-3，仅 transition 过渡）。
