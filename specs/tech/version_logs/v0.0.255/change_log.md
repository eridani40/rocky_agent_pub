# v0.0.255 变更日志 — async subagent 回报兜底（系统代发）

> 版本轴发布说明（跨 KB）。位置轴见各 KB `log.md`（multi_agent + agent/agent_interface_and_loop）；method 级契约见同目录 `change_plan.md`。
> 纯技术机制增强，**无 PRD/API/UI 变更**（不产 prd/api/ui version_log，无 app-guide 更新）。
> 需求源：`reqs/[working] v0.0.255.async_subagent_reply/req.md`。

## 1. 主题

async spawn 的 subagent 结果回传此前靠 LLM 自觉调 send_message（prompt 层约定 needReply=true 必回），无代码兜底，LLM 违约则 parent 静默收不到；sync spawn 则由代码保证（spawn 方 `await run.promise` + `getFinalAnswerFromStore` 从 transcript 取结果）。本版本给 async 加系统兜底，把回传可靠性拉到与 sync 同级：

- **触发**：child run 结束（`RunLifecyclePort.onRunEnd` 且 `stopReason≠tool_pending`；中断走 `onInterrupted`）时，对本 run drain 到的 `needReply=true` a2a 请求（`drainAndPartition` 收集 → `LoopState.agentReplyRequests` 跨轮累积）按 sender 去重，若本 run child 未向该 sender 投递过（**判据 A**）→ 系统以 child 身份经 `deliverTo` 代发一条回报：成功（no_tool_call/no_new_messages）= final text（复用 `getFinalAnswerFromStore`，空退化为通知文案）；失败/中断（error/interrupted/doom_loop/max_iterations）= 结局通知（stopReason + displayReason 一句原因）。代发消息 `needReply=false`（防回话风暴）、`inReplyTo` 指回该 sender 最新 M.id。
- **判据 A 数据源** = 进程内 `A2aReplyTracker`（`AgentManagerImpl` 持有，纯内存不持久化）：`deliverTo` 成功投递后按 message 自身 sender 记 `fromSid→toSid` 最新 seq（全局单调 epoch）；child run 装配时（`buildRunDeps`）快照 baseline epoch + `takePending` 取跨 run 未决；收尾 `hasDeliverySince(child, sender, baseline)` 判履约——零 transcript 扫描、零 LLM 语义依赖。成立根基 = subagent 仅可达 parent 的工具层硬约束（checkReachable），「child→sender 有无投递」是无歧义是/否。
- **tool_pending（HITL 悬挂）不代发**：悬挂轮无真结果（等审批续跑），未决请求 `stashPending` 跨 run 携带（take 即清防双 run 重复结算），续跑出真结果那轮才合并结算。
- **装配边界**：仅 `main && derivation='subagent'` 的 run 装配 replySettle（顶层/squad/旁路 run 不装配 → 全链路 noop）；best-effort——单 sender deliverTo 失败 catch 续下一条，不阻断 run 收尾主链；settle 整体异常吞掉仅 warn。

## 2. 实现偏差（相对 change_plan）

### 2.1 `buildFallbackMessage` 签名补 `targetSid` 参数（+ `errorDisplayReason` 第 5 参）

- **change_plan 行**原写 `buildFallbackMessage(deps, reason, inReplyToId)` 三参。
- **实际落地**（`subagent-reply-fallback.ts:86`）：`buildFallbackMessage(deps, targetSid, reason, inReplyToId, errorDisplayReason?)` 五参。
- **偏离原因**：change_plan 签名缺 targetSid——代发 Message 的 `sessionId` 字段必须 = 投递目标 sessionId（结算循环按 sender 逐条构造，目标 id 是显式入参非全局可取）；失败文案需 `state.error?.displayReason`（change_plan 约束列已声明「含 displayReason 一句原因」但签名未列入参）。语义未越界（代发内容契约与 change_plan 一致），reviewer 判合理。
- **教训**：change_plan 写函数签名时入参须列全（含「数据从哪来」的传递参），尤其循环内逐目标的构造函数。

### 2.2 settle reason 类型定为 `ReplySettleReason = Exclude<StopReason, 'tool_pending'>`

- **change_plan 行**原写约束「`reason='tool_pending'` MUST NOT 进入本函数（caller 拦）」——运行时约定。
- **实际落地**（`subagent-reply-fallback.ts:28`）：导出 `ReplySettleReason = Exclude<StopReason, 'tool_pending'>`，`settleAgentReplyFallback(state, deps, reason: ReplySettleReason)` 形参类型钉死——caller（`run-lifecycle-port.ts`）的 tool_pending 分支在类型层面就传不进来。
- **偏离性质**：把「tool_pending 不进入」从运行时约定升级为**编译期钉死**（类型即文档，未来 caller 误传直接编译错）。语义与 change_plan 约束完全一致，reviewer 判合理。

