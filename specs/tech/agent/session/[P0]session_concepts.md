---
type: concept
title: Session Concepts（内容概念）
priority: P0
status: active
updated: 2026-06-30
since: v0.0.7
---

# Session Concepts

> 本文档定义 session 层的内容概念：**raw / transcript / tool_result / summary**，以及两个剪裁状态 **message_snipped / tool_block_snipped**。
>
> 这些概念是 `[P0]session_store.md`（统一存储）的权威定义。`message` 是逻辑概念（一轮交互的信息），不单独建表。
>
> **存储归属**：全部经 `[P0]session_store.md` 的 SessionStore 存取（底经 persistence CrudStore）。「何时把大内容挪出热路径」是 context 的 **offload 决策**（见 `../context/`），落到 session 这里只是普通地存一条 raw / tool_result。**无独立 off-store / off-loader**（旧 `session_off_loader.md` 已废弃）。

## 1. 内容概念

一条 message 在系统里可能存在多种表示，分属不同生命周期、不同存储：

| 概念 | 一句话 | 是否一定发给过 LLM | 是否一定持久化 |
|------|--------|------------------|--------------|
| **raw** | 原文，message 进入系统时的原始完整内容 | ❌ 不一定（可能太长直接截断，从未整段发给 LLM） | ❌ 只有被 offload 时才额外存 |
| **transcript** | 每个 message **第一次被发送给 LLM 时**的样子 | ✅（首次发送即冻结） | ✅ 主存储的规范记录 |
| **tool_result** | 工具结果（或过长 tool call 参数）的原文 | ❌ 不一定（过大被截断） | ❌ 只有被 offload 时才额外存 |
| **summary** | 通常从开头到某一条 message 的概括 | — | ✅ 持久化（snapshot 级别使用） |

> `message` 是**逻辑概念**：针对一轮交互的信息。llm message 与 context 各自把 message 处理成自己业务方便的形态；session 存规范形态，消费者按需转换。

### 1.1 raw（原文）

- message 进入系统时的**原始完整内容**，未做任何缩减。
- 可能很长（巨大的工具结果、整份文件、大图片等）。
- raw **不一定被发送给过 LLM**：如果太长，可能在 assemble 阶段就被截断（truncate），整段原文从未完整进入过 LLM 请求。
- raw **默认不单独持久化**。只有当 context 决策 offload 它时，才额外存到 SessionStore 的 raw 内容（`saveContent(..., "raw", ...)`），transcript 通过引用关联（见 `[P0]session_store.md`）。
- 因此 raw 是**尽力保留**的：未被 offload 的 raw 在进程结束后可能丢失，transcript 才是可靠的历史记录。

### 1.2 transcript（会话内容）

- 每个 message **第一次被发送给 LLM 时**的样子，**冻结于首次发送**。
- 不一定是原文：可能被 **truncate**（按长度截断）或 **snip**（按相关性剪除），见 §2。
- transcript 是主存储里的**规范记录**——history、replay、后续 assemble 的读取都基于它。
- 一旦冻结，transcript 内容不再变化（除非显式 `allowEdit` 覆盖，见 `../context/[P0]context_ingest_detail.md`）。

> **关键不变量**：transcript = 首次发给 LLM 的形态。这意味着「同一条 message 在 transcript 里永远是它第一次被 LLM 看到的样子」，即使之后 raw 被 off-load、被丢弃，或后续轮次上下文发生变化，transcript 不变。

### 1.3 summary（概括）

- 通常覆盖**从 transcript 开头到某一条 message** 的内容概括。
- 在 snapshot 中使用（见 `../context/[P0]context_snapshot_interface.md` 的 `SummaryInfo`）。
- 由 compact 生成，不 per-message，而是区间级。

---

## 2. 两种缩减：truncate vs snip

raw → transcript 之间可能发生两种缩减，必须区分：

| 类型 | 触发依据 | 作用对象 | 是否记录状态 |
|------|---------|---------|------------|
| **truncate（截断）** | **长度**（超 token / 字节预算） | content 内部裁短（如 tool result 只保留头尾） | 由 raw 与 transcript 的差异体现；大块原文 offload 到 SessionStore 保留 |
| **snip（剪裁）** | **相关性**（认为不需要传递给 LLM） | 整条 message 或某些 block 整体移除 | ✅ 记录在 transcript 上（见 §3） |

- truncate 是「**缩短**」：内容还在，只是被裁短了；被裁掉的大块原文经 offload 存到 SessionStore（raw / tool_result），可还原。
- snip 是「**移除**」：整条或整块被认为不必传，从 transcript 里拿掉，并打标记告知消费者「这里剪过」。

---

## 3. 两个剪裁状态（记录在 transcript 上）

