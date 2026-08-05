---
type: design
title: v0.0.49 — Remove ContextPort + callLLMForXxx，骨架直调 contextEngine + base.callLLM
version: 0.1
updated: 2026-07-02
status: done
related:
  - specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md
  - specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md
  - specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_forked.md
  - specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md
  - specs/tech/agent/context/[P0]context_engine.md
  - specs/tech/agent/context/[P0]extension point and implementations.md
---

# v0.0.49 架构设计 — Remove ContextPort + callLLMForXxx

> 方向（用户拍板，不再质疑）：ContextPort 概念整个 remove；callLLMForMain/callLLMForForked remove；LLM 统一为 `base.callLLM`；分层归位（EOS→业务/展示层，filterToolDefinitions→agent 装配，厂商协议→llm_caller）；保留 runReActLoop 统一骨架 / LifecyclePort / scopeId 路由 / contextEngine impl 链 / base.callLLM 原语。

## 0. 当前真实偏差（spec vs 代码）

调研发现 **spec 与代码存在重大偏差**，是用户感觉「ext 大部分没必要」的根因：

- spec `context_engine.md §3.6 D1=B` 契约已声明：forked 也走 `contextEngine.ingest/assemble(scopeId='forked', buffer)`，由 `buffer_sink`/`buffer_reader`/`append_passthrough` impl 承担源/汇（保 cache 前缀 + 走 plugin chain）。
- **代码现实**（`forked-context-port.ts:69-89`）：`ForkedContextPort.recordAssistant/recordToolResults` **直接 `buffer.push()`，根本没调 contextEngine** —— 完全绕过了 forked scope 配置的所有 ext impl。
- 后果：forked scope 配置的 `buffer_sink`/`buffer_reader`/`append_passthrough`/`reject_should_compact` 等 impl **从未被 forked 路径触发**，纯属死代码。这才是「ext 没必要」的真相 —— 不是 ext 本身没必要，是骨架没真正调用它们。

- **第二处偏差（default sink 未 EP 化，不对称）**：`context-engine.ts:187-190` 硬编码 `if (scopeId !== FORKED_SCOPE_ID) store.appendMessages(...)` —— default scope 的 store sink 是代码 `if` 分支硬尾，**未进 ext impl chain**，与 forked 的 `buffer_sink` impl 不对称。后果：default/forked sink 行为由代码 `if scopeId` 决定，不是配置驱动；想替换/装饰/disable default sink 都无从下手。v0.0.49 用 `store_sink` impl（EP = `context_ingest_handler`）EP 化修复（见 D15）。

v0.0.49 的真正工作量：让骨架开始真正调用 contextEngine（main + forked 都走），ext impl 自然激活；同时删 ContextPort + callLLMForXxx 中间层；并把 default sink 也 EP 化（`store_sink` impl），让 contextEngine 删 `if scopeId` 硬尾、default/forked sink 对称。

## 1. 决策摘要（用户拍板项落地）

