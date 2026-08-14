---
type: interface
title: Agent Message Interface（业务消息权威类型）
priority: P0
status: active
updated: 2026-07-26
since: v0.0.8
---

# Agent Message Interface

## 1. MessageRole

```typescript
type MessageRole = "system" | "user" | "assistant" | "tool";
```

**设计决策**：

- 框架层保留全部 4 种 role，统一管理在 messages 数组中
- `system`：系统指令，放入 messages 而非独立字段
- `user`：用户输入
- `assistant`：模型输出（可携带 tool_calls）
- `tool`：工具执行结果
- 具体对接各家 LLM 时，由适配层负责转换（如 Anthropic 的 system 独立参数、tool_result content block 等）

**各家 LLM role 映射**：

| 框架 role     | OpenAI                          | Anthropic                                       | Gemini              |
| ----------- | ------------------------------- | ----------------------------------------------- | ------------------- |
| `system`    | `messages[0] = {role:"system"}` | 独立 `system` 参数                                  | `systemInstruction` |
| `user`      | `{role:"user"}`                 | `{role:"user"}`                                 | `{role:"user"}`     |
| `assistant` | `{role:"assistant"}`            | `{role:"assistant"}`                            | `{role:"model"}`    |
| `tool`      | `{role:"tool", tool_call_id}`   | `{role:"user", content:[{type:"tool_result"}]}` | `functionResponse`  |

---

## 2. Usage

Usage 类型（LLM 一次调用的用量：**token + char**）的**权威定义在 `../session/[P0]session_usage.md §1`**（session 是 usage 数据所有权方）。本文 message 的 `UsageBlock`（§4.9）引用同一类型。

> **[v0.0.10 scope]**：Usage 全字段（9 token + char + cost + currency）已在 `message/types.ts` 落地；cost 由 **LlmClient.call** 边界计算（computeCost 按 modelConfig.pricing 填 `usage.cost`+`currency`，非 agent loop 构造）。`accumulateUsage`（三分区累加）v0.0.10 当时是 no-op（保留签名）→ **[v0.0.14] 已激活**（三分区真累加 + ratio 学习 + session_usage_update 真发 + getUsageView 真聚合，见 `specs/tech/version_logs/v0.0.14/change_log.md`）。详见 `specs/tech/version_logs/v0.0.10/change_log.md §6`。

> **char 两个字段**：`inputCharCount`（assemble snapshot 产出，= `snapshot.inputCharCount`）+ `outputCharCount`（llm client 统计 LLM 输出）。agent loop 构造 Usage 时填入；token/cost ← LLM 返回。详见 session_usage.md §1。

**设计原则**：

- 所有 total 字段在写入时计算并固化，不依赖读取时动态计算
- 冗余无歧义：每个子项和汇总都可独立读取
- `cost` 由框架在记录时根据定价表算好
- 适用于成本追踪、缓存优化分析、reasoning 消耗监控

---

## 3. ContentBlock 总览

ContentBlock 是 Message.content 数组中的元素，采用 discriminated union（通过 `type` 字段区分）。

### 各 role 允许的 ContentBlock 类型

| ContentBlock | system | user | assistant | tool | 说明 |
|---|---|---|---|---|---|
| TextBlock | ✅ | ✅ | ✅ | ❌ | 纯文本 |
| ImageBlock | ✅ | ✅ | ✅ | ❌ | 图片（URL 或 base64） |
| AudioBlock | ✅ | ✅ | ✅ | ❌ | 音频输入 |
| VideoBlock | ✅ | ✅ | ✅ | ❌ | 视频输入 |
| FileBlock | ✅ | ✅ | ❌ | ❌ | 通用文件（PDF 等） |
| ToolCallBlock | ❌ | ❌ | ✅ | ❌ | 模型发起的工具调用 |
| ToolResultBlock | ❌ | ❌ | ❌ | ✅ | 工具执行结果 |
| ReasoningBlock | ❌ | ❌ | ✅ | ❌ | 思维链内容 |
| UsageBlock | ❌ | ❌ | ✅ | ❌ | 本次调用的 token 用量 |
| ApprovalResultBlock | ❌ | ✅ | ❌ | ❌ | 用户对工具调用的审批结果 |

