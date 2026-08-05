# v0.0.80.t1 — Change Plan（method 级 review 合同）

> **冻结契约**：planner 按本表切 task，coder 按本表实现，reviewer 按本表查偏离。coder 不改本文件；事后偏差写进 `change_log.md`。
>
> 行 = 一个函数/符号。8 列：所属模块 / 文件路径 / 函数·符号 / 类型 / 变更内容 / 约束 / 参考 / 影响行。
>
> 输入：`reqs/[working] v0.0.80.t1_consolidate_bug/diagnosis.md`（4 confirmed bug + 收敛设计方向 A）。

---

## 0. 背景与根因（详见 diagnosis.md）

session `01KWT9NQK54JPWB76E3QZZ2VTV` 出现 2 summary vs 4 memory_extract（不成对）、快照各异、极早触发、forked trace `metadata.inputMessageIds=[]`。诊断确认 4 bug：

1. **Bug-1 ★★★**：`try-compact.ts:66→70` doCompact 后**无条件**触发 post-compact；`summary_do_compact.ts:63` 丢弃 `runCompact` boolean 返回 → compact 锁失败的并发 tryCompact 也触发 memory_extract（count mismatch 主因）。
2. **Bug-2 ★★**：`post-compact-consolidation.ts` 启动 fork-2 **未 acquire `tier1_consolidation` 锁**（spec §6 说「如 tier1 接入」从未接）。
3. **Bug-3 ★★**：`ctx.snapshot` 是主 loop 活快照，并发 tryCompact 各取不同轮 → 输入各异。
4. **Bug-4 ★**：`forked-invoke-observability.ts:60` forked trace `inputMessageIds: []` 硬编码空；同 trace 未见 context window usage。

**收敛设计（用户已确认方向 A）**：触发点迁移到 `prepareStage` 之后/`callLLM` 之前；should-compact=true 时 summary 与 memory_extract 作为**两个独立 fire-and-forget sibling**（不再 doCompact → postCompact 串行链）；共享一份不可变 snapshot deep clone；各自 acquire 自己的锁；进 forked agent 再 deep clone 一次；改进 forked trace meta（trigger msg id + context window usage）+ 主 loop 每次 LLM 请求 meta 带 context window usage。

---

## 1. 设计总览

### 1.0 核心设计原则：summary = 纯生产者（本次修订核心）

> **compact/forked 是纯生产者**，只负责三件事：
> 1. 写 summary（`store.setSummary`）✓ 保留
> 2. 写 compact_notice 消息（`store.appendMessages` + `noticeEmitter` 让 UI 可见 — spec §6.5 / BUG-001）✓ 保留 —— 这是 transcript 消息条目，不是 usage-state 推送
> 3. 记自己的 LLM cost（`store.accumulateUsage(sid, 'forked', forkedResult.usage)` **write**）✓ 保留 —— agent run 自身簿记，类比主 loop 每次 callLLM 后记 usage
>
> **不碰消费侧**（本版本全部移除）：
> - ❌ `state.snapshot = re-assemble`（刷新主 loop snapshot）—— `loop-stage-context.ts:222`
> - ❌ `obs.setSystem(...)`（从 compact 内推 system）—— `loop-stage-context.ts:224`
> - ❌ 任何从 compact 内部触发的 `notifyUsageChanged`，含两处：
>   - `loop-stage-context.ts:225`（re-assemble 尾里的 `await store.notifyUsageChanged(config.sessionId)`）
>   - `context-compact-runner.ts:170-172`（`for (const notifySid of usageChain) { await store.notifyUsageChanged(notifySid); }` 循环）
>
> **消费侧归正规 assemble 管线**：现有正规管线已经在做——`ingestMainAndAssemble` 完成后，三个调用方（`prepareStage` / `ingestAssistant` / `ingestToolResults`）每次 assemble 后都调 `notifyUsageChanged`。`getUsageView` 读**全量** usage record（含 forked 分区 + contextWindowUsage），由这些正规 notify 携带 emit。
>
> **compact 写的 forked cost + 下一轮 context 下降（重算 contextWindowUsage）→ 都由下一轮正规 assemble 的 notifyUsageChanged 携带。compact 完成后不主动 notify，等下一轮 assemble。这是有意分离，不是遗漏。**

> **spec 同步（doc-modifier 阶段 5）**：此原则需写进 `consolidation_tier1.md`（§实现落点 / 失败隔离段补「不碰消费侧」）+ `context_compact_detail.md`（§2c.1 调用契约补「summary 纯生产者」段）。

### 1.1 触发点迁移 + sibling 双发时序

```
runReActLoop 每轮：
 ① prepareStage（drain inbox + ingest user/tool_result + assemble + 准入判定）
       ↓
       state.snapshot 已刷新（末尾 msg = user[turn 开头 drain] 或 tool_result[上轮 ingestToolResults]）
       ↓
 ★ NEW 触发点（fire-and-forget，旧位置 ingestAssistant:109 删除）
   void runTryCompact(spec, state).catch(log)
     └─ tryCompact:
          · 谓词（threshold_should_compact，>60%）
          · true → deep clone snapshot ONCE（structuredClone 或等价）
          · void runSummarySibling(sharedCtx).catch(log)   ← acquire 'compact' 锁（runCompact 内部）
          · void runConsolidationSibling(sharedCtx).catch(log) ← acquire 'tier1_consolidation' 锁（新接入）
          · 立即 return（两 sibling 异步并发，互不阻塞，互不耦合）
       ↓
 ② callLLM（此刻 snapshot 末尾 msg 必无 hanging tool_use，proof：drain/tool_result 都是封闭 msg）
       ↓
 ingestAssistant（写回 assistant + emit message_end；★ NO LONGER 触发 tryCompact）
       ↓
 ③ extractToolCalls / executeAndEmit / ingestToolResults
```

