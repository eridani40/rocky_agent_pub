---
type: spec
title: Agent Event（AgentEvent 联合，topic=agent_loop）
priority: P0
status: active
updated: 2026-07-26
since: v0.0.8
---

# Agent Event

> **事件声明**（规范见 `../event/[P0]event_convention.md`）：
> - **依赖**：event_bus（transport）+ event_hub（路由），见 `../event/`
> - **topic**：`agent_loop`
> - **group**：`session_id:<sid>_amt:<runKind>`（amt = agent mode type；`main` / `summary` / `consolidate`，详见 `[P0]agent_interface.md` §5）
> - **producer**：agent_loop（ReAct 循环产出事件）+ **agent_manager（abort api 4 步收尾时 emit `message_enqueued` 重组 partial + `run_stop` 携带 stopReason=interrupted，详见 agent_interrupt.md §2/§6.7；enqueue cancel 入队 inbox 见 §3 `cancel`）**
> - **bus 持有者**：agent_manager（创建 AgentLoop 时注入 bus 实例，loop 用它 emit）
> - **Event 类型**：`AgentEvent`（§8 联合）
>
> 参见 `../../convention.md` 了解命名、ID、时间格式等全局约定。中断相关语义见 `[P0]agent_interrupt.md`（abort api 收尾事件 / partial interrupted message / StopReason=interrupted）；enqueue cancel 见 §4.3 `enqueued_message_canceled`。

## 1. 设计理念

AgentEvent 是 Agent 执行过程中的**流式进度单元**，用于实时通知前端和中间件。

EventBus / EventHub 是通用基础设施（见 `../event/`，寻址规范见 `../event/[P0]event_convention.md`）。本文档定义 **AgentEvent**——Agent 领域专属的事件类型（topic=`agent_loop`，见开头声明；与 session 面板流 topic=`session_panel` 区分，见 `../session/[P0]session_event.md`）。

**核心不变量**：一次 agent run 产生的 AgentEvent 序列，累积后恰好重建出对应的 Message。

---

## 2. AgentEventBase

所有 Agent 事件继承自 AgentEventBase：

```typescript
interface AgentEventBase {
  id: string;             // 事件自身 ULID
  type: AgentEventType;   // 事件类型（discriminated union key）
  sessionId: string;      // 归属 session（唯一一定存在的业务字段）
  runKind: RunKind;       // ★ run 种类闭合枚举："main" | "summary" | "consolidate"，决定 groupKey（详见 [P0]agent_interface.md §5/§7）
  createdAt: string;      // ISO 8601 UTC
  // ── 业务关联，按事件类型可选 ──
  messageId?: string;     // 关联的 Message ULID（content/message 级事件）
  runId?: string;         // 关联的 agent run ULID（run 内事件）
  enqueueId?: string;     // 关联的 inbox 入队句柄（enqueue 级事件）
}
```

---

## 3. 事件分类总览

| 分类 | 事件 | 模式 |
|------|------|------|
| **生命周期** | `run_start`, `run_end`, `message_start`, `message_end` | 一次性 |
| **enqueue** | `message_enqueued`, `enqueued_message_processed`, `enqueued_message_canceled` | 一次性 |
| **文本流** | `text_block_start`, `text_block_delta`, `text_block_end` | start→delta*→end |
| **思维流** | `reasoning_block_start`, `reasoning_block_delta`, `reasoning_block_end` | start→delta*→end |
| **图片流** | `image_block_start`, `image_block_delta`, `image_block_end` | start→delta*→end |
| **工具调用** | `tool_call_start`, `tool_call_delta`, `tool_call_end` | start→delta*→end |
| **工具结果** | `tool_result_start`, `tool_result_delta`, `tool_result_end` | start→delta*→end |
| **工具执行阶段** | `tool_execution_start`, `tool_execution_end` | 执行前→执行后（成对，[v0.0.130.hang]） |
| **一次性** | `usage_block`, `error`, `custom` | 单次 |
| **HITL** | `require_human_input` | 请求→响应 |

---

## 4. 生命周期事件

### 4.1 Run 级

```typescript
interface RunStartEvent extends AgentEventBase {
  type: "run_start";
  inputMessageIds: string[];   // 传入的 message id 列表
}

interface RunEndEvent extends AgentEventBase {
  type: "run_end";
  stopReason: StopReason;      // 引用 [P0]agent_loop_base.md §9（StopReason 联合）
}
```

