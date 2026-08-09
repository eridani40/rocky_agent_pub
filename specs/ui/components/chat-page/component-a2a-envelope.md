# component-a2a-envelope（a2a 消息信封折叠）

> 层级: component
> 文件: app/web/src/components/chat-page/component-a2a-envelope.tsx
> since: v0.0.295（新组件）

## 职责

群聊 + member 单聊中 a2a inbox 消息的收起/展开展示（message-stream 共享内核 `isA2aInbox(msg)` 分支统一装配，两视图同走本组件）。收起态渲染为信封闭合 icon + senderName（不显示正文），点击切换到展开态——信封打开 icon + senderName + 灰色气泡正文（`PrimitiveBubble variant='a2a'`）。

**边界**：用于群聊 + member 单聊的 a2a inbox 消息（message-stream 共享内核按 `isA2aInbox(msg)` 装配，不区分视图）；不处理 a2a 消息的数据获取或排序（由 message-stream + sideOfMessage/memberSideResolver 决定渲染位置）。

**头像（v0.0.301）**：a2a 信封行左侧头像为**原 MemberAvatar 对象 invisible** —— actor 解析（`chat-actor-strategy.tsx`）对 a2a inbox 分支返回 `<div className="w-9 shrink-0 invisible"><MemberAvatar …/></div>`（保留原头像对象，仅外层 invisible 隐藏；w-9 列同 MemberAvatar md 尺寸），message-stream 渲染该包裹保持头像列位置 100% 保真，**信封位置不动**、未来恢复容易。senderName 仍由信封组件 header 承载。

## Props

```ts
interface A2aEnvelopeProps {
  /** 消息正文（展开态气泡内渲染的内容） */
  children: ReactNode;
  /** 发送方名称（收起/展开态 header 显示） */
  senderName: string;
}
```

## 状态 / 交互

- **收起态（默认）**：信封闭合 SVG icon + senderName 文本，无正文。视觉紧凑（行内高度，不占多余空间）。
- **点击展开**：点击信封区域 → 切换到展开态。本地 state（`useState<boolean>`），不受控。
- **展开态**：信封打开 SVG icon + senderName + 灰色气泡正文（`PrimitiveBubble variant='a2a'`，`bg-muted/40 border-border`）。正文为 markdown 渲染（复用 `PrimitiveMarkdownView`）。
- **再点击收起**：展开态点击 → 回到收起态。
- **可访问**：信封区域为 `<button>` 语义 + `aria-expanded`（收起=false / 展开=true）+ `aria-label`（含 senderName，如「展开 a2a 消息：{senderName}」）。

## 复用关系

- **组合**：由 `component-message-stream.tsx` 共享内核按 `isA2aInbox(msg)` 分支装配（群聊/单聊统一；a2a 归 assistant 侧左列 → 用本组件包裹）。
- **消费 primitive**：`PrimitiveBubble variant='a2a'`（灰色气泡，见 `primitive-bubble.md`）+ `PrimitiveMarkdownView`（正文 markdown）。
- **icon**：信封 SVG icon（`chat-page/icons.tsx`，闭合/打开两态，非 emoji）。

## 视觉基线

> 无独立设计稿——走既有 design system token（参照 message-stream 左侧气泡基线）。

- **收起态**：行内 flex（`inline-flex items-center gap-1.5`），信封闭合 SVG icon（`w-4 h-4 text-muted`）+ senderName（`text-xs text-muted font-mono`）；整体 `cursor-pointer` + hover `text-fg-2` 过渡。
- **展开态 header**：同收起态布局，icon 换为信封打开 SVG（同尺寸同色）。
- **展开态正文**：`PrimitiveBubble variant='a2a'`（`bg-muted/40 border-border rounded-lg px-3 py-2`），内含 `PrimitiveMarkdownView`；max-w 对齐左侧消息列宽度（`max-w-[680px]`）。
- **配色**：全 token / tailwind utility（`text-muted` / `bg-muted/40` / `border-border`），零字面 hex。
- 无 vision_check compare（无设计稿）。
