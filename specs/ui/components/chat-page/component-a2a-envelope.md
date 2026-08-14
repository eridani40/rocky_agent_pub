# component-a2a-envelope（a2a 消息信封折叠）

> 层级: component
> 文件: app/web/src/components/chat-page/component-a2a-envelope.tsx
> since: v0.0.295（新组件）

## 消费方

- `components/chat-page/component-message-stream.tsx`

## 职责

群聊 + member 单聊中 a2a 消息的收起/展开展示，双方向：
- **in 方向**（a2a inbox，v0.0.295）：message-stream 共享内核 `isA2aInbox(msg)` 分支统一装配，两视图同走本组件。收起态渲染为信封闭合 icon + senderName（不显示正文），点击切换到展开态——信封打开 icon + senderName + 灰色气泡正文（`PrimitiveBubble variant='a2a'`）。
- **out 方向**（send_message 信封，v0.0.310）：message-stream 对 `send-message-envelope` row 装配，`direction="out"` 信封 + senderName=targetName，`status` 控制 sending/done/error 三态。**targetName 语义（[v0.0.340]）**：后端 `resolveTargetDisplayName` 优先级 = ① AgentRef.name（LLM 已填）→ ② **memberStore 反查实时成员名**（target session 有 squadId+memberId 且 rtc.memberStore；成员名权威源 = memberStore）→ ③ session.title（subagent/squad chat/standalone 等 non-squad-member fallback）→ ④ undefined——**改名后信封显示新名，与 roster 永远一致**（不再读创建时 title 快照）。

**边界**：用于群聊 + member 单聊的 a2a 消息（in：message-stream 共享内核按 `isA2aInbox(msg)` 装配；out：`send-message-envelope` row 装配，均不区分视图）；不处理 a2a 消息的数据获取或排序（由 message-stream + sideOfMessage/memberSideResolver 决定渲染位置）。

**头像（v0.0.301）**：a2a 信封行左侧头像为**原 MemberAvatar 对象 invisible** —— actor 解析（`chat-actor-strategy.tsx`）对 a2a inbox 分支返回 `<div className="w-9 shrink-0 invisible"><MemberAvatar …/></div>`（保留原头像对象，仅外层 invisible 隐藏；w-9 列同 MemberAvatar md 尺寸），message-stream 渲染该包裹保持头像列位置 100% 保真，**信封位置不动**、未来恢复容易。senderName 仍由信封组件 header 承载。

## Props

```ts
interface A2aEnvelopeProps {
  /** 消息正文（展开态气泡内渲染的内容） */
  children?: ReactNode;
  /** 对端名字（in=senderName, out=targetName） */
  senderName: string;
  /** 方向：in（a2a inbox）/ out（send_message 信封，v0.0.310） */
  direction?: 'in' | 'out';
  /** out 信封状态：sending（投递中）/ done（已投递）/ error（失败） */
  status?: 'sending' | 'done' | 'error';
  /** error 正文（status=error 时展开显示） */
  errorContent?: ReactNode;
}
```

## 状态 / 交互

- **收起态（默认）**：信封闭合 SVG icon + senderName 文本，无正文。视觉紧凑（行内高度，不占多余空间）。
- **点击展开**：点击信封区域 → 切换到展开态。本地 state（`useState<boolean>`），不受控。
- **展开态**：信封打开 SVG icon + senderName + 灰色气泡正文（`PrimitiveBubble variant='a2a'`，`bg-muted/40 border-border`）。正文为 markdown 渲染（复用 `PrimitiveMarkdownView`）。
- **再点击收起**：展开态点击 → 回到收起态。
- **可访问**：信封区域为 `<button>` 语义 + `aria-expanded`（收起=false / 展开=true）+ `aria-label`（含 senderName，如「展开 a2a 消息：{senderName}」）。

### out 信封正文 / error 提取（message-stream 侧装配，v0.0.311 + v0.0.331）

- **正文**：`extractSendMessageBody(argContent)`（`component-message-stream.tsx` 文件级导出，v0.0.331）——从 `envRow.arguments['content']` 容错提取，四形态：① string → 直接当正文；② array → 每块 `typeof c==='object' && typeof c.text==='string'` 取 text join('\n')（**不读 type 过滤**，缺 type 按默认 text——历史脏数据兜底）；③ object → `.item ?? obj` 解包（payload string 直接用 / payload.text string 用 text / payload array 递归）；④ 其他 → `''`。与后端 `normalizeContentBlocks` 对齐（见 `multi_agent/[P1]subagent_derivation.md §5.1`）。
- **error 正文**：`status === 'error'` 时从 result 提取失败原因；**`_rawTruncated === true`（参数截断）时显示「发送失败（参数截断）」，优先于 result 提取**（v0.0.331 P1'，第二类空白可见化）。

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
