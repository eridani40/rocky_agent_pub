---
type: spec
title: Agent Loop — 旁路 Run（runKind=summary/consolidate 不变量契约源）
priority: P0
status: active
updated: 2026-07-25
since: v0.0.13
---

# Agent Loop — 旁路 Run（summary / consolidate 不变量契约源）

> **[v0.0.204] forked 概念退役，不变量保留**：类型系统与代码的 forked 命名整体退役（无 isForked/forkedRun/buildForkedDeps/ForkedLifecyclePort/modeKey）；「forked mode」改述为 **旁路 run（runKind=summary/consolidate）**——同 session 的旁路 ReAct run，snapshot 必填输入，profile（`session-types/*.yaml`）驱动装配（`buildRunDeps` 单装配）。本文保留作**旁路 run 特有不变量的契约源**：append-only 保缓存、tool 双维度、纯 directive task message、无副作用边界。coder 实现时仍须遵守。下文历史章节中的「forked / ForkedAgent / buildForkedDeps / modeKey」一律按本映射理解：forked→旁路 run、modeKey→runKind、memory_extract→consolidate、`scopeId='forked'`→scopeId=canonicalId（如 `playground-rocky:parent:summary`）。
> **[v0.0.40] 类退役 / 不变量保留**：`ForkedAgent` 策略类 + `ForkedLoop` 内部执行单元 + `while` 编排**退役**（迁入统一骨架 `runReActLoop(spec)` + `buildForkedDeps`，见 `[P0]agent_loop_unified.md`）。本文保留作 **forked mode 特有不变量的契约源**：append-only 保缓存、tool 双维度、无副作用边界——这些不变量随 deps 装配迁入骨架，coder 实现时仍须遵守。**tool emit gap 已补**：forked 改走 `executeAndEmit`（统一 emit tool_result + obs span）。
>
> **[v0.0.49] ContextPort 退役**：`ForkedContextPort` 整删（v0.0.40-0.0.48 直接 `buffer.push()` 绕过 contextEngine 的死代码——这是 v0.0.49 主要修复点）。`buildForkedDeps` 装配 RunSpec（`buffer` 字段进 RunState + `drainMode='none'` + `scopeId='forked'`），骨架直调 `contextEngine.ingest/assemble('forked', state.buffer)`，由 forked 专属 impl（`buffer_reader`/`append_passthrough`/`buffer_sink`）承担源/汇——ext impl 链终于被骨架真正激活。下文章节中「ForkedAgent / ForkedLoop / ForkedContextPort」描述是**v0.0.48 前的现状**，理解为「`buildForkedDeps` 装配出的 RunSpec 行为契约」即可。

> 定位：forked mode（旁路）的 ReAct 执行——summary / memory_extract。v0.0.40 前由 **ForkedAgent**（策略类）+ **ForkedLoop**（内部执行单元）承担；v0.0.40 后由统一骨架 + forked deps 装配承担，行为契约不变。
> 参见：[P0]agent_interface.md（单 run 契约）、[P0]agent_loop_unified.md（统一骨架 + RunSpec 字段 + LifecyclePort + emit，**v0.0.49 权威**）、[P0]agent_manager.md（门面调度）、[P0]agent_loop_base.md（机制原语）、[P0]agent_loop_eager_drain.md（current 不变量）、[P0]agent_interrupt.md（中断）
> 设计决策：D1 策略类无状态 / D2 RunState 内存游标 / D3 tool 双维度 / D4 独立中断无收尾

---

## 1. 定位

旁路 run 的行为由 `buildRunDeps`（build-run-deps.ts，v0.0.204 单装配合并）按 profile 装配 RunSpec + 统一骨架 `runReActLoop` 承担（v0.0.40 前由 ForkedAgent 策略类承担；v0.0.204 前 ForkedAgent→ForkedLoop / buildForkedDeps 命名链整体退役为 `runReActLoop` + `buildRunDeps`）。所有 session 级状态外移到 AgentManager 统一持有。

**旁路的 point**：
- **共享快照**：拿 session 截止此刻的 `snapshot`（messages + system + summary），天然理解历史上下文
- **享受缓存**：messages 前缀与主对话一致 → prompt cache 命中（**只能往后追加，不改前缀**）
- **旁路无污染**：默认不写持久 store / 不 compact / 不转状态机——主对话零感知
- **独立 emit**：默认 emit 到独立 groupKey（`session_id:<sid>_amt:<runKind>`），不污染主对话流