当一条 message 的 transcript 发生过 snip，**若存在**则在 transcript 记录上标注以下状态（字段缺失 = 该类 snip 未发生）。两个 snip 状态**本质都是布尔**（是否发生过），但 tool block 还需要知道「剪了哪几个」，故额外配一个 id 列表：

```typescript
interface TranscriptSnipState {
  /** 整条 message 被认为不需要传递，已整体剪裁（整条，无需 id） */
  message_snipped?: boolean;

  /** 是否有 tool block 被剪裁（与 message_snipped 对称，都是 t/f） */
  tool_block_snipped?: boolean;

  /** 被剪裁的 tool block id 列表；仅当 tool_block_snipped === true 时有值 */
  snipped_tool_block_ids?: string[];
}
```

> 不变量：`tool_block_snipped === true` ⇔ `snipped_tool_block_ids` 存在且非空。

### 3.1 `message_snipped: boolean`

- `true`：整条 message 被剪裁，transcript 里这条 message 不携带实质内容（可能仅占位 / 元信息）。
- 消费者据此知道「这条 message 存在过，但内容被整体跳过」，而非「这条 message 不存在」。
- 整条剪裁时无需 id（剪的就是整条），所以没有配套列表字段。

### 3.2 `tool_block_snipped: boolean` + `snipped_tool_block_ids: string[]`

- `tool_block_snipped`：**布尔**，表示这条 message 里是否有 tool block 被剪（与 `message_snipped` 对称）。
- `snipped_tool_block_ids`：被剪掉的 **tool 相关 block** 的 id 列表（ToolCallBlock.id 或对应 ToolResultBlock 的 toolCallId）。仅当布尔为 `true` 时填充。
- 粒度是 block 级：message 本身还在 transcript，只是其中某些 tool block 被移除。
- 消费者据此还原「这条 message 曾有这些 tool 调用/结果，但被剪掉了」。

### 3.3 为什么记录这些状态

- **可观测**：UI 能显示「此条消息/此工具调用被剪裁」，而非无声消失。
- **可回溯**：结合 SessionStore 存的 raw / tool_result，被 snip/truncate 的大块原文有机会还原（context loader 读回）。
- **审计**：判断 transcript 是否完整，避免误把剪裁后的形态当成原文。

---

## 4. 存储关系

全部内容经 **SessionStore**（`[P0]session_store.md`）存取，底层是 persistence CrudStore：

```
┌─────────────────────────────────────────────────────────────┐
│ transcript（主存储规范记录，总存）                            │
│  Message(transcript form)                                    │
│   ├─ content: ContentBlock[]   ← 发给 LLM 的形态（冻结）      │
│   ├─ message_snipped?                                        │
│   ├─ tool_block_snipped?                                     │
│   └─ rawRef? / toolResultRef?  ← 若 offload，引用大内容 contentId │
└─────────────────────────────────────────────────────────────┘
                │ offload（context 决策：raw 大 / 需保留时）
                ▼
┌─────────────────────────────────────────────────────────────┐
│ raw / tool_result（SessionStore 普通内容，仅 offload 时存）   │
│  item = 整 message 级快照，pk=(sessionId, contentId)          │
│  context loader 按 contentId + offset/limit 读回              │
└─────────────────────────────────────────────────────────────┘
summary（总存，单值/会话）：compact 产出，snapshot 用
```

**持久化规则**：
- transcript / summary：**总是**存（主存储 / snapshot）。
- raw / tool_result：**仅当 context 决策 offload** 才额外存；否则不单独保存。
- snip 状态：作为 transcript 字段随 transcript 一起存。

> **存储归属**：全部经 `[P0]session_store.md` 的 SessionStore（底经 persistence CrudStore，engine per-schema）。raw / tool_result 作为**普通 CrudStore 实体**（item=message），**无独立 blob store / off-store**（旧 off-loader 概念已废弃）。

---

## 5. 与 ContextEngine 的对应

| ContextEngine 概念 | 本文概念 |
|-------------------|---------|
| transcript（context engine 读取的消息序列） | §1 transcript 记录 |
| `assemble()` 选出的 messages | transcript 中未被 snip、未被 compact 进 summary 的部分 |
| `SummaryInfo` | §1 summary |
| `ingest()` 写入 | 委托 SessionStore.appendMessages 写 transcript（含 snip 状态、rawRef/toolResultRef） |
| offload 决策 + 大内容读回 | context 决策（truncate 时 `saveContent`），context loader 读回（见 `../context/[P0]context_ingest_detail.md`） |

> ContextEngine 在 ingest/assemble 时**决策**哪些 raw/tool_result 需要 offload，委托 SessionStore 存，并在 transcript 上记录 snip 状态与引用。session 侧只是存取，不参与 offload 决策。
