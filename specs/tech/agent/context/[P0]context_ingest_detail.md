---
type: interface
title: Context Engine — ingest 详解
priority: P0
status: active
updated: 2026-07-05
since: v0.0.8
---

# Context Engine — ingest 详解

> 主文档：`[P0]context_engine.md`。Message 见 `../message/[P0]agent_message_interface.md`，扩展点机制见 `../../plugin_system/[P0]extension_point_interface.md`，大内容存储见 `../session/[P0]session_store.md`（raw / tool_result）。

> **当前形态**：`ingest` 走完整 ordered handler chain（§3）+ truncate offload（§4）+ system_reminder_injector。chain 由 `ContextEngine` 经 `PluginManager.getExtensionImpls(ContextIngestHandlerPoint)` 取 active handler（[v0.0.18] 按 effective order 升序，1 在前）逐个 `handle`（见 `[P0]context_engine.md` §3.5）。4 个内置 handler（query_truncate / tool_result_truncate / system_reminder_injector / chain 尾 `store_sink`）归 `rocky_context` plugin（见 `[P0]extension point and implementations.md` §3.1）。全 disabled 时空链 → 直接 append（= v0.0.8 行为）。
>
> **历史基线（v0.0.8 简化版）**：v0.0.8 的 `ingest` **仅做固定落库**（§5）—— `store.appendMessages(sessionId, messages)`，**不跑** ordered handler chain（§3）、不做 truncate offload（§4）、不走 system_reminder injector。完整 chain/offload 形态 v0.0.13 起为 current。历史路径见 `specs/tech/version_logs/v0.0.8/change_log.md` §1/§5。`allowEdit` / id 冲突（§6）语义保留。

## 1. 概述

ingest 是消息进入 ContextEngine 的**唯一入口**。本质是 **ordered 处理链 + sink impl 落库终点**：

```
ingest(config, messages: Message[])
  │
  ├─ ① ordered handler chain —— 扩展点 context_ingest_handler（ordered）
  │     每个 handler: Message[] → Message[]
  │       ├─ query_truncate          （内置：截断过长 user query）
  │       ├─ tool_result_truncate    （内置：截断过大 tool_result）
  │       ├─ system_reminder_injector（内置：聚合 reminder 追加到末条 user message）
  │       └─ 未来: search_indexing / 脱敏 / 审计 …（加 ext impl）
  │
  └─ ② sink impl（chain 尾，扩展点内）：`store_sink` 写 store（v0.0.66 起 default+forked 共用同一 sink impl；
       落到哪个 store 由 `session_store` EP 按 scope 切：default=`persistent_session_store` / forked=`in_memory_session_store`）
       v0.0.49 D15 sink 由 chain 配置决定（替代旧 context-engine.ts 的 `if scopeId` 硬尾）；
       v0.0.66 store 也 EP 化（`session_store` exclusive EP），`buffer_sink` 退役
```

**管什么**：chain 编排（按 order 调 handler）+ sink 落库（chain 尾 sink impl）。
**不管什么**：单个 handler 的内部逻辑（各 handler 是独立 ext impl）、落库后的 snapshot 组装（→ assemble）、游标推进（→ agent_loop）。

---

## 2. 核心设计：链可插拔，sink 由 chain 配置定

| 环节 | 是否扩展点 | cardinality | 说明 |
|---|---|---|---|
| ① handler chain | ✅ 扩展点 `context_ingest_handler` | `ordered` | 按 order 串联 ext impl，每个 transform messages |
| ② sink 落库 | ✅ chain 尾 `store_sink` impl（v0.0.49 D15）+ `session_store` EP（v0.0.66） | `ordered` | `store_sink` 写 store（v0.0.66 起 default+forked 共用；落到哪个 store 由 `session_store` exclusive EP 按 scope 选 impl：default=`persistent_session_store` / forked=`in_memory_session_store`） |

**为什么链 + sink 都是扩展点**：
- 截断 / 脱敏 / indexing 等「入库前预处理」需求多样且可演进 → 扩展点。
- sink（写哪）随 scope 不同（default=持久 store / forked=内存 store），由 chain 配置 + `session_store` EP 共同表达；v0.0.40-0.0.48 用 context-engine.ts 的 `if (scopeId !== FORKED) store.appendMessages` 硬尾实现 default sink（不对称于 forked 的 `buffer_sink` impl）；**v0.0.49 D15 把 default sink 也 EP 化（`store_sink` impl）**，default/forked sink 对称（都走 chain 尾 impl），contextEngine 删 if 硬尾；**v0.0.66 进一步把 store 也 EP 化（`session_store` exclusive EP）**，`buffer_sink` 退役（forked 改用 `store_sink` + `in_memory_session_store`），default/forked 零 `isForked` 分支、对称走同一 sink impl。