**事件序列**：`run_start` → (message/step/content 事件) → `run_end`

### 4.2 Message 级

```typescript
interface MessageStartEvent extends AgentEventBase {
  type: "message_start";
  role: MessageRole;
  /** user 消息来源信封（仅 role=user 携带；其它 role 不带） */
  origin?: { type: string; configId: string };
  /** 业务侧 message 透传 Message.metadata（如 cron/heartbeat 等系统消息携带的 meta）；LLM 路径不发 */
  metadata?: Record<string, unknown>;
  /** 消息作者身份最小子集（仅 a2a inbox 消息携带；见下 sender 语义） */
  sender?: MessageStartSender;
}

/** message_start 携带的 sender 最小子集（判别式 union；当前只有 agent 一支） */
type MessageStartSender =
  | { source: "agent"; agent: { ref: { type: string; sessionId: string; name: string } } };

interface MessageEndEvent extends AgentEventBase {
  type: "message_end";
}
```

**[v0.0.107] `origin` 字段语义**（仅 role=user）：
- **派生**：由 `emitUserMessageBlocks` 从 `message.sender.channel` 派生 slim 结构 `{type, configId}`（剥掉 imUserId/imUserName 等 PII；v0.0.206 `instanceId`→`configId`，deriveOrigin 含 client 缺省 `'0'`）。
  - `sender.source==='user' && sender.channel` → `{type: channel.type, configId: channel.configId}`（如飞书 `{type:'feishu', configId:'01J...'}`）。
  - `sender.source==='user'` 无 channel（client web 发）→ 缺省 `{type:'client', configId:'0'}`。
  - 其它 role（system/assistant/tool）→ 不带 origin。
- **用途**：
  1. **channel accumulator self 判定**（echo 屏蔽）：`origin.configId === handle.configId` → DROP（用户自己发的，IM 已本地渲染）；不同 → 渲染 `User (from ${origin.type}): {text}` 投其它渠道。
  2. **client 来源徽标**：origin.type !== 'client' → user 气泡渲染「来自 ${origin.type}」。
- **LLM 零侵入**：origin 是**事件层信封元数据**，**绝不进发给 LLM 的 content**（`protocol-encode` 只读 ContentBlock，不读 origin/metadata）。LLM 看不到 user 消息来自哪个渠道。
- **为何不塞进 ContentBlock**：origin 是「信封」性质（同 sender.agent 子结构），加进 ContentBlock 会污染 LLM 协议层概念。详见 `../../channel/[P0]channel_impl_interface.md §5.1`。

**`sender` 字段语义**（仅 a2a inbox 消息携带）：
- **结构**：`{source:'agent', agent:{ref:{type, sessionId, name}}}`——`Message.sender` 的最小子集（只保留前端重建作者身份必需的 `agent.ref` 三字段）。
- **派生**：由 `emitUserMessageBlocks` → `deriveEventSender(message.sender)` 从 `message.sender` 派生：`sender.source==='agent'` 才携带（取 `agent.ref` 的 `type/sessionId/name`）；其它 source（user/system/approval/tool_reply）返 `undefined`。
- **用途**：前端 `chat-slice-reducer` 消费 message_start 时，`sender` 优先于 `origin` 重建 `Message.sender`——`source==='agent'` 时写入 `agent.ref`（`needReply` 填 `false`，SSE 路径不依赖它），供 chat 视图 `isA2aInbox` 判定 + 成员名/头像解析。`origin` 分支仅作 fallback（user channel 信封）。
- **为何是最小子集**：只带 `agent.ref` 三字段，刻意不带 `needReply` / IM 侧 `imUserId` / `imUserName` 等——避免事件层冗余 + PII 泄露（与 origin 剥 PII 同理）。`origin`（user channel 来源）与 `sender`（agent 作者身份）**各司其职、互不覆盖**（向后兼容：user 消息只有 origin，a2a 消息只有 sender）。
- **修复的问题（BUG-001）**：a2a 消息经 SSE 实时推送时，旧 message_start 只带 `role`+`origin`，前端 `isA2aInbox` 判定失败 → 兜底显示成 YOU；重进会话时因落库完整故正确。补 `sender` 后实时推送即可正确重建作者身份。