## 3. 代码↔spec 一致性核实（doc-modifier 阶段 5）

逐项核对「代码实现 == spec 契约」，**结论：实现与 spec 契约一致，spec 已同步新机制**——

| 契约点 | 代码核实 |
|---|---|
| deliverTo 成功后 mark 判据 A（from 取 message 自身 sender） | `agent-manager.ts:387-393` `managerDeliverTo` 成功后 `markDelivery(message.sender.agent.ref.sessionId, sessionId)`；失败抛错不 mark；user/system 来源不记 ✓ |
| replySettle 仅 main && subagent 装配 | `build-run-deps.ts:158-166` `isMain && kind.isSubagent && opts.a2aReplyTracker && opts.deliverToFn`；baseline=装配点 `deliveryEpoch()` 快照，carried=`takePending(sid)` ✓ |
| onRunEnd 分派（tool_pending 只 stash / 其余 settle） | `run-lifecycle-port.ts:76-87` persistRun/CAS 之后；stash 合并 carried+state 且非空才 stash ✓ |
| onInterrupted 代发旁路（不动 abort api 4 步） | `run-lifecycle-port.ts:107-111` 仅 `settle(state,'interrupted')`，无 transcript 收尾/emit ✓ |
| settle 异常吞掉不阻断 + 单 sender 失败续下一条 | `run-lifecycle-port.ts:117-132` try/catch warn；`subagent-reply-fallback.ts:71-77` per-sender catch ✓ |
| drain 收集用 reissue 后 id（inReplyTo 指得回 transcript 真身） | `agent-loop-stage-pre.ts:162-167` `sender.source==='agent' && needReply===true` 时收集 `{messageId: rewritten.id, fromSessionId}` ✓ |
| 跨轮累积只增不判 | `loop-stage-context.ts:61-62` `state.agentReplyRequests = [...state, ...drained]` ✓ |
| 代发消息以 child 身份 + needReply=false + inReplyTo=最新 M.id | `subagent-reply-fallback.ts:109-123` `ref.sessionId=childSid`（type='subagent' 占位 + name 空串由 enrichForInbox 反查补全）✓ |
| 成功=final text（空退化通知）/ 失败=结局通知（含 displayReason） | `subagent-reply-fallback.ts:93-108` ✓ |
| tracker 纯内存不持久化 | `a2a-reply-tracker.ts` 全文件无 store 读写 ✓ |
| 履约判定边界（顶层/squad/旁路 noop） | `agent-manager.ts:281-283` activate 注入两窄口；旁路 executeSideRun 不注入 → replySettle undefined → 全链路 noop ✓ |

## 4. spec 同步清单

- tech OKF：
  - `multi_agent/[P1]subagent_derivation.md §4`（「结果送达语义」async 条改述系统代发兜底 + 伪码注释 + §9 边界表行）+ 该 KB `index.md`（概念表行 + 原则 #8）+ `log.md` v0.0.255 条目。
  - `multi_agent/[P1]a2a_protocol.md §4.2`（needReply 表 async 行 + 新增「系统代发兜底」段）+ 该 KB `log.md` 同条目。
  - `agent/agent_interface_and_loop/[P0]agent_loop_unified.md §3.2`（RunLifecyclePort 表两行更新 + 新增「replySettle 装配」段）+ §4（中断退出/正常退出 main 条）+ `[P0]agent_loop_eager_drain.md §4` 与 `[P0]agent_interface.md` RunSpec.lifecycle 注释（「onInterrupted=noop」绝对表述订正）+ 该 KB `log.md` v0.0.255 条目。
- prd/api/ui overall：**无变更**（纯技术机制增强，无用户可感知行为/界面变化；代发消息走既有 message_enqueued/message_* 序列，前端 a2a inbox 渲染天然可见，无新 UI 契约）。
- app-guide：**无更新**（无新功能/板块/操作路径）。

## 5. 验证

- UT：全量 `bun run test` 绿（9344 passed）；新增 `subagent-reply-fallback.test.ts`（19 例：tracker + drain 收集 + settle 全分支）+ `run-lifecycle-port.test.ts` 补 6 例（tool_pending stash / settle / interrupted / replySettle 缺省纯旧行为 / 异常吞掉）。
- AT：3/3 pass——`agent_spawn_async_reply`（新增，真实调 minimax）+ `agent_spawn_sync` + `spawn_inline_tools_inherit`（回归）；端到端验证到 parent 收到 needReply=false 的 child 回报 = 系统代发签名（非 LLM 自觉）。
- ET：省略（零 UI 变更，test-plan 已裁）。
