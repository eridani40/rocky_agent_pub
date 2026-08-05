# v0.0.80.t1 change_log — consolidation 触发时机 bug 修复

> 版本轴发布说明。位置轴（per-KB `log.md`）见各 KB 目录。诊断详情见 `reqs/[working] v0.0.80.t1_consolidate_bug/diagnosis.md`，method 级变更合同见本目录 `change_plan.md`。

## 0. 背景

session `01KWT9NQK54JPWB76E3QZZ2VTV`（2026-07-05 23:27，主 agent 读 2 个 html 文件）Langfuse 出现 7 trace：**2 summary vs 4 memory_extract**（不成对）、每个 forked snapshot 起点/大小各异（4~8 msg）、部分极早触发（无 file read 结果）、所有 forked trace `metadata.inputMessageIds = []`。

诊断确认 4 bug：

1. **Bug-1 ★★★（count mismatch 主因）**：`try-compact.ts:66→70` doCompact 后**无条件**触发 post-compact；`summary_do_compact.ts:63` 丢弃 `runCompact` boolean 返回（false=锁失败），`run()` 仍 void resolve → compact 锁失败的并发 tryCompact 也触发 memory_extract。
2. **Bug-2 ★★**：`post-compact-consolidation.ts` 启动 fork-2 **未 acquire `tier1_consolidation` 锁**（spec §6 说「如 tier1 接入」从未接）。
3. **Bug-3 ★★**：`ctx.snapshot` 是主 loop 活快照，并发 tryCompact 各取不同轮 → 输入各异。
4. **Bug-4 ★**：`forked-invoke-observability.ts:60` forked trace `inputMessageIds: []` 硬编码空；同 trace 未见 context window usage。

## 1. 核心变更（6 点）

1. **触发点迁移**：`runTryCompact` 从 `ingestAssistant`（callLLM 后、可能 hanging tool_use）迁移到 `run-react-loop.ts` 的 `prepareStage` 之后、`callLLM` 之前——last msg 必 user/tool_result，无 hanging tool_call，干净。
2. **sibling 双发**：`tryCompact` 谓词 true 后 `structuredClone(snapshot)` 一次 → `void runSummarySibling + void runConsolidationSibling` 并发派发（替代旧 `await action.run + await triggerPostCompact` 串行链）；两 sibling 各自 fire-and-forget + 各自 acquire 自己的锁（`compact` / `tier1_consolidation`），互不阻塞、互不耦合。
3. **tier1_consolidation 锁接入**：`MemorySkillConsolidationHandler.handle` 内部 acquire `'tier1_consolidation'`——锁失败静默 return，成功后 `markDone` / 失败 `markFailed`（与 `compact` 锁对称）。
4. **deep clone 双保险**：tryCompact 谓词 true 后 clone 一次（sibling 共享不可变副本）；`agent-manager.forkedRun` 入口再 clone 一次（防篡改）。
5. **observability 改进**：(1) forked trace metadata `inputMessageIds` 改为 `[triggerMessageId]`（去硬编码空，反查触发点 msg id）+ 加 `triggerUsage`；(2) 主 loop 每次 `callLLM` 的 `startGeneration` 第 5 参数 `contextWindowUsage` 透传到 GenInput。
6. **summary 纯生产者原则**：compact/forked 只产 summary + compact_notice + accumulateUsage('forked') **write**；**不碰消费侧**——删 `loop-stage-context.ts:222-225` re-assemble 尾 + `context-compact-runner.ts:170-172` notifyUsageChanged 循环；usage 推送归正规 assemble 管线（`prepareStage`/`ingestAssistant`/`ingestToolResults` 每次 assemble 后 `notifyUsageChanged`，`getUsageView` 读全量 record emit）。

## 2. 决策（用户拍板）

