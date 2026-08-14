---
type: log
title: Message KB 变更记录
updated: 2026-08-12
---

# Message KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-08-12 · v0.0.331（ToolCallBlock arguments 半截容错 `_rawTruncated` + send_message 落库前 normalize）

- **`[P0]agent_message_interface.md §4.6`**：ToolCallBlock 补两段——① **arguments 半截容错**：`safeParseArgs`（agent-loop-stream.ts + replay-collector.ts）parse 失败返回 `{ _raw: <原始buf>, _rawTruncated: true }`（`_raw` 不进 LLM 上下文；`_rawTruncated` 供前端显示「发送失败（参数截断）」而非空白）；② **send_message 落库前 normalize（[v0.0.331 P1]）**：`closeActive()` / `reconstitute()` 对 `name==='send_message'` 且无 `_raw` 时调 `normalizeContentBlocks` 补缺 type block（权威形态契约见 `multi_agent/[P1]subagent_derivation.md §5.1`）——修复 out 信封正文按 `type==='text'` 过滤全滤导致的展开空白。
- 详情：`specs/tech/version_logs/v0.0.331/change_plan.md` + `change_log.md`

## 2026-07-26 · v0.0.206（sender.channel.instanceId → configId — channel 无状态化 wire 改名）

- **`[P0]agent_message_interface.md §5`**：`MessageSender` user 变体 channel 子结构字段 `instanceId → configId`（`message/types.ts:338` `MessageSenderChannel.configId` = ChannelConfig.id）——channel 子系统 ChannelInstance→ChannelConfig 全链改名的 message 侧联动（纯改名；字段表同步）。
- **历史 transcript 不迁**（§5 新增边界注记）：transcript 是 append-only 不可变历史，存量消息的 `sender.channel.instanceId` 保持原样；origin 只对新入站消息实时派生（新消息走新字段），运行时消费零影响，仅前端历史消息来源标签降级。channel_bindings 落盘字段走 MigrationManager（`channel-binding-config-id`，见 `../../migration/log.md`）。
- 详情：`specs/tech/version_logs/v0.0.206/change_plan.md`（模块六）

## 2026-07-17 · v0.0.161（新增 §7 message.id 分配时机 — drain 权威 + enqueueId/msgId 双 ID 独立）

- **`[P0]agent_message_interface.md §7` 新增「message.id 分配时机（drain 权威 — v0.0.161）」**：声明 msgId 分配唯一权威源 = `drainAndPartition` 阶段 `ulid()`；write-in 时刻（HTTP-in / channel-in / tool-emit）分配的 id 是 throwaway 占位。四条契约：(a) msgId 唯一权威源 = drain + ulid（不论 source）；(b) write-in msgId throwaway 不外泄（HTTP 响应 + message_enqueued SSE + GET /inbox 三处均不带 msgId）；(c) enqueueId 与 msgId 严格独立（inbox 队列 key vs transcript key，一消息 = 两 ID；drain 后通过 emitEnqueuedProcessed 建立映射）；(d) tool_reply 分支例外（不进 transcript、不 reissue，编辑既有占位 block）。下游约束 + 代码定位（drainAndPartition line 124-152 / session-messages.ts line 228-235 / feishu-channel.ts line 265 / emitEnqueuedProcessed line 174-187）+ 与 `[P0]agent_inbox_enqueue.md §6.4` 交叉引用。
- **修复背景**：v0.0.161 前 drain user 分支保留 HTTP-in 时刻 throwaway id，其他分支 reissue drain 时刻 ulid，msgId 时钟分裂 → transcript 按 id 升序时 user msg 位置错乱到「过去」→ context assemble 按 id 切割时被永久漏掉。§7 是 msgId 时钟统一化后的正式契约（原本类型层无此声明，是 base_builder/logical-view/observability 隐性依赖的 invariant）。
- 详情：`specs/tech/version_logs/v0.0.161/change_log.md`

## 2026-07-16 · v0.0.157（ImageBlock tool 层退役 — 截图改落盘 + 路径文本）

