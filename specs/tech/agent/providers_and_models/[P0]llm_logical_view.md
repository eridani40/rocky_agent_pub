---
type: interface
title: LLM Logical View（业务 Message → LLM 视图 公共 encoder）
priority: P0
status: active
updated: 2026-07-02
since: v0.0.50
related: [[P0]llm_protocol_interface.md, [P0]agent_message_interface.md, ../../multi_agent/[P1]a2a_protocol.md]
---

# LLM Logical View（业务 Message[] → LLM 视图 Message[] 公共 encoder）

## 1. 概述

**(a) 管什么**：定义**业务 `Message[]` → LLM 视图 `Message[]`** 的 protocol 无关公共 encoder——把结构化 `sender` 信封**展平**到首个 TextBlock 文本前缀（`[User]:` / `[Message from ...]` / `[System (...)]:` / `[Approval result]:`），供任意 `protocol.encode` 消费。是各 protocol.encode 的**统一上游**。

**(b) 不管什么**：协议本身映射（role tool→user、相邻同 role 合并、system 顶层落点、cache_control、多模态编码 → `LlmProtocol.encode`，见 `[P0]llm_protocol_interface.md`）；业务 Message 类型定义（→ `../message/[P0]agent_message_interface.md`）；sender 信封的程序构造（→ `../message/[P0]agent_message_interface.md §5`）；agent loop 何时调用本层（→ 各 mode 的 `callLLM` 入口）。

**(c) 与外界如何交互**：agent loop（stage-llm / call-main / call-forked 三入口）在 `toLogicalMessages(snapshot.messages)` 后，把视图产物同时喂给 (1) `observability.startGeneration({kind:'logical', input})` 的 `input.messages`，(2) `client.call`/`protocol.encode` 的入参 messages。`protocol.encode` 收到的**已是视图形态**——sender 已展平入 content，encode 不再感知 sender 字段。

### 1.1 为什么抽公共层（设计取舍）

`sender` 是结构化字段（`MessageSender` 判别联合，by `source`），LLM 不能理解结构；进 wire 前必须变成人类可读文本前缀（防幻觉、指示 a2a 回复方向）。若每 protocol 各做一遍此转换：
- **逻辑重复**：`[User]:` / `[Message from ...]:` 表要复刻 N 份。
- **不一致风险**：某 protocol 忘转 sender → LLM 看不到"这条谁发的"，导致行为漂移。
- **observability 打点困难**：想让 langfuse 记「LLM 真正看到什么」，必须先展平，抽公共层后 logical generation input 天然就是"LLM 视角"。

故 v0.0.50 抽为一层：所有 `protocol.encode` 上游统一调 `toLogicalMessages`；protocol 自身只做**协议本身的合并/映射**（role tool→user、相邻同 role 合并、system 顶层、cache_control 等）。

**反例**：若由 protocol 各自实现，新增 protocol（openai_chat_completions / gemini）需复制粘贴前缀表，且 observability 的 logical generation input 仍是业务视图（sender 未展平），与 LLM 真正看到的 input 不一致——对账盲区。

## 2. 接口定义

