# v0.0.107 channel user message 跨渠道下发 + echo 屏蔽 调研报告

- **调研范围**: 用户消息跨渠道（client + IM）下发的来源标识、echo 回环根因、各端渲染/过滤规则
- **调研对象**: 本仓库（channel 基建 v0.0.103 + accumulator），非竞品 refs 调研
- **调研日期**: 2026-07-10

## 1. 概述

channel（飞书）已实现：飞书 inbound → `deliverTo` → agent inbox → agent loop 推理 → accumulator 订阅 agent_loop 事件，按 block 级（answer/tool 概括）发 outbound 回飞书。

**实测 bug**：用户在飞书发 `123`，飞书先收到 `123`（echo 回环），再收到正式回复。本报告定位了 echo 的**确切根因**（agent loop 对 user 自己的消息也 emit `text_block_*`，accumulator 无角色判定地把 user 文本当 answer 发回），并给出来源标识方案、client/IM 渲染过滤规则、改动点清单。

## 2. Echo 根因（核心发现）

### 2.1 事件序列追踪（从 `123` 到 echo）

用户在飞书发 `123` 的完整链路：

1. **入站构造 user Message（带 sender.channel）**
   `app/plugins/builtins/feishu/feishu-channel.ts:263-277` `deliverUserMessage()` 构造：
   ```ts
   sender: { source: 'user', channel: { instanceId, conversationId, imUserId, imUserName } }
   ```
2. **deliverTo → enqueue + emit `message_enqueued`**
   `app/server/src/agent/agent-manager.ts:169-173` 入 inbox；`:513-523` `emitMessageEnqueued()`。
   注意：`message_enqueued` 事件**只带 `source/role/content`，不带 channel 子结构**（`:517-518`）。
3. **activate → runReActLoop → stage ① pre-process drain**
   `app/server/src/agent/loop-stage-context.ts:56-61`：`drainAndPartition` + `emitDrainResult(ctx, drained)`。
4. **emitDrainResult → emitUserMessageBlocks（user 消息也走）**
   `app/server/src/agent/agent-loop-stage-pre.ts:149-163`：对 `result.userMessages` 逐条调 `emitUserMessageBlocks(ctx, um.message)`。注释明确「drain 的所有 source 都用此 helper」。
5. **emitUserMessageBlocks → emitTextBlocks：对 user 的 TextBlock emit `text_block_*`**
   `app/server/src/agent/agent-loop-emitters.ts:160-198`：
   - `:164` `emitMessageStart(role=user)`
   - `:165` `emitTextBlocks` → 对每个 TextBlock emit `text_block_start` + **`text_block_delta(delta='123')`**（整段一次性）+ `text_block_end`（`:176-198`）
6. **accumulator 无角色判定地累积所有 `text_block_*`**
   `app/server/src/channel/channel-accumulator.ts:73-92`：`textBuffers` 按 `blockId` 累积，**只看 ev.type 不看 role/messageId 归属**，注释假定「text_block = answer」（`:7,73`）。
7. **text_block_end → sendOutbound 构造 `role:'assistant'` Message 投回 channel**
   `channel-accumulator.ts:83-92`（end 时发）+ `:125-143`（`sendOutbound` 构造 assistant Message）→ `channel.onOutBoundMessage(msg)`。
8. **飞书 onOutBoundMessage 把 `123` 发回飞书 = ECHO**
   `app/plugins/builtins/feishu/feishu-channel.ts:131-157`。

### 2.2 根因结论

**agent loop 对 user 自己的消息也 emit `text_block_*` 事件**（`emitTextBlocks`，`agent-loop-emitters.ts:176-198`，用于让 client 渲染 user 消息——client 自 v0.0.12 起不再本地 push，全靠 SSE `message_start(role=user)` + `text_block_delta` 渲染，见 `chat-slice-reducer.ts:158-195`）。

**accumulator 的设计前提「text_block = assistant answer」是错的**：`text_block_*` 同时承载 user 消息（`emitTextBlocks`）和 assistant 回复（`StreamConsumer`，`agent-loop-stream.ts:148-159`），两者**仅凭事件类型无法区分**（差异在 messageId/role，accumulator 都不读）。于是 user 的 `123` 被当 answer 原样发回飞书。

> `message_enqueued` 本身**不**触发 echo——accumulator 注释 `:120` 明确「message_* → 忽略」。echo 走的是 drain 后的 `text_block_*` 路径。

## 3. 来源标识方案（type + id 加在哪）

### 3.1 现状盘点