> **[v0.0.54] forked 不变量 — task message = directive（MANDATORY，核心设计原则）**：
>
> 1. **snapshot 是唯一信息源**：forked buffer = snapshot 内容（system + messages + reminder）+ 追加的 task 指令。caller 拿 snapshot 喂 forked runner，runner 在内部把 buffer 注入 `CanonicalRequest.messages`。
> 2. **task message = 纯 directive**：caller 传入的 `userMessage` 只下指令（"对上面的对话历史做 X"），**不复述** snapshot 任何内容、**不注入** 老 summary / 序列化 transcript / 任何对话文本。"上面的对话历史" = buffer 里的 messages，prompt 不重复发。
> 3. **违例特征（须拒绝）**：caller 在 task message 里塞 `serializeMessages(snap.messages)` / `JSON.stringify(snap.messages)` / `old_summary.content` 等任何 snapshot-derived 内容 → 对话历史发两遍，破坏 cache 命中、ruin 旁路的全部意义。v0.0.22-0.0.53 compact 实现曾犯此违例（`{{serialized_transcript}}` 占位符），v0.0.54 修复回归不变量。
> 4. **适用范围**：所有旁路 run caller（compact / consolidation / 任何未来旁路 EP）都必须遵守。caller 构造 task message 时自检：「这条消息的文本能否在没看 snapshot 的情况下独立写出？」能 = 合规 directive；不能（依赖 snapshot 内容）= 违例。
>
> **[v0.0.204] fork-1 / fork-2 同契约确认**：consolidation（fork-2）caller 曾长期违例——`post-compact-consolidation.ts` 把 `serializeMessages(snapshot.messages)` 塞进 task message（v0.0.51 遗留）。v0.0.204 修复：fork-2 task message 改纯 directive（`ConsolidationHandler.build()` 不读 vars，只填 `routing_rules`；`consolidation.md` 删 `[输入]` 段，`serializeMessages` 函数随唯一消费方删除）。**summary 与 consolidate 同契约：snapshot 经旁路 buffer 唯一承载对话历史，prompt 只下指令。**
>
> 详见 `../context/[P0]context_compact_detail.md §3.0`（compact 实现的 directive-only 契约）。

> **[v0.0.80.t1] forked 不变量补 — snapshot 不可变（双 clone）+ trigger meta 透传**：
>
> 5. **snapshot 不可变（双 clone 防篡改）**：caller 传入的 snapshot 在 tryCompact 谓词 true 后由胶水 `structuredClone(ctx.snapshot)` 一次（fork-1 / fork-2 两 sibling 共享同一份不可变 clone）；sideRun 入口（`agent-side-run.ts`）再 `structuredClone(opts.snapshot)` 一次。旁路 run 内部 runReActLoop 每轮调 `contextEngine.assemble(config, scopeId, state.parentSnapshot, ...)` 是另建新 snapshot 对象不动 clone（[v0.0.82] runCompact 也不再重新 assemble，直接用传入 snapshot 跑 sideRun——见 `../context/[P0]context_compact_detail.md §2b.3`）；caller 的原 `opts.snapshot` 也不被 mutate（多次复用安全，例如两 sibling 共用）。双 clone 是双保险：外层 clone 防两 sibling 互相污染 + caller 误改，内层 clone 防 sideRun 内部装配链意外回写。
> 6. **trigger meta 透传（仅写 trace metadata，不入 forked buffer）**：caller（compact / consolidation runner）从 `CompactCtx.triggerMessageId` + `CompactCtx.triggerUsage` 取触发点 meta，构造 synthetic `triggerMessage: { id: triggerMessageId, ... }`（仅用 id）传给 `wirePeekTriggerMessages`；`triggerUsage` 写进 `LoopObservability.startTrace` metadata。**目的**：从 forked trace 反查「触发时主 session 末尾 message id + context window 用量」（v0.0.80.t1 改进 #1/#2）。**不入 forked buffer**——synthetic triggerMessage 仅用于 `wirePeekTriggerMessages` 取 id 写 trace，forked buffer 由 `wireInitState` 显式 ingest reminder + userMessage 组装。

**职责**：
- 基于快照 + taskMessage 执行 loop（单次或多轮），调用 base 原语
- 多轮的 assistant/tool **追加到内存 buffer**（`in_memory_session_store` per-runId 桶），loop 结束丢弃
- tool 经 allowedTools 门控（toolDefinitions 复用主对话保缓存）
- 返回 answer + usage + stopReason

