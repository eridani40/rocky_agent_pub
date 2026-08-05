---
type: change_log
version: v0.0.66
title: context engine assemble/ingest 协议重构（零 isForked + session_store 扩展点）
updated: 2026-07-04
---

# v0.0.66 · context engine assemble/ingest 协议重构

> 一句话定位：default 与 forked 共用同一套 ingest/assemble 主干，差异**纯靠 store EP 切换 + summary 驱动 rebuild**，主干代码零 `isForked` / `scopeId==='forked'` 分支。
> 权威输入：`reqs/[working] v0.0.66/design.md`（用户已确认设计）；research 盘点见 `reqs/[working] v0.0.66/research.md`（9 EP/41 impl + default/forked 分支）。

---

## 1. 范围

### 1.1 IN-SCOPE（10 项核心改动）

| # | 项 | 核心文件 |
|---|---|---|
| 1 | **session store 扩展点化**：新增 `SessionStorePoint`（exclusive, group='context'）+ 2 impl | `extension-point.ts` / `store/persistent_session_store.ts` / `store/in_memory_session_store.ts` |
| 2 | **ingest/assemble 零 isForked**：主干代码无 scope 特殊逻辑，纯 scope 驱动（store EP 切换 + summary 驱动 rebuild） | `context-engine.ts` / `assemble-pipeline.ts` / `context-ingest-pipeline.ts` / `base_builder.ts` |
| 3 | **system prompt 独立**：删 `system_prompt` assemble impl；system 由 `context-engine.assemble` 独立调 `buildSystemPrompt`（复用 prevSnapshot.system 或重建） | `context-engine.ts` / `assemble/system_prompt.ts`（删） |
| 4 | **messages 纯对话历史**：system 不在 messages，由 `snapshot.system` 独立承载；`loop-stage-llm` 送 LLM 前 prepend `[snapshot.system, ...snapshot.messages]` | `base_builder.ts` / `loop-stage-llm.ts` |
| 5 | **forked in_memory store**：forked 用 `in_memory_session_store`（per-session Map），复用父 snapshot 全量 + 追加增量；`build-forked-deps` onRunEnd 调 `clearScopeSession` 清 in_memory slot | `store/in_memory_session_store.ts` / `build-forked-deps.ts` / `forked-lifecycle-port.ts` |
| 6 | **base_builder 改造**：统一 summary 驱动 `shouldRebuild = !prev || prev.messages.length===0 || (curVersion!==null && curVersion!==prevVersion)`；appendNew 按 id 用 transcript 原始版本覆盖 prev（保 tool_call 配对） | `assemble/base_builder.ts` |
| 7 | **删 4 buffer/system impl**：`buffer_sink` / `buffer_reader` / `append_passthrough` / `system_prompt(assemble)`；forked 改用 base_builder + in_memory store | manifest / `assemble/` / `ingest/` |
| 8 | **forked reducer 对齐 default**：forked active 5 个 reducer（base_builder + orphan/empty/role_merge/snip），与 default 一致；forked-scope-bootstrap 显式 enable 覆盖落盘 false drift | `forked-scope-bootstrap.ts` |
| 9 | **`SessionStoreContract.clearSession → releaseSlot` 重命名**：解 `SessionStore.clearSession`（删整 session）命名冲突；`releaseSlot` 仅清 forked 内存槽 | `store/types.ts` / `store/in_memory_session_store.ts` |
| 10 | **文件拆分**：`context-engine.ts` 拆出 `context-engine-store-resolver.ts`；`build-forked-deps.ts` 拆出 `forked-lifecycle-port.ts`；`types.ts` 拆出 `store/types.ts` | （≤300 行约束） |

### 1.2 OUT-OF-SCOPE（遗留 → v0.0.67）

- **forked-scope-bootstrap 运行时 enable/disable 流氓逻辑**：当前 bootstrap 显式 `setImplEnabled(true/false)` 覆盖历史落盘 drift（v0.0.49 残留累积）；本版本保此逻辑保 forked active 正确，v0.0.67 重构（落盘 drift 一次性清理 + bootstrap 不再写 enable）。
- **真 LLM AT 待配 provider**：本版本 UT 全绿 + code review PASS；AT 因 forked scope 黑盒难观测 + 需真 LLM provider 配置，遗留 v0.0.67 配齐跑首轮 AT。

---

## 2. 核心设计（统一逻辑 + scope 切换实现）

**原则**：default 和 forked 用**同一套 assemble/ingest 主干逻辑**，差异只在 store 实现（扩展点）+ plugin active 链（scope 配置）。ingest/assemble 代码零 `isForked` 判断。

