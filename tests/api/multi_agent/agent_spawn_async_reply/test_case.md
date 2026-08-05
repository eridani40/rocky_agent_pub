# agent_spawn_async_reply

**Module**: `multi_agent` · **覆盖契约**: `specs/api/overall/10-multi-agent.md` §4.1（a2a 回报消息落 parent transcript）+ `specs/tech/multi_agent/[P1]a2a_protocol.md` §4.2（needReply 语义）+ `specs/tech/multi_agent/[P1]subagent_derivation.md` §4（spawn async 模式）
**版本**: v0.0.255 — async subagent 回报兜底（系统代发，`A2aReplyTracker` 判据 A + `settleAgentReplyFallback`）

## 被测行为（v0.0.255 新增）

async spawn 的 subagent 完成任务后，parent **必收到**一条来自该 child 的回报消息（落 parent transcript）：

- **路径 a（LLM 自觉）**：child 看到首任务 `needReply=true`（async spawn 系统默认，a2a §4.2），完成后自觉 `send_message(to=parent)` 回报。
- **路径 b（系统兜底代发）**：child run 结束（onRunEnd/onInterrupted）且本 run 未向 parent 投递过（`A2aReplyTracker.hasDeliverySince` 判据 A），系统以 child 身份代发一条回报（成功=final text / 失败=结局通知；`needReply=false` 防回话风暴）。

两条路径落库的消息**同构**：`sender.source='agent'` + `sender.agent.ref` = child 的 AgentRef（`ref.type='subagent'`、`ref.sessionId=childSid`）。本 case 只断言「parent transcript 最终出现这样一条消息」这一必达契约，不区分走的是 a 还是 b（LLM 是否自觉回报是 LLM 自由行为，不可强制也不应强制）。

> **与既有 `agent_spawn_sync` 的区分**：sync spawn 首任务 `needReply=false`（系统硬填），结果经 `await run.promise` + `getFinalAnswerFromStore` 代码保证取回，child 不 send_message 回 parent——parent transcript 不该有 child 的 agent-source 消息。本 case 是 async 路径（`needReply=true` + 必达兜底），断言 parent transcript **有**这样的消息。两条 case 互补锁定 needReply 两个取值的契约行为。

## 链路设计

1. 建 parent session（playground + minimax），save `sid`。
2. 订阅 parent `agent_loop` 流（先订阅后触发）。
3. `POST /session/{sid}/messages` 驱动 parent 调 agent 工具 **async spawn**（mode=async、inline 不指定 templateRef）：child 任务 =「计算 17 乘以 23，把结果作为最终回答，任务即完成」。**任务明确「完成即可」，正文不提 send_message**——不诱导自觉回报，自觉/兜底两条路都允许走到。parent 被指示派生后直接回「已派生」、不等不查（防 agent.query 轮询污染 transcript）。
4. `wait` parent `run_end >= 1`（async spawn 立即返 handle，parent run 1 不等 child）。**只断 `>=1` 不断 `==2`**：eager-drain 可能把迟到得早的 child 回报吸入 parent run 1 内 drain（不产生 run 2），run 2 不是必然事件，强断会竞态假 fail。
5. `poll GET /children` 直到 child 落 `terminated[0]`（child run 结束；自觉回报已投递，兜底随 onRunEnd 触发——两路的最晚投递点），save `child_sid`。
6. `GET /session/{child_sid}` 验 `derivation=subagent` + `parentSessionId exists`（check rhs 不可插值，框架惯例 exists + 唯一性论证）。
7. `GET /session/{child_sid}/messages` 验 child transcript 首任务消息 `sender.source='agent'` + `sender.agent.needReply == true`（a2a §4.2 async 首任务契约行——这是整个回报链路的触发条件，顺带锚定 child 身份）。
8. **核心断言**：`poll GET /session/{sid}/messages` until `.items[] any .sender.source == "agent"`（timeout 60）→ check 同谓词 + `.items[] any .sender.agent.ref.type == "subagent"`。与 run 边界解耦（消息 drain 进 transcript 即命中），零竞态。
9. `GET /session/{sid}/usage` 验 `.sub.llmCallCount >= 1`（child 真跑过 LLM）+ 全流 `main.absent(type=error)` 收尾。
10. teardown `DELETE /session/{sid}`（child 随父联级清理）。

## 断言面