### 4.3 Enqueue 级

入队（`AgentManager.enqueue`）与消费（`AgentLoop` pre-process drain inbox）是异步解耦的两步，分别发出配对事件，构成「入队 → 处理 | 取消」完整生命周期（design 板块 3.4）。

**为什么需要两个 id**：ULID 字典序 = 时间序 = 对话历史顺序。入队时刻与处理时刻不同——若 enqueued 消息保留入队时刻的 ULID，它在 SessionStore 全局序列里会「插队」，排到实际被 agent 看到的时刻之前，搅乱历史顺序。因此入队时只分配 `enqueueId`（inbox 暂存句柄），处理时才**重新生成** `messageId`（反映处理时刻的 ULID），以 `messageId` 写入主对话 store。

```typescript
// AgentManager.enqueue 时发出：通知"有消息进入 inbox 待处理"
interface MessageEnqueuedEvent extends AgentEventBase {
  type: "message_enqueued";
  enqueueId: string;        // 入队句柄（窄化必填），前端用它建立 enqueue view 条目
  source: MessageSource;    // 来源，引用 [P0]agent_message_interface.md §5
  role: MessageRole;        // 消息角色，来自入队 Message.role
  content: ContentBlock[];  // 完整内容，供 enqueue view 直接渲染（非流式一次性通知）
  // 无 messageId（尚未生成）、无 runId（run 之外）
}

// AgentLoop pre-process 消费时发出：通知"该入队消息已被处理"
interface EnqueuedMessageProcessedEvent extends AgentEventBase {
  type: "enqueued_message_processed";
  enqueueId: string;        // 入队句柄，供前端关联、从 enqueue view 移除
  messageId: string;        // 处理时生成的真身 id（窄化必填），对话流里的 Message
  role: MessageRole;
}

// AgentLoop pre-process drain 同批拿到 message + cancel（同 enqueueId）时发出：
// 通知"该入队消息在处理前被作废"（design 板块 3.4）
interface EnqueuedMessageCanceledEvent extends AgentEventBase {
  type: "enqueued_message_canceled";
  enqueueId: string;        // 被作废的入队句柄（窄化必填），前端据此从 enqueue view 移除
  // 无 messageId（该消息未生成 messageId、未写主 store，被作废）、无 runId 之外语义
}
```

**三事件配对（design §3.4 生命周期）**：一条 enqueued message 的生命周期由 `message_enqueued`（建，分配 enqueueId）开始，由以下二者之一终结（互斥）：`enqueued_message_processed`（正常消费 → 生成 messageId 写主 store → 进对话流）或 `enqueued_message_canceled`（被 cancel 作废 → 不生成 messageId、不写主 store、不进对话流）。前端 enqueue view 收到二者其一都按 enqueueId 移除（幂等）。**cancel 机制详见 `[P0]agent_inbox_enqueue.md`**（cancel 消息形态 / drain 配对处理 / 原子性 / 竞态）。

**source 决定 enqueue view 行为**（避免混乱的关键）：

| source | enqueue view 行为 |
|--------|------------------|
| `user` | **[v0.0.12 修正]** session **idle** 时不进 enqueue view（enqueue → 立即 activate → 转 running → 容器短暂显示 → drain → `message_start` 渲染到对话流）；session **running / interrupting** 时**进 enqueue view 排队**（design §3.3），被 `enqueued_message_processed` 后从 enqueue view 移除并渲染到对话流 |
| `agent` / `approval` / `system` | 进 enqueue view 等待，被 `enqueued_message_processed` 后移除 |

> **[v0.0.31·代码已落地]** `source` enum 已对齐 `agent_message_interface §5`：`'scheduled'` 已并入 `'system'`（含 heartbeat/cron/reminder 子类，由 `sender.system.kind` 承载）。spec 表用 `'system'`；代码（`message/types.ts`）`MessageSource = 'user' | 'agent' | 'approval' | 'system'` 已对齐（无 `'scheduled'` 字面量）。a2a 消息（`source='agent'`）经 inbox enrich（`agent_inbox_enqueue §2.5`）后形态完整进 enqueue view，drain 后渲染前缀（a2a_protocol §5）。