> **[v0.0.83.forked_per_run_isolation] per-run 隔离 + 回收**（第一性原则：每个旁路 run 是独立运行节点，必须有独立资源区域）：
> - **隔离**：旁路 in_memory buffer（`in_memory_session_store`）按 **runId** 分桶（caller 经 `StoreCallOpts.runId` 传入，sid + runId 是通用领域 id，`slot` 仅 in_memory impl 内部概念）。修前 v0.0.66 按 sid 分桶 → summary + consolidate sibling 同 sid 共享桶 → buffer 混合发 3 套矛盾指令。`buildRunDeps` 的 `wireInitState` ingest reminder+userMessage 时传 `{ runId }`；`loop-stage-context` 旁路分支的 ingest/assemble 同样传 `{ runId: spec.runId }`。
> - **回收**（防泄漏）：per-run buffer 桶在 `RunLoopHandle.start()` 的 **finally** 块释放（`clearScopeSession(scopeId, sid, { runId })` → `releaseSlot`）——单一 chokepoint，覆盖成功/抛错/中断三路径（`releasesScopeSession` 旗标 = `!isMain` 派生：旁路=true 释放 / main=false 不释放）。`RunLifecyclePort.onRunEnd/onInterrupted` 均 noop（release 移交 finally）。详见 `specs/tech/version_logs/v0.0.83.forked_per_run_isolation/change_plan.md`。

**不负责**：写 transcript、compact、state machine、consume inbox（这些是 eager-drain 的；forked 拿快照不消费队列）。

> **forked vs fork-session（future）**：forked = 内存旁路 loop（无持久化）；fork-session = 持久化复制一个 session（更简单，另议，本次不做）。

> 旧 ForkedAgent 策略类（v0.0.16-v0.0.39）和 ForkedLoop 内部执行单元的接口定义已归档于 `log.md` 版本史。v0.0.40 起由统一骨架 `runReActLoop(spec)` + `buildForkedDeps` 装配承担，见 §2 流程。

---

## 2. 消息驱动（快照 + 内存 buffer 多轮）

> **[v0.0.40] while 编排退役**：下列 `ForkedAgent.run → ForkedLoop.run` 的 `while` 编排迁入统一骨架 `runReActLoop(spec)`（见 `[P0]agent_loop_unified.md §2`），由 `buildForkedDeps` 装配 RunSpec（buffer 字段进 RunState + drainMode='none' + scopeId='forked' + noop lifecycle）。本节保留作**forked mode 特有不变量的契约源**（append-only 保缓存 / tool 双维度 / 无副作用边界）——这些不变量随 RunSpec 装配迁入骨架。**tool emit gap 已补**：forked 改走 `executeAndEmit`（统一 emit tool_result + obs span），不再是调研 §3.2⑤ 的现状不一致。
>
> **[v0.0.49] ContextPort 退役**：v0.0.40-0.0.48 forked 用 `ForkedContextPort`（prepare/recordAssistant/recordToolResults 直接 `buffer.push()`）——绕过 contextEngine 的死代码（buffer_sink/buffer_reader/append_passthrough impl 从未被触发）。v0.0.49 删 ForkedContextPort，骨架直调 `contextEngine.ingest/assemble('forked', state.buffer)`：ingest 由 `buffer_sink` impl append 到 buffer（chain 尾）；assemble 由 `buffer_reader` 贡献 transcript + `append_passthrough` reducer 原样返回 buffer（不 rebuild）。

旁路 run **不消费 inbox**，初始消息由快照组装，多轮追加在内存：