### 1.2 sibling fire-and-forget 不变量

- **共享不可变 snapshot**：触发点一次 deep clone，两 sibling 共用。snapshot 不被任何 sibling 修改（sibling 内 `assembleFn(c)` 调 main scope `assemble` 会另建新对象，不动 clone）。
- **per-task 锁互不阻塞**：summary acquire `'compact'`（已存在），memory_extract acquire `'tier1_consolidation'`（**新接入**）。锁失败各自静默跳过（fire-and-forget）。
- **失败隔离**：sibling 异常各自 `.catch(log)`，不传播、不影响另一 sibling、不影响主 loop。
- **主 loop 不重等**：去掉旧 `runTryCompact` 的 `afterVersion > beforeVersion → re-assemble` 同步尾——主 loop 下一轮 `prepareStage.assemble('default', prevSnapshot)` 自动消费新 summary（v0.0.78.bug §0 invariants #5 早已论证）。
- **防递归不变量保留**：forked scope `reject_should_compact` 谓词恒 false → 两 sibling 在 forked agent 内的 prepareStage 阶段 tryCompact 自动跳过（结构上不可能递归）。

---

## 2. Method-level 变更表（8 列，按模块分组）

### 2.1 agent-loop — 触发点迁移

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-loop | app/server/src/agent/run-react-loop.ts | runReActLoop()（line 96 callLLM 前） | 修改 | 在 `prepareStage` 返回 'ok' 之后、`callLLMForSpec` 之前**新增** `void runTryCompact(spec, state).catch((err) => console.warn('[compact async]', err))`（fire-and-forget）；位置紧跟现有 `if (spec.controller.aborted)` 中断检查之后 | MUST：fire-and-forget（`void ... .catch(log)`），主 loop 立即继续到 callLLM；MUST NOT await；MUST NOT 加 try-catch 等结果；MUST 在中断检查通过之后调（避免 abort 后还触发） | diagnosis §6 方向 A 第 1 条；本文件 §1.1 时序图；`agent_loop_unified.md §2` line 92-99 | +4/-0 |
| agent-loop | app/server/src/agent/loop-stage-context.ts | ingestAssistant()（line 109-112） | 修改 | **删除** `void runTryCompact(spec, state).catch(...)` 块（触发点迁移到 run-react-loop.ts）；保留前置 `await ingestMainAndAssemble + notifyUsageChanged + emitMessageEnd`（写回 assistant 仍在此） | MUST：ingestAssistant 不再触发 compact；MUST NOT 改 ingest/emit 行为；MUST NOT 删 emitMessageEnd（前端 message_end 信号依赖） | diagnosis §6 方向 A 第 8 条；本文件 §1.1 时序图 | +0/-5 |
| agent-loop | app/server/src/agent/loop-stage-context.ts | runTryCompact()（line 195-227） | 修改 | **删除整个函数尾部** L215-226（`beforeVersion` / `afterVersion` / `state.snapshot = re-assemble` / `obs.setSystem(...)` / `await store.notifyUsageChanged(...)` 全部消费侧逻辑）；**保留** CompactCtx 构造（L199-214）+ `await tryCompact(spec.pluginManager ?? null, compactCtx)` 主体（L216）；函数仍 Promise\<void\>（caller 仍 fire-and-forget，本版本及未来都不 await 结果） | MUST：删除全部消费侧逻辑（snapshot 刷新 + setSystem + notify），理由是 §1.0「summary 纯生产者原则」（**非**「死码清理」——是有意的消费/生产分离）；MUST NOT 改 CompactCtx 字段构造；MUST NOT 保留任何 compact 内部的 notifyUsageChanged（含本处 L225 + `context-compact-runner.ts:170-172`，见 §2.7）；SHOULD：JSDoc 注明「caller fire-and-forget；消费侧（snapshot 刷新 + usage 推送）归正规 assemble 管线，见 §1.0」 | 本文件 §1.0 核心设计原则；本文件 §1.2 不变量；v0.0.78.bug §0 invariants #5 | +2/-14 |

