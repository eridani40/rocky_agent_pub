---
type: spec
title: Agent Loop — Unified Skeleton（统一 ReAct 骨架）
priority: P0
status: active
updated: 2026-08-04
since: v0.0.40
---

# Agent Loop — Unified Skeleton

统一骨架 `runReActLoop(spec)`：v0.0.40 起 eager/forked 共用一份；v0.0.49 进一步瘦身（删 ContextPort / FinalizePort / callLLMForMain / callLLMForForked，骨架直调 `contextEngine.ingest/assemble(scopeId, buffer)` + `base.callLLM`）；**v0.0.204 起 mode 差异由 `RunSpec.runKind`（扁平闭合枚举 main/summary/consolidate）+ profile.runShape 字段单源驱动**——骨架守护测试断言不含 `if.*main` / `if.*forked` 字面字符串，骨架代码也不含 `if.*summary` / `if.*consolidate`（差异靠 profile + RunSpec 字段，非骨架分支）。本文按 4 条线讲清楚这个设计。

参见：单 run 入口 → `[P0]agent_interface.md`；机制原语 → `[P0]agent_loop_base.md`；mode 不变量 → `[P0]agent_loop_eager_drain.md`（main 不变量）/ `[P0]agent_loop_side_run.md`（旁路 run 不变量）；scope 路由 → `[P0]agent_scope_router.md`（v0.0.204 已废止，scopeId=canonicalId 纯拼接）。

---

## 1. 主循环：阶段与退出

这条线讲骨架每轮做什么、什么时候退出。

**4 个阶段**（每轮迭代顺序执行）：

1. **Init**（仅首轮）：`initState(spec)` 构建 LoopStateBase + runKind 扩展（cursor for main / buffer for 旁路）；emit `run_start`；dev-log 写 `mode: spec.runKind`（v0.0.204 起，原 `mode: spec.wireStore ? 'main' : 'forked'` 字面已删）。
2. **Prepare**：drain inbox（main）或跳过（旁路，drainMode='none'）→ `contextEngine.ingest` 新消息 → `contextEngine.assemble` 拼装 snapshot。准入失败（无新消息 / snapshot 为空）→ 退出。
3. **LLM 调用 + ingest**：`base.callLLM`（RunSpec 字段透传 backgroundPath/stop/eosStripper）→ ingest assistant → `onUsage` → fire-and-forget `tryCompact`。
4. **Tool 执行 + ingest**：`extractToolCalls` → 无 tool call 则退出 / 有则 `executeTools` → ingest tool_result → doomLoop 检查 → step++ → maxIter 检查。

**退出条件全集**（7 种 stopReason）：

| stopReason | 触发点 |
|---|---|
| `no_tool_call` | LLM 回复无 tool_use（main 额外 peek inbox 有未消费则 continue） |
| `no_new_messages` | Prepare 准入失败（drain 无新消息 / snapshot 空） |
| `max_iterations` | step++ 后超限 |
| `doom_loop` | 连续重复 tool 签名 |
| `error` | 不可恢复异常 |
| `tool_pending` | 工具需人工审批（HITL） |
| `interrupted` | controller.aborted |

**退出分流**：interrupted → `lifecycle.onInterrupted` + 返回空 answer；normal → `lifecycle.onRunEnd` + emit `run_end` + 返回 finalText。

**精简伪代码**：

```
runReActLoop(spec):
  state = initState(spec); emit(run_start)
  while !done:
    if controller.aborted → interrupted; break
    // Prepare
    if drainMode=='eager': drain → ingest(newMsgs, scopeId, buffer)
    snapshot = assemble(scopeId, buffer, prevSnapshot)
    if 准入失败 → stopReason=no_new_messages; break
    // LLM
    {assistant, usage} = base.callLLM({messages, tools, backgroundPath, stop, ...})
    eosStripper?.(assistant); ingest([assistant], scopeId, buffer)
    lifecycle.onUsage(usage); void tryCompact(spec, state)
    if controller.aborted → interrupted; break
    // Tools
    toolCalls = extractToolCalls(assistant)
    if empty → (peek inbox? continue : no_tool_call; break)
    results = executeTools(toolCalls, allowedTools, controller)
    ingest([toolMsg], scopeId, buffer)
    if doomLoop → break;  step++
    if maxIter → break
  // 退出分流
  interrupted ? lifecycle.onInterrupted(state) : lifecycle.onRunEnd(state) + emit(run_end)
```