| 断言 | 信号含义 |
|------|---------|
| `main.run_start/run_end >= 1 / absent(error)` | parent run 1（含 async spawn 工具调用）正常完成 |
| `GET /children terminated[0]` 存在 | async spawn 真派生了 child session 且 child run 已结束 |
| `child.derivation==subagent` + `parentSessionId exists` | child 是本 parent 派生的 subagent（契约 §2） |
| `child transcript 有 sender.source='agent' 且 needReply==true` | async 首任务按 a2a §4.2 投递（needReply=true = 回报链路的触发条件） |
| **`parent transcript 有 sender.source='agent' 消息`** | **核心：child 回报必达（自觉 send_message 或系统兜底代发，二者其一）** |
| `parent transcript 有 sender.agent.ref.type=='subagent'` 消息 | 回报发送方是 subagent（双保险，排除其他来源解释） |
| `parent.sub.llmCallCount >= 1` | child 真跑过 LLM（usage 递归上报链路） |

**「来自该 child」的等价论证**（替代 DSL 表达不了的 `ref.sessionId == {child_sid}` 精确等值）：parent 是本 case 新建的 playground 主会话；全 case 只派生这一个 child；a2a §3 拓扑硬约束 subagent 仅可达 parent、且没有其他 agent 知晓该 parent → parent transcript 里任何 `sender.source='agent'` 的消息必然来自该 child。`ref.type=='subagent'` 进一步排除「assistant 消息误带 sender」类实现偏差的假阳性（assistant 消息无 sender 字段，见风险 2）。

## 已知 flaky / 残留风险（重要 — 执行前知会）

1. **parent LLM 可能不用 mode=async（静默偏离，可诊断）**：若 parent 不顾引导用了 sync spawn，则首任务 `needReply=false`（不武装兜底）→ parent 永远收不到回报 → 核心 poll 超时 fail。此时非产品 bug，是 LLM 不遵从 case 引导词。诊断：`last_run` 里 child session 存在 + parent transcript 无 agent-source 消息 + parent run 1 耗时明显长（sync 阻塞等 child）。缓解：引导词已显式写「mode=async（异步模式，派生后不等待）」。同类风险既有 case 也有（「必须调用 agent 工具」遵从性），接受。

2. **「assistant 消息无 sender」是实现假设，spec 未显式钉死**：`Message.sender` 为可选字段，spec 只规定 inbox 入口（user POST / a2a deliverTo / system emit）程序构造 sender；assistant 消息由 loop emit 路径产生、不经 inbox，按契约不应有 sender。若实现实际给 assistant 消息也落了 `sender.source='agent'`，核心断言会假 pass（被 `ref.type=='subagent'` 部分对冲——assistant 即便带 sender 也不会有 subagent ref）。首轮执行据 `last_run/steps/NN/responses.json` 核对 parent transcript 真实形态确认。

3. **child transcript `needReply==true` 断言绑定首任务消息**：child transcript 中唯一的 agent-source 消息 = parent 投递的首任务（child 自己发出的 send_message 落 parent 而非自己 transcript），故 any 谓词绑定唯一。若未来 child transcript 形态变化（如回声落库），此断言可能需收紧。

4. **回报→transcript 可见的时序**：a2a 消息在 parent run 的 drain 阶段 ingest 进 transcript；child terminated（五态机 CAS）先于兜底 settle 执行（change_plan 锁定顺序），故核心 poll 落在 child terminated 之后、容忍兜底代发 + parent 激活 + drain 的秒级延迟（60s 充足）。若兜底 deliverTo 失败（best-effort catch）→ 永无消息 → poll 超时 fail——这正是本 case 要守的契约（必达），属真 fail。

5. **不断言回报内容**（如 `~= "391"`）：兜底失败路径发的是结局通知（不含答案），且 parent run 2 的 assistant 复述也会含 391（无法绑定到 a2a 消息本身）。契约是「必达」而非内容形态，故只断 sender 结构。

## 与 UT 的关系（gate 取舍建议）

- **UT（`subagent-reply-fallback.test.ts` + `run-lifecycle-port.test.ts`）= 本机制的精确门**：判定逻辑全分支（已履约跳过 / 成功代发 / 结局通知 / tool_pending stash / 续跑结算 / 多 sender 去重）白盒确定覆盖，零 LLM 不确定性。
- **本 AT = 端到端行为层冒烟**：真实双 LLM 链路下验证「async spawn → child 完成 → parent 必收到回报」这一跨层契约（spawn → child run → tracker/drain → settle → deliverTo → parent drain ingest）。UT 摸不到这条集成链路的真实 LLM 不确定性段。
- **建议**：首轮真调跑；若 fail 落在风险 1（LLM 不用 async）→ 调引导词重跑；落在风险 2（transcript 形态假设不符）→ 按实际形态修断言路径并回记本文件；核心 poll 超时且 child transcript needReply 断言过 → 产品侧必达契约失效，退 coder + 建 BUG。
