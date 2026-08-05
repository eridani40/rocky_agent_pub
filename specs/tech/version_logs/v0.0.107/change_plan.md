# v0.0.107 变更计划书 — user message 跨渠道来源标识 + echo 屏蔽

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 背景（echo 根因一句话）

agent loop 对 user 自己的消息也 emit `text_block_*`（`emitTextBlocks`，供 client 渲染 user 气泡）；channel accumulator 无角色判定地把所有 `text_block_*` 当 assistant answer 发回 IM → 用户在飞书发 `123`，飞书先收到 echo `123` 再收到正式回复。修复 = sender.channel 加 `type` + message_start 事件透传 `origin` + accumulator 按 origin.instanceId 分流（self→DROP / 他渠道→「User (from X)」前缀）/ client 按 origin.type 渲染来源徽标。

权威调研：`specs/research/v0.0.107.channel_user_mesage/research.md`

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec 位置 / 项目原则编号 |
| 预计影响行 | +N / -M |

## 变更清单

### 模块 A：message 类型（sender.channel 加 type）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| message | app/server/src/message/types.ts | MessageSenderChannel | 修改 | 加 `type: string` 字段（implId，如 'feishu'；client 缺省 'client'）。原 4 字段（instanceId/conversationId/imUserId/imUserName）不变。兑现 feishu-channel.ts:8 遗留 TODO | MUST：`type` 即 `ChannelInstance.implId`，不另起枚举；MUST NOT 改其它 4 字段名（向后兼容） | specs/tech/channel/[P0]channel_impl_interface.md §5.1；research §3.2 | +3/-0 |

### 模块 B：agent-event（MessageStartEvent 加 origin）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-event | app/server/src/agent/agent-event-types.ts | MessageStartEvent | 修改 | 加可选 `origin?: { type: string; instanceId: string }`。仅 role=user 携带（派生自 sender.channel）；其它 role 不带 | MUST：origin 是「信封元数据」**绝不进发给 LLM 的 content**（protocol-encode 不读）；MUST：累积器/client 消费事件时 origin 唯一来源就是本字段 | specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §4.2；原则 #10「不污染 LLM 协议层」 | +3/-0 |

### 模块 C：emit 派生 origin

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-loop | app/server/src/agent/agent-loop-emitters.ts | emitMessageStart | 修改 | 签名加 `origin?: { type: string; instanceId: string }` 末参；publish 时展开 `...(origin ? { origin } : {})` | MUST：保持 metadata/origin 均为可选末参，不破坏既有调用；MUST NOT 把 origin 塞进 base() 公共字段（仅 message_start 专属） | specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §4.2 | +5/-1 |
| agent-loop | app/server/src/agent/agent-loop-emitters.ts | emitUserMessageBlocks | 修改 | 从 `message.sender` 派生 origin 后调 `emitMessageStart(ctx, message.id, message.role, undefined, origin)`（metadata 位保持 undefined，origin 为第 5 参）。派生规则：`sender?.source==='user' && sender.channel` → `{type: sender.channel.type, instanceId: sender.channel.instanceId}`；`sender?.source==='user'` 无 channel → `{type:'client', instanceId:'0'}`（web client 缺省）；**其它 source（system/agent/approval/tool_reply）→ undefined** | MUST：**gate 按 `sender.source==='user'` 非 role**（source='user' 必 role='user'，但语义锚 source）；systemMessages 走同 helper 但 source≠user → origin undefined；emitTextBlocks/emitMessageEnd 不变 | research §3.2 / §6.1；agent-loop-stage-pre.ts:149-156；feishu-channel.ts:8 TODO | +9/-1 |

### 模块 D：Channel 契约（加 instanceId 供 self 判定）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| channel | app/server/src/channel/types.ts | Channel | 修改 | interface 加 `readonly instanceId: string`（= 本实例 ChannelInstance.id，accumulator self 判定用） | MUST：instanceId === ChannelInstance.id（即 base this.instance.id）；MUST NOT 与 `type` 混淆（type=implId 不唯一） | specs/tech/channel/[P0]channel_impl_interface.md §2 | +2/-0 |
| channel | app/server/src/channel/channel-base.ts | ChannelBase | 修改 | 加 getter `readonly instanceId = this.instance.id`（或直接 `get instanceId() { return this.instance.id; }`）兑现 Channel 新契约 | MUST：值来自构造时注入的 `this.instance.id`，不重新生成；MUST NOT 改 abstract type 字段 | specs/tech/channel/[P0]channel_impl_interface.md §3 | +2/-0 |