---

## 4. ContentBlock 定义

### 4.1 TextBlock

```typescript
interface TextBlock {
  type: "text";
  text: string;
  /** 块级 reminder 标记：system_reminder_injector 追加 reminder text block 时设 true。
   *
   * - 前端按块级精确过滤：DEFAULT_BLOCK_FILTER（message-flatten.ts）隐藏此 block，不影响同 message
   *   其他 text block（旧 message 级 metadata.isSystemReminder 无法区分块，会误整条隐）。
   * - LLM 零侵入：protocol-encode.ts encodeContentBlock 对 text 只读 `b.text`，不读此字段；
   *   reminder 仍按既有路径进 wire（保 prompt cache 语义，见 system_reminder §5）。
   * - v0.0.50 起为唯一权威：旧 message 级 `metadata.isSystemReminder` 已废止（injector 停写），
   *   旧 transcript 数据读取时被前端块级 filter 忽略，不做数据迁移。 */
  isSystemReminder?: boolean;
}
```

> **设计决策 — reminder 块级标记（v0.0.39 引入，v0.0.50 唯一化）**：
> - **结论**：reminder 注入只设 `block.isSystemReminder=true`（块级，唯一权威）；v0.0.50 起停写消息级 `metadata.isSystemReminder`。
> - **理由**：旧 message 级 metadata 只能表达「这条 message 含 reminder」，前端要隐藏 reminder 时要么整条 message 隐（误伤同 message 的 user 正文）要么不隐（reminder 暴露给用户）。块级标记让前端 `DEFAULT_BLOCK_FILTER` 精确隐这一块 text，user 正文同 message 不受影响。
> - **v0.0.39 → v0.0.50 演进**：v0.0.39 引入块级时保留消息级双标记（兼容旧路径/工具）；v0.0.50 验证下游（前端 filter、transcript 视图）已全部按块级读取后，停写消息级（injector 删 metadata 写入分支）。`metadata` 字段本身保留（其他 kv 透传，仅 `isSystemReminder` 写路径停）。
> - **LLM 零侵入**：`encodeContentBlock(text)` 只读 `b.text`（见 `app/server/src/llm/protocol-encode.ts`），`isSystemReminder` 不进 wire —— reminder 仍透明发 LLM（保 system_reminder §5 prompt cache 不破坏的语义）。

### 4.2 ImageBlock

```typescript
interface ImageBlock {
  type: "image";
  source: ImageSource;
  mediaType: string;       // "image/png", "image/jpeg", "image/webp", "image/gif"
}

type ImageSource =
  | { kind: "url"; url: string }
  | { kind: "base64"; data: string };
```

> **v0.0.157 起 tool 层不再构造 ImageBlock（类型保留）**：截图类工具（computer-use `screenshot`/`get_app_state` + browser `screenshot`）改走 **落盘 + 路径文本**——截图存 `<workdir>/snapshots/<toolCallId>.<ext>`，tool_result.content 仅含 TextBlock（路径 + 尺寸 + "Use see_image tool to view it" 引导）。多模态模型按需显式调 `see_image({imagePaths:['snapshots/<id>.png']})` 读路径看图。**ImageBlock 类型本身保留**——llm/protocol-encode 的 `encodeContentBlock case 'image'` 仍需翻译 spec 形→anthropic wire 形（protocol 层消费路径：user 人工构造 image 消息 / 未来多模态扩展）。tool 层不再产出 ≠ 类型废弃，protocol 层仍依赖。详见 `specs/tech/version_logs/v0.0.157/log.md` + `../tools/log.md` 同版本块。

