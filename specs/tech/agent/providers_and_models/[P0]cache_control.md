---
type: design
title: Cache Control (Prompt Caching Breakpoint)
priority: P0
status: active
updated: 2026-08-15
since: v0.0.3
related: [[P0]llm_protocol_interface.md, anthropic_impl.md, ../context/[P0]system_reminder.md]
---

# Cache Control (Prompt Caching Breakpoint)

> 管什么：prompt cache 的**显式 breakpoint 注入策略**（canonical → wire encode 时，三断点体系）——稳定段锚定在 breakpoint 之前，本轮新块落 bp#2 之后；历史 reminder 块 append-only 全保留（v0.0.361），前缀命中不依赖 wire 过滤。
> 不管什么：reminder 是否持久化进 transcript（→ `../context/[P0]system_reminder.md`，context 层 ingest 决定）、HTTP 调用与缓存命中 token 计费（→ `[P0]llm_client_interface.md` / `session_usage`）。
> 所属层：**protocol encode 层**（canonical → wire 时注入断点），与 context 层 reminder 持久化**两层独立**（见 §5）。

## 1. 定位

cache_control 是 `LlmProtocol.encode` 的内部策略：把 canonical 请求翻译成 wire body 时，决定**哪些位置注入 `cache_control:{type:"ephemeral"}` breakpoint**。目标：最大化 prompt cache 命中率（省钱省 token）。**三断点体系（v0.0.361）**：system 末（bp#1）+ tools 末（bp#T）+ messages 末（bp#2）——三层各自锚定缓存边界；历史 reminder 块**全保留进 wire**（不再 drop，见 §3.3）。

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
- **对本项目的优势**：三断点（§3）各自锚定稳定段边界（system/tools/messages）；历史 reminder 块 append-only 字节稳定，bp#2 前缀 = 稳定历史 + 本轮新块 → 每轮命中上一轮缓存条目，只有新块计费。

### 2.3 两场景互斥（关键决策依据）

> **reducer 过滤历史 reminder 是错误方案**（破坏隐式 implicit）：过滤后 wire 内容序列与上轮 cache key 不一致，永远 miss。
> **显式 breakpoint 路线下 wire 层无过滤**（v0.0.361 起）：历史 reminder 块 append-only 进 wire（transcript 持久化 = wire 保留，两层一致）；bp#2 固定打 messages 末 block，前缀命中不依赖「drop 历史」维持稳定。

本项目选**显式 breakpoint 三断点路线**（§3）；旧「drop 历史 reminder」机制已于 v0.0.361 删除（裁决记录见 version_logs/v0.0.361/change_log.md §wire 语义）。

## 3. 我们的处理机制（显式三断点体系，目标契约）

`LlmProtocol.encode`（canonical → wire）时，对**支持 cache_control 的协议**在三个位置注入 breakpoint（**Anthropic 上限 4 断点，三断点合规**）：

### 3.1 bp#1：system prompt 末 content block

system prompt 转成 content block array（string 自动转），给**最后一个 system block** 加 `cache_control:{type:"ephemeral"}`。

- **理由**：system prompt 跨 turn 稳定（身份/规则/工具/skills + session_states 静态段，见 `../context/[P0]system_prompt.md`），是最稳定的 cache 段。
- **落点**：顶层 `system` 参数的 content array 末 block（anthropic 落点 `top_level`，见 protocol §3.5）。

### 3.1b bp#T：tools 末位 tool（v0.0.361 新增）

encodeTools 产出 wire tools 数组后，给**末位 tool** 加 `cache_control:{type:"ephemeral"}`。

- **理由**：tools 定义跨 turn 稳定（工具集在 run/session 级不变）；三断点体系要求 tools 层独立锚定——system 段变更（session states 刷新/summary 重建）→ bp#T 命中 tools+messages 前缀；tools 变更 → bp#1/bp#2 命中 system+messages。三层各自锚定 = 任一层变化不拖垮其余两层缓存。
- **现状来源**：老板 20:34 终版补丁（代码实证 encodeTools 旧为纯映射无注入 → 本版新增）。

### 3.2 bp#2：最末 message 的最末 content block

