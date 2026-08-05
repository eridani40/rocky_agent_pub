---
type: design
title: Cache Control (Prompt Caching Breakpoint)
priority: P0
status: active
updated: 2026-07-23
since: v0.0.3
related: [[P0]llm_protocol_interface.md, anthropic_impl.md, ../context/[P0]system_reminder.md]
---

# Cache Control (Prompt Caching Breakpoint)

> 管什么：prompt cache 的**显式 breakpoint 注入策略**（canonical → wire encode 时）+ **历史 reminder 的 wire 层过滤**——把稳定段 cache 在 breakpoint 之前、动态段放 breakpoint 之后，让每轮变化的 reminder 不破前缀 cache。
> 不管什么：reminder 是否持久化进 transcript（→ `../context/[P0]system_reminder.md`，context 层 ingest 决定）、HTTP 调用与缓存命中 token 计费（→ `[P0]llm_client_interface.md` / `session_usage`）。
> 所属层：**protocol encode 层**（canonical → wire 时注入 + 过滤），与 context 层 reminder 持久化**两层独立**（见 §5）。

## 1. 定位

cache_control 是 `LlmProtocol.encode` 的内部策略：把 canonical 请求翻译成 wire body 时，决定**哪些 content block 加 `cache_control:{type:"ephemeral"}` breakpoint**、**哪些历史 block 在 wire 层 drop**。目标：最大化 prompt cache 命中率（省钱省 token），同时允许每轮变动的 reminder 不破坏稳定段 cache。

Anthropic Messages API 的 prompt caching 有**两种命中机制**（互斥，见 §2），本项目走**显式 cache_control breakpoint** 路线（非隐式 prefix-only）。本文件是 protocol 层的**目标契约**；现状代码偏差见 §6（v0.0.52 改代码对齐）。

## 2. 缓存机制两场景（互斥）

Anthropic prompt caching 有两个互斥的命中机制，**理解二者区别是本 spec 全部决策的基础**：

### 2.1 隐式缓存（prefix matching）

- **机制**：整个 input 从头开始的 **prefix 完全匹配**才命中；中间任何字节变了 → cache 全失效。
- **约束**：只能**追加**新内容到末尾，**不能改中间**任何 token。
- **对本项目的代价**：reminder 每 turn 变（时间/环境/工具错误），若每轮 reminder 都**持久化进历史 message**（历史 content 跟着变），则历史段不稳 → prefix cache 从 reminder 第一次出现处全失效。reducer 在 assemble 层「过滤历史 reminder」看似能解决，**实则破坏 implicit 命中前提**（过滤后 wire 的内容序列变了，与上轮 cache key 不一致 → 反而永远 miss）。

### 2.2 显式缓存（cache_control breakpoint）

- **机制**：显式在 content block 上标 `cache_control:{type:"ephemeral"}`，**breakpoint 之前**的内容被 Anthropic 缓存（最多 4 个 breakpoint）；breakpoint 之前稳定 → cache 命中；breakpoint 之后动态 → 不影响前缀 cache。
- **约束**：breakpoint 落点要保证「之前稳定」。
- **对本项目的优势**：reminder 可以**不进历史 wire**（encode 时 drop 历史 reminder block），breakpoint 落在 reminder 之前的稳定段——历史段稳定（cache 命中）+ 末尾 reminder 段动态（不破 cache）。

### 2.3 两场景互斥（关键决策依据）

> **reducer 过滤历史 reminder 是错误方案**（破坏隐式 implicit）：过滤后 wire 内容序列与上轮 cache key 不一致，永远 miss。
> **正确做法是显式 breakpoint 路线下 wire 层过滤**：因为显式缓存不依赖「整个 prefix 字节一致」，breakpoint 之前的稳定段即使内容序列微调（drop 了历史 reminder）也能命中——只要 breakpoint 之前的稳定段本身跨 turn 一致。

本项目选**显式 breakpoint 路线**（§3），对应 wire 层过滤历史 reminder；transcript 仍持久化 reminder（fallback 隐式缓存保留），两层独立（见 §5）。

