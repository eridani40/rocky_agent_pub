---
type: spec
title: Agent Loop — Eager-Drain Mode（current 不变量契约源）
priority: P0
status: active
updated: 2026-08-04
since: v0.0.8
---

# Agent Loop — Eager-Drain Mode（current 不变量契约源）

> **[v0.0.40] 类退役 / 不变量保留**：`EagerDrainAgent` 策略类 + `AgentLoop` 内部执行单元 + `while` 编排**退役**（迁入统一骨架 `runReActLoop(spec)` + `buildMainDeps`，见 `[P0]agent_loop_unified.md`）。本文保留作 **current mode 特有不变量的契约源**：store 游标、cancel 配对、五态机 CAS、副作用策略表——这些不变量随 deps 装配迁入骨架，coder 实现时仍须遵守。下文章节中「EagerDrainAgent / AgentLoop 类」描述是**v0.0.40 前的现状**，理解为「`buildMainDeps` 装配出的 current deps 行为契约」即可。

> 定位：main runKind（主对话）的 ReAct 执行。v0.0.40 前由 **EagerDrainAgent**（策略类）+ **AgentLoop**（内部执行单元）承担；v0.0.40 后由统一骨架 + main deps 装配承担，行为契约不变。
> 参见：[P0]agent_interface.md（单 run 契约）、[P0]agent_loop_unified.md（统一骨架 + RunLifecyclePort 单 port，**v0.0.40 权威**）、[P0]agent_manager.md（门面调度）、[P0]agent_loop_base.md（机制原语）、[P0]agent_loop_side_run.md（旁路 run 不变量）、[P0]agent_interrupt.md（中断收尾）、[P0]agent_inbox_enqueue.md（cancel 入队）

---

## 1. 定位

current mode 的行为由 `buildMainDeps` 装配 RunSpec + `runReActLoop` 统一骨架承担（v0.0.40 前由 EagerDrainAgent 策略类承担）。所有 session 级状态外移到 AgentManager 统一持有。

**职责边界**：

| 组件 | 职责 |
|------|------|
| **buildMainDeps** | 装配 current RunSpec（scopeId=default, drainMode='eager', maxIter=config.maxIterations??25）+ LoopHandle。 |
| **runReActLoop** | 统一骨架，执行 ReAct 循环（drain → LLM → tool → exit check），current/forked 共用。 |
| **AgentManager** | 门面 + 状态持有者：enqueue/cancel 写 inbox；activate 路由到 buildMainDeps→run(spec,loop)；abort 做校验 + 置 aborted + 4 步收尾。 |

**不负责**：消息入队（AgentManager.enqueue）、事件订阅（AgentManager.subscribe）、session 生命周期、**收尾**（被中断/error 时 loop 不收尾，abort api 接管，见 §7 + agent_interrupt §1）。

> 旧 EagerDrainAgent 策略类（v0.0.16-v0.0.39）和 AgentLoop 内部执行单元的接口定义已归档于 `log.md` 版本史。v0.0.40 起由统一骨架 `runReActLoop(spec)` + `buildMainDeps` 装配承担，见 `[P0]agent_loop_unified.md`。

---

## 2. emit groupKey

所有 bus.emit 调用使用统一的 groupKey：

```
groupKey = `session_id:${sid}_amt:current`
```

> 不再使用裸 `session_id:${sid}`。`amt` = agent mode type，命名约定见 `[P0]agent_interface.md §4`。消费者经 AgentManager.subscribe(sid, "current") 订阅，内部转 `hub.sub("agent_loop", "session_id:<sid>_amt:current")`。

### 2.1 各阶段产出事件