**固定打最末 message 的最末 content block**（不做反向扫描、不避让 reminder）。

- **理由（v0.0.361 wire 语义裁决）**：历史 reminder 块进 transcript 后**字节不变（append-only）** → bp#2 前缀 = 稳定历史 + 本轮新块 → 每轮命中上一轮缓存条目，只有新块计费。旧「避让扫描找最后非 reminder block」机制已删——每轮重渲染累积视图（drop 方案的对照面）反导致最末块每轮重写 → 前缀分叉 miss，cache_creation 1.25x 重算，比现状更贵。
- **`isSystemReminder` 字段**：块级标记保留（前端 DEFAULT_BLOCK_FILTER 契约，`../context/[P0]system_reminder.md §4`）；encode 写 wire block 时仍丢弃此字段（不进 wire，LLM 零侵入）。

### 3.3 历史 reminder 全保留（wire 层无过滤，v0.0.361）

**encode 不再过滤历史 reminder**：全部 `isSystemReminder=true` 的 block 照常进 wire（历史 full 块 + 增量块 = run 内状态演进轨迹，LLM 可追溯）。

- **旧机制（drop 历史 + 保留最末）已删除**：drop 维持的「尾部动态、历史稳定」在 append-only 语义下天然成立，无需过滤；历史块累积由 compact/summary 天然吸收。
- **transcript 与 wire 一致**：context 层持久化的 reminder = wire 发送的 reminder（两层同内容，无「transcript 有 wire 无」分叉）。

### 3.4 效果

| 段 | 内容 | 稳定性 | cache |
|---|---|---|---|
| system（bp#1 前） | 身份/规则/工具/skills/session_states 静态段 | 跨 turn 极稳 | 命中 |
| tools（bp#T 前） | 工具定义 | run/session 级稳定 | 命中 |
| 历史 message（bp#2 前） | 历史对话（含历史 reminder 块，append-only） | 跨 turn 稳定（追加不改旧） | 命中 |
| 最末 message（bp#2 后） | 本轮新块（user 正文/当轮 reminder） | 每 turn 变 | 不命中（动态段） |

整体：三断点各自锚定稳定段；bp#2 前缀 = 稳定历史 + 本轮新块 → 每轮命中上一轮缓存条目，只有新块计费。

## 4. cache_control 是 anthropic_messages protocol encode 专属

cache_control breakpoint（`cache_control:{type:"ephemeral"}`）是 **Anthropic Messages API 特有 wire 字段**，其三断点注入逻辑（§3）在 `anthropic_messages` protocol impl 的 encode（`encodeAnthropicMessages` + `encodeTools`）内部，**不抽到公共 LlmProtocol 接口**。

| 协议 | cache 机制 | 落点 |
|---|---|---|
| `anthropic_messages`（当前唯一 impl，服务 anthropic 原生 + minimax 兼容端点）| 显式 cache_control breakpoint（§3 三步）| `encodeAnthropicMessages` 内 |
| 未来 protocol（openai_chat_completions 等）| 各自 cache 机制（如 openai 隐式 prefix matching，无显式 breakpoint）| 各 protocol impl 的 encode 各自实现；不实现 cache 的 encode 自然全传 reminder（fallback） |

**为什么不抽公共 `supportsCacheControl` 能力位**：cache_control 是 Anthropic 特有 wire 字段，不同 protocol 的 cache 机制不通用（openai 隐式 prefix vs anthropic 显式 breakpoint）。把 §3 三步（Anthropic wire 格式）提到公共 encode 按「能力位分支」不现实——每个 protocol 的 encode 独立（`encodeAnthropicMessages` 是 anthropic 专属函数），cache_control 逻辑留在 anthropic_messages encode 内最自然。其他 protocol 未来加入时，各自 encode 决定 cache 机制（或不实现 = 自然全传 fallback）。

> 当前仓库仅 `anthropic_messages` impl 实现。`anthropic_impl.md §4` 是 anthropic encode 落地细节。

### 4.1 reminder 密度分级（v0.0.274 记录方向，不实现）