> **`[v0.0.105]` ImageBlock 全链路打通（P0 前置，独立 Task 最先做）**：spec §4.2 早已声明 ImageBlock，但 `message/types.ts ContentBlock` union v0.0.8 起标 future 未实现（仅 6 类：text/tool_call/tool_result/reasoning/usage/tool_reply）。v0.0.105 computer use 的 `get_app_state` 截图回灌 LLM 是其首个消费者，必须打通：
> - **types.ts**：`ContentBlock` union 加 `ImageBlock`（spec 形 `{type:'image', source:{kind:'base64'|'url', data|url}, mediaType}`）。
> - **encode 适配**：`protocol-encode.ts encodeContentBlock case 'image'` 现 `{type:'image', source: b.source}` 假设 `b.source` 已是 anthropic wire 形（`{type, media_type, data}`）。spec ImageBlock 形不同（`source:{kind, data}, mediaType` 顶层）→ encode 需翻译：`source.kind==='base64'` → `{type:'base64', media_type: mediaType, data}`；`source.kind==='url'` → `{type:'url', url}`（注意 anthropic image url 形态）。
> - **ToolResultBlock.content: ContentBlock[]**：已声明（`content: ContentBlock[]`），types.ts 加 ImageBlock 后自动支持承载 image（computer use get_app_state 的 ToolRunResult.content 含 1 ImageBlock + 1 TextBlock）。
> - **CrudStore 序列化**：JSON 自然处理 base64 string（PNG ~1-2MB / record 行大小，FsCrudStore 文件存储可承载；后续如需可加独立 blob store，本版本不优化）。
> - **context assemble 不过滤 image**：已核对 `agent/context-compact-helpers.ts` 仅 `b.type === 'text' || 'reasoning'` 提取 text，image 不被 drop；compaction 时 image 随 message 一起 summarize（summary 是 text，image 在 compact 时丢弃是预期行为）。
> - **前端渲染**：P1 最小占位（chat UI 展示截图，click 展开）—— 本版本 P1，非阻断。

### 4.3 AudioBlock

```typescript
interface AudioBlock {
  type: "audio";
  source: AudioSource;
  mediaType: string;       // "audio/wav", "audio/mp3", "audio/ogg"
}

type AudioSource =
  | { kind: "url"; url: string }
  | { kind: "base64"; data: string };
```

### 4.4 VideoBlock

```typescript
interface VideoBlock {
  type: "video";
  source: VideoSource;
  mediaType: string;       // "video/mp4", "video/webm"
}

type VideoSource =
  | { kind: "url"; url: string }
  | { kind: "base64"; data: string };
```

### 4.5 FileBlock

```typescript
interface FileBlock {
  type: "file";
  source: FileSource;
  mediaType: string;       // "application/pdf", "text/plain", ...
  filename?: string;
}

type FileSource =
  | { kind: "url"; url: string }
  | { kind: "base64"; data: string };
```

### 4.6 ToolCallBlock

```typescript
interface ToolCallBlock {
  type: "tool_call";
  id: string;              // ULID 或 LLM 返回的 id
  name: string;            // 工具名称
  arguments: Record<string, any>;  // 调用参数
}
```

**id 分配规则**：
- LLM 返回了 id → 直接使用
- LLM 未返回 id → 框架自动生成 ULID

**arguments 半截容错（`_raw` / `_rawTruncated`）**：LLM 流式输出的 arguments JSON 片段可能被截断（parse 失败）。`safeParseArgs`（agent-loop-stream.ts + replay-collector.ts 各一份）解析失败时返回 `{ _raw: <原始buf>, _rawTruncated: true }`——`_raw` 保留原始半截串（不进 LLM 上下文），`_rawTruncated: true` 标记截断。前端消费方（send-message-envelope 渲染）据此显示「发送失败（参数截断）」，而非空白。

**send_message 落库前 normalize（[v0.0.331 P1]）**：`closeActive()`（agent-loop-stream.ts）/ `reconstitute()`（replay-collector.ts）在 `name === 'send_message'` 且 arguments 无 `_raw` 时，对 `arguments.content` 调 `normalizeContentBlocks`（见 `multi_agent/[P1]subagent_derivation.md §5.1`）——缺 `type` 的 block 补 `type:'text'`。原因：前端 out 信封正文从 LLM 原始 arguments 提取，若只按 `type==='text'` 过滤会因缺 type 全滤 → 展开空白。normalize 使落库数据永远权威形态（`_raw` 半截路径不补 content，由 `_rawTruncated` 标记展示）。