### 2.2 try-compact 重构 — sibling 双发

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| try-compact | app/server/src/agent/try-compact.ts | tryCompact() | 重构 | 谓词检查通过后：(1) `structuredClone(ctx.snapshot)` 一次（双保险，进入 forked agent 入口还会再 clone）；(2) 构造 `sharedCtx = { ...ctx, snapshot: clonedSnapshot }`；(3) `void runSummarySibling(pm, sharedCtx).catch(log)` + `void runConsolidationSibling(pm, sharedCtx).catch(log)` 并发双发；(4) 函数立即 return；(5) **删除** 旧 `await actions[0]!.run(ctx); await triggerPostCompact(pm, ctx);` 串行链 | MUST：谓词 false 直接 return（不动 snapshot，不 clone）；MUST：clone 在谓词 true 之后（避免谓词 false 也付 clone 代价）；MUST：两 sibling 并发不 await；MUST NOT：在 sibling 内部 catch 错误后 rethrow（fire-and-forget 语义）；MUST：保留 forked scope 谓词自动跳过机制（forked scope reject_should_compact 恒 false → 谓词处 return，不进 sibling 双发） | diagnosis §6 方向 A 第 2/3 条；`context_compact_detail.md §2c.1` | +25/-12 |
| try-compact | app/server/src/agent/try-compact.ts | runSummarySibling()（私有新增） | 新增 | 私有 async fn：`actions = pm.getExtensionImpls<DoCompactAction>(ContextDoCompactPoint, ctx.scopeId)`；空返 → return；`try { await actions[0]!.run(ctx) } catch (err) { console.warn('[summary sibling]', err) }`（run 内部 runCompact 已 acquire 'compact' 锁 + markFailed/markDone，详见 `context-compact-runner.ts:113/175/180`） | MUST：空 actions 静默 return（容错，spec §2c.3）；MUST：catch 仅 log（不 rethrow、不影响 consolidation sibling）；MUST NOT：在 sibling 里再 acquire 锁（runCompact 已承担） | `context-compact-runner.ts:113`（acquire 'compact'）；`summary_do_compact.ts:63` | +10/-0 |
| try-compact | app/server/src/agent/try-compact.ts | runConsolidationSibling()（私有新增） | 新增 | 私有 async fn：`handlers = pm.getExtensionImpls<PostCompactHandler>(ContextPostCompactPoint, ctx.scopeId)`；空返 → return；`try { await handlers[0]!.handle(ctx) } catch (err) { console.warn('[consolidation sibling]', err) }`（handle 内部新接入 acquire 'tier1_consolidation' 锁，见 §2.3） | MUST：空 handlers 静默 return；MUST：catch 仅 log；MUST NOT：在 sibling 里 acquire 锁（锁归 handler 自身，便于 handler 内部 fork-2 全程持锁） | diagnosis §6 方向 A 第 4 条；`session_task_lock.md §6` | +10/-0 |
| try-compact | app/server/src/agent/try-compact.ts | triggerPostCompact()（line 79-96） | 删除 | 删除整个函数（post-compact 链已由 runConsolidationSibling 取代，串行 await 链不再需要） | MUST：删除后 grep 确认无残留引用；MUST NOT：保留 dead code | 本文件 §1.2 不变量；diagnosis §6 方向 A 第 2 条 | +0/-18 |

### 2.7 summary 纯生产者 — 删 compact 内部 notifyUsageChanged（§1.0 原则落地）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| compact-runner | app/server/src/agent/context-compact-runner.ts | runCompact()（forked usage 记账 L167-172） | 修改 | **保留** L169 `const usageChain = await store.accumulateUsage(sid, 'forked', forkedResult.usage)`（write 不可删，forked cost 必须落盘——agent run 自身簿记）；**删除** L170-172 `for (const notifySid of usageChain) { await store.notifyUsageChanged(notifySid); }` 循环（compact 内部零 notifyUsageChanged） | MUST：accumulateUsage write 保留（数据必须落盘，否则 forked cost 丢失）；MUST NOT：保留任何 compact 内部的 notifyUsageChanged（本处 L170-172 与 §2.1 runTryCompact 尾部 L225 都删，缺一不可）；MUST：forked cost 的 UI 推送由**下一轮正规 assemble 的 notifyUsageChanged** 携带（`prepareStage` / `ingestAssistant` / `ingestToolResults` 调用方；`getUsageView` 读全量 record，含 forked 分区 + contextWindowUsage）；MUST NOT：在 compact 完成后手动触发一次 assemble 来「立即推送」（违反 §1.0 原则） | 本文件 §1.0 核心设计原则；本文件 §1.2 不变量；diagnosis §5；`context-compact-runner.ts:167-172` | +0/-3 |

### 2.3 fork-2 sibling — tier1_consolidation 锁接入

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| post-compact-consolidation | app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts | MemorySkillConsolidationHandler.handle() | 修改 | 在 `void this.startConsolidation(ctx).catch(() => {...})` 调用**之前**新增 `acquire('tier1_consolidation')`：(1) `if (!ctx.taskLock) return`（无锁兼容 UT fixture）；(2) `const runId = 'consolidation:' + Date.now()`；(3) `if (!ctx.taskLock.acquire(sid, 'tier1_consolidation', runId)) return`（锁占用 → 静默跳过）；(4) 改 `.catch` 为 `.then(() => ctx.taskLock.markDone(sid, 'tier1_consolidation'), (err) => ctx.taskLock.markFailed(sid, 'tier1_consolidation', String(err)))`（fork-2 完成/失败时 release 锁） | MUST：锁失败静默 return（fire-and-forget 不阻塞）；MUST：fork-2 成功 markDone / 失败 markFailed（与 `compact` 锁对称，spec §3.1）；MUST：emit 由 SessionTaskLock 内部 emitTaskUpdate 自动承担（v0.0.78.bug 已实装），handler 不重复 emit；MUST NOT：在 catch 链里再 throw | diagnosis §6 方向 A 第 4 条；`session_task_lock.md §6`；`session_task_lock.md §3.1` CAS 语义 | +10/-2 |