- **`[P0]agent_message_interface.md §4.2`**：ImageBlock 加说明「v0.0.157 起 tool 层不再构造；类型保留供 protocol 层」。**根因**：prod 用 MiniMax-M3（纯文本模型），computer 截图经 wrapScreenshot 包成 ImageBlock inline 进 tool_result → provider 400「Model only support text input」每轮复现（session `01KXJZCFVST8SQVD4SKGWVDP0E` 实证 5 条 image tool_result / 上下文 107k 未压缩）。**方案**：截图统一落盘 `<workdir>/snapshots/<toolCallId>.<ext>`，tool_result 改纯 text（路径 + size + "Use see_image" 引导），多模态模型按需显式调 see_image 读路径。ImageBlock 类型本身**保留**（protocol-encode `case 'image'` 仍需翻译 spec 形→wire 形，protocol 层消费路径未被 tool 层退役影响）。
- **不改**：`message/types.ts ContentBlock` union 不改（ImageBlock 类型保留）；`ToolResultBlock.content: ContentBlock[]` 不改（类型上仍可承载 image，但 tool 层不再产出）；context assemble 不过滤 image 的行为不改（仅 text/reasoning 进 summary，image 在 compact 时丢弃是预期）。

详情：`specs/tech/version_logs/v0.0.157/log.md` + `change_plan.md`（§2 影响面 message/types 条目）+ `../tools/log.md`（tool 层主变更）。

## 2026-07-10 · v0.0.107（MessageSenderChannel 加 type 字段）

- **`[P0]agent_message_interface.md §5`**：`MessageSender` user 变体加可选 `channel?: {type, instanceId, conversationId, imUserId, imUserName}` 子结构（`message/types.ts:308` `MessageSenderChannel` 新增 `type` 字段=implId 如 `'feishu'`；原 4 字段不变，向后兼容）。仅飞书等 IM 渠道入站填充，web client 直发无 channel；类型权威指向 `../../channel/[P0]channel_impl_interface.md §5.1`。字段表 + 判别联合定义同步；frontmatter `updated` 同步。
- 详见 `specs/tech/version_logs/v0.0.107/change_log.md` + `change_plan.md`（模块 A）+ `../../channel/log.md`。

## 2026-07-10 · v0.0.105（ImageBlock 全链路打通 — P0 前置，独立 Task 最先做）

- **`[P0]agent_message_interface.md §4.2`**：ImageBlock spec 形早已声明，本版本落地代码层（types.ts 砍了的补回）+ encode 适配（spec 形 → anthropic wire 形翻译）+ ToolResultBlock.content 承载 image（computer use get_app_state 首消费者）。
- **代码 GAP 记录**：`message/types.ts:174-180 ContentBlock` union 缺 ImageBlock；`protocol-encode.ts:255-256 case 'image'` 假设 source 已是 wire 形（实际 spec 形不同，encode 需翻译）。
- **不变的复用点**：ToolResultBlock.content 类型已是 `ContentBlock[]`（types.ts 加 ImageBlock 自动支持）；context assemble 不过滤 image（已核对 context-compact-helpers 仅提取 text/reasoning）。
- **前端渲染**：P1 最小占位（chat UI 展示截图，click 展开）—— 非阻断。

详情：`specs/tech/version_logs/v0.0.105/change_log.md` + `change_plan.md`（模块 A ImageBlock 打通）

## 2026-07-09 · v0.0.101（ToolResultBlock 三态 + ToolReplyBlock + tool_reply sender）

- **`[P0]agent_message_interface.md §4.7`**：ToolResultBlock 加顶层 `status:'success'|'pending'|'fail'` + pending 的 `subState`+`data`；INV-6 占位 block 首次发 LLM 前可变。
- **§4.10a 新增 ToolReplyBlock**（携 toolCallId/handleType/payload，进 user message）；§4.11 联合加 ToolReplyBlock。
- **§5 MessageSource 加 `'tool_reply'`**；MessageSender 判别联合加 `{source:'tool_reply',tool_reply:{toolCallId,runId}}` 变体。
- 详见 `specs/tech/version_logs/v0.0.101/change_log.md` + `change_plan.md`（模块 B）。

## 2026-07-02 · v0.0.50（消息级 isSystemReminder 废止，块级唯一权威）