| # | 决策 | 落地形态 |
|---|------|---------|
| D1 | 删 ContextPort | 骨架直调 `contextEngine.ingest/assemble(scopeId, buffer)`；main 专属逻辑（drain inbox + 游标准入）通过 `drainMode='eager'` + RunState 游标表达，不进 ContextPort 包装 |
| D2 | 删 callLLMForMain/callLLMForForked | 骨架直调 `base.callLLM`；差异（`backgroundPath`/observability modeKey）由 RunSpec 字段透传 |
| D3 | EOS→业务/展示层 | squad 主对话的 EOS stop seq + strip 留在 main 的 `buildMainDeps` 装配（spec.toolDefinitions + 可选 stopSeq 参数）；骨架零感知 |
| D4 | filterToolDefinitions→agent 装配 | main 的 `filterToolDefinitionsBySessionType` 在 `buildMainDeps` 装配时一次性过滤后存 `spec.toolDefinitions`；骨架与 base.callLLM 不感知 |
| D5 | 厂商协议→llm_caller | 已在 llm_caller 层（不动）；base.callLLM 内部调 `llmCaller.invoke`（v0.0.25 已落） |
| D6 | 保留 runReActLoop 统一骨架 | 同一份 `runReActLoop(spec)` 服务 main + forked |
| D7 | 保留 LifecyclePort（FinalizePort 并入） | 三 hook `onUsage`/`onRunEnd`/`onInterrupted` 都挂 LifecyclePort（**删 FinalizePort 概念**，onInterrupted 成为 LifecyclePort 方法）；承担 mode 差异（main 持久化 + 五态机，onInterrupted=noop 由 abort api 4 步接管；forked 全 noop，buffer 随 GC）；usage forked 分区保留 |
| D8 | 保留 scopeId 路由 | `AgentScopeRouter.resolve(modeKey, session)` 不变（main→`default`，forked→`forked`） |
| D9 | 保留 contextEngine impl 链 | `context-ingest-pipeline.ts`/`assemble-pipeline.ts`/`buffer_sink`/`buffer_reader`/`append_passthrough`/`try-compact.ts` 全部不动；新骨架真正开始调用它们 |
| D10 | 保留 base.callLLM/executeTools 原语 | `agent-loop-base.ts` 不动 |
| D11 | tryCompact 统一挂载 | 骨架统一调 `tryCompact`；forked scope `reject_should_compact` 返 false 自动跳过 —— **不用 if main/forked 分支** |
| D12 | main/forked 差异收敛 4 维 | `scopeId` + `buffer`(per-run RunState 字段) + `drainMode`（三态 eager/none/lazy）+ LifecyclePort hook |
| D13 | onUsage forked 分区保留 | `accumulateUsage(sid, "forked", u)` 在 ForkedLifecyclePort.onUsage 不动 |
| D14 | Forked→forked 小写 | `forked-scope-bootstrap.ts:32` `FORKED_SCOPE_NAME='Forked'` → `'forked'` |
| D15 | store_sink EP 化（default/forked sink 对称） | 新增 `store_sink` impl（EP=`context_ingest_handler`，行为=`ctx.store.appendMessages(sessionId, messages)`）；default scope chain 尾 activate `store_sink`，forked scope chain 尾 activate `buffer_sink`（`store_sink` disabled）；`contextEngine.ingest` 删 `if scopeId !== FORKED` 硬尾，**只跑 chain**（chain 尾 sink impl 决定写哪）；`IngestCtx` 加 `store?: SessionStore` 字段（default 注入 / forked 不注入 / `store_sink` 读它）；「怎么决定 forked 不持久化」= scope 配置 disable store_sink（非代码 if） |

## 2. 新 runReActLoop 骨架（remove 后的完整伪代码）