### 2.4 forked 入口 deep clone（双保险）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-manager | app/server/src/agent/agent-manager.ts | forkedRun()（line 312 入口） | 修改 | 函数开头新增 `const snapshotClone = structuredClone(opts.snapshot) as ContextSnapshot`（或等价 deep clone），后续传给 buildForkedDeps 的 `snapshot` 字段改用 `snapshotClone`（不污染 caller 的 opts.snapshot） | MUST：deep clone 在 forkedRun 入口（caller 可能多次复用同 snapshot，例如 summary 与 consolidation 两 sibling 共用 clone — 但本入口对每路 forked 单独再 clone 一次）；MUST NOT：把 clone 推到 buildForkedDeps 内部（buildForkedDeps 是同步装配，clone 异常处理不便）；SHOULD：注释引用「双保险防篡改」（diagnosis §6 方向 A 第 5 条） | diagnosis §6 方向 A 第 5 条；`agent_loop_forked.md §1` 不变量 | +3/-1 |

### 2.5 observability — 改进 #2 主 loop LLM meta 带 context window usage

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| observability | app/server/src/observability/types.ts | GenInput | 修改 | 加 optional 字段 `contextWindowUsage?: ContextWindowUsage`（import from `../message/types`） | MUST：optional（向后兼容，UT fixture / 旧调用点不破）；MUST：注释指明数据源 = `snapshot.contextWindowUsage`（stage-llm 注入） | diagnosis §6 改进 #2；`message/types.ts:164` ContextWindowUsage | +3/-0 |
| agent-loop-obs | app/server/src/agent/agent-loop-observability.ts | LoopObservability.startGeneration()（line 190） | 修改 | 签名加第 5 参数 `contextWindowUsage?: ContextWindowUsage`；在 `const input: GenInput = {...}` 内追加 `contextWindowUsage` 字段（line 200-209 GenInput 字面量） | MUST：optional（UT 兼容）；MUST：透传给 GenInput（langfuse 接受任意 metadata，adapter.safe 包裹）；MUST NOT：在 metadata 顶层重复字段（GenInput 已含） | diagnosis §6 改进 #2；本表上一行 | +4/-0 |
| agent-loop-stage-llm | app/server/src/agent/loop-stage-llm.ts | callLLMForSpec()（line 65 调用点） | 修改 | 调用 `obs.startGeneration(logicalMessages, inputCharCount, new Date(), systemText, snapshot.contextWindowUsage)`（追加第 5 参数） | MUST：传 `snapshot.contextWindowUsage`（已 line 46 取 snapshot，line 89 已读 maxOutputTokens）；MUST NOT：在 stage-llm 内构造新字段（直接透传 snapshot 字段） | diagnosis §6 改进 #2；`loop-stage-llm.ts:46/65/89` | +1/-1 |

### 2.6 observability — 改进 #1 forked trace meta 带 trigger msg id + usage