### 2.1 session_store 扩展点（exclusive）

| scope | 选中 impl | 行为 |
|---|---|---|
| default | `persistent_session_store` | 包装真实持久 SessionStore（delegate holder），全方法 |
| forked | `in_memory_session_store` | per-session `Map<sessionId, Message[]>`；只实现 appendMessages + getMessages + getSummary（恒 null）+ getRatio（恒 1.0）+ updateContextWindowUsage（no-op）+ releaseSlot |

> **`getSummary` 恒返 null 是关键**（不 throw）：让 forked curVersion 永远 null → 永远不触发 rebuild → 永远 append 复用 prevSnapshot，**纯数据驱动，无 isForked 判断**。

### 2.2 base_builder 统一 shouldRebuild（无 scopeId 分支）

```
shouldRebuild = !prev
             || prev.messages.length === 0
             || (curVersion !== null && curVersion !== prevVersion)
```

- forked：curVersion 恒 null（in_memory store getSummary 返 null）→ 第三个条件不触发 → 永远 append
- default 无 summary：curVersion=null → 第三个条件不触发 → append（cache 友好）
- default compact 后：curVersion 非 null 且 ≠ prevVersion → rebuild

### 2.3 base_builder appendNew 按 id 覆盖保 tool_call 配对

`appendNew(prevMessages, transcript)` 按 id 用 transcript 原始版本覆盖 prev 中已有的 message。**为什么**：default scope 下清理 reducer（orphan_tool_call）每轮都跑，当 tool_call 还没配对 tool_result 时会剥掉 assistant 的 tool_call block。下轮 tool_result 到时，prev.messages 的 assistant 已丢 tool_call → orphan 进一步剥 tool_result → tool 配对永久丢失 → LLM 多调一轮。按 id 覆盖恢复 tool_call block，orphan_tool_call 能正确配对。

### 2.4 system prompt 独立 + 复用（design §1.3）

system prompt 不再走 `context_assemble_mapper` 链（删 `system_prompt` impl）；`context-engine.assemble` 独立构建：

```
shouldRebuild = !prevSnapshot || prevSnapshot.summary?.version !== summary?.version
systemText = shouldRebuild
  ? buildSystemPrompt(config)
  : (prevSnapshot?.system ? firstText(prevSnapshot.system) : buildSystemPrompt(config))
```

default + forked 都走同一逻辑（forked curVersion 恒 null → 永远 rebuild=false → 永远复用父 snapshot.system，不调 builder）。

### 2.5 messages 纯对话历史 + loop-stage-llm prepend

- `base_builder` 不再构造 systemMsg（rebuild 路径产 `[summaryMsg?, ...recent]`，append 路径产 `[...prev.messages, ...新增]`，无 system）
- `snapshot.system` 独立 Message 字段
- `loop-stage-llm.callLLMForSpec` 送 LLM 前显式 `messages = [snapshot.system, ...snapshot.messages]` 让 protocol encode 抽 system 落到 wire system 位（cache_control bp#1）

---

## 3. 改造后 default / forked 分支对比

### 3.1 ingest（统一，无 isForked）

```
ingest(config, msgs, scopeId)
  → resolveStore(scopeId)                     // store EP 按 scope 切实现
  → applyIngestPipeline(pm, config, msgs, extras, scopeId, store)
    → handler 链：query_truncate → tool_result_truncate → system_reminder_injector(default only) → store_sink
    → store_sink: store.appendMessages(scope 选中的 store 实现负责写)
```

| scope | store 实现 | reminder 注入 |
|---|---|---|
| default | 持久 store（写 transcript） | 是 |
| forked | 内存 store（写内存数组） | 否（disabled） |

### 3.2 assemble（统一，无 isForked）

```
assemble(config, scopeId, prevSnapshot)
  → store = resolveStore(scopeId)
  → summary = store.getSummary(sid)           // 内存 store 返 null
  → ratio = store.getRatio(sid)               // 内存 store 返 1.0
  → runAssemblePipeline(pm, store, config, prevSnapshot, scopeId, ratio)
    → mapper 链：transcript_reader + summary_reader + prev_snapshot
    → reducer 链：base_builder + orphan/empty/role_merge/snip
  → systemText = 复用条件满足 ? prevSnapshot.system.text : buildSystemPrompt(config)
  → store.updateContextWindowUsage(sid, cw)    // 内存 store no-op
  → snapshot = {system, messages: picked, inputCharCount, contextWindowUsage, summary}
```