```text
runReActLoop(spec: RunSpec): Promise<RunResult>
  // —— state 初始化（main/forked 差异 1：buffer 字段）——
  state = spec.wireInitState ? await spec.wireInitState() : await initState(spec.wireStore, spec.config)
  //   main RunState: { ingestUpTo, llmUpTo, snapshot, step, done, ... , buffer: null }
  //   forked RunState: { ingestUpTo: null, llmUpTo: null, snapshot, step, done, ... , buffer: Message[] }
  state.recentToolSigs = []
  spec.observability.reset()
  if spec.wireStore: await ensureRunCreated(spec.wireStore, spec.config, spec.runId)  // main only
  if spec.controller.aborted: return { interrupted }

  peeked = spec.wirePeekTriggerMessages ? spec.wirePeekTriggerMessages() : []   // main only
  emitRunStart(emitCtx, peeked.map(m => m.id))
  spec.observability.startTrace(peeked)

  while !state.done:
    if spec.controller.aborted: break interrupted
    spec.observability.startStepSpan(state)

    // —— ① drain（main only；forked drainMode='none' 跳过，lazy 占位 future）——
    if spec.drainMode == 'eager':
      drained = drainAndPartition(spec.wireInbox, sid)
      emitDrainResult(emitCtx, drained)
      if drained.newMessages.length > 0:
        await contextEngine.ingest(config, drained.newMessages, scopeId, false, state.buffer)
        //   main: scopeId='default', buffer=undefined → transcript_reader + base_builder + chain 尾 store_sink 写 store
        //   forked: 不进此分支（drainMode='none'）

    // —— 统一 assemble（main + forked 都走 contextEngine；scopeId 选 impl 链）——
    snapshot = await contextEngine.assemble(config, scopeId, state.buffer)
    state.snapshot = snapshot
    if spec.drainMode == 'eager':
      await spec.wireStore.notifyUsageChanged(sid)   // assemble 内部 updateContextWindowUsage 后显式 notify

    // —— 准入判定（main only：游标推进；forked 恒首轮准入，maxIter 控制后续）——
    if spec.drainMode == 'eager' and state.ingestUpTo == state.llmUpTo:
      state.stopReason = 'no_new_messages'; break
    if !snapshot: state.stopReason = 'no_new_messages'; break

    if spec.controller.aborted: break interrupted

    // —— ② 统一 base.callLLM（差异由参数透传：messages 取自 state.buffer ?? snapshot.messages；backgroundPath 标 forked）——
    messages = state.buffer ?? snapshot.messages
    messageId = ulid()
    if config.agentToolContext: config.agentToolContext.currentMessageId = messageId
    genHandle = spec.observability.startGeneration(messages, snapshot.inputCharCount, now(), firstText(snapshot.system))
    invokeObs = createLangfuseObservabilityPort({ adapter, genHandle, ... })
    { assistantMessage, usage } = await base.callLLM({
      sessionId, runId, client: config.client, modelId: config.modelId,
      messages: messages.map(toProtocolMessage),
      tools: spec.toolDefinitions,           // 已在装配阶段过滤（filterToolDefinitionsBySessionType 仅 main）
      controller, emit, messageId,
      inputCharCount: snapshot.inputCharCount,
      modeKey: spec.modeKey,                  // observability 身份标记
      maxOutputTokens: snapshot.contextWindowUsage.maxOutputTokens,
      stop: spec.stopSequences,               // main squad 才有 EOS；forked undefined
      llmCaller: { invoke: llmCallerInvoke },
      runState: state,
      backgroundPath: spec.backgroundPath,    // main=false, forked=true
      invokeObservability: invokeObs,
      logWriter: config.logWriter,
    })
    if spec.eosStripper: spec.eosStripper(assistantMessage.content)   // main squad only；forked undefined
    spec.observability.recordLastAssistant(assistantMessage)
    state.lastAssistantContent = assistantMessage.content

    // —— 写回 assistant（统一 ingest；scopeId 选 impl 链 → default chain 尾 store_sink 写 store / forked chain 尾 buffer_sink 写 buffer，无代码 if 分支）——
    await contextEngine.ingest(config, [assistantMessage], scopeId, false, state.buffer)
    emitMessageEnd(emitCtx, assistantMessage.id)

    await spec.lifecycle.onUsage(usage)       // main→accumulateUsage("current")；forked→accumulateUsage("forked")

    // —— compact 统一挂载（tryCompact；forked scope reject_should_compact 恒 false 自动跳过，无需 if 分支）——
    beforeVersion = (await spec.wireStore?.getSummary(sid))?.version ?? 0   // forked wireStore=null → 0
    await tryCompact(spec.pluginManager, { config, snapshot, store: spec.wireStore, scopeId,
      stateMachine: spec.wireStateMachine, assembleFn: (c) => contextEngine.assemble(c, scopeId, state.buffer),
      forkedRunner: contextEngine.getForkedRunner(), noticeEmitter: spec.compactNoticeEmitter })
    afterVersion = (await spec.wireStore?.getSummary(sid))?.version ?? 0
    if afterVersion > beforeVersion:
      state.snapshot = await contextEngine.assemble(config, scopeId, state.buffer)
      // obs.setSystem + notifyUsageChanged（main only；forked wireStore=null 跳过）

    if spec.controller.aborted: break interrupted

    // —— ③ tools ——
    toolCalls = extractToolCalls(state.lastAssistantContent)
    if toolCalls.length == 0:
      if spec.drainMode == 'eager' and (await peekInboxHasMessage(spec.wireInbox, sid)): continue
      state.stopReason = 'no_tool_call'; break
    if checkMaxIter(state.step, spec.maxIter): state.stopReason = 'max_iterations'; break

    results = await executeAndEmit({ toolEngine: spec.wireToolEngine, ..., allowedTools: spec.allowedTools })
    toolMsg = { id: ulid(), sessionId: sid, role: 'tool', content: results, runId }
    await contextEngine.ingest(config, [toolMsg], scopeId, false, state.buffer)

    if checkDoomLoop(toolCalls, state.recentToolSigs): state.stopReason = 'doom_loop'; break
    state.step++

  // —— 退出分流 ——
  catch (e):
    if controller.aborted: interrupted = true
    else: state.stopReason = 'error'; state.error = buildRunError(e); emitError(...)
  if interrupted:
    await spec.lifecycle.onInterrupted(state)        // main→noop；forked→noop（buffer 随 run GC）
    return { interrupted }
  await spec.lifecycle.onRunEnd(state)               // main→persistRun + markIdle/markError；forked→noop
  emitRunEnd(emitCtx, state.stopReason)
  return { answer: extractFinalText(state), state.stopReason, state.step }
```