> **现状核对**：`buildForkedInvokeObservability`（`forked-invoke-observability.ts`）经 grep **仅测试使用**，非生产路径。生产 forked trace `inputMessageIds=[]` 真因是 `runReActLoop:73 peekedMessages = spec.wirePeekTriggerMessages ? ... : []`，而 `build-forked-deps.ts:268` 显式注释「wirePeekTriggerMessages 不设」。**两处都修**（forked-invoke-observability.ts 按 diagnosis 字面要求修；build-forked-deps.ts 是生产真路径）。

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| compact-types | app/server/src/agent/compact-types.ts | CompactCtx | 修改 | 加 optional 字段 `triggerMessageId?: string`（主 session 末尾 msg id，forked trace meta 用）+ `triggerUsage?: ContextWindowUsage`（触发时 context window 用量） | MUST：optional（UT fixture 不注入即 undefined）；MUST：注释指明「触发点在 tryCompact sibling spawn 时填入」 | diagnosis §6 改进 #1 | +4/-0 |
| agent-loop-stage-ctx | app/server/src/agent/loop-stage-context.ts | runTryCompact()（CompactCtx 构造 line 199-214） | 修改 | 构造 CompactCtx 时新增两字段：`triggerMessageId: state.snapshot.messages[state.snapshot.messages.length - 1]?.id`、`triggerUsage: state.snapshot.contextWindowUsage` | MUST：从 `state.snapshot` 读（已 line 197 校验非空）；MUST：messages 空数组兜底 undefined（不抛错） | diagnosis §6 改进 #1；`compact-types.ts` 本表上行 | +2/-0 |
| compact-runner | app/server/src/agent/context-compact-runner.ts | CompactForkedRunner（type line 68-74） | 修改 | input 加 optional 字段 `triggerMessageId?: string` + `triggerUsage?: ContextWindowUsage`（与 CompactCtx 同名，透传用） | MUST：optional（旧调用点不破）；MUST：注释指明「caller（summary_do_compact）透传，进一步传给 forkedRun」 | diagnosis §6 改进 #1 | +2/-0 |
| compact-runner | app/server/src/agent/context-compact-runner.ts | runCompact()（forkedRunner 调用 line 136-141） | 修改 | 调 `forkedRunner({ sessionId, config, snapshot: snap, userMessage: taskMessage, triggerMessageId: ???, triggerUsage: ??? })`——但 runCompact 自身签名无此两参数。**新增** runCompact 第 8、9 参数 `triggerMessageId?: string, triggerUsage?: ContextWindowUsage`（透传给 forkedRunner 调用） | MUST：新参 optional（旧调用点 `ContextEngine.compact` 不破）；MUST：透传不丢弃；SHOULD：JSDoc 注明用途 | diagnosis §6 改进 #1；本表上行 | +5/-1 |
| summary-do-compact | app/plugins/builtins/rocky_context/compact/summary_do_compact.ts | SummaryDoCompactAction.run()（line 63-70） | 修改 | 调 runCompact 时透传 `ctx.triggerMessageId, ctx.triggerUsage`（追加第 8、9 参数）；**额外修复 Bug-1**：捕获 runCompact 返回 boolean（之前丢弃），记录日志（不改变控制流——action.run 仍 void resolve） | MUST：透传两 trigger meta；MUST NOT：基于 boolean 改变 action 契约（仍是 Promise\<void\>）；SHOULD：日志记 boolean false 时「compact 锁失败跳过」便于观测 | diagnosis Bug-1 + 改进 #1；`summary_do_compact.ts:63` | +5/-1 |
| compact-types | app/server/src/agent/compact-types.ts | ConsolidationRunner（type line 87-102） | 修改 | input 加 optional 字段 `triggerMessageId?: string` + `triggerUsage?: ContextWindowUsage`（同 CompactForkedRunner） | MUST：optional；MUST：注释指明「caller（memory_skill_consolidation handler）透传」 | diagnosis §6 改进 #1 | +2/-0 |
| post-compact-consolidation | app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts | MemorySkillConsolidationHandler.startConsolidation()（line 77-107） | 修改 | runner 调用（line 96-106）追加 `triggerMessageId: ctx.triggerMessageId, triggerUsage: ctx.triggerUsage`（透传） | MUST：透传（不丢失 meta）；MUST NOT：在 handler 内自造 trigger meta（数据源是 CompactCtx） | diagnosis §6 改进 #1 | +2/-0 |
| agent-manager | app/server/src/agent/agent-manager.ts | forkedRun()（opts 签名 line 312-326） | 修改 | opts 加 `triggerMessage?: Message`（含 id 即可，用于 wirePeekTriggerMessages）+ `triggerUsage?: ContextWindowUsage`（写进 LoopObservability trace metadata） | MUST：optional；MUST：注释指明「caller=compact/consolidation runner 回调，从 CompactCtx.triggerMessageId 反查 message 或直接构造 synthetic Message({id: triggerMessageId})」 | diagnosis §6 改进 #1 | +3/-0 |
| bootstrap | app/server/src/bootstrap.ts | contextEngine.setForkedRunner wrapper（line 626-644） | 修改 | wrapper input 加 `triggerMessageId?, triggerUsage?`（透传）；调 `agentManager.forkedRun` 时构造 `triggerMessage: { id: input.triggerMessageId ?? '', sessionId: input.sessionId, role: 'user', content: [] } as Message`（synthetic 仅用 id，content 空——只给 wirePeekTriggerMessages 取 id 用） + `triggerUsage: input.triggerUsage` | MUST：triggerMessageId 缺省时仍构造（id='' 兜底，避免 type error）；MUST：synthetic message 仅用于 trace meta 不入 buffer；MUST NOT：在 wrapper 内读 main session store（破坏 forked 隔离） | diagnosis §6 改进 #1；`bootstrap.ts:626-644` | +6/-1 |
| bootstrap | app/server/src/bootstrap.ts | contextEngine.setConsolidationRunner wrapper（line 652-668） | 修改 | 同 setForkedRunner wrapper：input 加 `triggerMessageId?, triggerUsage?`；调 `agentManager.forkedRun` 时同构造 synthetic triggerMessage + triggerUsage 透传 | MUST：与 setForkedRunner wrapper 对称；MUST NOT：复用同一 wrapper（两 runner 任务语义不同——summary NO_TOOLS / consolidation 多工具） | 本表上一行 | +6/-1 |
| build-forked-deps | app/server/src/agent/build-forked-deps.ts | wirePeekTriggerMessages（line 268 当前未设） | 修改 | RunSpec 加 `wirePeekTriggerMessages: opts.triggerMessage ? () => [opts.triggerMessage] : undefined`（与 main 同模式，`build-deps.ts:237-242`） | MUST：triggerMessage 缺省时 undefined（runReActLoop:73 兜底 []）；MUST：返回数组（main 模式是 `Message[]`）；MUST NOT：在 forked 内 peek inbox（forked 不消费 inbox） | diagnosis §6 改进 #1；`build-deps.ts:237-273`；`run-react-loop.ts:72-75` | +2/-1 |
| build-forked-deps | app/server/src/agent/build-forked-deps.ts | BuildForkedDepsOpts（line 91-120） | 修改 | 加 optional 字段 `triggerMessage?: Message` + `triggerUsage?: ContextWindowUsage`（透传给 RunSpec 与 LoopObservability） | MUST：optional（旧调用点兼容） | 本表上行 | +2/-0 |
| build-forked-deps | app/server/src/agent/build-forked-deps.ts | new LoopObservability({...})（line 172-181） | 修改 | LoopObservabilityOpts 加 `triggerUsage?: ContextWindowUsage`（用于 startTrace metadata） | MUST：optional；MUST：注释指明数据源（forkedRun opts.triggerUsage → buildForkedDeps → LoopObservability） | diagnosis §6 改进 #1 | +2/-0 |
| agent-loop-obs | app/server/src/agent/agent-loop-observability.ts | LoopObservabilityOpts（line 34-51） | 修改 | 加字段 `triggerUsage?: ContextWindowUsage` | MUST：optional（UT 兼容） | 本表上一行 | +2/-0 |
| agent-loop-obs | app/server/src/agent/agent-loop-observability.ts | startTrace()（line 131-150） | 修改 | metadata（TraceMetadata）追加 `triggerUsage?: ContextWindowUsage`（来自 opts.triggerUsage，写入 adapter.startTrace metadata 字段） | MUST：triggerUsage undefined 时跳过该字段（不写 undefined 进 metadata）；MUST：保持现有 inputMessageIds 行为（来自 triggerMessages.map）不变 | diagnosis §6 改进 #1；`agent-loop-observability.ts:131-149` | +3/-1 |
| forked-invoke-obs | app/server/src/agent/forked-invoke-observability.ts | buildForkedInvokeObservability()（args line 43-49 + metadata line 60） | 修改 | args 加 optional `triggerMessageId?: string` + `triggerUsage?: ContextWindowUsage`；line 60 metadata 改 `inputMessageIds: triggerMessageId ? [triggerMessageId] : []`（去掉硬编码空）+ 追加 `triggerUsage` 字段（undefined 跳过） | MUST：保留所有现有字段（runId/sessionId/modelId/toolNames）；MUST：triggerMessageId 缺省时仍 `[]`（向后兼容）；MUST NOT：硬编码空（Bug-4 修复核心） | diagnosis Bug-4 + 改进 #1；`forked-invoke-observability.ts:43-60` | +5/-2 |