```typescript
/**
 * 业务 Message[] → LLM 视图 Message[]（sender 展平入首个 TextBlock 前缀）。
 *
 * 公共 encoder：所有 protocol.encode 上游统一调本函数。返回新数组，不 mutate 入参；
 * 每个元素是浅拷贝（{...m}）——sender/metadata/id/role/runId 等字段原样保留，
 * 仅 content 替换为 renderMessageContentWithPrefix 产出的新数组。
 *
 * @param messages 业务 Message[]（sender 结构化，可能混块含 reminder）
 * @returns LLM 视图 Message[]（sender 已展平入首块前缀，其他字段保留）
 */
export function toLogicalMessages(messages: Message[]): Message[];

/**
 * 把前缀注入 message.content（返回新 content blocks，不改原 message）。
 *
 * 注入策略：
 *   - 前缀为空 → 原样返回 content 引用（无拷贝，caller 不修改则安全）
 *   - 首个 block 是 TextBlock → 前缀拼到其 text 前（返回新 TextBlock，不污染原 block）
 *   - 首个 block 非 TextBlock 或空 content → prepend 一个新 TextBlock 承载前缀
 *
 * @param message 业务 Message（读 sender + content）
 * @returns 渲染后的 content blocks（无前缀时 === 原 content 引用）
 */
export function renderMessageContentWithPrefix(message: Message): ContentBlock[];

/**
 * 按 sender.source 渲染前缀字符串（无 sender / 未知 source → 空串）。
 *
 * @param sender 消息来源信封（判别联合，by source）
 * @returns 前缀字符串（含末尾 `: ` 分隔符）；无前缀时返回空串
 */
export function renderSenderPrefix(sender: MessageSender | undefined): string;
```

## 3. 前缀表（6 类 source）

| sender.source | subkind | prefix |
|---|---|---|
| `agent` | — | `[Message from <ref.name> (<ref.type>, needReply=<bool>)]: ` |
| `user` | — | `[User]: ` |
| `system` | `kind='heartbeat'` | `[System (heartbeat tick)]: ` |
| `system` | `kind='reminder'` | `[System reminder]: ` |
| `system` | 其他 kind | `[System (<kind>)]: ` |
| `approval` | — | `[Approval result]: ` |
| 无 sender / 未知 source | — | 空串（content 原样返回） |

**前缀表权威**：与 a2a prompt 渲染规则对齐（见 `../../multi_agent/[P1]a2a_protocol.md §5`「消息归属 = sender.source 分流」表）。sender 字段定义见 `../message/[P0]agent_message_interface.md §5`。

**注入策略**（与原 `message-prefix-renderer` 行为逐字节一致，v0.0.50 仅位置迁移）：
- 前缀空 → 原样返回 content 引用（caller 不修改则安全）。
- 首个 block 是 TextBlock → 前缀拼到其 `text` 前（返回新 TextBlock 对象，不污染原 block）。
- 首个 block 非 TextBlock 或 empty → prepend 一个新 TextBlock 承载前缀。

## 4. 调用点（agent 侧）

`agent-loop-stage-llm.ts` / `agent-loop-call-main.ts` / `agent-loop-call-forked.ts` 三入口在拿到 assemble 后的 snapshot.messages 后、调 `client.call` / `protocol.encode` 前：

```typescript
const logicalMessages = toLogicalMessages(snapshot.messages);
// logicalMessages 同时喂给：
//   1) observability.startGeneration({kind:'logical', input:{messages: logicalMessages, ...}})
//   2) client.call({ messages: logicalMessages, ... })
//      → protocol.encode 拿到的就是视图形态（sender 已展平入 content 前缀）
```

**不变量**：`snapshot.messages` **不被** mutate；`logicalMessages` 是新数组，元素浅拷贝（`{...m}`）+ 首块 TextBlock 新对象（其他 block 引用复用）。

## 5. 设计决策

### 5.1 sender 展平归公共层，不归 protocol

**结论**：sender → 文本前缀的转换在 `llm/logical-view.ts`（公共层），不在各 `protocol.encode` 内。
**理由**：见 §1.1。sender 是消息流的一部分，转换逻辑跨协议复用，抽公共层避免重复 + 不一致 + observability 盲区。
**反例**：若由 protocol 各自实现，新增 protocol（openai_chat_completions / gemini）需复制粘贴前缀表，且 observability 的 logical generation input 仍是业务视图（sender 未展平），与 LLM 真正看到的 input 不一致——对账盲区。

### 5.2 展平目标 = 首个 TextBlock 文本前缀（不进 wire 字段）