## 3. 我们的处理机制（显式 breakpoint，目标契约）

`LlmProtocol.encode`（canonical → wire）时，对**支持 cache_control 的协议**执行以下三步：

### 3.1 bp#1：system prompt 末 content block

system prompt 转成 content block array（string 自动转），给**最后一个 system block** 加 `cache_control:{type:"ephemeral"}`。

- **理由**：system prompt 跨 turn 稳定（身份/规则/工具/skills，见 `../context/[P0]system_prompt.md`），是最稳定的 cache 段。
- **落点**：顶层 `system` 参数的 content array 末 block（anthropic 落点 `top_level`，见 protocol §3.5）。

### 3.2 bp#2：最后一个非 reminder 的 content block

**跨所有 wire messages 从末尾向前扫，找第一个 `isSystemReminder !== true` 的 content block**，给它加 `cache_control:{type:"ephemeral"}`。

- **关键**：breakpoint 必须**落在 reminder 之前**的稳定段——不是「最后一条 message 的末 block」（若末 block 是 reminder，bp 落 reminder 上 → 下轮该 reminder 内容变 → cache miss）。
- **搜索规则**：wire messages 数组从末尾向前扫（跨 message 边界），命中第一个非 reminder block 即停。该 block 通常是 user 正文 / tool_result / assistant 回复（业务对话的最末稳定内容）。
- **`isSystemReminder` 字段**：block 级标记，由 context ingest 注入（见 `../context/[P0]system_reminder.md §4`）；encode 读 canonical block 时识别此标记，**写 wire block 时丢弃此字段**（不进 wire，LLM 零侵入）。

### 3.3 过滤历史 reminder（wire 层 drop）

encode 各 message 时，按「是否最后一条 message」分支（**[修正 2026-07-22] 口径从「最末 user message」改为「最末 message」**，role 不限——发送给 LLM 的最后一条永远是 user/tool，wire 上映射后都是 user）：

- **非最末 message**：drop 所有 `isSystemReminder=true` 的 block（历史 reminder 不进 wire）。
- **最末 message**：drop 除**最后一个 reminder block** 之外的所有 `isSystemReminder=true` block（保留当轮 reminder 发给 LLM）。

**修正动机（prod trace 01KY2M2JY81B5P2AGPQRMVE46N 实证）**：旧口径「最末 canonical user message」在 tool 密集 loop 里把 reminder 钉死在历史深处的 user 消息上（该 trace 钉在 msg#1 长达 13 步，内容冻结在 ingest 时刻）；新 user/a2a 消息到达时旧位置 reminder 被 retroactive drop → 已发送前缀在深位置变化 → 隐式 prompt cache（控不了断点，只能逐字节持有已发消息）整段崩（单步 cache_read 掉 128、命中率 0.2%；同 trace 另有 8 处同机制尾部分歧）。新口径下历史 reminder 全 drop，**保留/drop 只发生在尾部**（reminder 恒为所在 message 的末块，被 drop 时前缀损失≈零）。

要点：

- **保留最末 reminder**：当前 turn 的 reminder 仍要发给 LLM（环境/时间/工具错误等上下文 LLM 需要看见）。
- **drop 历史 reminder**：历史 reminder 在 wire 层不再发（避免历史段不稳 + 节省 token）；transcript 仍持久化（context 层，见 §5），不丢数据。
- **过滤时机**：必须在 encode（canonical → wire）层做，**不能在 assemble reducer 做**——assemble 改的是 canonical transcript（破坏隐式缓存 fallback + 违反「transcript 完整」语义），encode 改的是 wire 一次性产物（每轮重新生成，不影响 transcript）。

### 3.4 效果

| 段 | 内容 | 稳定性 | cache |
|---|---|---|---|
| system（bp#1 前） | 身份/规则/工具/skills | 跨 turn 极稳 | 命中 |
| 历史 message（bp#2 前） | 历史对话（去 reminder） | 跨 turn 稳定（追加新 message 不改旧） | 命中 |
| 最末 user message（bp#2 后） | user 正文 + 当轮 reminder | 每 turn 变 | 不命中（动态段） |