```
buildRunDeps 装配 RunSpec（旁路分支，profile 驱动；v0.0.204 单装配合并，无 buildForkedDeps）:
  // snapshot 由 caller 必填传入（生产三路径非空：自动 compact=main snapshot 深拷贝 /
  //   手动 compact=ContextEngine.compact 先 assemble 产 / consolidate=ctx.snapshot 复用），
  //   sideRun 入口（agent-side-run.ts）再 structuredClone 一次（双保险，见 §1 v0.0.80.t1 不变量 #5）。
  //   tools 来源 = snapshot.tools（与 main spec.toolDefinitions 同源，保 cache 前缀）。
  state.buffer = [snapshot.system, ...snapshot.messages, userMessage]
  const toolDefinitions = snapshot.tools
  spec.drainMode = 'none'; spec.scopeId = canonicalId（如 playground-rocky:parent:summary）
  spec.backgroundPath = true; spec.stopSequences = undefined; spec.eosStripper = undefined
  spec.lifecycle = RunLifecyclePort（profile 驱动单 impl——旁路 run：onRunEnd=noop /
    onUsage 对 forked 桶 early return（不逐调用累计，见 §5）/ onInterrupted=noop）

runReActLoop(spec) 内旁路路径（与 main 同骨架，差异由 profile.runShape 字段驱动）:
  emit run_start ⚡                          ← base 中断检查（emit 前），发到 groupKey=`session_id:<sid>_amt:<runKind>`
  while (!state.done):
    ⚡ iteration 边界中断检查（controller.aborted）
    // ① drain 跳过（drainMode='none'）；统一 assemble（side_run_builder 复用固定 parentSnapshot + in_memory 增量，implId v0.0.204 由 forked_builder rename）
    state.snapshot = await contextEngine.assemble(config, scopeId, state.parentSnapshot, { runId })
    ② LLM Request
       base.callLLM(modelId, state.buffer, tools=toolDefinitions, controller, emit?, backgroundPath: true) ⚡chunk 循环中断
       accumulate usage → lifecycle.onUsage → 旁路 early return（caller 按 run 结束总量累计，见 §5）
       assistantMsg = result.assistantMessage
       await contextEngine.ingest(config, [assistantMsg], scopeId, false, { runId })
         └─ chain: query_truncate → tool_result_truncate → store_sink（in_memory_session_store，按 runId 分桶）
    ②b tryCompact（骨架统一调；summary/consolidate scope reject_should_compact 恒 false 自动跳过，无 if 分支）
    ③ Tool Execution（若 LLM 产出 tool_call）
       toolCalls = extractToolCalls(assistantMsg)
       if (toolCalls.length === 0): state.done=true, stopReason="no_tool_call" → break
       if (state.rounds >= maxIter): state.done=true, stopReason="max_iterations" → break
       ⚡ if (controller.aborted) → break (stopReason="interrupted")
       toolResults = base.executeTools(toolCalls, allowedTools, controller, emit?) ⚡每个 tool step 前
       toolMsg = { role:'tool', content: toolResults }
       await contextEngine.ingest(config, [toolMsg], scopeId, false, { runId })   // store_sink（in_memory）
    ④ Exit Check → base.checkDoomLoop / checkMaxIter(state.rounds, maxIter)
  退出分流（§7）：
    中断 → lifecycle.onInterrupted=noop（buffer 随 RunState GC；旁路不走 abort 4 步）
    正常 → answer = extractFinalText(state.buffer)；return { answer, usage, stopReason, rounds }
    error → return stopReason="error"
  // per-run in_memory buffer 桶在 RunLoopHandle finally 块 clearScopeSession(scopeId, sid, { runId }) 回收
```

**缓存保证**：`state.buffer` 前缀（system + snapshot.messages + userMessage）整个 loop 不变，仅往后追加 assistant/tool（由 `buffer_sink` 在 chain 尾 append，骨架不动前缀）→ prompt cache 命中。**禁止**：修改 snapshot.messages / 改 toolDefinitions / compact（任一破坏前缀）。**v0.0.49 起前缀稳定性由骨架直调 contextEngine + buffer_sink impl append 保证**（不再依赖 ForkedContextPort 内的 buffer.push）。**[v0.0.82] tools 段前缀一致性**：toolDefinitions 改读 `snapshot.tools`（与 main spec.toolDefinitions 同源 = config.tools policy 裁剪后），不再读 opts.toolDefinitions（之前 forked 收 `defaultToolDefinitions(workdir)` registry 全集 24 vs main 20 分叉，破坏 anthropic prompt cache 前缀，cache_read_input_tokens 显著低于 main）。

---

## 3. tool 双维度（缓存契约 ↔ 行为契约）

| 维度 | 旁路取值 | 效果 |
|------|------------|------|
| `toolDefinitions` | **复用 snapshot.tools**（与 main spec.toolDefinitions 同源 = assemble 从 `config.tools` policy 裁剪后派生 definitions；profile `toolDefinitionsSource: host-snapshot` 钉死此契约） | 前缀一致（tools 段同源）→ 缓存命中 |
| `allowedTools` | **profile.toolBound**（runKind 粒度：summary=[] / consolidate=[skill_manage, memory_manage]） | 执行门控：不 allowed 的 tool_call → not-allowed result 喂回（多轮可自修正） |