> **[v0.0.12] §4.3 修正缘由**（design 板块 3.3）：旧定 `source:user` 一律不进 enqueue view，导致 running 时连续发送的用户消息无处显示。修正后：running 期间 user 消息也进 enqueue view 排队，前端可见排队区；idle 时保持原行为（立即激活、短暂入容器）。对照：enqueued message「处理时生成 messageId」；partial/interrupted message「message_start 时即分配」（abort api 重组，design §6.3）。

**与 message 事件对比**：`message_start → 内容事件 → message_end`（用户直接 query 或 LLM/工具产出）→ 渲染出消息进对话流；`message_enqueued` → 加入 enqueue view；`enqueued_message_processed` / `enqueued_message_canceled` → 从 enqueue view 移除（前者进对话流、后者不进）。详见 §9 映射。

---

## 5. 内容流事件

### 5.1 文本流

```typescript
interface TextBlockStartEvent extends AgentEventBase {
  type: "text_block_start";
  blockId: string;
}

interface TextBlockDeltaEvent extends AgentEventBase {
  type: "text_block_delta";
  blockId: string;
  delta: string;
}

interface TextBlockEndEvent extends AgentEventBase {
  type: "text_block_end";
  blockId: string;
}
```

### 5.2 思维流

```typescript
interface ReasoningBlockStartEvent extends AgentEventBase {
  type: "reasoning_block_start";
  blockId: string;
}

interface ReasoningBlockDeltaEvent extends AgentEventBase {
  type: "reasoning_block_delta";
  blockId: string;
  delta: string;
}

interface ReasoningBlockEndEvent extends AgentEventBase {
  type: "reasoning_block_end";
  blockId: string;
}
```

### 5.3 图片流

```typescript
interface ImageBlockStartEvent extends AgentEventBase {
  type: "image_block_start";
  blockId: string;
  mediaType: string;
}

interface ImageBlockDeltaEvent extends AgentEventBase {
  type: "image_block_delta";
  blockId: string;
  data: string;        // 增量 base64
}

interface ImageBlockEndEvent extends AgentEventBase {
  type: "image_block_end";
  blockId: string;
}
```

### 5.4 工具调用流

> **[v0.0.28]** `tool_call_start` / `tool_call_delta` / `tool_call_end` 携带 `messageId`
> （= 该 tool_call 所属的 role='assistant' 消息 id，start/delta/end 三事件共享同一 messageId）。
> **客户端 reducer 必须用 `evt.messageId` 锚定 assistant message**，不得依赖
> "message_start(role=assistant) 已先到达" 的时序假设——切到进行中的 run（如 subagent
> 只读页：run 后台开始、用户后切过去）时 message_start 已发完，reducer 若靠
> ctxRef.currentAssistantMessageId（仅 message_start 时才设）锚定会得到 undefined，
> tool_call part 被静默丢弃（v0.0.28 之前的 BUG，实证 subagent 26 个 tool_call UI 只显 2 个）。
> 错过 message_start 时 `tool_call_start` 应**兜底建 assistant message**（id=evt.messageId,
> role='assistant', content=[]）再追加 ToolCallBlock。text_block_delta 早已用 evt.messageId，
> tool_call_* 在 v0.0.28 对齐。

```typescript
interface ToolCallStartEvent extends AgentEventBase {
  type: "tool_call_start";
  blockId: string;
  toolCallId: string;
  toolName: string;
  messageId: string;   // [v0.0.28] 该 tool_call 所属的 role='assistant' 消息 id（start/delta/end 共享）
}

interface ToolCallDeltaEvent extends AgentEventBase {
  type: "tool_call_delta";
  blockId: string;
  toolCallId: string;
  delta: string;       // 增量 JSON 片段（arguments 的流式拼接）
  messageId: string;   // [v0.0.28] 同上
}

interface ToolCallEndEvent extends AgentEventBase {
  type: "tool_call_end";
  blockId: string;
  toolCallId: string;
  messageId: string;   // [v0.0.28] 同上
}
```

### 5.5 工具结果流

> **[v0.0.19]** `tool_result_start` / `tool_result_delta` / `tool_result_end` 携带 `messageId`
> （= 该 tool result 对应的 role='tool' 消息 id）。**per-result 独立**：每次 emit 生成一个新 messageId，
> start/delta/end 三事件共享同一 messageId。客户端 reducer 据此 messageId 建/更新 tool 消息节点
> （对齐 chat-page `_overview` §2 rule4/rule6：part 以 messageId+toolCallId 为 key）。
> 多工具场景下各 result 各自独立 messageId → 各自独立绑定到对应 tool_call。