- `system_reminder_injector` 停写消息级 `metadata.isSystemReminder`（删除 `last.metadata = { ...last.metadata, isSystemReminder: true }` 写入分支）；保留 `metadata` 字段本身（其他 kv 透传）。块级 `TextBlock.isSystemReminder`（v0.0.39 引入）成为唯一权威。
- 旧 transcript 数据（含消息级标记）被前端 `DEFAULT_BLOCK_FILTER`（块级过滤）忽略；不做数据迁移。
- forked-reminder-injector（v0.0.48 新增的 forked 场景 reminder 注入器）**漂移点证伪**：本版澄清前推测它也需同步停写，实际代码 `injectForkedReminder` 仅写 `id/sessionId/role/content/sender`，**从不写 metadata**——本版无需改动。
- `[P0]agent_message_interface.md` §4.1 TextBlock 注释更新（消息级废止/块级唯一）；§5 `metadata` 字段注释同步；index.md ④ 原则更新（块级唯一权威）。

详情：`specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md`

## 2026-06-30 · v0.0.39

- `TextBlock` 加 `isSystemReminder?: boolean` 字段（前后端 `message/types.ts` 同步）：reminder 块级标记。
- 设计决策（块级 vs 消息级）：同 message 多 text block 时，旧 `metadata.isSystemReminder` 只能表达「这条 message 含 reminder」，前端要隐 reminder 时要么整条隐（误伤 user 正文）要么不隐（reminder 暴露）；块级标记让前端 `DEFAULT_BLOCK_FILTER` 精确隐这一块。
- 双标记共存：保留 `message.metadata.isSystemReminder`（兼容旧路径/按消息级读取的工具），新代码读块级。
- LLM 零侵入：`protocol-encode.ts` 的 `encodeContentBlock(text)` 只读 `b.text`，`isSystemReminder` 不进 wire —— reminder 仍透明发 LLM（保 prompt cache 语义）。
- `[P0]agent_message_interface.md` §4.1 补 TextBlock 字段 + 块级/消息级双标记设计决策段。

详情：`specs/tech/version_logs/v0.0.39/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`。
- `agent_message_interface.md` 加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理顶部 `> version:` 噪声 + 文件内「[vX.Y 代码已落地]」残留 drift 注保留（说明当前判别联合形态的落地状态）；版本史迁移到本 log。

## 2026-06-20 · v0.0.31

- `MessageSender` 从「optional 子结构 + 文档约束」升级为**严格 TS 判别联合**（by `source`：`agent`/`user`/`system`/`approval`，每变体独立子结构）。
- `MessageSource` enum `'scheduled'` 并入 `'system'`（heartbeat/cron/reminder 由 `sender.system.kind` 承载）。
- user POST handler 扁平残留 `agentName/agentId` 清除（user 变体 `sender = { source: 'user' }`）。
- 程序构造性原则明确：sender 信封由程序组装（deliverTo enrich 补全 type/name），非 LLM 构造。

详情：`specs/tech/version_logs/v0.0.31/change_log.md`

## 2026-06-14 · v0.0.14

- `accumulateUsage` 激活（三分区真累加 + ratio 学习 + session_usage_update 真发 + getUsageView 真聚合）；v0.0.10 时为 no-op。

详情：`specs/tech/version_logs/v0.0.14/change_log.md`

## 2026-06-12 · v0.0.10

- Usage 全字段（9 token + char + cost + currency）落地 `message/types.ts`；cost 由 LlmClient.call 边界计算（computeCost 按 modelConfig.pricing）。
- char 两个字段：`inputCharCount`（assemble snapshot 产出）+ `outputCharCount`（llm client 统计）。

详情：`specs/tech/version_logs/v0.0.10/change_log.md`

## 2026-06-10 · v0.0.8

- `agent_message_interface.md` 初版：MessageRole（4 态）+ 各家 LLM role 映射 + ContentBlock 总览（10 类 + 联合）+ Message 形态（含 store 信封）+ 持久化归属。
- ContentBlock 子集（5 类）落地 `message/types.ts`：text/tool_call/tool_result/reasoning/usage（Image/Audio/Video/File/ApprovalResult 标 future）。

详情：`specs/tech/version_logs/v0.0.8/change_log.md`