| 阶段 | 事件 | 说明 |
|------|------|------|
| run 开始 | `run_start` | loop 启动一次 |
| enqueue 时刻 | `message_enqueued` | AgentManager 发，run 之外 |
| ① drain | `enqueued_message_processed` / `enqueued_message_canceled` | 含 enqueueId + messageId；cancel 作废带 cancelFor |
| LLM 流式 | `message_start` → `text_block_*` / `reasoning_block_*` / `tool_call_*` → `usage_block` → `message_end` | callLLM 产出（base） |
| 工具执行 | `tool_result_start` → `tool_result_delta*` → `tool_result_end` | executeTools 产出（base） |
| run 结束 | `run_end` | 正常/error 退出（中断走 AgentManager emit run_stop） |

> 原则：所有处理过的消息都 emit；**去重是消费端职责**。

---

## 3. 消息驱动（inbox drain）

eager-drain 模式下，`allowContinuousInboxRead = true`——每次 iteration 的 ① 都 drain inbox，用户可在 tool 执行中途插话。整轮 run 内 inbox 可被多次读取。

```
start():
  runLoop(allowContinuousInboxRead: true)   // 单 runLoop，每轮 ① 都可读
```

> 另一种模式 lazy-drain（`allowContinuousInboxRead: false`，外层 while 驱动，每个 run 仅首轮 drain）见 `[P2]agent_loop_lazy_drain.md`，本 spec 不展开。

### 3.1 cancel 配对（v0.0.12，BUG-002 修复）+ drain 全量 emit SSE（v0.0.58.cron-fix）

drain 同批读到的 message+cancel（同 enqueueId）一次性判定，无需加锁（inbox 已被 drain 清空）：

```
① drain 本批所有 entry（message + cancel）
  扫 cancel 条目 → 建 cancelSet = { cancelFor 集合 }
  逐条处理 message：
    message.enqueueId ∈ cancelSet → 作废：不生成 messageId / 不 ingest / 不 emit processed
                                  + emit enqueued_message_canceled(enqueueId)
    否则 → 正常 processed（[v0.0.161] user/agent/system/approval 四分支统一，全部 reissue）：
      → 重新生成 messageId=ulid() → emit message_* + emit enqueued_message_processed(enqueueId, newId, role) → ingest（用新 id）
  cancel 条目本身：判定后丢弃（不进任何 store、不 emit）
幂等：cancel 找不到配对 message（已 processed / 重复 cancel）→ 直接丢弃，无事件
```

> **[v0.0.161] user 分支同轨对称化**：早前实现 user query 分支保留 entry.message.id（HTTP-in 时刻分配的 throwaway id），仅 agent/system/approval reissue → user msgId 锚在 HTTP-in 时钟，其他消息 msgId 锚在 drain 时钟 → transcript 按 id 升序时 user msg 位置错乱到「过去」→ context assemble 按 id 切割时被永久漏掉。v0.0.161 修：user 分支同样 reissue newId=ulid()，从源头保「msgId 顺序 = drain 处理顺序」。契约细节见 `[P0]agent_inbox_enqueue.md §6.4 msgId 分配契约（I1/I2/I3）`。

> **[v0.0.58.cron-fix] drain 全量 emit SSE 原则（离线/在线统一）**
>
> 上述「正常 processed」分支中，**user query 与 enqueued（system/agent/approval source）都 emit `message_*`**（message_start + text_block_start/delta/end + message_end）。
>
> 之前实现仅 user-source 走 `emitUserMessageBlocks`，system/agent/approval 只 emit `enqueued_message_processed`，导致 system-source message（cron / heartbeat tick / a2a 等）入主对话 store（GET /messages 能看到）但 SSE 实时看不到 → 重新进入 session 才发现这些消息，**离线/在线不一致**。
>
> 设计原则（用户确认）：
> 1. **后端 SSE 发的 = store 存的**（源头统一）：drain 的所有 message 都 emit，sender 语义不能为「让前端看到」而伪装（早前曾把 cron 的 `sender.source` 改 'user' 绕过分流，已回退——违反语义保留）。
> 2. **前端可以选择不展示**：filter 在 `message-flatten.ts` 控制（system_reminder 已是此模式：后端发、前端 `DEFAULT_BLOCK_FILTER` 滤）。
> 3. **SSE 和 GET 逻辑要统一**：前端 SSE 收到的 message 和 GET /messages 返回的 message 走**同一 flatten filter** → 离线展示 = 在线展示。
>
> 实现：`drainAndPartition` 返回 `DrainResult.systemMessages: Message[]`（rewritten id，与 newMessages/processed 同 id），`emitDrainResult` 对 userMessages + systemMessages 都调 `emitUserMessageBlocks`（名字历史，实际支持任意 role）。