**密度策略按 protocol 的 cache_control 能力分级**（老板 2026-08-07 拍板记录，详见 `../version_logs/v0.0.274/reminder-cache-design-discussion.md §五`）——对未来新增不支持 cache_control 的 protocol 有支撑，本版本只记录方向、不实现：

| protocol cache 能力 | reminder 注入策略 | 为什么 |
|---|---|---|
| **支持 cache_control**（Anthropic，当前唯一）| user + tool_result 都注入（v0.0.274 起）| 三断点锚定（bp#T/bp#2）+ 历史 reminder 块 append-only 全保留（§3.2/§3.3）→ bp#2 前缀每轮命中上一轮条目，注入不破缓存 |
| **不支持 cache_control**（未来 openai_chat_completions 等）| 无显式 breakpoint，只有隐式 prefix matching → reminder 频繁注入会崩隐式 cache → 需密度控制预案 | 预案 A：**清理 run 内非首个 reminder**（run 开始只留第一个，后续全 drop）；预案 B：**每 10 个保留第一个**（保持密度上限，兼顾 LLM 看到近期团队状态） |

**三层自洽性（v0.0.361 语义）**：tool 上加 reminder（context 层 ingest）+ 历史块 append-only 全保留（protocol 层 wire）+ 三断点锚定（bp#1/bp#T/bp#2）三者自洽——Anthropic 下注入密度不影响缓存（每轮只有新块计费），不需要额外密度控制；只有不支持 cache_control 的 protocol 才需要显式密度预案（预案 A/B 在**该 protocol 的 encode 内部**实现，不污染 context 层 ingest，也不动 anthropic encode）。

**未来扩展锚点**：新增 protocol 时，在 `LlmProtocol` 接口（`../providers_and_models/[P0]llm_protocol_interface.md`）加 `supportsCacheControl` 能力标志 → 各 protocol 的 encode 按能力标志分派密度策略：支持 → 沿用 Anthropic 模式（注入 + wire 收敛）；不支持 → 应用预案 A/B。当前 anthropic_messages 不抽公共能力位（本 spec §4 前述），该标志仅对未来多 protocol 场景有约束力。

## 5. 与 context 层关系（两层独立）

reminder 的处理跨两层，**两层职责正交、互不干扰**：

- **context 层（ingest，持久化）**：reminder 由 `system_reminder_injector` handler 在 ingest 时注入到最后一条 user message 的 content 末尾并**持久化进 transcript**（见 `../context/[P0]system_reminder.md §4`）。transcript 完整保留所有历史 reminder（数据不丢）。
- **protocol 层（encode，wire）**：encode canonical → wire 时，按本 spec §3 注入 breakpoint + 过滤历史 reminder。wire 是每轮一次性产物（不写回 transcript）。

**两层独立的意义**：

- transcript 永远完整（context 层职责）——回放/审计/隐式缓存 fallback（不支持 cache_control 的协议）都能用。
- wire 只发必要内容（protocol 层职责）——cache 命中率最大化 + token 节省。
- 一层改动不破另一层：protocol 层过滤 wire 不影响 transcript；context 层 ingest 改 reminder 形态（如改 block 结构）只要 encode 能识别 `isSystemReminder` 标记就能继续过滤。

## 6. 代码对齐状态（v0.0.361 已落地）

> 本 spec §3 三断点机制已全部落地于 `app/plugins/builtins/llm_anthropic/protocol-encode.ts`（`encodeAnthropicMessages` + `encodeTools` 内；v0.0.191 起 impl 物理迁 plugin 目录）。v0.0.361 删除旧避让扫描（`injectLastNonReminderCacheControl`）与 encodeMessage drop 逻辑，改为三断点 + 历史块全保留。

逐项对齐（`protocol-encode.ts` ↔ spec 条款）：