### 模块 E：accumulator（echo 过滤 + 跨渠道渲染）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| channel | app/server/src/channel/channel-accumulator.ts | runChannelAccumulator | 修改 | ① 新增 per-loop `userOrigins: Map<messageId, {type, instanceId}>`；② 处理 `message_start` 事件：`role==='user' && ev.origin` 时 `userOrigins.set(ev.messageId, ev.origin)`；③ `text_block_end` 发送前查 `userOrigins.get(ev.messageId)`：命中且 `origin.instanceId === channel.instanceId` → DROP（echo 屏蔽，不调 sendOutbound）；命中且不同 instanceId → 文本前缀 `User (from ${origin.type}): ` 后走 sendOutbound；未命中 → 维持原 answer 行为 | MUST：self 判定按 `origin.instanceId === channel.instanceId`（非 type，因多实例同 implId 时 type 相同但仍可能是不同 instance）；MUST：DROP 即 continue，不调 sendOutbound 不留 buffer；MUST NOT 把 user 渲染文本当 assistant 落库（sendOutbound 构造的 Message role='assistant' 仅作 outbound 信封，IM 侧零改）；MUST：注释行 :120「message_* → 忽略」改为「user 级 message_start 记 origin，其它 message_* 忽略」 | research §2 / §5；specs/tech/channel/[P0]channel_manager.md §3.5 | +30/-3 |
| channel | app/server/src/channel/channel-accumulator.ts | sendOutbound | 修改 | 文档注释更新：现在也承载跨渠道 user 文本（前缀已由 caller 拼好）；签名/行为不变（仍构造 role='assistant' 的 outbound Message 投 channel.onOutBoundMessage） | MUST NOT 改 sendOutbound 签名（caller 拼前缀复用）；MUST NOT 引入新 sendUserOutbound（YAGNI，前缀即可） | research §5.2 | +2/-1 |

### 模块 F：feishu 入站填 type

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| feishu | app/plugins/builtins/feishu/feishu-channel.ts | deliverUserMessage | 修改 | 构造 sender.channel 时加 `type: this.instance.implId`（兑现 :8 注释 TODO）；保留 instanceId/conversationId/imUserId/imUserName 4 字段 | MUST：值取 `this.instance.implId`（ChannelInstance.implId），不用 `this.type`（两者等价但取权威源 instance.implId 更内聚）；同时清 :8 TODO 注释 | research §3.2 / §6；feishu-channel.ts:8 TODO | +2/-1 |
| feishu | app/plugins/builtins/feishu/feishu-channel.ts | onOutBoundMessage | 不改 | accumulator 已在文本前缀 `User (from X): `，formatFeishuOutbound 原样发即可。零改 | — | research §5.2 末段 | +0/-0 |

### 模块 G：web client 类型 + reducer + flatten + 渲染