### 4.7 ToolResultBlock

```typescript
interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;      // 关联到 ToolCallBlock.id
  content: ContentBlock[]; // 结果内容（可嵌套 TextBlock、ImageBlock 等）
  isError: boolean;        // 是否执行出错
  /** [v0.0.101] 顶层状态：success（正常完成）/ pending（悬挂型 tool 占位，等用户回填）/ fail（拒绝/失败）。
   *  默认 'success' 向后兼容（旧数据缺省视 success）。
   *  status='pending' 时带 subState + data（见下）。 */
  status?: "success" | "pending" | "fail";
  /** [v0.0.101] 仅 status='pending' 时有值：渲染分发 key（前端弹什么 UI） */
  subState?: "need_approval" | "need_feedback";
  /** [v0.0.101] 仅 status='pending' 时有值：交互载荷（FeedbackData | ApprovalData，tool 给前端渲染用） */
  data?: FeedbackData | ApprovalData;
}
```

**绑定关系**：每个 ToolResultBlock 必须通过 `toolCallId` 关联到一个已存在的 ToolCallBlock。

> **[v0.0.101] pending 占位 result 可被编辑（INV-6 关键约束）**：悬挂型 tool 生成 pending 占位 block（status='pending'，content=人话占位「用户回答中…」）写入 transcript 后、loop 退出（StopReason=tool_pending）→ **尚未发给 LLM** → pre-process 按用户回填编辑该 block（占位→真实答案 + status pending→success/fail）→ 下一轮 LLM 首次消费看到真实答案。transcript「首次发给 LLM 时冻结」而非「写入即冻结」——这是「先占位后编辑」在 append-only 下成立的唯一前提。

### 4.8 ReasoningBlock

```typescript
interface ReasoningBlock {
  type: "reasoning";
  text: string;            // 思维链内容
}
```

### 4.9 UsageBlock

```typescript
interface UsageBlock {
  type: "usage";
  usage: Usage;            // 引用 §2 定义的 Usage 接口
}
```

### 4.10 ApprovalResultBlock

```typescript
type ApprovalDecision = "allow" | "allow_always" | "deny";

interface ApprovalResultBlock {
  type: "approval_result";
  toolCallId: string;              // 关联到 ToolCallBlock.id
  decision: ApprovalDecision;      // 审批决定
  modifiedArguments?: Record<string, any>;  // 用户修改后的参数（可选）
}
```

**decision 含义**：

| 值 | 说明 | Agent 行为 |
|----|------|-----------|
| `"allow"` | 同意本次 | 执行工具，下次同类调用仍会询问 |
| `"allow_always"` | 始终同意 | 执行工具，更新权限规则，后续同类调用自动放行 |
| `"deny"` | 拒绝 | 不执行工具，产出 isError=true 的 ToolResultBlock |

### 4.10a ToolReplyBlock（[v0.0.101] 新增 — 悬挂型 tool 回填载荷）

```typescript
interface ToolReplyBlock {
  type: "tool_reply";
  toolCallId: string;              // 关联 PendingToolCall.toolCallId（pre-process 匹配 key）
  handleType: "direct_result" | "approval" | "callback";  // pre-process 处理分发
  payload: FeedbackAnswer | ApprovalDecision | unknown;   // 按 handleType（FeedbackAnswer=ask-question 答案）
}
```

> 进 user message（role=user，sender.source='tool_reply'）。pre-process drain 时识别 → 按 toolCallId 匹配 pendingToolCalls → 按 handleType 编辑对应占位 result block（§4.7 INV-6）。**不独立接口，走 inbox**（deliverTo，INV-5）。

### 4.11 联合类型

```typescript
type ContentBlock =
  | TextBlock
  | ImageBlock
  | AudioBlock
  | VideoBlock
  | FileBlock
  | ToolCallBlock
  | ToolResultBlock
  | ReasoningBlock
  | UsageBlock
  | ApprovalResultBlock
  | ToolReplyBlock;       // [v0.0.101]
```

---

## 5. Message

