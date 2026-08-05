# v0.0.52.context_engine_fix 技术变更日志 — cache_control breakpoint + reminder wire 层过滤

> 范围红线：本版是 protocol encode **内部策略**修正（`anthropic_messages` wire 层的 `cache_control` breakpoint 落点 + reminder 过滤），**不动 `LlmProtocol` 接口**、**不动 context 层**（`system_reminder_injector` / transcript 持久化语义不变）、**reminder 块级 `isSystemReminder` 标记不进 wire**（LLM 零侵入）。
> 权威 spec：`specs/tech/agent/providers_and_models/[P0]cache_control.md`（目标契约 + §6 代码对齐核对表）。

---

## 1. 背景（为什么改）

v0.0.8 引入 reminder（块级 `TextBlock.isSystemReminder` 标记）后，`protocol-encode.ts` 的 `encodeContentBlock(text)` 只读 `b.text`（零侵入，正确），但 **bp#2 仍按「最后一条 message 的最后一个 block」落点**。reminder 由 context ingest 持久化进 transcript，每轮追加到最末 user message 的 content 末——于是 bp#2 落在 reminder 上，下轮 reminder 内容变（时间/环境/工具错误）→ cache key 失配 → prompt cache 命中率掉。

同时历史 reminder 全量进 wire（每轮 reminder 都进历史段），既浪费 token 也使历史段不稳。

## 2. 目标契约（`[P0]cache_control.md`）

确立**显式 cache_control breakpoint 路线**（非隐式 prefix-only）。理由：reducer 过滤历史 reminder 是错误方案（过滤后 wire 内容序列与上轮 cache key 不一致 → 隐式 prefix 永远 miss）；显式 breakpoint 路线下 wire 层过滤不影响 breakpoint 之前稳定段的跨 turn 一致性。

§3 三步处理机制（canonical → wire 时，对支持 cache_control 的协议）：

1. **bp#1 — system 末 content block**：`cache_control:{type:"ephemeral"}`（system 跨 turn 极稳）。
2. **bp#2 — 跨所有 wire messages 反向扫第一个非 reminder block**：从末尾向前跨 message 边界，命中第一个 `isSystemReminder !== true` 的 block 注入；bp 必须落在 reminder 之前的稳定段。
3. **wire 层过滤历史 reminder**：非最末 user message drop 所有 `isSystemReminder=true` block；最末 user message 只保留最末一个 reminder block。

§5 两层独立：reminder 持久化归 context 层（ingest，transcript 完整保留所有历史 reminder）；breakpoint + wire 过滤归 protocol 层（encode，wire 是每轮一次性产物不写回 transcript）。一层改动不破另一层。

§4 anthropic encode 专属：cache_control 是 Anthropic 特有 wire 字段，注入 + 过滤逻辑在 `encodeAnthropicMessages` 内，**不抽公共 `supportsCacheControl` 能力位**（不同 protocol cache 机制不通用：anthropic 显式 breakpoint vs openai 隐式 prefix）。其他 protocol 未来加入时各自 encode 决定 cache 机制（不实现则自然全传 reminder，fallback）。

## 3. 代码落地（`app/server/src/llm/`）

| 文件 | 操作 | 变更要点 | spec 对齐 |
|---|---|---|---|
| `protocol-encode.ts` | 修改 | `encodeAnthropicMessages` 加 reminder wire 层过滤（非最末 user drop 所有 reminder；最末 user 只保留最末一个）+ 平行产 `reminderFlags[]` 供 bp#2 决策；`injectLastMessageCacheControl` → `injectLastNonReminderCacheControl`（跨 messages 反向扫，跳过 reminder block）；新增 `isReminderBlock(b)` = `b.type==='text' && b.isSystemReminder===true` | §3.2 / §3.3 |
| `protocol-types.ts` | 修改（类型）| `ContentBlock` text variant 加 `isSystemReminder?: boolean`（镜像 `message/types.ts` TextBlock 权威源的块级标记，供 encode 读识别；`encodeContentBlock` 写 wire 时丢弃此字段） | §3.2 「标记不进 wire」 |

**不改**（红线）：
- `LlmProtocol` 接口 / `encode` 签名（cache_control 逻辑全在 anthropic impl 内）。
- context 层：`system_reminder_injector.ts`（ingest 注入 + 持久化语义不变）/ transcript 存储 / `message/types.ts`（TextBlock 权威源早有 `isSystemReminder`）。
- 其他 protocol impl（当前仓库仅 `anthropic_messages` 一家）。

## 4. 关键实现细节

- **`reminderFlags` 必须在 merge 相邻同 role 之前读**：reminder 标记是 per-block 的，`mergeAdjacentSameRole` 只拼 content 数组不改顺序但破坏 block 原位——故 `injectLastNonReminderCacheControl` 在 merge 前 call。
- **`encodeMessage` 单遍过滤 + 标记**：一遍循环同时完成「过滤历史 reminder」+「平行产 flags 标记保留块是否原为 reminder」，避免两遍扫。
- **`encodeContentBlock` text 零侵入**：只取 `{type:'text', text: b.text}`，不读 `isSystemReminder`——该字段不进 wire，LLM 看不到结构化标记（与 v0.0.50 logical-view sender 展平同理：结构化字段不进 wire）。

## 5. 验证（AT 真 LLM）

- **volcengine turn2 命中 `input_cache_read`**：两轮对话，turn1 写 cache（`cache_creation_input_tokens` > 0），turn2 命中（`input_cache_read` > 0，`cache_creation` 归零）——证明 bp 落在稳定段、reminder 不破前缀 cache。
- 既有 `protocol-encode` 单元测试已覆盖（bp#1 / bp#2 反向扫 / reminder 过滤三分支 / `isSystemReminder` 不进 wire）。

## 6. 版本

> 变更历史见 `specs/tech/agent/providers_and_models/log.md` v0.0.52 条目（位置轴）。
