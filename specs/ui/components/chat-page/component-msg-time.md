# component-msg-time

> 层级: primitive（chat-page 内部 primitive，不放 framework/ 因绑定 message 上下文）
> 文件: app/web/src/components/chat-page/component-msg-time.tsx

## 职责
在每条消息 bubble（user / agent）后方渲染一行**极小 mono 时间戳**（当日 `HH:mm`，跨日 `MM-dd HH:mm`）。
- **只做展示**：接受 ISO 字符串 + side，不做数据订阅、不感知消息内容。
- **不做交互**：无 hover tooltip、无点击（严肃基调）。
- **不做本地化**：不走 i18n（纯数字/mono，locale 无关）。

## Props
- iso: string
- side: 'user' | 'assistant'
- testId?: string

## 状态 / 交互
- **纯静态**：无 state、无 effect、无 event handler
- **降级**：`iso` 为空字符串或 `formatMsgTime` 兜底返 `''` 时，组件**返回 null**（不渲染 DOM，也不占位）

## 视觉基线
- **字号**：
- **字重**：（默认，不加粗）
- **字体**：（等宽，视觉对齐）
- **颜色**：`text-[var(--muted-2)]`（银灰体系最浅字色，不抢戏）

## 复用关系
- **被 `component-message-stream` 组合**：在 user / agent 分支的 bubble 后插入
- **组合**：无（叶子 primitive）