**v0.0.130.hang 不变量**：max_iterations 判定在轮次边界（step++ 之后）——一轮 = LLM → 工具执行 → result 落盘，凡落盘 tool_use 必有配对 tool_result（消灭 dangling 半轮）。

---

## 2. Context 交互：消息从哪来、往哪去

这条线讲骨架与 contextEngine 的交互——Prepare 阶段读、Record 阶段写、compact 判定。差异由 scopeId（v0.0.204 起 = canonicalId 纯拼接，如 `playground-rocky:parent:main` / `:summary` / `:consolidate`）路由到对应 impl 链。

**Prepare 阶段（读）**：
- main：drain inbox 取新消息 → `contextEngine.ingest(config, newMsgs, mainScopeId, false)` → `contextEngine.assemble(config, mainScopeId)` 走 main scope impl 链（store_reader + 多源拼装）。
- 旁路 run（summary/consolidate）：drainMode='none' 跳过 drain → `contextEngine.assemble(config, sideScopeId, parentSnapshot, { runId })` 走旁路 scope impl 链（`transcript_reader` + `side_run_builder`，复用固定 parentSnapshot + summaryUpTo 后 in_memory 增量 upsert）。

**Record 阶段（写）**：
- 骨架统一调 `contextEngine.ingest(config, [msg], scopeId, false, { runId })`。
- main（scopeId=main canonical）：走 main chain 尾 `store_sink` 写 transcript store。
- 旁路 run（scopeId=summary/consolidate canonical）：走旁路 chain 尾 `store_sink` append 到 `in_memory_session_store`（per-runId 桶）。

**compact 判定**：
- 骨架在 recordAssistant 后统一调 `tryCompact`（fire-and-forget，不 await）。
- main scope：激活 `threshold_should_compact` + `summary_do_compact`（达阈值则压缩）。
- summary/consolidate scope：激活 `reject_should_compact`（恒 false）→ 结构上不可能递归 compact。

**设计决策——为什么骨架直调 contextEngine**：v0.0.40 曾抽 ContextPort 做源/汇/组装的抽象层，但 v0.0.40-0.0.48 期间 forked 的 `ForkedContextPort` 直接 `buffer.push()` 绕过 contextEngine，导致旁路 impl 链（buffer_sink/buffer_reader/append_passthrough）从未被触发——死代码。v0.0.49 删 ContextPort，骨架直调 contextEngine，impl 链终于被真正激活。不这样做的后果：中间层给「绕过」留了口子，spec 声明走 impl 链但代码静默绕过，ext 扩展点形同虚设。

---

## 3. runKind 差异：RunSpec 字段 + RunLifecyclePort + emit（profile.runShape 单源驱动）

这条线讲 main 与旁路 run（summary/consolidate）的差异如何表达——不靠骨架 if/else 分支，靠 profile.runShape 字段 + RunSpec 注入字段。

**设计决策**：v0.0.40 初始用 4 port（Context / Lifecycle / Finalize / emit）；v0.0.49 删 ContextPort + FinalizePort（骨架直调 contextEngine；中断收尾 main=noop / 旁路=GC 不需要抽象），差异收敛为 RunSpec 字段 + LifecyclePort + emit。v0.0.204 进一步合并：① `buildMainDeps` + `buildForkedDeps` → 单 `buildRunDeps(opts)`（profile 驱动 RunSpec 装配）；② `MainLifecyclePort` + `ForkedLifecyclePort` → 单 `RunLifecyclePort`（按 profile.runShape 字段分派）；③ `RunKind` 扁平闭合枚举（main/summary/consolidate）替代 modeKey 自由 string；④ modeKey→scopeId 路由层（AgentScopeRouter）整体删除，scopeId=canonicalId 纯拼接。