---

## 3. Spec 同步待办（doc-modifier 阶段 5 处理）

| Spec 文件 | 章节 | 改动 |
|---|---|---|
| `specs/tech/agent/memory/[P0]consolidation_tier1.md` | §4（与 compact 的协作） | 把「compact 完成 → post-compact handler 触发」**顺序链**图改为「should-compact=true → sibling 双发」图；§5「失败隔离」补「两 sibling 互不阻塞、各自锁失败各自静默跳过」 |
| `specs/tech/agent/memory/[P0]consolidation_tier1.md` | §6（待定） | 「fork-2 model resolve」保留；新增「fork-2 acquire tier1_consolidation 锁（spec session_task_lock §6 实接）」 |
| `specs/tech/agent/context/[P0]context_compact_detail.md` | §2c.1（tryCompact 胶水） | 伪代码段更新：谓词 true → deep clone snapshot → void runSummarySibling + void runConsolidationSibling（替代旧 `await action.run + await triggerPostCompact` 串行链） |
| `specs/tech/agent/context/[P0]context_compact_detail.md` | §2c.1（调用契约 / 核心设计原则段 — **新增**） | 新增「**summary = 纯生产者**」原则段：compact/forked 只产 summary + 写 compact_notice 消息 + accumulateUsage('forked') write；**不碰消费侧**（不刷新主 loop snapshot / 不 setSystem / 不 notifyUsageChanged）。消费侧（snapshot 刷新 + usage 推送）归正规 assemble 管线（每次 assemble 后 notifyUsageChanged，读全量 record emit）。compact 完成后不主动 notify，等下一轮 assemble。 |
| `specs/tech/agent/context/[P0]context_compact_detail.md` | §2c.1（line 142 调用点描述） | 「骨架 runReActLoop 在 ingest + assemble 之后调用」→ 改为「骨架 runReActLoop 在 prepareStage 之后、callLLM 之前调用」 |
| `specs/tech/agent/context/[P0]context_compact_detail.md` | §2d（post-compact handler ext point） | 标注「v0.0.80.t1 起 handler.handle 改为 sibling fire-and-forget 调用（不再 await doCompact 后串行触发），由 tryCompact 胶水直接并发派发；handler 内部 acquire 'tier1_consolidation' 锁」；§2d.5 表格「时机」行更新 |
| `specs/tech/agent/session/[P0]session_task_lock.md` | §6（实现落点） | 「post-compact-consolidation.ts（如 tier1 接入）」→ 改为「**已接入**（v0.0.80.t1）：MemorySkillConsolidationHandler.handle 内部 acquire('tier1_consolidation')，fork-2 完成/失败时 markDone/markFailed」 |
| `specs/tech/agent/session/[P0]session_task_lock.md` | §7（不变量） | 不变量 #4「同 session 同 taskType 同时只 1 个 active」补例：`compact + tier1_consolidation 同 session 可并行（不同 taskType）` |
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md` | §1（forked 不变量） | 新增「snapshot 不可变」：caller 传入的 snapshot 应被 forkedRun 入口 deep clone（双保险），sibling 共享一份 clone；forked agent 内部 assemble 不污染 clone |
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md` | §1（task message = directive） | 保留不动（本版本不动 prompt）；仅补「trigger meta（msg id + usage）透传给 forked trace metadata，便于反查触发点」 |

> **coder 偏离反馈**：实现期间如发现 spec 描述与代码不符（例如 spec 写「post-compact handler EP ordered chain」但代码已改 sibling），按代码实际实现 + 汇报偏离，doc-modifier 统一修 spec 对齐。

---

## 4. 测试影响

### 4.1 UT（白盒，主要覆盖）