> 对外声明不变（缓存）+ 对内执行受限（行为）。详见 base §3。eager-drain 的 allowedTools=全集；forked 用白名单收窄。
>
> **[v0.0.82] tools 字段来源迁移**：v0.0.82 前 forked 的 toolDefinitions 由 caller 经 `opts.toolDefinitions` 传 `defaultToolDefinitions(workdir)`（registry 全集 24），与 main 的 `spec.toolDefinitions`（config.tools policy 裁剪集 20）不同源 → wire body tools 段分叉 → anthropic prompt cache tools 段前缀对不齐 → cache_read 命中率掉（实测 SUMMARY/MEM_EXT cache_read ~0% pre-fix）。v0.0.82 起 `ContextSnapshot.tools` 字段恢复必填（见 `../context/[P0]context_snapshot_interface.md §2`），assemble 从 config.tools 派生写进 snapshot，buildForkedDeps 改读 `opts.snapshot.tools`，bootstrap forkedRunner/consolidationRunner 传 `toolDefinitions: []`（旧值被忽略，仅作占位）。修复后 cache_read_input_tokens：MAIN 56%、SUMMARY/MEM_EXT 93%（forked 命中 main 缓存）。

---

## 4. runKind（扁平闭合枚举两行）

`runKind` ∈ `summary | consolidate`（旁路两值；main 是主对话非旁路）。行为由 profile（toolBound / maxIterDefault / runShape）+ `userMessage` 决定：

| runKind | allowedTools（profile.toolBound） | maxIterDefault | userMessage | 典型 |
|----------|-------------|---------|-------------|------|
| `summary` | `[]`（NO_TOOLS） | 1（单次） | 压缩指令（纯 directive） | compact 第一类任务 |
| `consolidate` | `[skill_manage, memory_manage]` | 10（多轮） | 整理指令（纯 directive，v0.0.204 同契约） | memory/skill consolidation |

> runKind 同时决定 scopeId（canonicalId 纯拼接：`<biz>-<role>:<derivation>:<runKind>`）、groupKey（`session_id:<sid>_amt:<runKind>`）、agentRuns key（`${sid}_${runKind}`）——三处同一拼接源，无路由表。

---

## 5. 副作用（默认全关，profile 字段承载）

| 副作用 | 默认 | 开启方式 |
|--------|------|---------|
| 写 transcript | **关**（永不写持久 store，in_memory per-run buffer） | —（不可开，硬约束）。summary/consolidate scope 的 `session_store` EP 选 `in_memory_session_store`（消息缓冲按 runId 分桶，RunLoopHandle finally 回收），chain 尾 `store_sink` 写 in_memory |
| compact | **关**（永不触发） | —（不可开，硬约束）。骨架统一调 tryCompact，summary/consolidate scope `reject_should_compact` 恒 false → 谓词检查处 return（结构上不可能 compact）；`context_do_compact`/`context_post_compact` 选 noop impl defense-in-depth |
| state machine | **关**（不碰主 session 状态） | —（不可开；profile.runShape.touchesStateMachine=false） |
| consume inbox | **关**（拿快照） | —（不可开；profile.runShape.drainMode='none' → 骨架 ① drain 段跳过） |
| emit | **开**（profile.eventChannel.emitDefault=true） | `emit: false` 关闭；默认发送到独立 groupKey（§8） |
| accumulateUsage | **开（caller 总量口径）** | 旁路 run usage **由 caller 按 run 结束总量一次性累计** `accumulateUsage(sid, "forked", run总usage)`（summary 在 runCompact / consolidate 在 startConsolidation；store UsagePartition 桶名 "forked" 是 v0.0.204 决策保留——store 三分区桶 current/sub/forked 与 runKind 四值 main/summary/consolidate/sub 是 N:1 映射：summary/consolidate 同落 "forked" 桶）；`RunLifecyclePort.onUsage` 对 forked 桶 early return（不逐调用累计、不 notify——防双计；推送由下一轮 main assemble 的 notifyUsageChanged 携带）。**tier2 三 run 零累计**（公共全局整理不摊 session usage） |
| run 记录 | **关** | （profile.runShape.persistsRun=false；future option，当前不记录） |

> 对比 eager-drain：eager-drain 全开（eager_drain §7），forked 全关——这是「几乎不持久化」的精确边界。可选项（emit/usage）开在隔离维度，绝不触碰主 session 的 transcript/state/compact/inbox。

---

## 6. system 注入（D2.2 — 修 latent gap）

