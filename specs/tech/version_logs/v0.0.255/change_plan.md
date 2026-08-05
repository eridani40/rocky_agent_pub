# v0.0.255 变更计划书 — async subagent 回报兜底（系统代发）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 设计总述（锁定机制，来自 req.md 调研结论）

run 结束（onRunEnd / onInterrupted）且 `stopReason ≠ tool_pending` 时，对本 run drain 到的 `source='agent' && needReply=true` 消息集合：按发送方去重，若本 run 内 child 未向该 sender deliverTo 过（判据 A = target 判据，只查出站投递追踪，**不翻 transcript、不对账 inReplyTo**）→ 系统以 child 身份代发一条回报：

- 成功（`no_tool_call` / `no_new_messages`）→ 代发 final text（复用 `getFinalAnswerFromStore`；取不到 text 退化为结局通知）。
- 失败/中断（`error` / `interrupted` / `doom_loop` / `max_iterations`）→ 代发结局通知（stopReason + 一句原因，`needReply=false` 防回话风暴，`inReplyTo` 指回该 sender 最新 M.id）。
- `tool_pending`（HITL 悬挂）→ 不代发，未决请求 **stash 跨 run 携带**，续跑出真结果那轮才结算。

**出站投递追踪数据源设计（判据 A 的可机读根基）**：`AgentManagerImpl` 持一个进程内 `A2aReplyTracker`（`Map<fromSid, Map<toSid, seq>>` 最新投递序号 + 全局单调 epoch）；`deliverTo` 成功投递后按 message 自身 `sender.agent.ref.sessionId → targetSid` 记一条 mark；child run 装配时（buildRunDeps）快照 baseline epoch，`onRunEnd` 用 `hasDeliverySince(childSid, parentSid, baseline)` 判定本 run 有无履约——零 transcript 扫描、零 LLM 语义依赖。tracker 同时持 `Map<childSid, AgentReplyRequest[]>` 做 tool_pending 未决请求的跨 run stash/take（内存态，与 children tracker 同级先例：非持久，崩溃靠后续 run 自然重建）。