| 测试文件 | 影响 | 新增/改 |
|---|---|---|
| `app/server/src/agent/__tests__/try-compact.test.ts`（或同等） | 重构：原「doCompact 后触发 post-compact」断言改「谓词 true 后两 sibling 并发派发」；新增「谓词 false 不 clone、不派发」case；新增「sibling 异常互不影响」case；新增「forked scope 谓词自动跳过」case（防递归保留） | 改 + 新增 |
| `app/server/src/agent/__tests__/loop-stage-context.test.ts`（runTryCompact 相关） | 删除「ingestAssistant 触发 runTryCompact」断言；新增「run-react-loop 在 prepareStage 后触发」集成断言（或在 run-react-loop.test.ts） | 改 |
| `app/server/src/agent/__tests__/run-react-loop.test.ts` | 新增「prepareStage 后、callLLM 前调 tryCompact」断言（mock tryCompact 验证调用时机） | 新增 |
| `app/plugins/builtins/rocky_context/compact/__tests__/post-compact-consolidation.test.ts` | 新增「acquire tier1_consolidation 锁失败 → 静默跳过」case；新增「fork-2 完成 markDone / 失败 markFailed」case；保留「runner 缺失/工具空跳过」既有 case | 新增 |
| `app/server/src/agent/__tests__/agent-manager.forkedRun.test.ts`（或同等） | 新增「opts.snapshot 不被 mutate（deep clone 验证）」case；新增「triggerMessage 透传到 wirePeekTriggerMessages」case | 新增 |
| `app/server/src/agent/__tests__/agent-loop-observability.test.ts` | 新增「startGeneration 第 5 参数 contextWindowUsage 透传到 GenInput」case；新增「startTrace metadata 含 triggerUsage」case | 新增 |
| `app/server/src/agent/__tests__/context-compact-runner.test.ts` | 改：runCompact 新增 triggerMessageId/triggerUsage 参数后，旧断言补两参（optional 兼容）；新增「参数透传到 forkedRunner input」case | 改 + 新增 |

### 4.2 AT（黑盒，参考 spec 现有口径）

> spec `consolidation_tier1.md §实现落点` 已明示「post_compact AT 不可行（黑盒难观测），UT 15 覆盖」。本版本同样口径：
>
> - **不可观测部分**（sibling 双发时序、deep clone、tier1 锁 acquire）→ UT 覆盖
> - **可观测部分**（compact 触发后 session 仍正常对话；多轮对话触发 compact 不破坏 session）→ 复用现有 compact AT case（`tests/api/context/` 下已有）
>
> **本版本不强制新增 AT case**——核心修复是触发时机 + 并发安全，UT 已充分覆盖；AT 维持现有 compact case 验证「session 可用性」即可。如 AT 跑出 compact 后 trace 数量异常（如 summary vs memory_extract 不成对），将作为回归检测信号。

### 4.3 ET（前端）

无前端变更（compact 是后端异步任务，前端 CompactBtn 信号源 `summary_task_update` 不变）。

---

## 5. 风险与不变量

### 5.1 风险

| 风险 | 缓解 |
|---|---|
| **R1：deep clone 性能开销**（大对话 snapshot clone 慢） | structuredClone 在 Node 17+/Bun 原生支持，百 KB 级 snapshot clone <1ms；且仅在谓词 true 时 clone（谓词 false 直接 return），实际频次低 |
| **R2：两 sibling 并发对同一 session 写入冲突** | summary 写 `setSummary`（store-level 原子），consolidation 写 skill/memory（独立 store），**写入域正交**；snapshot 是 clone（只读）；SessionTaskLock per-taskType 互不阻塞 |
| **R3：触发点迁移后 compact 频次变化**（提前一轮） | 行为正向（更早触发，但谓词阈值 60% 不变）；UT 覆盖谓词 true/false；AT 监测异常频次 |
| **R4：synthetic triggerMessage（{id: triggerMessageId, content: []}）污染 forked buffer** | 仅用于 `wirePeekTriggerMessages` 取 id（写入 trace metadata），不进 forked in_memory store（forked store 由 `wireInitState` 显式 ingest reminder + userMessage） |
| **R5：`buildForkedInvokeObservability` 修改影响测试** | 仅测试使用，args 加 optional 字段向后兼容；测试调用点按新签名补参（可选） |
| **R6：compact 完成后 forked cost + context 下降的 UI usage 推送延迟到下一轮 assemble**（§1.0 纯生产者原则的 trade-off，**接受**） | 接受：compact_notice 消息仍由 `noticeEmitter` 立即 emit（UI 立即知晓 compact 发生，spec §6.5 / BUG-001）；usage 数字延迟到下一次用户消息触发的正规 assemble（人可感知 ~秒级延迟，可接受）；若 turn 已结束（主 loop idle），延迟到下次用户消息。如未来需即时 usage 推送，可由 compact 完成后显式 trigger 一次 assemble（**本版本不做**，违反 §1.0 原则） |

### 5.2 不变量（MUST NOT 违反）