snapshot.system 作为 **role=system message prepend** 到 messages 前：

```
messages = [ snapshot.system, ...snapshot.messages, userMessage ]
```

- 协议层（`llm/protocol-encode.ts extractSystemText`）从 messages[] 按 `role:system` 抽取 → 落 anthropic top-level system 字段
- **不碰协议层 schema**（CanonicalRequest 无独立 system 字段），复用现有抽取机制
- 保证 forked 真正把 system 发给 LLM（v0.0.13 修复：此前 snapshot.system 未注入）

---

## 7. 中断（controller.aborted，无收尾）

forked 中断检查与 eager-drain 同模型：

```
isInterrupted = controller.aborted   // O(1) 内存布尔，单一检查点（§2 while 开头 + tool 前各检查一次）
```

- **D4**：旁路 run 被 abort → **直接退出，无收尾**（反正无副作用可收——in_memory buffer 丢弃即可）。`RunLifecyclePort.onInterrupted = noop`（profile 驱动，恒 noop），buffer 桶由 RunLoopHandle finally 回收。
- 不接主 session abort api 那套 half-data 收尾（那是为 eager-drain 主对话设计的）
- caller 不直接持有 controller。中断必经 `AgentManager.abort(sid, runId, runKind)`（runKind='summary'/'consolidate'），manager 校验 runId 后置 controller.aborted=true

---

## 8. emit（默认开，独立 groupKey）

- **默认 emit:true**（v2.0 变更，之前是 false）
- **groupKey** = `session_id:<sid>_amt:<runKind>`，`runKind` 取 `"summary" / "consolidate"`
- 产出的消息/tool 事件（base §7.2）发到独立 groupKey，主对话前端订阅 `session_id:<sid>_amt:main` 看不到
- 通过 `hub.sub("agent_loop", "session_id:<sid>_amt:summary")` 即可订阅旁路事件流
- caller 可传 `emit:false` 关闭（保留 option）

> 命名约定见 `[P0]agent_interface.md §4`。删除原 D5 设计决策（独立 emit group 已合并到默认行为）。

---

## 9. 当前用法 + future

**当前**：`ContextEngine.compact`（经 `summary_do_compact` → runCompact）与 `memory_skill_consolidation` handler 分别经 `manager.sideRun` 起旁路 run（runKind=summary / consolidate）：

```typescript
const run = await manager.sideRun({
  sessionId,
  runKind: "summary",            // 或 "consolidate"
  userMessage: { role: "user", content: [{ type: "text", text: directivePrompt }] },  // 纯 directive
  snapshot,                      // 必填（旁路核心，caller 深拷贝；tools 字段必填）
  emit: true,
  // allowedTools/maxIter/toolDefinitions 全由 profile 派生（sideRun 内部 buildRunDeps 读
  //   SessionTypePolicy：allowedTools=profile.toolBound、maxIter=profile.maxIterDefault、
  //   toolDefinitions=snapshot.tools），caller 不传。
  // 不传 abortSignal —— AgentManager 创建 controller 并注入；caller 中断走 manager.abort(sid, run.runId, runKind)
});
const result = await run.promise;
// summary caller runCompact 随后 setSummary(result.answer) +
//   accumulateUsage(sid, "forked", result.usage)（caller 总量口径，见 §5）；
// consolidate caller startConsolidation 在 runner 返回后同样总量累计。
```

**future**：
- fork-session（持久化复制 session，比旁路 run 简单，另议）

> **tier2 三 run（天级公共整理）也走 sideRun**：consolidation-tier2 的 session-memory/global-memory/global-skill 三 caller 构造的 SessionConfig **无 kind**（旁路整理 run 不属任何业务会话类型）——`executeSideRun` 兜底 `playground-rocky:parent` + runKind='consolidate'（对应 consolidate profile toolBound=[skill_manage,memory_manage]，与 tier2 snapshot.tools 交集正确）。tier2 run usage **零累计**（公共全局整理不摊 session usage，见 §5）。

---

## 10. not-allowed 文案

工具不在 `allowedTools` 时的 result 文案（base.executeTools 门控产出）：

```
"工具 '<name>' 在当前会话不允许调用，请仔细阅读任务说明，不要再次尝试调用该工具"
```

> 同 `[P0]agent_loop_base.md §2.2`。多轮 loop 下 LLM 下一轮看到 not-allowed 结果，可自我修正换思路。

---

## 11. （版本史见 `log.md`）
