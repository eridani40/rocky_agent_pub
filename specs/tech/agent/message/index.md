---
type: index
title: Message 子系统总起（业务消息权威类型）
priority: P0
updated: 2026-07-17
---

# Message 子系统总起（业务消息权威类型）

## ① 是什么

message 子系统 = **agent 业务的 message 类型权威源**——定义 `Message` 形态（role + ContentBlock[] + sender + store 信封）、`ContentBlock` discriminated union（text/tool_call/tool_result/reasoning/usage/...）、`MessageSender` discriminated union（by `source`：user/agent/system/approval）。落库 / agent loop / context engine 共用本类型；LLM 协议层翻译（anthropic wire）由 `llm/protocol-types.ts` 另担。

| 核心概念 | 一句话 |
|---|---|
| **Message** | 业务消息（id/sessionId/role/content[]/runId?/sender?/信封字段）；落 SessionStore transcript |
| **MessageRole** | `"system" \| "user" \| "assistant" \| "tool"`（4 态，框架全保留；适配层翻译各家 LLM） |
| **ContentBlock** | message.content[] 元素，discriminated union（by `type`：text/image/audio/video/file/tool_call/tool_result/reasoning/usage/approval_result） |
| **MessageSender** | 消息来源信封，discriminated union（by `source`：`agent`/`user`/`system`/`approval`）；**程序构造**，非 LLM 构造 |
| **store 信封** | `createdAt`/`updatedAt`/`version`：store 注入管理，业务 put 时不传（见 `../../persistence/`） |
| **tool_call↔tool_result 绑定** | `ToolResultBlock.toolCallId` 关联到 `ToolCallBlock.id`（id = LLM 返回值 or 框架 ULID） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| Message / ContentBlock / MessageSender / MessageRole 类型定义 | 持久化 schema / engine / 分片（→ `../../persistence/`；message 自身只定义结构） |
| 各 role 允许的 ContentBlock 矩阵 + 联合类型 | LLM 协议层 wire 翻译（→ `../providers_and_models/` + `llm/protocol-types.ts`） |
| ToolCallBlock.id 分配规则（LLM 返回 or 框架 ULID） | transcript 剪裁状态字段语义（`message_snipped`/`tool_block_snipped` 由 `../session/[P0]session_concepts.md §3` 定义） |
| ApprovalResultBlock（HITL 审批回流形态） | HITL 流程（→ `../agent_interface_and_loop/[P0]agent_hitl.md`，future 不实现） |
| Usage 类型引用（→ 权威在 `../session/[P0]session_usage.md §1`） | usage 累加 / cost 计算（→ `../session/` + `../llm_caller/`） |

## ③ 与系统的关系

```
                          ┌── session/        (session_usage §1 = Usage 权威；session_concepts §3 = transcript 剪裁状态)
   message KB             │
   (本目录) ──────────────┼── agent_interface_and_loop/  (agent_event §4.3 source 行为；agent_inbox_enqueue §2.5 sender enrich)
                          │
                          ├── persistence/    (CrudStore 注入信封字段 createdAt/updatedAt/version)
                          │
                          ├── providers_and_models/  (LLM role/content 翻译：anthropic system 独立参数 / tool_result content block)
                          │
                          └── multi_agent/    (a2a_protocol §2 AgentRef = sender.agent.ref 子结构)
```

**对外协作点**：
- 类型落地：`app/server/src/message/types.ts`（Message/ContentBlock 子集/MessageSender 判别联合/Usage）。
- sender.agent.ref 引用 `specs/tech/multi_agent/[P1]a2a_protocol.md §2` AgentRef（`{ type, sessionId, name }`）。
- store 信封字段（createdAt/updatedAt/version）由 CrudStore 注入（见 `../../persistence/`）。

## ④ 核心设计原则（跨文件不变量）

1. **message 是业务层权威**——落库 / agent loop / context engine 共用；与 `llm/protocol-types.ts`（协议层 wire 翻译）分工，字段名对齐本 spec（`tool_call`/`tool_result`/`reasoning`）。→ `agent_message_interface.md §1/§3`
2. **ContentBlock 是 discriminated union**——by `type` 区分；各 role 允许的 block 类型有严格矩阵（如 `tool` role 只承载 ToolResultBlock）。→ `agent_message_interface.md §3`
3. **MessageSender 是程序构造非 LLM 构造**——sender 信封（source/agent.ref/needReply/inReplyTo）由程序在投递时组装；LLM 入口只有 `agent.spawn`/`send_message` 工具入参 + AgentRef。判别联合价值 = 程序内部类型安全。→ `agent_message_interface.md §5`
4. **id 体系**：Message.id / ToolCallBlock.id（LLM 未返回时）/ sessionId / runId 均用 ULID；LLM 返回的 tool_call_id 保留原值不强制转换。→ `agent_message_interface.md §4.6/§5` + `../../convention.md §3`
5. **块级标记优于消息级（同 message 多 block 精确区分）**——当标记语义属于「某一块」而非「整条 message」时（如 reminder text block），用 `ContentBlock` 字段（`TextBlock.isSystemReminder`）而非 `message.metadata`。反例：消息级 metadata 只能表达「这条 message 含 reminder」，前端过滤时要么整条隐（误伤同 message 的 user 正文）要么不隐（reminder 暴露）；块级让前端精确隐这一块。**v0.0.50 起块级为唯一权威**：injector 停写消息级 `metadata.isSystemReminder`（双标记共存期结束），旧 transcript 数据被前端块级 filter 忽略、不迁移；对 LLM 零侵入（`encodeContentBlock` 只读 `b.text`）。→ `agent_message_interface.md §4.1` + `../context/[P0]system_reminder.md §4`
6. **[v0.0.161] message.id 分配时机 = drain 权威（write-in 是 throwaway 占位）**——所有 message.id 由 `drainAndPartition` 阶段 `ulid()` 统一分配（不论 source=user/agent/system/approval）；HTTP-in / channel-in / tool-emit 时刻分配的 id 仅满足 inbox schema 非空约束（throwaway），drain 时被 reissue，从不落 SessionStore transcript、也从不通过 HTTP 响应体或 SSE 事件外泄。→ 保证 msgId ULID 单调 = drain 顺序 = transcript 时间顺序（base_builder appendNew / logical-view / observability 都依赖此 invariant）。enqueueId（inbox 队列 key）与 msgId（transcript key）严格独立（一消息 = 两 ID），drain 后 msgId 通过 `emitEnqueuedProcessed` 通知 UI 建立映射。tool_reply 分支例外（不进 transcript、不 reissue）。→ `agent_message_interface.md §7` + `../agent_interface_and_loop/[P0]agent_inbox_enqueue.md §6.4`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **接口定义** | | |
| `agent_message_interface.md` | MessageRole / Usage 引用 / ContentBlock 全集（10 类 + 联合）/ Message + MessageSender 判别联合 / 持久化归属 | [link]([P0]agent_message_interface.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