```typescript
interface Message {
  id: string;                      // ULID
  sessionId: string;               // 所属会话 ULID
  role: MessageRole;               // system | user | assistant | tool
  content: ContentBlock[];         // 内容块数组（transcript 形态：首次发给 LLM 的样子）
  runId?: string;                  // 所属 agent run ULID（可选）

  // ── store 信封（store 管理；put 时不传，store 注入。见 ../../persistence/[P0]crud_store_interface.md §2.1 RecordMeta）──
  createdAt: string;     // isoDate，首次写入注入
  updatedAt: string;     // isoDate，每次写入更新
  version: number;       // 乐观锁版本号，首次为 1，每次写入自增

  sender?: MessageSender;          // 消息来源
  metadata?: Record<string, any>;  // 扩展元数据。注：消息级 isSystemReminder 已于 v0.0.50 废止（injector 停写，块级 TextBlock.isSystemReminder 唯一权威）；旧 transcript 数据被前端块级 filter 忽略，不迁移

  // ── transcript 剪裁状态（见 ../session/[P0]session_concepts.md §3）──
  /** 整条 message 被认为不需要传递，已整体剪裁 */
  message_snipped?: boolean;
  /** 是否有 tool block 被剪裁（与 message_snipped 对称） */
  tool_block_snipped?: boolean;
  /** 被剪裁的 tool block id 列表；仅当 tool_block_snipped === true 时有值 */
  snipped_tool_block_ids?: string[];

  // ── raw 引用（见 ../session/[P0]session_concepts.md §1、../session/[P0]session_store.md）──
  /** 若 raw 原文被 offload，指向 SessionStore raw 内容的 contentId；缺失 = raw 未单独持久化 */
  rawRef?: string;
  /** 若 tool_result 被 offload，指向 SessionStore tool_result 内容的 contentId */
  toolResultRef?: string;
}

type MessageSource = "user" | "agent" | "approval" | "system" | "tool_reply";  // [v0.0.101] 加 tool_reply（悬挂型 tool 回填）

/**
 * MessageSender = 判别联合（discriminated union by `source`，v0.0.31 落实）。
 * - 每个 source 变体是独立子结构；TS 在 `if (sender.source === 'agent')` 后窄化拿 agent 子字段。
 * - needReply / sender.agent 子结构 = source='agent'（a2a）专属，user/system/approval 不存在此字段（结构层钉死）。
 * - AgentRef 见 specs/tech/multi_agent/[P1]a2a_protocol.md §2（{ type, sessionId, name }，不含 user）。
 *
 * ★ 程序构造性原则（关键，防后续误解）：sender 信封（source/agent.ref/needReply/inReplyTo）是**程序构造**的，
 *   不是 LLM 构造的。LLM 入口只有 `agent.spawn` / `send_message`（一定 a2a），LLM 只传工具入参
 *   （target/content/needReply/inReplyTo）+ AgentRef；message 信封由程序组装（source 硬编码按入口、
 *   ref 从 runtime context、needReply/inReplyTo 透传 LLM 入参）。LLM 从不直接构造/看到 sender 结构
 *   （只看工具入参 + prompt 渲染的 `[Message from ...]`）。故判别联合的价值 = **程序内部类型安全**
 *   （防程序构造/读取 sender 时的代码 bug），非防御 LLM/外部不可控输入；类型形态是程序内部细节，coding 保证即可。
 */
type MessageSender =
  | { source: "agent"; agent: {
      ref: AgentRef;             // 发送方完整 ref（type/sessionId/name）；sessionId=路由权威（enrich 校验，见 inbox §2.5）
      needReply: boolean;        // ★ 是否期待对方回复——a2a 必填；接收方 LLM 据此决定是否 send_message 回（a2a_protocol §4.2）
      inReplyTo?: string;        // 关联原 message.id（thread 线索）
    } }
  | { source: "user"; channel?: {          // user 经 session UI 直发（web client 无 channel）或 IM 渠道入站
      // [v0.0.107] IM 渠道来源信封（仅飞书等 channel 入站填；类型权威 channel_impl_interface §5.1）
      type: string;              // 渠道 impl 类型（= ChannelConfig.implId，如 'feishu'；web client 缺省语义 'client'）
      configId: string;          // ChannelConfig.id（渠道配置 id；v0.0.206 原 instanceId 改名）
      conversationId: string;    // 会话 id（群=chatId / 私聊=openId）
      imUserId: string;          // IM 用户 id
      imUserName: string;        // IM 用户名（可能为空）
    } }
  | { source: "system"; system: {
      kind: string;              // "heartbeat" | "cron" | "reminder" | ...（开放，按需扩；scheduled 已并入 system）
      refId?: string;            // 关联 scheduleId / reminderId 等
    } }
  | { source: "approval"; approval: {
      toolCallId: string;        // 关联 ToolCallBlock.id（审批回流对哪个 tool_call）
      decision: "allow" | "allow_always" | "deny";
      // 其他审批载荷按需扩
    } }
  | { source: "tool_reply"; tool_reply: {     // [v0.0.101] 悬挂型 tool 回填（ask-question 答案 / approval 决定 / callback payload）
      toolCallId: string;        // 关联 PendingToolCall.toolCallId（pre-process 匹配 key）
      runId: string;             // 产出 pending 的 run
    } };
```