### 2.1 RunSpec / RunState 字段（差异参数化）

```typescript
interface RunSpec {
  // —— 身份（不变）——
  sessionId, runId, modeKey, scopeId, controller, config
  // —— 工具（装配时定，spec base §3）——
  toolDefinitions: ToolDefinition[]   // main 已 filterToolDefinitionsBySessionType；forked caller 原样传
  allowedTools: string[]
  maxIter: number
  // —— main/forked 4 维差异（D12）——
  backgroundPath: boolean             // main=false；forked=true
  drainMode: 'eager' | 'none' | 'lazy'  // main='eager'（每轮 drain inbox）；forked='none'（不 drain）；'lazy' 预留 future（run 结束 drain，spec base §1.1 概念定稿暂不实现）
  stopSequences?: string[]            // main squad=[EOS]；forked undefined
  eosStripper?: (content: ContentBlock[]) => void  // main squad=stripEosToken；forked undefined
  compactNoticeEmitter?: (notice: Message) => void // main=emitMessageStart/Text/End；forked undefined
  // —— LifecyclePort（D7：FinalizePort 并入，三 hook onUsage/onRunEnd/onInterrupted）——
  lifecycle: LifecyclePort            // onUsage / onRunEnd / onInterrupted
  // —— 观测 + emit ——
  observability, emit, wireEmitCtx
  // —— wire extras（main 专属基础设施；forked 多为 undefined）——
  wireStore?, wireInbox?, wireStateMachine?, wireToolEngine?
  wirePeekTriggerMessages?
  wireInitState?
  pluginManager?                     // tryCompact 用；forked 也传（让 tryCompact 在 forked scope 调用 reject_should_compact 显式返 false）
}

interface RunState extends LoopStateBase {
  // main 专属（forked 全 null）
  ingestUpTo, llmUpTo                // 游标；不变量 llmUpTo ≤ ingestUpTo
  // forked 专属（main 全 null）
  buffer?: Message[] | null          // per-run 内存数组；forked 持引用
}
```

## 3. main/forked 差异收敛表（4 维）

| 维度 | main | forked |
|------|------|--------|
| `scopeId` | `default` | `forked` |
| `state.buffer` | `null`（走 store）| `Message[]`（持引用，初始=[system,...snapshot.messages,userMessage]）|
| `drainMode` | `'eager'` | `'none'` |
| `lifecycle.onUsage` | `accumulateUsage(sid,"current",u)` + notifyUsageChanged | `accumulateUsage(sid,"forked",u)` + notifyUsageChanged |
| `lifecycle.onRunEnd` | persistRun + markIdle/markError(CAS) | noop |
| `lifecycle.onInterrupted` | noop（abort api 4 步接管）| noop（buffer 随 GC）|
| `backgroundPath` | `false` | `true` |
| `stopSequences`/`eosStripper` | squad 才有 | undefined |
| `maxIter` | `config.maxIterations ?? 25` | 1（summary）/ N（memory_extract future）|

骨架**无 if main/forked 分支** —— 全部通过上述字段参数化。

## 4. 文件三态分类（保留/删除/修改）

详见 `design_refactor_manifest.md` §1-§2。摘要：