> ⚠ 4 段协作缺一不可：类型（types + AgentEvent）→ reducer 写 sender.channel → flatten 派生 name → **component-message-stream 渲染 label**。缺最后一段则 flatten 的 name 无处渲染（inert）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-chat | app/web/src/components/chat-page/types.ts | MessageSender | 修改 | user 变体加 `channel?: { type: string; instanceId: string }`（UI 镜像后端 sender.channel slim 子集，只取 type/instanceId，不透传 imUserId/imUserName 保护隐私）。flatten 读 `m.sender.channel.type` 对 **live**（reducer 写 slim）+ **history**（GET /messages 后端全量 channel，converter session-store-converters.ts:136 `sender` 原样透传）两路都成立 | MUST：仅加可选字段，向后兼容；MUST NOT 把 imUserId/imUserName 透到前端（PII） | research §4.2；后端 message/types.ts:308 | +2/-1 |
| web-chat | app/web/src/store/chat-slice-reducer.ts | AgentEvent（message_start 变体） | 修改 | 本地 UI `AgentEvent` 的 `message_start` 联合成员（:31）加 `origin?: { type: string; instanceId: string }`——否则下方 case 读 `evt.origin` 不过 typecheck。运行时该字段由 SSE 原样透传（use-messages.ts:179 `event as AgentEvent` 直接 cast，无字段白名单剥离，origin 天然可见） | MUST：只加可选字段，不动其它联合成员；origin 唯一来源 = 后端 message_start 事件 | 模块 B；chat-slice-reducer.ts:28-31 | +1/-0 |
| web-chat | app/web/src/store/chat-slice-reducer.ts | case 'message_start' | 修改 | 构造新 Message（:165-175 `if(!findMsg)` 创建块内）时读 `evt.origin`：present → 写 `sender: { source:'user', channel: { type: evt.origin.type, instanceId: evt.origin.instanceId } }`；无 origin → 维持原行为（不写 sender） | MUST：只在创建分支写（findMsg 命中不覆盖已有 sender）；client origin（type='client'）也照写，**显示 gate 交给 flatten**（reducer 只转录不做展示判断，单一职责）；MUST NOT 破坏 sideOfMessage（source:'user' 仍走 role 判定，不与 a2a source==='agent' 冲突） | research §4.2；chat-slice-reducer.ts:158-182 | +4/-0 |
| web-chat | app/web/src/components/chat-page/message-flatten.ts | flattenMessages（user-text 分支） | 修改 | user-text ViewElement 的 `name`：`const ch = m.sender?.source==='user' ? m.sender.channel : undefined; name = ch && ch.type !== 'client' ? ch.type : undefined`（**原始 type**，如 'feishu'；不预拼「来自」）。删「user name 由内核 resolveActor 提供」失效注释（无 resolveActor，name 恒 undefined，本版首次填值） | MUST：只非 client 填 name（client/无 channel → undefined，无徽标噪声）；MUST：flatten 只产语义 type，「来自」前缀 + i18n 由渲染层拼（单一职责） | research §4.2；message-flatten.ts:90-97；types.ts ViewElement.user-text.name（:279 字段已存在） | +5/-2 |
| web-chat | app/web/src/components/chat-page/component-message-stream.tsx | RenderRow(user-text) + user 侧渲染 | 修改 | ① `RenderRow` 的 `user-text` 变体加 `name?: string`（:107-112）；② row 折叠时透传 `name: el.name`（:196-202，当前丢弃 name）；③ user 侧 render（:251-255 `flex flex-col items-end` 容器内，PrimitiveBubble 下方）：`row.name` present 时渲一行 muted 小字「来自 {row.name}」label（i18n 前缀 coder 可用现有 t() 包装），testid `msg-user-{messageId}-origin` | MUST：仅 user 侧 + row.name 非空才渲染；MUST NOT 影响 assistant 侧/默认头像/a2a 前缀行；client（name=undefined）不渲染徽标 | research §4.2；本文件 :107-112/:196-202/:251-258；_overview.md §2 user-text | +6/-1 |

### 模块 H：spec 同步（✅ = 架构期已落 tech/channel + tech/agent；⏳ = doc-modifier 阶段 5 落）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec | specs/tech/channel/[P0]channel_impl_interface.md | §2 + §5.1 | 修改 | ✅已落：§2 Channel interface 加 `instanceId`；§5.1 MessageSenderChannel 加 `type` + client origin 缺省 `{type:'client',instanceId:'0'}` | MUST：与代码一致 | 模块 A/D | 已落 |
| spec | specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md | §4.2 MessageStartEvent | 修改 | ✅已落：加 `origin?: {type; instanceId}` + 语义段（仅 role=user / 不进 LLM content / accumulator+client 两处消费） | MUST：与代码一致 | 模块 B | 已落 |
| spec | specs/tech/channel/[P0]channel_manager.md | §3.5.1 | 新增 | ✅已落：user message echo 屏蔽（self instanceId→DROP）+ 跨渠道「User (from X)」渲染规则 + 关键不变量 | MUST：self 判定按 instanceId 非 type | 模块 E | 已落 |
| spec | specs/tech/agent/message/[P0]agent_message_interface.md | §5 MessageSender user 变体 | 修改 | ⏳doc-modifier：user 变体 channel 子结构加 `type` 字段（类型权威指向 channel_impl_interface §5.1） | — | 模块 A | +3/-1 |
| spec | specs/api/overall/04-agent-session.md（§3.2）+ 10-multi-agent.md | 落库 message.sender 形态 | 修改 | ⏳doc-modifier：GET /messages 返回的 user 消息 sender 可含 `channel`（带 `type`）；补 sender.channel.type 契约说明（现文档写 `{source:'user'}` 需补 channel 可选） | — | 模块 A | +4 |
| spec | specs/ui/components/chat-page/_overview.md | §2 user-text 渲染 | 修改 | ⏳doc-modifier：加「非 client channel → user 气泡下渲『来自 {type}』徽标（testid `msg-user-{id}-origin`）」规则 | — | 模块 G | +4 |

## 影响面评估

