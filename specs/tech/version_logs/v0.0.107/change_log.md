# v0.0.107 — Tech Change Log（user message 跨渠道来源标识 + echo 屏蔽）

> 跨版本发布说明（版本轴）。本目录级变更见各 KB `log.md`（位置轴）：`specs/tech/channel/log.md` + `specs/tech/agent/agent_interface_and_loop/log.md` + `specs/tech/agent/message/log.md`。
> 权威输入：`specs/tech/version_logs/v0.0.107/change_plan.md`（method 级契约，模块 A-H）+ `specs/research/v0.0.107.channel_user_mesage/research.md` + `states/v0.0.107.channel_user_mesage/task.json` decisions。

## 概览

channel（飞书）已实现，但 user message 跨渠道下发有 echo 回环 bug：用户在飞书发 `123`，飞书先收到回环的 `123` 再收到正式回复。本版修复 echo + 加来源标识 + client「来自 X」徽标。

**echo 根因**：agent loop 对 user 自己的消息也 emit `text_block_*`（`emitUserMessageBlocks → emitTextBlocks`，供 client SSE 渲染 user 气泡）；channel accumulator 无角色判定地把所有 `text_block_*` 当 assistant answer 发回 IM = echo。**过滤点 = outbound（accumulator）按 instanceId 判 self→DROP**（不是发送/inbound 时——user message 必须进 agent loop）。

**三原则**：
1. **来源标识**：user content block 加渠道 `type`（client=client/feishu=implId）+ instanceId。
2. **client 渲染**：type=client 正常 / 非 client → user 气泡下显「来自 {type}」徽标。
3. **IM outbound 过滤**：origin.instanceId === channel.instanceId → DROP（echo 屏蔽）/ 不同 → 渲染「User (from {type}): xxx」。

**破坏性变更**：无。所有新字段（`MessageSenderChannel.type` / `MessageStartEvent.origin` / `Channel.instanceId` / web `MessageSender.channel`）均为新增可选字段或 interface 扩展，向后兼容。

## §1 message 类型（模块 A）

`MessageSenderChannel` 加 `type: string` 字段（`message/types.ts:308`，= `ChannelInstance.implId` 如 `'feishu'`；web client 缺省语义 `'client'`）。原 4 字段（instanceId/conversationId/imUserId/imUserName）不变。兑现 `feishu-channel.ts:8` 遗留 TODO。

spec：`agent/message/[P0]agent_message_interface.md §5`（user 变体 channel 子结构加 type）+ `channel/[P0]channel_impl_interface.md §5.1`。

## §2 agent-event origin（模块 B/C）

- **`MessageStartEvent` 加 `origin?: {type, instanceId}`**（`agent-event-types.ts:137`，仅 role=user 携带）。
- **`emitMessageStart` 加 origin 末参**（`agent-loop-emitters.ts:106`，只挂 message_start 事件体，不进 base() 公共字段）。
- **`deriveUserOrigin(sender)` 派生规则**（`agent-loop-emitters.ts:130`，gate 按 `sender.source==='user'` 非 role）：user+channel → `{channel.type, channel.instanceId}`；user 无 channel → `{type:'client', instanceId:'0'}`；非 user source（system/agent/approval/tool_reply）→ undefined。
- **origin 绝不进 LLM content**：protocol-encode 只读 ContentBlock 不读 origin/metadata。

spec：`agent/agent_interface_and_loop/[P0]agent_event.md §4.2`。

## §3 channel accumulator echo 屏蔽（模块 D/E/F）

- **`Channel` interface 加 `readonly instanceId`**（`channel/types.ts:29`）+ `ChannelBase` getter 透 `this.instance.id`（`channel-base.ts:57`）。self 判定按 **instanceId 非 type**（同 implId 可有多 instance）。
- **`runChannelAccumulator` echo 分流**（`channel-accumulator.ts`）：`message_start(role=user)` 记 `userOrigins: Map<messageId, origin>`；`text_block_end` 查表：self（instanceId 匹配）→ DROP（不 sendOutbound）/ 跨渠道 → 前缀 `User (from ${type}): ` 走 sendOutbound / 未命中 → 原 answer 行为；**`message_end` 清 userOrigins 项**（资源卫生，code-review Minor 修，防无界增长）。
- **feishu `deliverUserMessage` 填 `type: this.instance.implId`**（`feishu-channel.ts:270`）；onOutBoundMessage 零改（前缀已由 accumulator 拼好，formatFeishuOutbound 原样发）。

spec：`channel/[P0]channel_manager.md §3.5.1`（伪代码补 message_end 清理 + 不变量修正）+ `channel/[P0]channel_impl_interface.md §2`。

## §4 web client 渲染链（模块 G，4 段缺一不可）

`chat-page/types.ts` MessageSender user 变体加 `channel?: {type, instanceId}`（slim，不透 PII）→ `chat-slice-reducer.ts` message_start 读 evt.origin 写 sender.channel → `message-flatten.ts` user-text `name` 从 sender.channel.type 派生原始 type（非 client 才填）→ `component-message-stream.tsx` user 侧渲「来自 {type}」muted 徽标（testid `msg-user-{id}-origin`，i18n `chat:origin.from`）。live SSE（reducer 写 slim）+ history（GET /messages 后端全量 channel）两路一致。

spec：`specs/ui/components/chat-page/_overview.md §2 rule 2a + §4.6` + `specs/api/overall/04-agent-session.md §3.1/§3.2`（GET /messages 返 sender.channel；POST /messages 不接受 sender.channel，唯一构造点=飞书 WS 入站）+ `specs/api/overall/10-multi-agent.md §4.1`。

## §5 code↔spec 一致性核实

15 符号逐项核对 == spec 契约，零静默偏离。2 授权偏离（deriveUserOrigin helper 抽取 + i18n `origin.from` key）+ 1 code-review Minor 修（message_end 清 userOrigins）均已落 spec。

## 测试

- **UT 主验证**：accumulator self-DROP（instanceId 命中消 123 回环）/ 跨渠道前缀 / 非 user answer 回归 / origin 派生三态 / reducer sender.channel / flatten name / component 徽标。70 本版 test 全过（含 16 新增）。
- **AT** `channel_user_msg_origin` PASS + **ET** `chat_user_origin_badge` PASS（web-origin 负向：client 无 channel/不显徽标）。正向 channel.type + echo 屏蔽 + 「来自 feishu」徽标归 UT（发消息 HTTP 接口不接受 sender.channel，无 message-seed 端点，真飞书全链手动冒烟）。