- **触发点 = callLLM 前（prepareStage 后）**：last msg 必 user/tool，无 hanging tool_call；旧位置 ingestAssistant 是 callLLM 后（可能 hanging tool_use）。
- **sibling fire-and-forget 双发**：summary 与 memory_extract 是**两个独立 fire-and-forget sibling**，不再 doCompact → postCompact 串行链——两 sibling 共享不可变 snapshot，各自 acquire 自己的锁，锁失败各自静默跳过。
- **「summary 纯生产者，不碰消费侧」**（架构原则）：compact 内部零 `notifyUsageChanged`、零 re-assemble、零 setSystem；消费侧（snapshot 刷新 + usage 推送）归正规 assemble 管线。理由：边界清晰防 compact 与主 loop 重复/冲突推送。**接受 trade-off**：compact 完成后 forked cost + context 下降的 UI usage 推送延迟到下一轮 assemble（人可感知 ~秒级延迟）。

## 3. 不变量（change_plan §5.2 八条 + §1.0）

1. **fire-and-forget 不阻塞主 loop**：`void runTryCompact(...).catch(log)`，主 loop 立即进 callLLM。
2. **sibling 互不阻塞**：summary 与 consolidation 各自 `void ... .catch(log)`，互不 await。
3. **per-task 锁 CAS 语义**：`acquire('compact')` / `acquire('tier1_consolidation')` 失败各自静默跳过（不重试、不排队）。
4. **snapshot 不可变**：触发点 clone 后两 sibling 共用、不修改；forkedRun 入口再 clone 一次（双保险）。
5. **防递归 forked scope**：forked scope `reject_should_compact` 谓词恒 false → forked agent 内 tryCompact 在谓词处 return，不进 sibling 双发。
6. **CompactBtn SSE 信号不丢**：SessionTaskLock.acquire/markDone/markFailed 内部 emit `summary_task_update`（v0.0.78.bug 已实装）；tier1_consolidation 锁复用同 emit 链路。
7. **错误观测链不破**：sibling catch 仅 log + 不 rethrow；markFailed 由 handler/runner 内部承担。
8. **triggerMessageId/triggerUsage 不入 forked buffer**：仅写 trace metadata，不进 forked in_memory store。
9. **§1.0 compact 内部零 notifyUsageChanged（纯生产者原则）**：`accumulateUsage(sid, 'forked', ...)` write 保留（forked cost 必须落盘），任何 compact 内部的 notifyUsageChanged 都已删。usage 推送的唯一触发点是正规 assemble 管线。

## 4. 测试

- **UT 70/70 pass**（新增 7 case：sibling 双发时序、谓词 false 不 clone、sibling 异常互不影响、forked scope 防递归、tier1 锁 acquire 失败静默跳过、fork-2 markDone/markFailed、deep clone 不 mutate opts.snapshot + triggerMessage 透传 + startGeneration 第 5 参数 + startTrace triggerUsage）。
- **AT 4/4 compact case pass**（`compact_409_mutex` / `compact_directive_no_retell` / `compact_manual_sse` / `compact_run_end_unblocked` 真实 LLM 串行跑，复用验证无回归）。
- **ET**：无前端变更（compact 是后端异步任务，前端 CompactBtn 信号源 `summary_task_update` 不变）。
- **code-review**：清单 G 9 项 + 不变量八条全 ✅；4906 UT pass / 0 fail；纯生产者原则落地（grep 确认 compact 内部零 notifyUsageChanged，accumulateUsage write 保留）；核心约束零偏离。

## 5. Spec 同步

- `[P0]consolidation_tier1.md`：顶部「实现落点」注记 + §4（顺序链图 → sibling 双发图）+ §5 失败隔离 + §6 fork-2 acquire tier1_consolidation 锁。
- `[P0]context_compact_detail.md`：§2c.1 伪代码（sibling 双发）+ §2c.1.0 新增「summary 纯生产者」原则段 + §2c.1.1 并发不变量更新（#5/#6）+ §2d 触发时机（compact 后串行 → tryCompact sibling）+ §2d.5 表格。
- `[P0]session_task_lock.md`：§6 实现落点（tier1 已接入）+ §7 不变量 #4（compact + tier1 同 session 可并行例）。
- `[P0]agent_loop_forked.md`：§1 forked 不变量补（snapshot 双 clone + trigger meta 透传）。
- 4 KB `index.md` ④核心设计原则 + `log.md` 追加 v0.0.80.t1 条目。