1. **fire-and-forget 不阻塞主 loop**：触发点 `void runTryCompact(...).catch(log)`，主 loop 立即进 callLLM。
2. **sibling 互不阻塞**：summary 与 consolidation 各自 `void ... .catch(log)`，互不 await。
3. **per-task 锁 CAS 语义**：`acquire('compact')` / `acquire('tier1_consolidation')` 失败各自静默跳过（不重试、不排队）。
4. **snapshot 不可变**：触发点 clone 后，两 sibling 共用、不修改；forkedRun 入口再 clone 一次（双保险）。
5. **防递归 forked scope**：forked scope `reject_should_compact` 谓词恒 false → forked agent 内 tryCompact 在谓词处 return，不进 sibling 双发（结构上不可能递归，spec `context_compact_detail §2c.3` 保留）。
6. **CompactBtn SSE 信号不丢**：SessionTaskLock.acquire/markDone/markFailed 内部 emit `summary_task_update`（v0.0.78.bug 已实装）；本版本 tier1_consolidation 锁复用同 emit 链路，前端 CompactBtn 不感知差异（spec 决定复用事件名）。
7. **错误观测链不破**：sibling catch 仅 log + 不 rethrow；markFailed 由 handler/runner 内部承担（与 v0.0.78.bug 一致）。
8. **triggerMessageId/triggerUsage 不入 forked buffer**：仅写入 trace metadata，不进 forked in_memory store（forked buffer 由 wireInitState 显式 ingest reminder + userMessage）。
9. **compact 内部零 notifyUsageChanged（§1.0 纯生产者原则）**：summary 是纯生产者——`accumulateUsage(sid, 'forked', ...)` write 保留（forked cost 必须落盘），但**任何 compact 内部的 notifyUsageChanged 都已删**（`loop-stage-context.ts:225` + `context-compact-runner.ts:170-172`）。usage 推送的唯一触发点是正规 assemble 管线（`ingestMainAndAssemble` 调用方：`prepareStage` / `ingestAssistant` / `ingestToolResults` 每次 assemble 后 notify，`getUsageView` 读全量 record emit）。compact 完成后的 forked cost + context 下降由下一轮 assemble 的 notify 携带。

---

## 6. 文件级变更清单（roll-up，供 planner 切 task 参考）

| 文件路径 | 操作 | 主要变更 |
|---|---|---|
| app/server/src/agent/run-react-loop.ts | 修改 | runReActLoop 加触发点（prepareStage 后、callLLM 前） |
| app/server/src/agent/loop-stage-context.ts | 修改 | ingestAssistant 删触发；runTryCompact 删同步 re-assemble 尾；CompactCtx 加 triggerMessageId/triggerUsage |
| app/server/src/agent/try-compact.ts | 重构 | tryCompact 改 sibling 双发；新增 runSummarySibling/runConsolidationSibling；删 triggerPostCompact |
| app/server/src/agent/compact-types.ts | 修改 | CompactCtx 加 triggerMessageId/triggerUsage；ConsolidationRunner input 加同字段 |
| app/server/src/agent/context-compact-runner.ts | 修改 | CompactForkedRunner input 加 triggerMessageId/triggerUsage；runCompact 加第 8/9 参数透传；**§1.0 落地**：删 L170-172 notifyUsageChanged 循环（accumulateUsage write 保留） |
| app/server/src/agent/agent-loop-observability.ts | 修改 | LoopObservabilityOpts 加 triggerUsage；startGeneration 加第 5 参数 contextWindowUsage；startTrace metadata 加 triggerUsage |
| app/server/src/agent/build-forked-deps.ts | 修改 | BuildForkedDepsOpts 加 triggerMessage/triggerUsage；wirePeekTriggerMessages 设置；LoopObservability 透传 triggerUsage |
| app/server/src/agent/agent-manager.ts | 修改 | forkedRun opts 加 triggerMessage/triggerUsage；入口 deep clone opts.snapshot |
| app/server/src/agent/forked-invoke-observability.ts | 修改 | args 加 triggerMessageId/triggerUsage；line 60 去硬编码空 |
| app/server/src/observability/types.ts | 修改 | GenInput 加 contextWindowUsage? 字段 |
| app/server/src/agent/loop-stage-llm.ts | 修改 | callLLMForSpec 调 startGeneration 透传 snapshot.contextWindowUsage |
| app/plugins/builtins/rocky_context/compact/summary_do_compact.ts | 修改 | run() 透传 triggerMessageId/triggerUsage；记录 runCompact boolean（日志） |
| app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts | 修改 | handle() acquire 'tier1_consolidation' 锁；startConsolidation 透传 triggerMessageId/triggerUsage |
| app/server/src/bootstrap.ts | 修改 | setForkedRunner/setConsolidationRunner wrapper 透传 triggerMessageId/triggerUsage + 构造 synthetic triggerMessage |

**总影响**：~14 文件，+/- 约 90 行净增（含注释 + JSDoc）。

---

> **reviewer 检查清单 G（按本表查偏离）**：
> 1. 触发点是否在 prepareStage 后、callLLM 前？ingestAssistant 是否已删触发？
> 2. tryCompact 是否 sibling 双发（无串行 await）？deep clone 是否在谓词 true 后？
> 3. consolidation handler 是否 acquire 'tier1_consolidation' 锁？锁失败是否静默跳过？
> 4. forkedRun 入口是否 deep clone opts.snapshot？
> 5. startGeneration 第 5 参数是否 contextWindowUsage？GenInput 是否含该字段？
> 6. forked trace metadata.inputMessageIds 是否非空（trigger msg id）？triggerUsage 是否写入？
> 7. runTryCompact 同步 re-assemble 尾是否已删？
> 8. 单文件 ≤300 行（try-compact.ts 重构后预估 ~120 行；loop-stage-context.ts 减至 ~210 行）？
> 9. **compact 内部零 notifyUsageChanged（§1.0 原则）**：`context-compact-runner.ts:170-172` 循环已删？`loop-stage-context.ts:225` notify 已删？`accumulateUsage` write（L169）是否保留（不可删）？forked cost 是否仍能通过下一轮 assemble 的 `getUsageView` 读到？