**跨模块**：message 类型（最底层）→ agent-event → agent-loop-emitters → channel（types/base/accumulator）→ feishu impl → web client（types/reducer/flatten/**component-message-stream 渲染**）。依赖方向严格自底向上，无循环。

**依赖顺序（coder 落地建议）**：模块 A（message 类型加 type）→ B（event 加 origin）先落（最底层类型），C/D/E/F 后端并行，G 前端（其中 G 的 types→AgentEvent→reducer→flatten→component-message-stream 5 段须一起落，缺一则「来自 X」徽标不显示）。

**破坏性变更**：无。所有新字段（MessageSenderChannel.type / MessageStartEvent.origin / Channel.instanceId / MessageSender channel）均为**新增可选字段**或 interface 扩展，向后兼容。

**关键约束（不可破）**：
1. **origin 绝不进 LLM content** — protocol-encode（`llm/protocol-encode.ts`）不读 origin/metadata，仅读 ContentBlock 文本。origin 是事件/message 元数据层概念。
2. **accumulator self 判定按 instanceId 非 type** — 同一 implId（如 feishu）可有多个 instance，必须按 instanceId 精确判定本渠道，否则跨实例串扰。
3. **PII 不透前端** — web MessageSender.channel 只镜像 `{type, instanceId}`，imUserId/imUserName 留后端。
4. **client 类型不显示来源徽标** — 避免 web→web 显示「来自 client」噪声。

**风险点**：
- **origin 派生按 `sender.source==='user'` 非 role**：emitDrainResult 也对 systemMessages（source=system/agent/approval）调 emitUserMessageBlocks（`agent-loop-stage-pre.ts:149-156` 双循环）→ 这些 sender.source≠'user'，派生 origin=undefined，安全不误标。tool_reply（source='tool_reply'）content 是 tool_reply block 非 text，emitTextBlocks 不 emit text_block，无 echo 隐患。
- 飞书 `formatFeishuOutbound` 需兼容带「User (from X): 」前缀的 assistant 形态 outbound（accumulator 拼好文本走现有 sendOutbound role='assistant' 信封）— research §5.2 已确认零改（按纯文本发）。
- accumulator DROP 路径：`text_block_end` 已 `textBuffers.delete(blockId)`（:86）取出 text 后再查 userOrigins 分流；self-DROP 分支须在 delete 之后 `continue`（不调 sendOutbound），避免 buffer 泄漏。
- **history 消息不经 reducer**：GET /messages 返回的历史 feishu 消息 sender.channel 已带 type（模块 A 落库 + converter :136 透传），flatten 直接读 `sender.channel.type` 出「来自 feishu」——与 live SSE（reducer 写 slim channel）两路一致，无需 reducer 参与历史渲染。
- **type 必填 → 唯一构造点 + 测试 fixture 须补**：模块 A 使 `MessageSenderChannel.type` 成必填。全仓唯一构造 sender.channel 的产品代码 = `feishu-channel.ts:270` deliverUserMessage（模块 F 修）；此外 `app/server/src/message/__tests__/message-sender-channel.test.ts` fixture 构造的 channel 对象须补 `type`，否则 UT typecheck 失败（coder 随实现更新 fixture）。
- **测试 mock Channel 需补 instanceId**：模块 D 使 Channel interface 多一必填 `instanceId`，`app/server/src/channel/__tests__/channel-binding-and-redact.test.ts` 的 mock channel（:134/:170/:187/:202 传入的 channel 对象）须补 `instanceId` 字段，否则 UT typecheck/断言受影响（coder 随实现更新 mock + 补 accumulator self-DROP/跨渠道 UT）。

**测试覆盖**（test-plan 阶段细化）：
- UT：emitUserMessageBlocks 派生 origin 三态（feishu channel / client 缺省 / 非 user→undefined）；accumulator self-DROP（instanceId 命中）+ 跨渠道前缀「User (from client)」+ 非 user 消息正常 answer；ChannelBase.instanceId getter；reducer message_start 写 sender.channel（origin present）；flatten user-text name 派生（feishu→'feishu' / client→undefined）；component-message-stream user-text「来自 X」label 渲染
- AT：飞书 inbound `123` → outbound 不再 echo（self DROP，仅正式回复回飞书）；client 发消息 → 绑定同 session 的飞书 IM 收到 `User (from client): ...`
- ET：web user 气泡：feishu 来源显示「来自 feishu」徽标（testid `msg-user-{id}-origin`）；client 自发消息无徽标

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现 spec 漂移（如 emitDrainResult 实际签名与本表不符）→ 按代码实际调整 + 汇报偏离，orchestrator 记 doc-sync 待办