> **AgentRef 定义**：`specs/tech/multi_agent/[P1]a2a_protocol.md §2`（`{ type: "leader"|"mate"|"subagent"|"squad"; sessionId; name }`，**不含 user**——user ↔ agent 不走 a2a，user 在 session UI 旁；详见 a2a_protocol §4 回复规则）。`[v0.0.33.1]` type enum `member`→`mate`（B 方案统一）。

> **[v0.0.31 判别联合化·代码已落地]**：本节 `MessageSender` 从「optional 子结构 + 文档约束」升级为**严格 TS 判别联合**（按 `source` 分流，每个 source 一个独立子结构）。
> - **定夺结论**：**严格判别联合**。理由：①PRD 诉求（needReply = a2a 专属，user/system/approval 不存在此字段）类型层钉死防"user 消息误读 needReply"；②窄化路径清晰（`if (sender.source === 'agent') sender.agent.needReply`）无歧义；③inbox enrich / prompt 渲染按 source 分流的代码强类型化（compile-time 检查）；④与 ContentBlock（§4.11）已是判别联合的设计风格统一。
> - **代码已落地**（`app/server/src/message/types.ts`）：`MessageSender` 已是判别联合（4 变体 by source，详见本节 TS 定义）；`MessageSource = 'user' | 'agent' | 'approval' | 'system'`（`'scheduled'` 已并入 `'system'`）。
> - **同步落地清单**：①types.ts 已落本节判别联合定义；②user POST handler（`session-messages.ts:236`）扁平残留 `agentName/agentId` 已清（user 变体 `sender = { source: 'user' }`）；③`agent_event.md §4.3` source 行为表用 `'system'`（已对齐）；④emit message_enqueued 处硬编码 `'system'`；⑤inbox enrich（见 `[P0]agent_inbox_enqueue.md §2.5`）产出的 `sender.agent` 严格匹配判别联合形态。
> - **程序构造性原则**：sender 信封（source/agent.ref/needReply/inReplyTo）是**程序构造**的，非 LLM 构造。LLM 入口只有 agent.spawn / send_message（一定 a2a），LLM 只传工具入参（target/content/needReply/inReplyTo）+ AgentRef；message 信封由程序组装（source 硬编码按入口、ref 从 runtime context、needReply/inReplyTo 透传 LLM 入参）。判别联合价值 = **程序内部类型安全**（防程序构造/读取 sender 时的代码 bug）。
> - **历史**：早期 `MessageSender` 含 `agentName/agentId` 标量字段（数据临时），v0.0.28 已子结构化（agent:{ref,inReplyTo,needReply}）但仍是 optional 子结构；v0.0.31 正式判别联合化 + 清扁平残留。早期 `scheduled` source 已并入 `system`（heartbeat/cron 为其子类）。