```typescript
interface ToolResultStartEvent extends AgentEventBase {
  type: "tool_result_start";
  blockId: string;
  toolCallId: string;  // 关联到 ToolCallBlock.id
  messageId: string;   // [v0.0.19] 该 tool result 对应的 role='tool' 消息 id（start/delta/end 共享）
}

interface ToolResultDeltaEvent extends AgentEventBase {
  type: "tool_result_delta";
  blockId: string;
  toolCallId: string;
  delta: string;       // 增量文本
  messageId: string;   // [v0.0.19] 同上
}

interface ToolResultEndEvent extends AgentEventBase {
  type: "tool_result_end";
  blockId: string;
  toolCallId: string;
  isError: boolean;
  messageId: string;   // [v0.0.19] 同上
}
```

### 5.6 工具执行阶段流（[v0.0.130.hang]）

标记 loop ③ tools 段的**执行边界**——填 `message_end`（assistant 已决定调工具）→ `tool_result_start`（结果开始返回）之间的空白期。工具卡死/hang 时 `tool_result_start` 永不到达，UI 会永停「思考中」；这两事件让前端在**执行开始时**即切「运行工具: X」阶段（前端消费见 `specs/ui/components/chat-page/_overview.md §4.10`）。

**成对语义**：`tool_execution_start`（`executeToolsForSpec` 调用前 emit）→ `tool_execution_end`（`ingestToolResults` 后 emit），与 agent.log 的 `loop_tools_begin/end` breadcrumb 同址、同字段（一机制两用）。经 `spec.wireEmitCtx`（forked 无 emitCtx 则跳过）。

**MUST NOT 复用 `tool_result_start`**：其语义 = 单个工具结果已开始返回（= 该工具执行**已结束**），无法表达「执行中」阶段——语义相反。

```typescript
interface ToolExecutionStartEvent extends AgentEventBase {
  type: "tool_execution_start";
  toolNames: string[];    // 本轮待执行工具名（与 toolCallIds 一一对应）
  toolCallIds: string[];  // 本轮待执行 tool call id
}

interface ToolExecutionEndEvent extends AgentEventBase {
  type: "tool_execution_end";
  resultCount?: number;   // 本轮已产出的工具结果数
  pendingCount?: number;  // 本轮悬挂（HITL）数
}
```

---

## 6. 一次性事件

```typescript
interface UsageBlockEvent extends AgentEventBase {
  type: "usage_block";
  usage: Usage;        // 引用 ../session/[P0]session_usage.md §1（Usage 权威定义：token + char）
}

interface ErrorEvent extends AgentEventBase {
  type: "error";
  message: string;     // 错误描述
  code: string;        // 错误码，如 "RATE_LIMIT", "TOOL_EXECUTION_FAILED"
}

interface CustomEvent extends AgentEventBase {
  type: "custom";
  name: string;        // 自定义事件名
  value: Record<string, any>;
}
```

---

## 7. HITL 事件

```typescript
interface RequireHumanInputEvent extends AgentEventBase {
  type: "require_human_input";
  /** [v0.0.101] breaking：从 {toolCalls:ToolCallBlock[], prompt?} 改为单个队首 PendingToolCall。
   *  多 pending 串行展示（peek 队首单条，INV-4）；前端按 subType 分发渲染（need_feedback→提问卡 / need_approval→审批卡）。 */
  pending: PendingToolCall;
}
```

**恢复机制**：[v0.0.101] Agent loop 退出（StopReason=`tool_pending`，session=suspended）后，用户回填构造 `tool_reply` message（sender.source='tool_reply'）经 `deliverTo` 进 inbox → 新一轮 loop ① pre-process 按 `handleType` 编辑占位 content block（见 `agent_hitl.md`）。前端 recover（切走切回/重启）：`GET /session/:id/pending-tool-call` peek 队首 + agent_loop SSE sticky replay 重渲染。

---

## 8. 联合类型