整体：稳定段（bp#1 + bp#2 之前）跨 turn 命中 cache，动态段（bp#2 之后的当轮 reminder）每轮变但不破前缀 cache。

## 4. cache_control 是 anthropic_messages protocol encode 专属

cache_control breakpoint（`cache_control:{type:"ephemeral"}`）是 **Anthropic Messages API 特有 wire 字段**，其注入 + 过滤逻辑（§3 三步）在 `anthropic_messages` protocol impl 的 encode（`encodeAnthropicMessages`）内部，**不抽到公共 LlmProtocol 接口**。

| 协议 | cache 机制 | 落点 |
|---|---|---|
| `anthropic_messages`（当前唯一 impl，服务 anthropic 原生 + minimax 兼容端点）| 显式 cache_control breakpoint（§3 三步）| `encodeAnthropicMessages` 内 |
| 未来 protocol（openai_chat_completions 等）| 各自 cache 机制（如 openai 隐式 prefix matching，无显式 breakpoint）| 各 protocol impl 的 encode 各自实现；不实现 cache 的 encode 自然全传 reminder（fallback） |

**为什么不抽公共 `supportsCacheControl` 能力位**：cache_control 是 Anthropic 特有 wire 字段，不同 protocol 的 cache 机制不通用（openai 隐式 prefix vs anthropic 显式 breakpoint）。把 §3 三步（Anthropic wire 格式）提到公共 encode 按「能力位分支」不现实——每个 protocol 的 encode 独立（`encodeAnthropicMessages` 是 anthropic 专属函数），cache_control 逻辑留在 anthropic_messages encode 内最自然。其他 protocol 未来加入时，各自 encode 决定 cache 机制（或不实现 = 自然全传 fallback）。

> 当前仓库仅 `anthropic_messages` impl 实现。`anthropic_impl.md §4` 是 anthropic encode 落地细节。

## 5. 与 context 层关系（两层独立）

reminder 的处理跨两层，**两层职责正交、互不干扰**：

- **context 层（ingest，持久化）**：reminder 由 `system_reminder_injector` handler 在 ingest 时注入到最后一条 user message 的 content 末尾并**持久化进 transcript**（见 `../context/[P0]system_reminder.md §4`）。transcript 完整保留所有历史 reminder（数据不丢）。
- **protocol 层（encode，wire）**：encode canonical → wire 时，按本 spec §3 注入 breakpoint + 过滤历史 reminder。wire 是每轮一次性产物（不写回 transcript）。

**两层独立的意义**：

- transcript 永远完整（context 层职责）——回放/审计/隐式缓存 fallback（不支持 cache_control 的协议）都能用。
- wire 只发必要内容（protocol 层职责）——cache 命中率最大化 + token 节省。
- 一层改动不破另一层：protocol 层过滤 wire 不影响 transcript；context 层 ingest 改 reminder 形态（如改 block 结构）只要 encode 能识别 `isSystemReminder` 标记就能继续过滤。

## 6. 代码对齐状态（v0.0.52 已落地）

> 本 spec 的 §3 三步机制已全部落地于 `app/plugins/builtins/llm_anthropic/protocol-encode.ts`（`encodeAnthropicMessages` 内；v0.0.191 起 impl 物理迁 plugin 目录）。v0.0.52 之前的两项偏差（bp#2 落最后 block 而非最后非 reminder block + 历史 reminder 未在 wire 过滤）已修复。

逐项对齐（`protocol-encode.ts` ↔ spec 条款）：

