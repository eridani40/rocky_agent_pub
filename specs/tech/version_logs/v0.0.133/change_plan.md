# v0.0.133 变更计划书 — 会话区布局修复（v0.0.131 遗留 4 问题）

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。事后偏差写进 `change_log.md`。
>
> **纯布局修复版本**：零 API / 数据 / testid / 功能契约变更（v0.0.131 全部沿用）。仅改 className 与少量容器结构。
>
> **用户关键约束（2026-07-13 澄清）**：「右侧应该是悬浮的，这个没问题。但是不代表大家位置无法规划好。」→ **overlay 保持 absolute 悬浮**，修复靠「规划位置」：消息区右侧预留空间让头像左移、消除横向滚动、minimap 居中、文字换行。**不做实体 gutter 列。**

## 四个问题 → 修复映射

| # | 问题 | 修复 (F) |
|---|------|---------|
| 1 | minimap 在顶部，应在中间 | F1：overlay 改 `inset-y-0` 纵向铺满消息区，minimap `flex-1 items-center` 居中 |
| 2 | 「you」头像没左移让位 | F2：消息流加右侧 reserve padding（悬浮 overlay 浮在预留区），居中内容左移 |
| 3 | 对话区横向滚动 | F3：消息区包 `relative overflow-hidden min-w-0` 容器 + `min-w-0` 链贯通 |
| 4 | 文字不换行被撑宽 | F4：`PrimitiveBubble` + `PrimitiveMarkdownView` 加 `break-words` |

## 列定义（8 列，行 = 一个组件/符号）

| 列 | 说明 |
|----|------|
| 模块 | 所属子系统 |
| 文件 | 相对路径 |
| 函数·符号 | 组件名 / className 锚点 |
| 类型 | 新增 / 修改 / 结构 |
| 变更内容 | 具体改什么 |
| 约束 | 必须满足 |
| 参考 | 依据 |
| 影响行 | 大致行号（coder 按实际） |

## 变更表

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|----------|------|---------|------|------|--------|
| chat-page | app/web/src/components/chat-page/component-chat-right-overlay.tsx | `ComponentChatRightOverlay` 根 div className | 修改 | `absolute right-3 top-16 ... flex flex-col items-end gap-3` → `absolute inset-y-0 right-3 z-20 flex flex-col items-end pointer-events-none`；children(float-menu) 包裹加 `pt-3`；minimap 包裹从无 flex 改为 `flex-1 flex items-center justify-end min-h-0`（纵向居中） | overlay 仍 absolute 悬浮（不做实体列）；float-menu 顶部、minimap 纵向居中；pointer-events gate 保留（容器 none + 子 auto）；z-20 不变 | F1；req.md 约束 | 31-43 |
| chat-page | app/web/src/components/chat-page/component-message-stream.tsx | `ComponentMessageStream` 根 scroll div className | 修改 | `flex-1 overflow-y-auto py-6 px-8 pb-[60px] flex flex-col gap-7` 的 `px-8` → `pl-8 pr-[80px]`（右侧 80px 预留悬浮 overlay 区） | 仅改右 padding；左 padding 不动；reserve 使居中 `max-w-[820px] mx-auto` 内容左移、右侧 user 头像让位；3 root 共享一致 | F2；req.md #2/#3 | 243 |
| chat-page | app/web/src/components/chat-page/section-chat-detail.tsx | `SectionChatDetail` 消息区结构 | 结构 | 在 `{isEmpty ? EmptyState : MessageStream}` + `{sessionId && Overlay}` 外包一层 `<div className="flex-1 flex flex-col relative min-h-0 min-w-0 overflow-hidden">`（input-bar 留在 wrapper 外） | wrapper = overlay 定位上下文（`inset-y-0` 指 wrapper 高 = 消息区）；`overflow-hidden` 杀横向滚动；EmptyState/MessageStream 仍 flex-1 填充 | F1/F3；req.md #3 | 230-261 |
| studio-page | app/web/src/components/studio-page/section-member-chat.tsx | `SectionMemberChat` 消息区结构 | 结构 | 同上：消息区（empty 占位 div 或 MessageStream）+ Overlay 包进 `flex-1 flex flex-col relative min-h-0 min-w-0 overflow-hidden` wrapper（input-bar 在外） | 同上；empty 占位 div 也要进 wrapper（保持 flex-1） | F1/F3 | 216-253 |
| studio-page | app/web/src/components/studio-page/section-squad-chat.tsx | `SectionSquadChat` 消息区结构 | 结构 | 同上 wrapper | 同上 | F1/F3 | 196-229 |
| common | app/web/src/components/common/primitive-bubble.tsx | `PrimitiveBubble` user/assistant 两态 className | 修改 | 两态 div className 末尾加 `break-words`（user 行 32、assistant 行 44） | 长 token/URL 在 `max-w-full` 内换行不撑宽；其余视觉不变 | F4；req.md #4 | 32,44 |
| common | app/web/src/components/common/primitive-markdown-view.tsx | `PrimitiveMarkdownView` root `<div>` + 段落 `<p>` className | 修改 | root `<div className={className}>` 加 `break-words min-w-0`；`<p className="my-0.5">` 加 `break-words` | markdown 段落长 token 换行；`min-w-0` 让 root 在 flex 链内可缩 | F4 | 264,258 |

## 不变项（明确排除，防越界）
- v0.0.131 所有功能 / 数据 hook / testid / 交互（minimap Dock 悬停、预览气泡、跳转、float-menu badge、modal 二级视图）—— **全部不动**。
- `deriveMinimapBars` / `useFlattenedView` / `useCronCrud` / `useMemoryCrud` —— 不动。
- `specs/api/` —— 不动（零后端变更）。
- input-bar 布局 —— 不动（用户未提；消息区 reserve 后输入区与消息区轻微错位属可接受已知点，验收由用户定）。
- 空态（empty-state）—— 除包进 wrapper 外不动其内容。

## 验证
- **无 ET**（用户裁决，自验）。
- UT 全绿（现有 v0.0.131 minimap/float-menu/message-stream UT 不破坏）+ `bun run typecheck` 0 error。
- 用户实机验证 4 问题消失。

## 影响面 / 风险
- **3 root 共享 message-stream 的 `pr-[80px]`**：所有用 ComponentMessageStream 的页（3 root）统一左移，一致无分歧。
- **wrapper 新增一层 div**：需保证 EmptyState / MessageStream 的 flex-1 在 `flex flex-col` wrapper 内仍正确填充（wrapper 必须是 flex-col）。
- **`overflow-hidden` wrapper**：clip 横向溢出；overlay 在 bounds 内不受影响；minimap 预览气泡向左伸入消息区（bounds 内）不被 clip。