```typescript
type AgentEventType =
  // 生命周期 — run 级
  | "run_start" | "run_end"
  // 生命周期 — message 级
  | "message_start" | "message_end"
  // enqueue
  | "message_enqueued" | "enqueued_message_processed" | "enqueued_message_canceled"
  // 文本流
  | "text_block_start" | "text_block_delta" | "text_block_end"
  // 思维流
  | "reasoning_block_start" | "reasoning_block_delta" | "reasoning_block_end"
  // 图片流
  | "image_block_start" | "image_block_delta" | "image_block_end"
  // 工具调用
  | "tool_call_start" | "tool_call_delta" | "tool_call_end"
  // 工具结果
  | "tool_result_start" | "tool_result_delta" | "tool_result_end"
  // 工具执行阶段（[v0.0.130.hang]）
  | "tool_execution_start" | "tool_execution_end"
  // 一次性
  | "usage_block" | "error" | "custom"
  // HITL
  | "require_human_input";

type AgentEvent =
  | RunStartEvent | RunEndEvent
  | MessageStartEvent | MessageEndEvent
  | MessageEnqueuedEvent | EnqueuedMessageProcessedEvent | EnqueuedMessageCanceledEvent
  | TextBlockStartEvent | TextBlockDeltaEvent | TextBlockEndEvent
  | ReasoningBlockStartEvent | ReasoningBlockDeltaEvent | ReasoningBlockEndEvent
  | ImageBlockStartEvent | ImageBlockDeltaEvent | ImageBlockEndEvent
  | ToolCallStartEvent | ToolCallDeltaEvent | ToolCallEndEvent
  | ToolResultStartEvent | ToolResultDeltaEvent | ToolResultEndEvent
  | ToolExecutionStartEvent | ToolExecutionEndEvent
  | UsageBlockEvent | ErrorEvent | CustomEvent
  | RequireHumanInputEvent;
```

---

## 9. 事件 → Message 重建映射

| 事件 | 对 Message 的效果 |
|------|------------------|
| `run_start` | 不修改 Message，标记 run 开始（消费者可初始化状态） |
| `run_end` | 不修改 Message，标记 run 结束（携带 stopReason） |
| `message_start` | 创建新 Message，设置 id/role（sessionId 从基类继承）；带 `sender`（a2a）或 `origin`（user channel）时重建 `Message.sender`——sender 优先（§4.2） |
| `message_end` | 标记 Message 完成 |
| `message_enqueued` | 不创建/修改 Message（不入主 store）。通知客户端：消息已入 inbox（携带 enqueueId + source + content），前端据此建立 enqueue view 并渲染内容 |
| `enqueued_message_processed` | 不修改 Message 内容。通知客户端：入队消息（enqueueId）已被 loop 消费、真身 messageId 已写入主 store，前端从 enqueue view 移除并关联 messageId |
| `enqueued_message_canceled` | 不修改 Message 内容。通知客户端：入队消息（enqueueId）在处理前被 cancel 作废（drain 同批拿到 message+cancel），**未生成 messageId、未写主 store、未进对话流**，前端从 enqueue view 移除（design 板块 3.4） |
| `text_block_start` / `delta` / `end` | 追加空 TextBlock → 拼接 delta 到 `.text` → 完成 |
| `reasoning_block_start` / `delta` / `end` | 追加空 ReasoningBlock → 拼接 delta 到 `.text` → 完成 |
| `image_block_start` / `delta` / `end` | 追加空 ImageBlock → 拼接 base64 data → 完成 |
| `tool_call_start` / `delta` / `end` | **[v0.0.28] 用 evt.messageId 锚定 assistant message**（错过 message_start 时 start 兜底建 assistant message）；追加空 ToolCallBlock（含 id/name）→ 拼接 JSON 片段到 arguments → 完成 |
| `tool_result_start` / `delta` / `end` | 追加空 ToolResultBlock → 拼接文本到 content → 设置 isError 完成 |
| `tool_execution_start` | 不修改 Message。[v0.0.130.hang] 通知客户端③段工具执行开始（toolNames/toolCallIds）→ 前端置 `loadingPhase='tool_executing'` + `runningToolNames`（UI 显「运行工具: X」，见 ui `_overview §4.10`） |
| `tool_execution_end` | 不修改 Message。通知客户端③段执行结束（resultCount/pendingCount）→ 前端清 `runningToolNames`（loadingPhase 待 tool_result_* 覆盖） |
| `usage_block` | 追加 UsageBlock |
| `error` | 不修改 Message，记录错误 |
| `custom` | 不修改 Message，通知中间件 |
| `require_human_input` | [v0.0.101] HITL 悬挂：loop ③ 段悬挂型 tool 触发，emit 队首 PendingToolCall（前端 mount 提问卡 / 审批卡）；恢复=用户回填 tool_reply message 经 inbox → pre-process 编辑占位 block（见 `agent_hitl.md`） |