| spec 条款 | 代码实现 | 状态 |
|---|---|---|
| §3.1 bp#1（system 末 block）| `encodeAnthropicMessages` 内 `body['system'] = [{ type:'text', text, cache_control:{type:'ephemeral'} }]` | ✅ |
| §3.2 bp#2（跨 messages 反向扫第一个非 reminder block）| `injectLastNonReminderCacheControl(encoded, reminderFlags)`：双循环从末尾向前，`flags[bi]===true` 跳过 reminder block，命中第一个非 reminder block 注入并 return | ✅ |
| §3.3 过滤历史 reminder（非最末 message 全 drop；最末 message 只保留最末一个）| `encodeMessage(m, isLastMessage)`：`lastKeptReminderIdx`（非最末 message=-1 全 drop；最末 message=最末 reminder 索引），单遍 `isRem && i !== lastKeptReminderIdx` drop | ✅ |
| §3.2 `isSystemReminder` 不进 wire（零侵入）| `encodeContentBlock` text 分支只取 `{type:'text', text: b.text}`，丢弃 `isSystemReminder` 字段 | ✅ |
| §4 anthropic encode 专属（不动 `LlmProtocol` 接口）| 逻辑全在 `encodeAnthropicMessages` 内；无 `supportsCacheControl` 能力位 | ✅ |
| §5 两层独立（不动 context 层 / transcript 持久化）| encode 只读 canonical block 标记做一次性 wire 过滤，不写回 transcript | ✅ |

> 历史偏差根因（v0.0.8 引入 reminder 时 encode 未同步 reminder 标记 + bp#2 仍按「最后 block」落点）已记录在 `log.md` v0.0.52 条目，不在正文保留版本史。
>
> 注：cache_control 是 anthropic_messages encode 专属（§4），不抽公共 `supportsCacheControl` 能力位——不同 protocol 的 cache 机制不通用（anthropic 显式 breakpoint vs openai 隐式 prefix），抽公共能力位按「分支」不现实。故 v0.0.52 改动只在 `encodeAnthropicMessages` 内，不动 `LlmProtocol` 接口；其他 protocol 未来加入时各自 encode 决定 cache 机制（不实现则自然全传 reminder，fallback）。

## 7. 边界

| 零件 | 归属 |
|---|---|
| cache_control breakpoint 注入策略（落点 + ttl）+ 历史 reminder wire 层过滤 | 本文（cache_control）✅ |
| `LlmProtocol.encode` 契约 + 多模态编码 + role 转换 | `[P0]llm_protocol_interface.md` |
| anthropic_messages impl encode 落地（§3 三步的代码实现） | `anthropic_impl.md §4` |
| reminder 持久化（ingest 注入 + transcript 完整性）+ `isSystemReminder` 标记定义 | `../context/[P0]system_reminder.md` |
| cache 命中 token 计费 / `Usage.input_cache_read` | `../session/[P0]session_usage.md` |
| HTTP 调用 / 编排（cache 命中与否是 client 观测，非 protocol 决定） | `[P0]llm_client_interface.md` |

## 8. 核心设计原则（跨文件不变量）

1. **两层独立**——reminder 持久化归 context 层（ingest），cache_control breakpoint + wire 过滤归 protocol 层（encode）。一层改不破另一层；transcript 完整 + wire 精简同时成立。
2. **显式 breakpoint 路线**——选 cache_control breakpoint（非隐式 prefix-only），因为只有显式 breakpoint 才允许「wire 层 drop 历史 reminder」（隐式路线 drop 内容序列就破坏 prefix 一致性）。
3. **bp 落点不落 reminder**——bp#2 必须落在「最后一个非 reminder block」，落在 reminder 上 = 下轮 cache miss（reminder 内容每轮变）。
4. **encode 层过滤，不进 assemble**——wire 过滤是 encode（canonical → wire 一次性产物）职责，assemble reducer 改 canonical transcript 会破坏隐式 fallback + 违反 transcript 完整语义。
5. **anthropic_messages encode 专属**——cache_control 是 Anthropic 特有 wire 字段，注入 + 过滤逻辑在 `encodeAnthropicMessages` 内，不抽公共 LlmProtocol 能力位；其他 protocol 各自 encode 决定 cache 机制（不实现则自然全传 fallback）。

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