> **[v0.0.206] `instanceId` → `configId` 改名边界**：ChannelInstance 改名 ChannelConfig 全链联动，wire 字段 `sender.channel.configId`。**历史 transcript 的 sender.channel 不迁**——transcript 是 append-only 不可变历史（「当时事实」记录，重写违反不可变语义）；origin 由 agent-loop-emitters 只对**新入站消息**实时派生，历史消息从不重新 emit，echo 屏蔽判定的是运行时新事件——运行时消费零影响，仅前端历史消息来源标签降级。channel_bindings 落盘字段走 MigrationManager 一次性迁移（见 `../../migration/log.md`）。

**字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string (ULID) | ✅ | 消息唯一标识，框架自动生成 |
| `sessionId` | string (ULID) | ✅ | 所属会话 ID |
| `role` | MessageRole | ✅ | 消息角色 |
| `content` | ContentBlock[] | ✅ | 内容块数组，可为空数组 |
| `runId` | string (ULID) | ❌ | 关联的 agent run，用于追踪单次执行链路 |
| `createdAt` | string (isoDate) | ✅ | store 信封，put 时不传，store 注入（首次写入时间） |
| `updatedAt` | string (isoDate) | ✅ | store 信封，put 时不传，store 注入（每次写入更新） |
| `version` | number | ✅ | store 信封，put 时不传，store 注入（乐观锁版本，首次为 1，自增） |
| `sender` | MessageSender（判别联合） | ❌ | 消息来源标记，按 `source` 判别联合：`source='agent'` → `{source, agent:{ref, needReply, inReplyTo?}}`（a2a 专属，needReply 必填）；`source='user'` → `{source:'user'}`（web client 直发）或 `{source:'user', channel:{type,configId,conversationId,imUserId,imUserName}}`（[v0.0.107] IM 渠道入站，`type`=implId 如 `'feishu'`；v0.0.206 `configId`=ChannelConfig.id）；`source='system'` → `{source, system:{kind, refId?}}`；`source='approval'` → `{source, approval:{toolCallId, decision, ...}}`。详见 §5 |
| `metadata` | Record | ❌ | 扩展字段。注：消息级 `isSystemReminder` 已于 v0.0.50 废止（injector 停写，块级 `TextBlock.isSystemReminder` 唯一权威）；其他 kv 不受影响 |
| `message_snipped` | boolean | ❌ | 整条 message 是否被整体剪裁（transcript 不携带实质内容）。见 `../session/[P0]session_concepts.md` §3 |
| `tool_block_snipped` | boolean | ❌ | 是否有 tool block 被剪裁；为 `true` 时 `snipped_tool_block_ids` 必有值 |
| `snipped_tool_block_ids` | string[] | ❌ | 被剪掉的 tool block id 列表（ToolCallBlock.id / 对应 ToolResultBlock 的 toolCallId） |
| `rawRef` | string | ❌ | raw 原文被 offload 时指向 SessionStore raw 内容的 contentId；缺失表示 raw 未单独持久化（见 `../session/[P0]session_store.md`） |
| `toolResultRef` | string | ❌ | tool_result 被 offload 时指向 SessionStore tool_result 内容的 contentId |

**JSON 示例**：

```json
{
  "id": "01KVCA58G80Y54TTF2S8ZPFR5M",
  "sessionId": "01KVC7P2ZYKZZE2NWCGPAN9WRY",
  "role": "assistant",
  "content": [
    { "type": "text", "text": "好，先看下当前工作区状态。" },
    { "type": "tool_call", "id": "call_d37fcb3494364913bfda6745", "name": "bash", "arguments": { "command": "ls -la" } }
  ],
  "runId": "01KVC7QCMMPTPVPZ2V4HSEBJG3",
  "createdAt": "2026-06-18T02:07:31.601Z"
}
```

---

## 6. 持久化归属

> **持久化**：Message 经 `persistence` 的 CrudStore 落盘；具体 entity（transcript）/ engine / 分片配置由 session 模块的 schema 决定，Message 自身只定义结构，不关心存储。
>
> **信封字段**（`createdAt` / `updatedAt` / `version`）由 store 注入管理，业务 put 时不传；读取返回的 Message 已含信封。SchemaDef（见 persistence）只声明业务字段，不声明信封名。