骨架守护测试断言 `run-react-loop.ts` 不含 `if.*main` / `if.*forked` 字面字符串（也不含 `if.*summary` / `if.*consolidate`——差异全靠 RunSpec 字段注入）。

**RunSpec 差异字段表**（profile.runShape 单源驱动，buildRunDeps 装配写入）：

| 字段 | main（profile=*.main） | summary（profile=*.summary） | consolidate（profile=*.consolidate） | 作用 |
|---|---|---|---|---|
| scopeId | canonicalId（:main 段） | canonicalId（:summary 段） | canonicalId（:consolidate 段） | contextEngine impl 链路由（v0.0.204 纯拼接，零路由表） |
| parentSnapshot | `null` | caller 传入 snapshot（必填） | caller 传入 snapshot（必填） | 旁路 run 复用固定 parent（保 cache 前缀） |
| drainMode | `'eager'` | `'none'` | `'none'` | 是否 drain inbox |
| backgroundPath | `false` | `true` | `true` | overload 直接 fail 不重试 |
| stopSequences | config.stop（squad 才有） | `undefined` | `undefined` | EOS 停止符 |
| eosStripper | config.eos（squad 才有） | `undefined` | `undefined` | 剥离 EOS token |
| maxIter | profile.maxIterDefault ?? 25 | profile.maxIterDefault（=1，单次） | profile.maxIterDefault（=10，多轮） | 迭代上限 |
| allowedTools | profile.toolBound | profile.toolBound（=[]，零工具） | profile.toolBound（=[skill_manage,memory_manage]） | 执行门控 |
| toolDefinitions | config.tools 派生（policy 裁剪） | snapshot.tools | snapshot.tools | 与 main 同源保 cache 前缀（v0.0.82） |

**RunLifecyclePort**（唯一保留的 port，profile.runShape 单 impl 按 runKind 字段分派）：

| hook | main | summary / consolidate |
|---|---|---|
| onRunEnd | persistRun + markIdle/markError(CAS)；**其后追加回报兜底**（仅装配 replySettle 的 subagent main run：tool_pending→stash 未决请求不代发，其余 reason→`settleAgentReplyFallback` 系统代发，见下「replySettle 装配」） | noop |
| onUsage | accumulate(sid, "current", u) + notify | accumulate(sid, "forked", u) early return / noop（caller 按 run 结束总量累计，见 `agent_loop_side_run.md §5`） |
| onInterrupted | 默认 noop（abort api 4 步接管）；**装配 replySettle 的 subagent main run 开「代发旁路」**（interrupted→结局通知；transcript 收尾/emit 仍归 abort api 4 步，本 hook 不碰） | noop（buffer 随 RunState GC + RunLoopHandle finally 回收 in_memory 桶） |

> **store UsagePartition 桶名说明**：v0.0.204 起 runKind 四值（main/summary/consolidate/sub）但 store UsagePartition 仍是三分区桶（current/sub/forked）。mapUsagePartition 映射：main→current / sub→sub / summary+consolidate→forked（同桶）。store 桶名保留是 v0.0.204 决策（不破坏持久化数据），未来 spec 升级再扩 UsagePartition 类型。