---

## 10. API + SSE 不漏契约 + Replay 精确语义

> agent_loop 事件流「不漏消息」的权威契约。transport 细节见 `../event/[P0]event_bus.md`，replay 链路（hub→bus）见 `../event/[P0]event_hub.md`。

### 10.1 三路数据源

前端获取某 session 的完整对话状态，由**三路**数据按 message id merge：

| 路 | 来源 | 内容 |
|----|------|------|
| **GET /messages** | 查询接口（读 DB） | **所有已持久化** Message 全量（含 tool_call/tool_result part），确定性、不依赖时序 |
| **SSE replay** | subscribe 瞬间 bus buffer 回放 | 「上次持久化(ingest)之后」emit 的、**尚未持久化**的半截 |
| **SSE stream** | subscribe 之后的实时 emit | 新增量 |

**不变量**：GET(全量已持久化) ∪ replay(半截未持久化) ∪ stream(增量) = 完整状态，不漏。

### 10.2 replay 的精确语义（关键：不是补历史）

buffer 由 `clearReplay` 收紧为有限窗口：

```
agent_loop 一轮（一次 LLM 调用）：
  emit message_start / text_block_* / tool_call_* / tool_result_* / message_end
  → ingestAndAssemble（持久化这批到 DB）→ bus.clearReplay(group)   ← 持久化点，buffer 清空
  → （有 tool_call 则继续下一轮 emit…）
```

持久化的数据已落 DB → 下次 GET 必含 → buffer 不必再持有 → `clearReplay`（`agent-loop-lifecycle.ts` `ingestAndAssemble` 内，line 73）。因此 **buffer 永远只含「最近一次 ingest 之后、尚未持久化」的半截**。后订阅者切进来：**历史靠 GET**（全量已持久化），**当前进行中的半截靠 replay**，**之后靠 stream**。

### 10.3 replay 完整性不变量

run 进行中（半截在 buffer）时，新订阅者 replay 回放的第一条**应是 `message_start`**（一个未持久化 message 的完整开头）。若第一条是 `message_end` / `tool_call_delta` / `run_end` 等尾部/中间事件，说明 replay 不完整（buffer 被过早清空或写入竞态）——诊断信号。

> **v0.0.28 实证**（probe2）：多轮 tool_call run 进行中，每 0.8s unsubscribe + resubscribe，replay 快照第一条 6/6 次均为 `message_start`（含 text_block_delta 等半截）；run 结束后 resubscribe 只剩 `message_end` + `run_end`（buffer 已被最后一轮 ingest 清空）——符合 §10.2 语义。

### 10.4 客户端 reducer merge 规则

1. 以 **GET /messages** 为基线（全量、有序、权威）。
2. SSE 事件（replay + stream 统一处理，都是增量 part）按 **`evt.messageId`** 锚定到对应 Message：message 已存在（GET 有 / 之前 stream 建过）→ 追加/更新 part；message 不存在（错过 message_start）→ **兜底建**（id=evt.messageId, role 按 event 推断）再追加 part。
3. **不得依赖「message_start 已先到达」的时序假设**——后订阅者切到进行中的 run 时 message_start 可能已在 replay 之外（被上一轮 ingest 清）。`tool_call_*` / `text_block_*` 一律用 `evt.messageId` 锚定（§5.4）。

### 10.5 subagent / 多 session 一致性

subagent 是独立 session，其 agent_loop 用**自己的 sessionId** 作 group：`session_id:<childSid>_amt:main`（`groupKeyForRunKind(childSid, 'main')`，见 `[P0]agent_interface.md`）。subagent 只读页订阅该 group，走**同一个** replayable bus、同一套 groupKey 分区逻辑——replay 行为与主 session 完全一致，无特殊路径。parent 与 child 各自独立 group，互不串扰。

---

## 11. （版本史见 `log.md`）