详见 `[P0]agent_inbox_enqueue.md`。

---

## 4. 循环结构（①②③④ — base 原语 + eager-drain 驱动/副作用）

> **[v0.0.40] while 编排退役**：下列 `AgentLoop.start() → runLoop` 的 `while` 编排迁入统一骨架 `runReActLoop(spec)`（见 `[P0]agent_loop_unified.md §2`），由 `buildMainDeps` 装配 RunSpec。**v0.0.49 ContextPort 退役**：`MainContextPort` 整删，骨架直调 `contextEngine.ingest/assemble('default')` + drain inbox（drainMode='eager'）+ base.callLLM（无 callLLMForMain 包装，EOS stop seq / filterToolDefinitions 已在装配阶段进 spec.toolDefinitions / spec.stopSequences）；FinalizePort 并入 LifecyclePort（三 hook onUsage/onRunEnd/onInterrupted）。本节保留作**current mode 特有不变量的契约源**（store 游标 / cancel 配对 / 五态机 CAS / 副作用策略表）——这些不变量随 RunSpec 装配迁入骨架，不在骨架层面重新定义。

```
buildMainDeps 装配 RunSpec:
  spec.scopeId = 'default'; spec.drainMode = 'eager'; spec.backgroundPath = false
  spec.toolDefinitions = filterToolDefinitionsBySessionType(config.tools, sessionType)  // 装配阶段一次性过滤
  spec.stopSequences = sessionType === 'squad' ? [EOS_STOP_TOKEN] : undefined
  spec.eosStripper = sessionType === 'squad' ? stripEosToken : undefined
  spec.lifecycle = MainLifecyclePort（onUsage→accumulate('current')+notify / onRunEnd=persistRun+markIdle/markError / onInterrupted=noop；subagent main run 另装配 replySettle 回报兜底，见 `[P0]agent_loop_unified.md §3.2`）

runReActLoop(spec)（drainMode='eager' 路径）:
  构建 LoopState（step=0, done=false, snapshot=initial, ingestUpTo/llmUpTo=初始游标；base §4 + 本 mode 扩展）—— 控制循环与状态
  emit run_start ⚡                          ← base 中断检查（emit 前）
  while (!state.done):
    ⚡ iteration 边界中断检查
    ① Pre-Process（eager-drain 驱动，§3）
       drain inbox + cancel 配对（每轮都 drain，eager 模式核心）
       contextEngine.ingest(未被作废的, 'default', undefined, false, undefined)（推进 ingestUpTo）⚡ingest 前检查
       state.snapshot = contextEngine.assemble(config, 'default', undefined, state.snapshot)（v0.0.52 P0-1 透传 prevSnapshot → base_builder append 分支激活）
    ② LLM Request（准入：ingestUpTo != llmUpTo）
       不准入 → break（no_new_messages）
       准入 → base.callLLM(snapshot.messages, tools=spec.toolDefinitions, controller, stop: spec.stopSequences, backgroundPath: false) ⚡chunk 循环中断（无 callLLMForMain 包装，骨架直调）
            → if (spec.eosStripper) spec.eosStripper(assistant.content)   // squad session EOS strip
            → accumulateUsage(sid, "current", usage) via lifecycle.onUsage   ← v0.0.14 激活
            → contextEngine.ingest([assistantMsg], 'default') → assemble ⚡ingest 前检查
            → tryCompact(pluginManager, ctx)（骨架统一调；default scope threshold_should_compact/summary_do_compact 触发）  ← eager-drain 独有
    ③ Tool Execution
       → base.executeTools(toolCalls, allowedTools=全集, controller) ⚡每个 tool step 前
       → contextEngine.ingest([toolResults], 'default') → assemble（推进 ingestUpTo）
    ④ Exit Check → base.checkDoomLoop / checkMaxIter
  退出分流（§7）：
    中断 → 直接 return，不收尾（lifecycle.onInterrupted 默认 noop，abort api 4 步接管；subagent main run 例外——开回报兜底代发旁路，transcript 收尾仍归 abort api）
    正常 → lifecycle.onRunEnd=persistRun + emit run_end + stateMachine.markIdle(CAS)
    error → emit run_end(error) + markError(CAS)
```