---

## 7. message.id 分配时机（drain 权威 — v0.0.161）

**message.id 分配唯一权威源 = `drainAndPartition` 阶段 `ulid()`**（不论 source=user/agent/system/approval/tool_reply）。write-in 时刻（HTTP-in / channel-in / tool-emit）分配的 id 是 **throwaway 占位**——仅为满足 inbox schema 非空约束，drain 时被 reissue，从不落 SessionStore transcript、也从不外泄给前端。

**四条契约**：

- **(a) msgId 分配唯一权威源 = drainAndPartition + ulid()**：所有 source（user/agent/system/approval）在 `app/server/src/agent/agent-loop-stage-pre.ts::drainAndPartition` line 124-152 统一分配 `newId=ulid()`，然后 push 到 `userMessages/systemMessages/processed/newMessages`（三处对同一消息用同一 newId）。→ 保证 msgId ULID 单调 = drain 处理顺序 = transcript 时间顺序 → context assemble 按 id 切割/排序时无位置错乱。

- **(b) write-in 时刻的 msgId 是 throwaway 占位**：`POST /messages`（`app/server/src/handlers/session-messages.ts` line 228-235）、feishu channel（`app/plugins/builtins/feishu/feishu-channel.ts` line 265 附近）等入口分配的 msg.id 仅满足 inbox schema 非空约束，drain 时被完全丢弃，不进任何持久化 store、不通过 HTTP 响应体外泄。响应仅返 `{runId, enqueueId}`（无 msgId 字段）。

- **(c) enqueueId 与 msgId 严格独立（I1）**：
  - `enqueueId` = **inbox 队列 key + UI 排队感知 key**（inbox append 时分配；`GET /inbox` 返、`message_enqueued`/`enqueued_message_processed`/`enqueued_message_canceled` SSE 携带；供前端 enqueue-view 定位排队项）。
  - `messageId` = **transcript key + LLM context key**（drain 时刻 ulid；进 `SessionStore.appendMessages`；供 assemble/reducer/logical-view/observability 锚定）。
  - 二者语义不同、生命周期不同（enqueueId 在 emit canceled/processed 后 UI 移项即完；messageId 落库随 transcript 永存），一消息 = 两 ID。
  - drain 后 msgId 通过 `emitEnqueuedProcessed(enqueueId, newMessageId, role)`（`agent-loop-emitters.ts` line 174-187）事件外泄给前端建立 `enqueueId ↔ msgId` 映射（I3）。

- **(d) tool_reply 分支例外（不进 transcript）**：`sender.source === 'tool_reply'` 消息在 drain 独立分流（`agent-loop-stage-pre.ts` line 114-123），不入 userMessages/systemMessages/newMessages（不作为 transcript 条目 ingest）；其 message.id 通过 `emitEnqueuedProcessed(enqueueId, entry.message.id, role)` 通知前端完成占位 block 编辑归属（INV-6：编辑既有 pending tool_result block 而非追加新 message，见 `../context/[P0]context_ingest_detail.md §6 allowEdit`）。tool_reply 的 message.id **不 reissue**（编辑既有占位而非追加新 message，id 无 ordering 依赖）。

**下游约束**：
- `base_builder.appendNew`（`../context/[P0]context_assemble_detail.md §2.6`）不再依赖 msgId ULID 顺序作切片（v0.0.161 改集合 diff + summaryUpTo cutoff），但 A 修复仍是关键——drain 顺序 = msgId 顺序是 transcript 排序、logical-view 组装、observability 关联的 invariant 基础。
- `logical-view.toLogicalMessages`（LLM 上下文渲染）按 msgId 顺序聚合 role，msgId 顺序即对话时间顺序。
- observability trace 关联按 msgId + runId 精确定位，msgId 全局唯一（drain reissue 保证）。

**交叉引用**：msgId 分配契约 I1/I2/I3 详细见 `../agent_interface_and_loop/[P0]agent_inbox_enqueue.md §6.4 msgId 分配契约（v0.0.161）`。