**履约判定边界**：仅 `main && derivation='subagent'` 的 run 装配 replySettle（forked 旁路 / 顶层 / squad 角色不装配，自然 noop）；代发只对 drain 批里实际出现的 sender（实践中=parent）。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| multi_agent | app/server/src/agent/a2a-reply-tracker.ts | `class A2aReplyTracker` | 新增 | 进程内 a2a 履约追踪器：双向 Map 存「from→to 最新投递 seq」+ 全局单调 epoch 计数器 + `Map<childSid, AgentReplyRequest[]>` 未决携带桶 | MUST 内存态不持久化（对齐 children tracker 先例）；MUST NOT 读写 store | req.md 判据 A；本文件「设计总述」 | +70（新文件） |
| multi_agent | app/server/src/agent/a2a-reply-tracker.ts | `markDelivery(fromSid, toSid)` | 新增 | `++epoch` 并记录 from→to 最新 seq | MUST 仅由 deliverTo 成功投递后调用（deliver 失败不算履约） | req.md 判据 A | （含上行） |
| multi_agent | app/server/src/agent/a2a-reply-tracker.ts | `deliveryEpoch()` / `hasDeliverySince(fromSid, toSid, sinceEpoch)` | 新增 | epoch 快照读取 + 「since 之后 from→to 有无投递」是/否判定 | MUST 纯函数式读，无副作用；无记录返 false | req.md 判据 A | （含上行） |
| multi_agent | app/server/src/agent/a2a-reply-tracker.ts | `stashPending(childSid, reqs)` / `takePending(childSid)` | 新增 | tool_pending 未决 needReply 请求的跨 run 存取（take=读+清） | MUST take 即清空（防双 run 重复结算）；reqs 为空 MUST 不写桶 | req.md「HITL 悬挂不回复，续跑那轮才结算」 | （含上行） |
| multi_agent | app/server/src/agent/subagent-reply-fallback.ts | `interface ReplyFallbackDeps` | 新增 | settle 依赖契约：`{ childSid, store, deliverTo(targetSid,msg), tracker, baseline, carried }`（carried=构造时 takePending 出的跨 run 未决） | MUST 依赖全注入（可测）；deliverTo 签名对齐 `AgentManagerImpl.deliverTo` 前二参 | 本文件「设计总述」 | +25（新文件内） |
| multi_agent | app/server/src/agent/subagent-reply-fallback.ts | `settleAgentReplyFallback(state, deps, reason)` | 新增 | 结算入口：合并 `deps.carried + state.agentReplyRequests` → 按 fromSessionId 去重（每 sender 取最新 M.id）→ `tracker.hasDeliverySince(childSid, fromSid, baseline)` 为 true 跳过 → 否则 `buildFallbackMessage` + `deliverTo(fromSid, msg)` | MUST best-effort：单 sender deliverTo 失败 catch 续下一条，MUST NOT 阻断 run 收尾/抛出；MUST NOT 翻 transcript 判履约、MUST NOT 读 inReplyTo 对账；`reason='tool_pending'` MUST NOT 进入本函数（caller 拦） | req.md 判定规则；a2a_protocol §4.2 | +55（新文件内） |
| multi_agent | app/server/src/agent/subagent-reply-fallback.ts | `buildFallbackMessage(deps, reason, inReplyToId)` | 新增 | 构造代发 Message：`role='user'`、`sender.source='agent'`、`ref.sessionId=childSid`（type/name 占位由 enrichForInbox 反查补全）、`needReply=false`、`inReplyTo=inReplyToId`；成功 reason（no_tool_call/no_new_messages）content=final text（`getFinalAnswerFromStore(store, childSid)`，空串退化为通知文案）；失败 reason（error/interrupted/doom_loop/max_iterations）content=结局通知（含 stopReason + `state.error?.displayReason` 一句原因） | MUST needReply=false（防回话风暴，成功/失败同）；MUST 以 child 身份（ref.sessionId=childSid，MUST NOT 用 parent ref）；MUST 经 deliverTo 走 enrichForInbox（MUST NOT 直调 inbox.append） | req.md 代发内容；a2a_protocol §4.2/§4.3；inbox-enrich.ts enrichForInbox 契约；spawn-action.ts getFinalAnswerFromStore | +55（新文件内） |
| agent-loop | app/server/src/agent/loop-ports.ts | `interface AgentReplyRequest` | 新增 | `{ messageId: string; fromSessionId: string }`——本 run drain 到的待回 a2a 请求（messageId=drain reissue 后新 id） | 纯类型；供 DrainResult / LoopState / tracker / fallback 四处共用 | req.md 结算对象 | +8 |
| agent-loop | app/server/src/agent/loop-ports.ts | `LoopState.agentReplyRequests` | 新增 | 可选字段 `agentReplyRequests?: AgentReplyRequest[]`——run 内跨多次 drain 累积的待回请求 | MUST 仅由 prepareStage drain 路径写入；forked（drainMode='none'）恒空 | req.md 结算对象 | +5 |
| agent-loop | app/server/src/agent/agent-loop-stage-pre.ts | `DrainResult.agentReplyRequests` | 新增 | DrainResult 加 `agentReplyRequests: AgentReplyRequest[]` 字段（纯数据投影，drain 无该来源时为空数组） | MUST 保持 drainAndPartition 纯函数无副作用 | req.md 结算对象 | +4 |
| agent-loop | app/server/src/agent/agent-loop-stage-pre.ts | `drainAndPartition()` | 修改 | else 分支（agent/approval/system）内：当 `rewritten.sender?.source==='agent' && rewritten.sender.agent.needReply===true` 时收集 `{ messageId: rewritten.id, fromSessionId: rewritten.sender.agent.ref.sessionId }` 入 `result.agentReplyRequests` | MUST 用 drain reissue 后的 `rewritten.id`（非 inbox 原 id，inReplyTo 才指得回 transcript 真身）；MUST NOT 收集 user/system/approval/tool_reply 来源 | req.md 结算对象；stage-pre.ts:107 注释（drain 透传完整 sender） | +8 |
| agent-loop | app/server/src/agent/loop-stage-context.ts | `prepareStage()` | 修改 | drain 后（`drained.newMessages.length>0` 分支内）把 `drained.agentReplyRequests` 追加并入 `state.agentReplyRequests`（跨多轮 drain 累积） | MUST 只增不判（履约判定归 settle）；本文件已 293 行，本次 MUST ≤+6 行防破 300 上限 | req.md 结算对象 | +4 |
| agent-loop | app/server/src/agent/run-lifecycle-port.ts | `RunLifecyclePortDeps.replySettle` | 新增 | deps 加可选 `replySettle?: { deliverTo, tracker, baseline, carried }`（baseline/carried 由 buildRunDeps 装配时快照/取出） | MUST optional（forked/非 subagent/测试缺省 undefined → 全链路 noop，现有 2 个 UT 构造点零改动） | 本文件「设计总述」 | +12 |
| agent-loop | app/server/src/agent/run-lifecycle-port.ts | `onRunEnd()` | 修改 | persistRun + 五态机 CAS 之后追加：`replySettle` 存在时——`state.stopReason==='tool_pending'` → `tracker.stashPending(sid, [...carried, ...state.agentReplyRequests ?? []])`（非空才 stash）；其余 reason → `await settleAgentReplyFallback(state, deps, state.stopReason)` | tool_pending MUST NOT 触发代发（只 stash）；MUST 在 `!persistsRun` early-return 之后（forked 永不达）；settle 异常 MUST catch 吞掉不阻断（收尾主链 persistRun/CAS 已完成） | req.md 触发时机 + 不回复条款；agent_loop_unified §3.2 | +18 |
| agent-loop | app/server/src/agent/run-lifecycle-port.ts | `onInterrupted()` | 修改 | main+subagent（replySettle 存在）时 `await settleAgentReplyFallback(state, deps, 'interrupted')`（interrupted 走结局通知分支）；同步更新文件头「onInterrupted 恒 noop」注释 | MUST NOT 做 transcript 收尾/emit（abort api 4 步接管不变，本 hook 仅开「代发旁路」）；MUST NOT 调 wireEmitCtx/wireContextEngine（abort 已 revoke） | req.md 失败/中断条款；agent_interrupt §3；run-react-loop.ts:277 | +12 |
| agent-loop | app/server/src/agent/agent-manager.ts | `AgentManagerImpl.a2aReplyTracker` | 新增 | 类字段 `private readonly a2aReplyTracker = new A2aReplyTracker()`（manager 单例持有，全 session 共享） | MUST 单实例随 manager 生命周期；MUST NOT 落盘 | 本文件「设计总述」 | +3 |
| agent-loop | app/server/src/agent/agent-manager.ts | `deliverTo()` | 修改 | `await managerDeliverTo(...)` 成功后：`message.sender?.source==='agent'` 则 `this.a2aReplyTracker.markDelivery(message.sender.agent.ref.sessionId, sessionId)`，再返回 run | MUST 仅在投递成功后 mark（失败抛错不 mark）；MUST 从 message 自身 sender 取 fromSid（user/system 来源不记） | req.md 判据 A；deliverTo 统一投递入口（derivation §4.1） | +6 |
| agent-loop | app/server/src/agent/agent-manager.ts | `activate()` | 修改 | buildRunDeps 调用 opts 追加 `a2aReplyTracker: this.a2aReplyTracker` + `deliverToFn: (sid, msg) => this.deliverTo(sid, msg)` | MUST 用箭头函数绑 this；MUST NOT 把 manager 整体传给 lifecycle（只暴露两窄口） | 本文件「设计总述」 | +3 |
| agent-loop | app/server/src/agent/build-run-deps.ts | `BuildRunDepsOpts.a2aReplyTracker / deliverToFn` | 新增 | opts 加两个可选字段（main 路径由 activate 注入；旁路 executeSideRun 不注入） | MUST optional（旁路/测试缺省 → replySettle 不装配） | 本文件「设计总述」 | +8 |
| agent-loop | app/server/src/agent/build-run-deps.ts | `buildRunDeps()` | 修改 | 构造 RunLifecyclePort 处：`isMain && kind.isSubagent && opts.a2aReplyTracker && opts.deliverToFn` 时装配 `replySettle={ deliverTo: opts.deliverToFn, tracker, baseline: tracker.deliveryEpoch(), carried: tracker.takePending(sid) }` 传入 deps | baseline MUST 在此刻快照（=run 起点，本 run 的 mark 全部晚于它）；MUST 仅 main && derivation='subagent' 装配（顶层/squad/forked 不启用） | req.md 判据 A；session-kind.ts isSubagent；build-run-deps.ts:146 | +12 |
| agent-loop | app/server/src/agent/__tests__/subagent-reply-fallback.test.ts | 新 UT 文件 | 新增 | 覆盖：已履约跳过 / 成功代发 final text / final 空退化通知 / error·interrupted·doom_loop·max_iterations 结局通知（needReply=false+inReplyTo=最新 M.id）/ tool_pending 只 stash 不发 / 续跑轮 carried 合并结算 / 多 sender 去重 / deliverTo 失败 best-effort；含 A2aReplyTracker 单测 + drainAndPartition 收集单测 | MUST 走 `bun run test`（vitest under bun）；MUST NOT mock 掉 enrichForInbox 语义外的投递主链（deliverTo 用 mock fn 断言入参即可） | req.md 判定规则全表 | +180（新文件） |
| agent-loop | app/server/src/agent/__tests__/run-lifecycle-port.test.ts | onRunEnd/onInterrupted 相关 case | 修改 | 补：tool_pending→stash 不发、no_tool_call→调 settle、onInterrupted→settle('interrupted')、replySettle 缺省→纯旧行为 | MUST 保持既有 case 全绿（新 dep optional） | agent_loop_unified §3.2 | +40 |