> ⚡ = 中断检查点（单条件 `controller.aborted`，§7）。base.callLLM/executeTools 内部每条 emit 前已检查 controller.aborted；本循环在 iteration/ingest/compact 边界补检查。

---

## 5. 副作用策略（eager-drain 独有，forked 默认全关）

| 副作用 | 何时 | 落点 |
|--------|------|------|
| ingest 写 transcript | ①/②/③ 每批消息 | session store（推进游标） |
| compact | ② 后 remainingTokens<0 | contextEngine.compact → store.setSummary |
| accumulateUsage | ② 每次 LLM 调用 | store.accumulateUsage(sid, "current", usage)（v0.0.14） |
| run 记录 | run 起/止 | store.createRun / updateRun（status/stopReason/usage） |
| state machine | run_end | markIdle(CAS) / markError(CAS)（session 五态机） |
| emit | 全程 | bus.emit → groupKey（§2） |

> forked 的同名维度全部默认关闭（option 开），见 forked spec。

---

## 6. store 游标

```
SessionStore 消息序列: [1][2][3][4][5][6][7]
                              ↑           ↑
                          llmUpTo     ingestUpTo
```

- 不变量：`llmUpTo ≤ ingestUpTo`（发给 LLM 的必已 ingest）
- 准入条件：`ingestUpTo != llmUpTo` → 有新消息，调 LLM；相等 → loop 结束（no_new_messages）
- `summaryUpTo`（compact 进度）归 ContextSnapshot，loop 不直接操作

> RunState 共享字段（step/done/stopReason/snapshot/lastAssistantContent）见 base §4；eager-drain 扩展 `ingestUpTo / llmUpTo`。

---

## 7. 中断（单条件 + abort api 收尾）

eager-drain 的中断判定 = `controller.aborted`（单一内存检查，agent_interrupt §2）：

```
isInterrupted = controller.aborted  // O(1) 内存读，abort() step1 置 true
```

> 旧模型三条件（`signal.aborted OR state∈{interrupting,interrupted} OR currentRunId≠self`）简化为单一 `controller.aborted`。runId 守门由 `AgentManager.abort()` 单点校验 `controller.runId === runId` 承担；持久化 state 不再被 loop 读。

- **abort 生效点**：每个副作用边界（iteration / emit 前 / ingest 前 / tool step 前 / LLM fetch 注入 signal）高频检查
- **退出分流**：
  - 被中断 → **不收尾**（不 persistRun / 不 emit run_end / 不写 state / 不 clearReplay）——abort api 接管（step2 重组 partial + 补 interrupted tool_result → step3 clearReplay → step4 emit run_stop(interrupted) + state=interrupted）
  - 正常退出 → persistRun + emit run_end(stopReason) + markIdle(CAS)
  - 自身 error → emit run_end(error) + markError(CAS)
- half-data 收尾三场景、message id 顺序硬约束见 agent_interrupt §4

---

## 8. （版本史见 `log.md`）