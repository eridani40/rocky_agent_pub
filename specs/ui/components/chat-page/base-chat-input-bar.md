type: component
purpose: 输入区组件级 base（slot 驱动 + HITL subState 分流两卡互斥，三 chat 页共用）
since: v0.0.155
updated: 2026-07-16

# base-chat-input-bar

## 1. 职责（管什么 / 不管什么）
**管什么（INV-E2 骨架 + HITL 分流）**：
- 输入区容器（`border-t + bg-surface-2` + max-w 居中）+ ChatComposer wrapper（textarea 上段）+ 按钮行容器（下段）。
- ComponentRunStateBar（enqueue 排队区；running spinner 由 message-stream 渲染不在此）。
- 发送/操作错误行（红字渲染在 input 下方）。
**不管什么（slot 注入）**：

## Props
- sessionId: string
- sessionRunning: boolean
- sessionState?: SessionState | null
- enqueueItems: EnqueueItem[]
- pendingToolCall?: PendingToolCallView | null
- onSubmitReply?: (toolCallId: string, handleType: 'direct_result' | 'approval'...
- onEnqueueCancel: (enqueueId: string) => void
- error?: string | null
- composerSlot: ReactNode
- buttonRowSlot: ReactNode
- containerTestid?: string
- maxWidthClass?: string

## 视觉基线
- 容器：（border-t 分割 + shrink-0 防压缩 + 横向 padding 8）
- composerSlot / buttonRowSlot 上下分离（r2 重设计）：composer  占满 + buttonRow  右对齐