| scope | mapper | reducer | systemText | messages |
|---|---|---|---|---|
| default | transcript_reader + summary_reader + prev_snapshot | base_builder + 4 清理 | 复用 prevSnapshot.system 或 builder | base_builder append/rebuild |
| forked | transcript_reader + summary_reader + prev_snapshot | base_builder + 4 清理 | 复用 prevSnapshot.system（不调 builder） | base_builder append（复用 prevSnapshot + 追加内存 store 增量） |

> forked active reducer 与 default 完全一致（base_builder 正确后 4 清理 reducer 是格式保障），forked-scope-bootstrap §6 不再 disable 它们。

---

## 4. 代码-spec 一致性验证（doc-modifier 核对结果）

| spec 声明 | 代码核对 | 结论 |
|---|---|---|
| `SessionStorePoint` cardinality='exclusive', group='context' | `extension-point.ts:191-196` ✅ | 一致 |
| 主干零 `isForked` / `scopeId==='forked'` 实际逻辑 | `context-engine.ts` / `assemble-pipeline.ts` / `context-ingest-pipeline.ts` / `base_builder.ts` grep 仅注释/历史 docstring，无运行时分支 ✅ | 一致 |
| `context-engine.assemble` systemText 复用规则（design §1.3） | `context-engine.ts:205-208` `shouldRebuild = !prevSnapshot \|\| prevSnapshot.summary?.version !== summary?.version` ✅ | 一致 |
| forked active 5 reducer（base_builder + orphan/empty/role_merge/snip） | `forked-scope-bootstrap.ts:135-137`（enable base_builder/store_sink/transcript_reader）+ §6 注释（4 清理 reducer 保持 active 不 disable）✅ | 一致 |
| `loop-stage-llm` prepend `[snapshot.system, ...snapshot.messages]` | `loop-stage-llm.ts:52` `messages: Message[] = [snapshot.system, ...snapshot.messages]` ✅ | 一致 |
| `SessionStoreContract.releaseSlot`（非 clearSession） | `store/types.ts` + `store/in_memory_session_store.ts:129` ✅ | 一致 |
| `in_memory_session_store.getSummary` 恒 null | `in_memory_session_store.ts:107-109` ✅ | 一致 |
| `in_memory_session_store.updateContextWindowUsage` no-op | `in_memory_session_store.ts:117-122` ✅ | 一致 |

**无静默偏离**：spec 与代码对齐，所有声明的链路/机制代码均按 spec 实现。

---

## 5. 关联 specs 同步

- `specs/tech/agent/context/[P0]context_engine.md`：§3 ingest/assemble 签名（删 buffer 参数）+ §3.6 重写（session_store EP 取代 buffer）+ §3.5 表（10 EP，删 system_prompt mapper）+ §4 交互图（loop-stage-llm prepend）
- `specs/tech/agent/context/[P0]context_assemble_detail.md`：§2 base_builder 统一 shouldRebuild（无 scopeId 分支）+ §3 AssembleData 删 system 字段 + §5 base_builder 行（system 独立）+ §6 产出结构（删 systemMsg）
- `specs/tech/agent/context/[P0]extension point and implementations.md`：EP 清单 9→10（新增 session_store exclusive）+ impl 清单 40→42（删 system_prompt 1 + 加 persistent_session_store/in_memory_session_store 2；memory_user/memory_session 替代 memory 1→2）+ §3.6/§3.7 删 buffer_sink/buffer_reader/append_passthrough
- `specs/tech/agent/context/index.md`：④ 加原则 11（session_store EP + 零 isForked）+ 概念表更新
- `specs/tech/agent/context/log.md`：v0.0.66 条目
- `specs/tech/agent/session/[P0]session_store.md`：§4 SessionStore 接口注 session_store EP 化（持久/in_memory 双 impl）+ releaseSlot vs clearSession 命名分离
- `specs/tech/agent/session/log.md`：v0.0.66 条目
- `specs/prd/version_logs/v0.0.66.md`：PRD 摘要（内部 refactor，无 API/UI 变更）
- `specs/api/version_logs/v0.0.66.md`：API 无变更注明

---

## 6. 验证

- **UT 全绿**：assemble/ingest 全量回归（forked 用内存 store + base_builder 复用 prevSnapshot）+ 新增 append-tool-pair.test 覆盖 appendNew tool_call 配对补偿
- **typecheck 全绿**
- **AT 遗留**：forked scope 黑盒难观测 + 真 LLM provider 待配，遗留 v0.0.67