- **删除（4 个文件）**：`context-port.ts` / `forked-context-port.ts` / `agent-loop-call-main.ts` / `agent-loop-call-forked.ts`
- **修改（5 个文件）**：`run-react-loop.ts`（内联 contextEngine 调用，drainMode 三态分支）/ `loop-ports.ts`（删 ContextPort + CallLLMHook + FinalizePort 契约，保留 LifecyclePort 含 onInterrupted）/ `build-deps.ts` + `build-forked-deps.ts`（装配改传 scopeId+buffer+drainMode，Main/ForkedLifecyclePort 含 onInterrupted）/ `context-engine.ts`（D15：删 `if scopeId !== FORKED` 硬尾 + `IngestCtx` 加 `store?` 字段，default 注入 wireStore）
- **小改（2 个文件）**：`forked-scope-bootstrap.ts`（Forked→forked 小写 + disable `store_sink` in forked）/ spec 文档（6 个，含 ext impl 清单加 store_sink）
- **新增（1 个文件）**：`app/plugins/builtins/rocky_context/ingest/store_sink.ts`（D15：default 专属 sink，EP=`context_ingest_handler`，对齐 buffer_sink；plugin.json P0 enabled 或 ensureDefaultScope 显式 activate）
- **保留不动（核心）**：`context-ingest-pipeline.ts` / `assemble-pipeline.ts` / `buffer_sink`/`buffer_reader`/`append_passthrough` impl / `try-compact.ts` / `compact-types.ts` / `agent-loop-base.ts` / `agent-scope-router.ts`

## 5. ext impl 对接 + 配置

详见 `design_context_ext.md`。摘要：

- ext impl 契约：`buffer_sink`（forked 写 buffer 尾）/ `buffer_reader`（forked 读 buffer 含 system 首条）/ `append_passthrough`（forked 原样返回 reducer 不 rebuild）/ `store_sink`（**v0.0.49 新增**，default 专属写 store，对齐 `buffer_sink`；详见 `design_context_ext.md §1.4`）
- 当前 `ensureForkedScope` 配置：enable 3 forked impl（隐式）+ disable 4 store-based impl（transcript_reader / base_builder / system_reminder_injector / **`store_sink`** v0.0.49 新增 disable）+ setExclusive reject/noop compact（防递归）
- default scope 配置（plugin.json P0 或 ensureDefaultScope）：activate `store_sink`（default chain 尾 sink impl 决定写 store）—— contextEngine 删 if 硬尾后由 chain 尾 sink impl 决定写哪
- 可选精简：关 4 清理 reducer（orphan_tool_call/empty_message/role_merge/snip_handler）—— append_passthrough 忽略 input 不跑 reducer，故 disable 不影响行为，但节省 chain 遍历

## 6. 不变量守护

详见 `design_refactor_manifest.md` §3。摘要：

- **append-only 保缓存**：`append_passthrough` reducer 原样返回 buffer + 骨架不改 buffer 前缀
- **绝不 compact（forked）**：tryCompact 在骨架统一调；forked scope `reject_should_compact` impl 恒 false → 谓词检查处 return
- **无 store transcript（forked）**：forked scope `store_sink` disabled（`ensureForkedScope` 显式 disable，**非代码 if 硬尾**）→ ingest chain 不含 `store_sink` → chain 尾是 `buffer_sink` 写 buffer；contextEngine.ingest 只跑 chain（D15 已删 `if scopeId !== FORKED` 硬尾）
- **无持久化（forked）**：`wireStore` 不设 → `ensureRunCreated` 跳过；LifecyclePort.onInterrupted/onRunEnd noop（D7 并入后 onInterrupted 是 LifecyclePort 方法）
- **onUsage forked 分区保留**：`ForkedLifecyclePort.onUsage` 调 `accumulateUsage(sid,"forked",u)`（type 隔离不污染 current）

## 7. 风险 + 测试策略

详见 `design_refactor_manifest.md` §4。摘要：

- UT 白盒：main 路径（drain/游标推进/tryCompact 触发/persistRun）+ forked 路径（buffer 引用/无 store/compact 自动跳过）+ 骨架无 if main/forked 分支断言
- AT 真 LLM：主对话多轮（drain+ingest+assemble+compact 触发）+ forked summary（buffer 走 buffer_sink/buffer_reader/append_passthrough 全链路）+ 主对话触发 forked compact（验证 forked scope 路由 + tryCompact 自动跳过 forked 不递归）