---

## 3. `context_ingest_handler` 扩展点

```typescript
/** 扩展点声明（机制见 plugin_system）；[v0.0.13] 注册进 BUILTIN_EXTENSION_POINTS */
const ContextIngestHandlerPoint = {
  id: "context_ingest_handler",
  group: "context",           // 归 context 分区
  cardinality: "ordered",     // [v0.0.18] 按 effective order 升序串联（1 在前）
};

/** handler 契约：从 ingest main 视角是 transform（副作用见 §4） */
interface IngestHandler {
  handle(messages: Message[], ctx: IngestCtx): Message[];
}

interface IngestCtx {
  config: SessionConfig;   // sessionId 圈定范围；截断阈值按 token 估算（char×ratio，见 context_usage_detail §4）
  store: SessionStore;     // truncate handler offload 原文用（saveContent，见 §4）；由 ContextEngine.ingest 经 `session_store` EP 按 scope 解析注入（v0.0.66：default=`persistent_session_store` / forked=`in_memory_session_store`），chain 尾 `store_sink` impl 读它写库
}
```

**内置 ext impl**（v0.0.13 起归 `rocky_context` plugin，P0；[v0.0.18] 按 effective order 升序，无 order record 时按 manifest 登记序：query → tool_result → reminder_injector → store_sink）：

| implId | 默认 order（登记序） | configSchema（显式 JSON Schema 见 extension point and implementations.md §4） | 职责 |
|---|---|---|---|
| `query_truncate` | 1 | `{ queryTruncateChars: 8000 }` | 截断过长的 user query message（超阈值原文 offload 为 raw） |
| `tool_result_truncate` | 2 | `{ toolResultTruncateChars: 25000 }` | 截断过大的 tool_result（超阈值 offload 为 tool_result）；过长 tool call 参数同理 |
| `system_reminder_injector` | 3 | —（reminder provider 各自 config） | 跑 `system_reminder` provider 链，聚合 reminder，**只针对 ingest 最后一条且必须是 user message**，追加 reminder content block 到其 content 末尾（持久化进 transcript；见 `system_reminder.md`） |
| `store_sink` ★ v0.0.49 D15 | 4 | — | **default + forked 都 active 的 sink**（chain 尾，v0.0.66）：`ctx.store.appendMessages(ctx.config.sessionId, messages)` 写 store；store 由 `session_store` EP 按 scope 选 impl（default 写持久 transcript / forked 写内存数组），同 impl 透传不同 store 实现；`ctx.store` 空 → no-op（UT 未注入的防御性 fallback） |
| ~~`buffer_sink`~~ | — | — | **[v0.0.66] 已退役**（manifest 不再登记）：原 forked 专属 sink `ctx.buffer.push(...)` 写 buffer；由 `store_sink` + `session_store` EP（forked 选 `in_memory_session_store`）取代 |

> 截断阈值归各 handler 的 `ExtImpl.configSchema`（谁用归谁，非全局 config 调参组）；阈值单位 char（按 char×ratio 估算 token 判定是否超）。order：query 先于 tool_result——同一 message 不会同时是 query 和 tool_result，order 仅定链顺序。**[v0.0.13]** 5 个有 configSchema 的 impl 的**显式 JSON Schema 字段**（type/default/单位）见 `[P0]extension point and implementations.md` §4（本节仅散文默认值）。

> **[v0.0.13]** 内置 handler 归 `rocky_context` builtin plugin（见 `plugin_system/[P0]builtin_plugins_directory.md` §2.3 + `[P0]extension point and implementations.md` §3.1），可在 PluginConfigService 中 disable / 调 order。ContextEngine 调链方式见 `[P0]context_engine.md` §3.5。

---

## 4. truncate handler 的副作用契约 ★

truncate handler **不是**纯 transform——它对 ingest main 透明地做两件事（**offload 是 context 的决策**，落到 session 只是普通存一条内容）：

```
query_truncate.handle(messages, ctx):
  for msg of messages (role=user 且 content 超阈值):
    1. offload 原文：ctx.store.saveContent(sessionId, "raw", contentId, { message: 原文 })
    2. 改写 message：content → 截断版 + 记 rawRef = contentId（指向 SessionStore 大内容）
  return messages      ← ingest main 只看到截断版

tool_result_truncate.handle(...):  同理，type="tool_result"，记 toolResultRef = contentId
```

**关键不变量**：
- ingest main **不知道** handler 做了 offload——它只接收 handler 返回的 messages 并落库。
- 落库的是**截断版**；原文完整内容在 SessionStore 的 raw / tool_result（item = 整 message 级）。
- 截断版记的 `rawRef` / `toolResultRef`（= contentId）**足以让 agent 取回原文**——不丢信息，只控规模。