## 影响面评估

- **跨模块**：agent-loop（loop-ports / stage-pre / stage-context / lifecycle / manager / build-run-deps）+ multi_agent（两个新文件落在 `app/server/src/agent/`，语义属 multi_agent 兜底）。**零 API 契约变更**（无新 endpoint、无 SSE 事件新增——代发消息走既有 message_enqueued/message_* 序列，前端 a2a inbox 渲染天然可见）；零 DB schema 变更（tracker 纯内存）。
- **依赖顺序**：tracker/新类型（底层纯数据结构）→ drain 收集（stage-pre + stage-context）→ settle（fallback 模块）→ lifecycle/manager/build-run-deps 接线。单 coder 顺序实现即可。
- **风险点**：(1) `loop-stage-context.ts` 现 293 行，本次 +4 后 297——reviewer 须核对未破 300；(2) `onInterrupted` 打破「恒 noop」注释——仅开代发旁路，transcript 收尾仍归 abort api 4 步，注释同步更新；(3) fallback deliverTo 会 activate parent——parent 正 running 时消息入队下轮 drain（必达但不即时），符合「结果回来触发 parent 新 run」语义；(4) `getFinalAnswerFromStore` 从 `agent/tools/spawn-action.ts` import 到 `agent/subagent-reply-fallback.ts`——方向 agent→tools，与 agent-manager→tools/engine 既有先例一致，无循环（spawn-action→agent-manager-children 不回指 fallback）。
- **spec 同步（doc-modifier 阶段 5 做，不在本表）**：`subagent_derivation.md §4`「async = best-effort 无内置通知」表述改为「系统代发兜底」；`a2a_protocol.md §4.2` 加系统代发行；`agent_loop_unified §3.2` LifecyclePort 行为补 onRunEnd/onInterrupted 兜底钩子。

## task 规划复核

读 planner.md 任务设计原则后复核 `states/v0.0.255/task.json`：**维持 1 个 task**。本机制是一条纯串行链路（tracker → drain 收集 → settle → 接线），无后端∥前端等并行面，拆分只会增加冷恢复成本。已顺手把 task.coversFiles 更新到与本表一致（原只列 2 文件，实际 8 源文件 + 2 测试文件）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