| 位置 | 字段 | 现状 | 代码 |
|------|------|------|------|
| `MessageSenderChannel` | `instanceId/conversationId/imUserId/imUserName` | **已有**，缺 `type` | `message/types.ts:308-317` |
| `ChannelInstance` | `implId`(=type 如 'feishu') + `id`(=instanceId) | 已有 | `channel/types.ts:41-59` |
| `Channel.type` | = implId | 已有 | `channel/types.ts:23` |
| `message_start` 事件 | `role` + `metadata` | **无 sender/origin** | `agent-event-types.ts:125-131` |
| `message_enqueued` 事件 | `source/role/content` | **无 channel** | `agent-manager.ts:517-518` |
| client `MessageSender` | `{source:'user'}` 无 channel | **缺 channel 变体** | `web/.../chat-page/types.ts:44-48` |

**关键缺口**：channel 来源只存在于**落库 Message 的 `sender.channel`**，既不在事件流（accumulator/client 都消费事件不查 store），client 类型也不含 channel 变体。feishu 注释 `feishu-channel.ts:8` 标「channel 字段 type 由 T4 落」=遗留 TODO。

### 3.2 推荐方案：sender.channel 加 `type` + 事件透传 origin

req 想要「type + id 加到 user content block」，但**accumulator/client 都消费事件而非查 store**，所以 origin 必须能经事件到达。最贴合现有设计的方案：

1. **`MessageSenderChannel` 加 `type` 字段**（implId，如 `'feishu'`）：
   `message/types.ts:308-317` → `{ type: string; instanceId; conversationId; imUserId; imUserName }`。
   `id` 即 `instanceId`（已存在，等于 `ChannelInstance.id`）。client 消息 `type='client'`（无 sender.channel 时缺省语义）、`id='0'`。
2. **feishu inbound 填 `type`**：`feishu-channel.ts:270` 加 `type: this.type`（兑现 T4 TODO）。
3. **事件透传 origin**：`emitMessageStart` 增加 `origin`（仅 role=user 携带），从 `message.sender` 派生 slim 结构 `{ type, instanceId }`（client 无 channel → `{type:'client', id:'0'}`）。
   - 改 `agent-loop-emitters.ts:103-115` `emitMessageStart` + `:160-167` `emitUserMessageBlocks`（从 message.sender 派生 origin 传入）。
   - 改 `MessageStartEvent`（`agent-event-types.ts:125-131`）加 `origin?: { type: string; instanceId: string }`。
   - （可选）`message_enqueued` 也加 origin，供 client enqueue-view 渲染来源徽标。

**为何不新增 content block / 不塞 message 级新字段**：origin 是「信封元数据」（同 sender.agent 子结构性质），落 sender.channel 最内聚；事件层只加一个 slim `origin` 字段透传，不污染 ContentBlock（ContentBlock 是 LLM 协议层概念，加 origin 会污染 protocol-encode）。req 提的「content block」建议视为「message 级来源标识」的口语表达，落 sender 更正确。

## 4. client（web）渲染规则

### 4.1 现状

- client 收 `message_start(role=user)` + `text_block_delta` 渲染 user 消息（`chat-slice-reducer.ts:158-195`），**不本地 push**（`:159-161` 注释）。
- `MessageStartEvent` 透传 `metadata`（`reducer:171`）但**无 origin**。
- `flattenMessages` 产 `user-text` ViewElement，`name: undefined`（`message-flatten.ts:90-97`，注释「user name 由内核 resolveActor 提供」）。
- client `MessageSender` 联合**不含 channel 变体**（`types.ts:44-48`）。

### 4.2 渲染规则（建议）

| origin.type | 渲染 |
|-------------|------|
| `'client'`（缺省/无 channel） | 正常 user 气泡，无来源标识 |
| 其他（`'feishu'` 等） | user 气泡 + 来源徽标「来自 feishu」（name/subtitle 位） |

实现点：
- `web/.../chat-page/types.ts:44-48` MessageSender 加 channel 变体 `{ source:'user'; channel?: { type; instanceId; ... } }`。
- `chat-slice-reducer.ts:158-181` `message_start` 分支：从 `evt.origin` 写到 Message.sender.channel（或 metadata）。
- `message-flatten.ts:90-97` user-text：`name` 从 `m.sender?.channel?.type` 派生（非 client → 「来自 {type}」）。

## 5. IM outbound accumulator 过滤规则

### 5.1 accumulator 需新增能力

当前 accumulator（`channel-accumulator.ts`）只认 `text_block_*`，不认 `message_start`，无 origin 概念。改为：

1. **处理 `message_start(role=user)`**：记录 `messageId → origin`（从 `evt.origin`）。当前注释 `:120`「message_* → 忽略」需改为「user 级 message_start 记录 origin」。
2. **text_block 处理时查 messageId 归属**（text_block 事件已带 messageId，`agent-loop-emitters.ts:181-195`）：
   - `messageId ∈ userMessageOrigins` → 是 user 消息文本，走分发判定（下方）；否则当 assistant answer 正常发。