**为什么走 SessionStore**：session 统一管理所有存储（见 `../session/[P0]session_store.md`）。offload 是 context 的业务决策（何时截断、存什么），存储动作就是 `saveContent`；session 侧不认识 offload，只是存一条 raw / tool_result。**无独立 off-store / off-loader**。

> **取回不在 ingest**：被 offload 的原文由 agent 通过 **context reload 工具**（一个 agent tool，LLM 按需调用，按 contentId + offset/limit 分页读回，委托 `SessionStore.getContent`）取回，**不是 ingest 的职责**——ingest 只负责落库前的 offload 写入。context reload 工具归 tools 层（SessionConfig.tools，见对应 spec），本文不定义。

> **不可变性边界（重定义）**：本设计下「不可变」指**落库后**不可变；ingest 链是**落库前的预处理**，handler 可改写待入库的 message。与 `context_engine.md` §1 原则一致（落库后仅 `allowEdit=true` 允许按 id 覆盖）。

---

## 5. sink 落库终点（chain 尾 `store_sink` impl）

链跑完后，由 chain 尾 `store_sink` impl 写 store（v0.0.66 起 default + forked 共用同一 sink impl）：

```typescript
// chain 尾：store_sink impl（default + forked 共用，透传同一 ctx.store）
await ctx.store.appendMessages(config.sessionId, finalMessages);   // 写 store
```

- **store 由 `session_store` EP 按 scope 选 impl**（v0.0.66，exclusive EP，`ContextEngine.resolveStore(scopeId)` 解析）：
  - default scope → `persistent_session_store`（包装真实持久 SessionStore）→ 写持久 transcript
  - forked scope → `in_memory_session_store`（per-session `Map`）→ 写内存数组（run 结束 `releaseSlot` 清槽）
- **v0.0.66 演进**：v0.0.49 D15 把 default sink EP 化（`store_sink`，对齐当时 forked 的 `buffer_sink`，chain 尾二选一）；v0.0.66 把 store 也 EP 化（`session_store`）后，forked 改用 `store_sink` + `in_memory_session_store`，`buffer_sink` 退役，default/forked 零 `isForked` 分支、对称走同一 sink impl（见 `[P0]extension point and implementations.md` §6）。
- **id 校验/冲突下沉到 sink**：链不管 id；落库时若撞 id，按 `allowEdit` 语义处理（见 §6）。
- **事务性**：整批 append 推荐事务实现（撞 id 时回滚已写入部分）。
- **append 必须 await**（store_sink）：`store.appendMessages` 是 async（session_store §6.1 serialized putAsync），`handle` 返回 Promise；applyIngestPipeline 对每个 handler await——否则下一轮 assemble 读 store 会漏本轮新消息（race）。
- **降级路径**（无 pluginManager / 空链，v0.0.8 兼容）：`applyIngestPipeline` 直接 `store.appendMessages` 落库，不走 chain（避免与 `store_sink` 双写）。

---

## 6. allowEdit 与 id 冲突（落库终点语义）

落库时 `message.id` 已存在于 transcript 的处理：

| allowEdit | 行为 |
|---|---|
| `false`（默认） | 撞 id → 抛 `DuplicateMessageIdError`，整批回滚 |
| `true` | 同 id 整体覆盖（保留 id；`createdAt` 通常保留原值） |

> handler 链不产生 id 冲突（它只 transform 已有 id 的 message，不重新分配 id）。id 冲突仅发生于「调用方对同 id 重复 ingest」，归落库终点处理。

---

## 7. 与游标 / assemble 的关系

```
transcript:  [m1] [m2] [m3] [m4] [m5]
                          ↑
                     ingestUpTo（RunState 持有，agent_loop 推进）

ingest(config, [m6, m7])
  → chain 处理 m6/m7 → 落库 m6'/m7'（可能被截断）
  → 不触碰 ingestUpTo
  → agent_loop 在 ingest 返回后推进 ingestUpTo → assemble
```

ingest 不返回游标、不返回 messageId（id 由调用方 ingest 前分配，见 message interface 的 ULID 规则）。

---

## 8. 可扩展性（未来）

| 需求 | 做法 |
|---|---|
| search 存储 indexing | 加 ext impl（落库前拿 messages 建 index，或经 context loader 读回 offload 原文） |
| 内容脱敏 | 加 ext impl（transform 敏感字段） |
| 审计日志 | 加 ext impl（只读 side-effect，不改 messages） |

均不动 ingest 主流程，符合「链可插拔」。

---

## 9. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。