| spec 条款 | 代码实现 | 状态 |
|---|---|---|
| §3.1 bp#1（system 末 block）| `encodeAnthropicMessages` 内 `body['system'] = [{ type:'text', text, cache_control:{type:'ephemeral'} }]` | ✅ |
| §3.1b bp#T（tools 末位 tool）| `encodeTools` 末位 tool 注入 `cache_control:{type:'ephemeral'}`（v0.0.361 新增；原纯映射无注入） | ✅ |
| §3.2 bp#2（最末 message 最末 block 固定落位）| encode messages 后给末位 message 末位 block 注入；无反向扫描、无避让（v0.0.361 删 `injectLastNonReminderCacheControl`） | ✅ |
| §3.3 历史 reminder 块全保留 | encode 各 message 一视同仁，无 `isLastMessage` 分支、无 reminder drop（v0.0.361 删 `encodeMessage` 的 `lastKeptReminderIdx` 过滤） | ✅ |
| §3.2 `isSystemReminder` 不进 wire（零侵入）| `encodeContentBlock` text 分支只取 `{type:'text', text: b.text}`，丢弃 `isSystemReminder` 字段 | ✅ |
| §4 anthropic encode 专属（不动 `LlmProtocol` 接口）| 逻辑全在 `encodeAnthropicMessages` + `encodeTools` 内；无 `supportsCacheControl` 能力位 | ✅ |
| §5 两层独立（不动 context 层 / transcript 持久化）| encode 只做 wire 一次性组装（注入断点、剥标记），不改写 canonical、无「transcript 有 wire 无」分叉 | ✅ |

> 历史偏差根因（v0.0.8 引入 reminder 时 encode 未同步 reminder 标记 + bp#2 仍按「最后 block」落点）已记录在 `log.md` v0.0.52 条目，不在正文保留版本史。
>
> 注：cache_control 是 anthropic_messages encode 专属（§4），不抽公共 `supportsCacheControl` 能力位——不同 protocol 的 cache 机制不通用（anthropic 显式 breakpoint vs openai 隐式 prefix），抽公共能力位按「分支」不现实。故 v0.0.52 改动只在 `encodeAnthropicMessages` 内，不动 `LlmProtocol` 接口；其他 protocol 未来加入时各自 encode 决定 cache 机制（不实现则自然全传 reminder，fallback）。未来多 protocol 场景的密度分派预案见 §4.1。

## 7. 边界

| 零件 | 归属 |
|---|---|
| cache_control breakpoint 注入策略（三断点落点 + ttl）| 本文（cache_control）✅ |
| `LlmProtocol.encode` 契约 + 多模态编码 + role 转换 | `[P0]llm_protocol_interface.md` |
| anthropic_messages impl encode 落地（§3 三步的代码实现） | `anthropic_impl.md §4` |
| reminder 持久化（ingest 注入 + transcript 完整性）+ `isSystemReminder` 标记定义 | `../context/[P0]system_reminder.md` |
| cache 命中 token 计费 / `Usage.input_cache_read` | `../session/[P0]session_usage.md` |
| HTTP 调用 / 编排（cache 命中与否是 client 观测，非 protocol 决定） | `[P0]llm_client_interface.md` |

## 8. 核心设计原则（跨文件不变量）

1. **两层独立**——reminder 持久化归 context 层（ingest），cache_control 三断点注入归 protocol 层（encode）。一层改不破另一层；transcript 与 wire 同内容（append-only，无过滤分叉）。
2. **显式 breakpoint 三断点路线**——system 末（bp#1）/ tools 末（bp#T）/ messages 末（bp#2）三层各自锚定稳定段；历史 reminder 块 append-only 字节稳定，无需 wire 过滤维持命中。
3. **bp#2 固定末位**——最末 message 最末 block 固定落位，不做避让扫描：历史块跨 turn 字节不变 → bp#2 前缀 = 稳定历史 + 本轮新块，每轮命中上一轮条目。
4. **encode 层组装，不进 assemble**——断点注入是 encode（canonical → wire 一次性产物）职责，assemble reducer 改 canonical transcript 才破坏缓存与完整语义。
5. **anthropic_messages encode 专属**——cache_control 是 Anthropic 特有 wire 字段，注入逻辑在 `encodeAnthropicMessages` + `encodeTools` 内，不抽公共 LlmProtocol 能力位；其他 protocol 各自 encode 决定 cache 机制（不实现则自然全传 fallback）。

---

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../../version_logs/)（跨版本发布说明）。
