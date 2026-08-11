# component-pending-approval-card

> 层级：`component-`（功能组件，含业务语义）。组合 primitive（button/tooltip）。
> 归属一级目录：`chat-page/`（与 component-pending-question-card / component-enqueue-view 同级）。
> 后端契约：`specs/api/overall/04-agent-session.md §3.2`（POST /messages toolReply, handleType='approval'）+ `§3.6`（GET /pending-tool-call recover）+ agent_event（require_human_input payload=pending）
> 同构参照：`component-pending-question-card.md`（提问卡，位置/驱动/可见性模式一致）

## 消费方

- `components/chat-page/base-chat-input-bar.tsx`

## 3. 职责
- 渲染队首 `subState==='need_approval'` 的 PendingToolCall（data=ApprovalData）：工具名 + 参数（bash 即 `command`）+ 拦截原因（reason）。
- 三按钮触发回填：同意（allow）/ 拒绝（deny）/ 永远同意（allow_always）→ `submitReply(toolCallId, 'approval', {decision})`。
- 只渲染 `need_approval`；`need_feedback` 防御性返回 null（交提问卡）。

## Props
- pending: PendingToolCallView
- onSubmit: (toolCallId: string, handleType: 'approval', payload: { decision: '...

## 状态 / 交互（MANDATORY — 决策锁定）
   - 命令区：`arguments.command` 用**等宽字体**块展示（bash 场景；非 bash 工具展示 `JSON.stringify(arguments)`）。
2. **三按钮**（一行，右侧或底部一排）：
   - 点任一按钮 → 前端乐观清 pendingToolCall（卡片立即 unmount，或 reducer 切下一个）→ POST /messages toolReply。
3. **无取消 / 跳过按钮**（同提问卡 INV-7）：composer 提问态**保持可用**（不禁用）。用户放弃 → 直接 composer 打 query 回车 → 走 c 路径（后端清空 pending + 占位原样发 LLM）。三按钮是唯一显式出口。
4. composer + 审批卡并存（INV-7），mention 系统不受影响。
5. `key=toolCallId`：切换不同 pending 时天然 remount（本地态重置，多 pending 串行 INV-4）。

## 视觉基线
- 复用 chat-page 现有卡片视觉（accent-surface 底 + 圆角 + 边框，同提问卡）。
- 命令区用等宽字体（mono）+ 浅底代码块样式；拦截原因用警示色（accent/warning）文案。
- 三按钮：同意 = 主按钮（accent）；拒绝 = 次要/危险色；永远同意 = 次要按钮。具体尺寸/配色沿用现成控件（_conventions §9 无设计稿时沿用现成）。
- 「?」列表指示器（conv-item）见 `_overview.md §4.2`（suspended 态，与提问卡共用）。

## 复用关系
- `component-chat-composer`：提问态不禁用（INV-7），用户可发 query 触发放弃。
- `useMessages`（chat_area_hooks）：订阅 `require_human_input` → 驱动本卡 mount/切换（与提问卡共用
- `component-conversation-item`：suspended 态显示「?」指示器（与提问卡共用）。
- `base-chat-input-bar`：统一挂载点（pendingToolCall.subState 分流：need_approval → 本卡，need_feedback → 提问卡，同位互斥）；数据由 `SectionChatSession` 经 `component-chat-session-input` 按 `capabilities.hitl` 透传（关闭时置 null 不 mount）——7 页同源，无逐页挂载。