3. **accumulator 需知自身 instanceId**：`Channel` interface 加 `readonly instanceId: string`（或 `runChannelAccumulator` 入参加 selfInstanceId），值 = `ChannelBase.instance.id`。

### 5.2 user 文本 outbound 规则

| 条件 | 动作 |
|------|------|
| `origin.instanceId === self.instanceId`（消息来自本渠道） | **过滤（DROP）**——用户自己发的，IM 已本地渲染，发回 = echo |
| `origin.instanceId !== self.instanceId`（来自 client 或其他渠道） | 渲染 `User (from {type}): {text}`（如 `User (from client): 123`），让人识这是用户消息非 AI |

实现点：
- `channel-accumulator.ts` 新增 `userOrigins: Map<messageId, {type, instanceId}>`；`message_start(role=user)` 记录；`text_block_end` 查表分流。
- `sendOutbound`（`:125-143`）：跨渠道 user 文本时改 role 保持 user + 前缀文案（或新 helper `sendUserOutbound`）。
- 飞书 `onOutBoundMessage`（`feishu-channel.ts:131-157`）目前把 outbound 当 assistant 发；若 accumulator 改发 user 角色 Message，需确认 `formatFeishuOutbound` 兼容（或 accumulator 直接拼好文本走 assistant 通道，IM 侧零改）——推荐 accumulator 拼好 `User (from {type}): {text}` 走现有 `sendOutbound`（assistant 形态但文本含前缀），IM 侧零改。

## 6. 改动点清单

| 模块 | 文件 | 改动 |
|------|------|------|
| message 类型 | `app/server/src/message/types.ts:308-317` | `MessageSenderChannel` 加 `type: string` |
| feishu 入站 | `app/plugins/builtins/feishu/feishu-channel.ts:268-277` | sender.channel 填 `type: this.type`（兑现 T4 TODO） |
| event 类型 | `app/server/src/agent/agent-event-types.ts:125-131` | `MessageStartEvent` 加 `origin?: {type; instanceId}` |
| event emit | `app/server/src/agent/agent-loop-emitters.ts:103-167` | `emitMessageStart`/`emitUserMessageBlocks` 从 sender 派生 origin 传入 |
| accumulator | `app/server/src/channel/channel-accumulator.ts` | 处理 `message_start(role=user)` 记 origin；text_block 查表：self→DROP / 他渠道→「User (from X)」 |
| Channel 契约 | `app/server/src/channel/types.ts:22-35` + `channel-base.ts` | `Channel` 加 `readonly instanceId`（accumulator 判 self 用） |
| client 类型 | `app/web/src/components/chat-page/types.ts:44-48` | MessageSender 加 channel 变体 |
| client reducer | `app/web/src/store/chat-slice-reducer.ts:158-181` | message_start 读 evt.origin 写 sender.channel |
| client flatten | `app/web/src/components/chat-page/message-flatten.ts:90-97` | user-text name 从 sender.channel.type 派生「来自 X」 |

### 6.1 边界与坑

- **client 消息的 origin**：web 发的 user 消息无 sender.channel → origin 缺省 `{type:'client', id:'0'}`；飞书收时 `instanceId('0') !== self.instanceId` → 渲染 `User (from client)`。正确。
- **message_enqueued 是否要带 origin**：echo 修复只需 `message_start` 带 origin（drain 后才有）。enqueue-view 徽标若要也显示来源，需给 `message_enqueued` 也加（agent-manager.ts:513-523）。本期可不做。
- **accumulator self instanceId 来源**：ChannelBase 持 `this.instance`（`channel-base.ts:57`），FeishuChannel extends 它；`Channel.type` 已有，加 `Channel.instanceId` 透出 `this.instance.id` 即可。
- **多渠道同 session 绑定**：D6 binding 双向唯一（一个 session 至多绑一个 instance），故 self 判定不会歧义。
- **spec 同步**：`specs/tech/agent/.../[P0]agent_event.md` §4.2 MessageStartEvent、`specs/tech/channel/[P0]channel_impl_interface.md` §5.1、message interface §5 MessageSenderChannel 需 doc-modifier 同步加 `type`/`origin`。

## 7. 结论

- **echo 根因**：agent loop 对 user 消息 emit `text_block_*`（`emitTextBlocks`），accumulator 无角色判定地把 user 文本当 answer 发回原渠道。
- **最小修复**（仅消 echo）：accumulator 处理 `message_start(role=user)`，对 user messageId 的 text_block 一律 DROP。零新字段。
- **完整方案**（含跨渠道「User (from X)」）：sender.channel 加 `type` + message_start 事件透传 `origin`，accumulator/client 按 origin.instanceId 分流（self→DROP / 他渠道/ client→渲染来源）。