**replySettle 装配（async subagent 回报兜底）**：`buildRunDeps` 仅对 `isMain && kind.isSubagent`（且 manager 经 `activate` 注入 `a2aReplyTracker`/`deliverToFn` 两窄口；旁路 `executeSideRun` 不注入）装配 `replySettle = { deliverTo, tracker, baseline: tracker.deliveryEpoch(), carried: tracker.takePending(sid) }`——baseline 在装配点快照（本 run 的投递 mark 全部晚于它），carried 取出上一 run tool_pending stash 的跨 run 未决请求（take 即清）。顶层/squad/旁路 run 不装配 → 全链路 noop（deps 缺省，旧行为不变）。**结算对象** = `state.agentReplyRequests`：`drainAndPartition` 对本 run drain 批里 `sender.source='agent' && needReply=true` 的消息收集 `{messageId: drain reissue 后新 id, fromSessionId}`（reissue id 让代发的 inReplyTo 指得回 transcript 真身），`prepareStage` 跨多轮 drain 只增不判地累积入 LoopState。**onRunEnd 分派**（persistRun/CAS 之后）：`tool_pending` → `tracker.stashPending(sid, [...carried, ...state.agentReplyRequests])`（非空才 stash）；其余 reason → `settleAgentReplyFallback(state, deps, reason)`（carried+state 合并、按 sender 去重取最新 M.id → 判据 A `hasDeliverySince` 已履约跳过 → 以 child 身份代发，成功=final text / 失败=结局通知，needReply=false）；settle 异常 catch 吞掉不阻断收尾主链。机制语义权威（判据 A / needReply=false / 代发内容契约）见 `../../multi_agent/[P1]a2a_protocol.md §4.2`「系统代发兜底」。

**emit**：main → bus groupKey `session_id:<sid>_amt:main`（额外发 enqueue 级事件）；summary/consolidate → `session_id:<sid>_amt:<runKind>` 或 noop（`emit:false` 时）。emit 是普通闭包注入，不进 PluginManager EP（热路径 + runKind 内聚策略，不需运行时可配）。

**装配入口**：单 `buildRunDeps(opts)`（build-run-deps.ts，v0.0.204 合并原 buildMainDeps/buildForkedDeps 二元分裂）——profile 驱动 RunSpec 装配（runShape/lifecycleHooks/eventChannel/toolDefinitionsSource 全字段驱动），把上表字段 + RunLifecyclePort 单 impl + emit 闭包组装成 RunSpec，传入骨架。

---

## 4. 中断与生命周期

这条线讲 run 如何被中断、中断后谁收尾、正常退出谁持久化。

**中断模型**：`controller.aborted` 单一布尔位（外部 abort api 设置）。骨架在 iteration 边界 + LLM 调用后两处检查。v0.0.130.hang 增加 run 级子进程 sweep：`childRegistry.killAll()` 确保工具子进程不泄漏。

**中断退出**：
- main：`RunLifecyclePort.onInterrupted` 默认 noop——收尾由 abort api 4 步接管（half-data 补全 + clearReplay + emit run_stop + markIdle），骨架不重复做。**唯一例外** = 装配 replySettle 的 subagent main run：此 hook 开「系统代发回报」旁路（interrupted→结局通知，见 §3.2），仍不做 transcript 收尾/emit。
- 旁路 run：noop。in_memory buffer 桶由 RunLoopHandle finally 块 `clearScopeSession(scopeId, sid, { runId })` 回收，无持久化副作用可收。

**正常退出**：
- main：`onRunEnd` = persistRun（写 run 记录）+ markIdle/markError（五态机 CAS 转换）+ emit `run_end`；装配 replySettle 的 subagent main run 在 persistRun/CAS 后追加回报兜底（tool_pending 只 stash 不代发，其余 reason 系统代发，见 §3.2）。
- 旁路 run：noop（旁路无持久化，不碰 session state；caller 拿 result 自行处理，如 summary caller 调 setSummary）。

**usage 分区隔离**：`onUsage` 按 store 桶标签（"current" / "forked"）分别累计，互不干扰。五态机 + 幂等是 main 专属——markRunning 在 manager.activate 入口（CAS），旁路 run 不碰 session state。

---

## 与其他 spec 的关系

| 文档 | 关系 |
|---|---|
| `[P0]agent_loop_base.md` | 单轮原语（callLLM / executeTools / 中断检查 / StopReason 全集），骨架复用 |
| `[P0]agent_loop_eager_drain.md` | main 特有不变量（store 游标 / cancel 配对 / 五态机 CAS） |
| `[P0]agent_loop_side_run.md` | 旁路 run 特有不变量（append-only / tool 双维度 / prompt cache 前缀不动 / snapshot 双 clone） |

版本史见 `log.md`。