**结论**：前缀拼到首个 TextBlock 的 `text` 前（人类可读），不新增 wire 字段（如 `_sender_prefix`）。
**理由**：LLM 只识 wire 的 text 内容，不识结构化字段；前缀入 text 是最透明、最 LLM-friendly 的形态。也是 v0.0.28 起的既有行为（`message-prefix-renderer`），v0.0.50 仅位置迁移，wire body byte-level 不变。
**反例**：若新增 wire 字段，每 protocol 都要在 encode 时多写一个字段、parse 时多识别一个字段；与"protocol 只做协议本身映射"的边界（见 `llm_protocol_interface §1`）冲突。

### 5.3 与 reminder 的关系（reminder 是后续 block，不受前缀影响）

Reminder 已由 `system_reminder_injector` 追加到 last user/a2a message 的 content **末尾**作为独立块级 TextBlock（`isSystemReminder=true`）。经 `toLogicalMessages` 后：
- 该 message 的 `sender.source='user'`（或 `'agent'`），前缀 `[User]:` 拼进首个 TextBlock（业务正文）前。
- reminder block 是**后续**的 TextBlock，不受前缀影响；仍原样 `[system_reminder]\n- ...`。
- LLM 看到：`[User]: 请列出目录\n... reminder text ...`（首块前缀 + 尾块 reminder）。

块级 `isSystemReminder` 标记**不进 wire**：`protocol-encode.encodeContentBlock(text)` 只读 `b.text`（既有语义，见 `protocol-encode.ts`）。

### 5.4 边界（零件唯一归属）

| 管 | 不管 |
|---|---|
| sender 展平（→ 首个 TextBlock 前缀） | tool→user role 映射（→ protocol.encode） |
| 保持其他字段（role/id/metadata/tool block 等）原样 | 相邻同 role 合并（→ protocol.encode） |
| ContentBlock 类型联合完整性 | cache_control / system 顶层 / tools wire 字段映射（→ anthropic_impl） |
| 前缀表（6 类 source） | sender 信封的程序构造（→ inbox enrich / agent loop） |

## 6. 示例

业务 messages（sender 结构化 + reminder 块）：

```json
[
  {
    "role": "user",
    "sender": { "source": "user" },
    "content": [
      { "type": "text", "text": "请列出目录" },
      { "type": "text", "text": "[system_reminder]\n- 时间：2026-07-02", "isSystemReminder": true }
    ]
  },
  {
    "role": "user",
    "sender": { "source": "agent", "agent": { "ref": { "type": "mate", "sessionId": "01K...", "name": "explorer" }, "needReply": true } },
    "content": [{ "type": "text", "text": "目录已列出" }]
  }
]
```

经 `toLogicalMessages` 后（视图形态）：

```json
[
  {
    "role": "user",
    "sender": { "source": "user" },
    "content": [
      { "type": "text", "text": "[User]: 请列出目录" },
      { "type": "text", "text": "[system_reminder]\n- 时间：2026-07-02", "isSystemReminder": true }
    ]
  },
  {
    "role": "user",
    "sender": { "source": "agent", "agent": { "ref": {...}, "needReply": true } },
    "content": [{ "type": "text", "text": "[Message from explorer (mate, needReply=true)]: 目录已列出" }]
  }
]
```

protocol.encode 收到本视图 → 进一步 role tool→user 映射 + 相邻 user 合并 → wire body。sender 字段从未出现在 wire 中。

## 7. 边界

| 零件 | 归属 |
|---|---|
| `toLogicalMessages` / `renderSenderPrefix` / `renderMessageContentWithPrefix` 签名 + 前缀表 + 注入策略 + 调用点 | 本文 ✅ |
| `Message` / `MessageSender` / `ContentBlock` 类型定义 | `../message/[P0]agent_message_interface.md` |
| protocol.encode 契约（入参假定已 logical 展平） | `[P0]llm_protocol_interface.md §3.5` |
| agent loop 何时调本层 | `../agent_interface_and_loop/` 各 mode |
| sender 信封程序构造 | `../agent_interface_and_loop/[P0]agent_inbox_enqueue.md §2.5`（enrich） + spawn-action（首任务 sender） |

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
