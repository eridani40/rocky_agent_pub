# v0.0.235 变更计划书 — forked（整理）usage 统计链路修复

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **PRD 豁免**（纯技术 bug，恢复 spec §6.1 v0.0.204 既有设计）。修复点集中在后端 session/agent 层 4 处 + spec 同步 2 处。不引入新概念。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 根因（一句话）

`runReActLoop` 三条 return 全 `usage: {} as never`（v0.0.40 起每轮 callLLM usage 只喂 `onUsage`，从不聚合进 RunResult.usage）→ forked caller `accumulateUsage(sid,'forked', {})` → forked 分区数值字段全跳过（只 llmCallCount++）→ 前端 `forkedIn+forkedOut>0` 不成立 → 「整理」行隐藏。**零双计依据**：main loop 返 `Promise<void>`，`attachRunPromise` L78 硬编码 `result.usage={}` 忽略 loop 返回值；只有 forked 经 `buildAgentRunShell` L196 真实传播 RunResult。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session_usage | app/server/src/agent/session-usage-helper.ts | sumUsage(a, b) | 新增 | 纯函数 Σ 两个 Usage 的 NUMERIC_KEYS 字段（11 个数值字段：input_cache_read/input_cache_write/input_no_cache/input_total_tokens/output_response/output_reasoning/output_total_tokens/total_tokens/cost/inputCharCount/outputCharCount）；非 number 字段跳过；currency 缺则取 b.currency；返回新 Usage 对象 | MUST 复用现有 NUMERIC_KEYS 常量（不重新列举字段）；MUST 兼容 `b: Usage \| null`（callLLMForSpec 返 `Usage \| null`，null 时直接返回 a 不动）；MUST NOT 包含 llmCallCount（NUMERIC_KEYS 不含；partition 顶级由 accumulatePartition 单独 ++）；MUST 纯函数无 IO 可 UT | specs/tech/agent/session/[P0]session_usage.md §2（Usage/NUMERIC_KEYS 字段集合）+ §6.2 step1（accumulatePartition 同模式 L123-135） | +15 |
| agent-loop | app/server/src/agent/run-react-loop.ts | runReActLoop（局部累加器） | 修改 | 函数体内（state 初始化之后、while 之前）声明 `let accumulatedUsage: Usage = {} as Usage`；每轮 L149 `callLLMForSpec` 拿到 usage 后追加 `accumulatedUsage = sumUsage(accumulatedUsage, usage)`；三条 return（L78 pre-loop abort / L269 interrupted / L287 正常退出）把 `usage: {} as never` 改为 `usage: accumulatedUsage` | MUST 在每轮 callLLMForSpec 后累加（不漏轮）；MUST NOT 删除/改 L153 `spec.lifecycle.onUsage(usage)` 调用（forked onUsage L70 仍 early return，防双计）；MUST NOT 影响 main loop（main 经 attachRunPromise L78 硬编码忽略 RunResult.usage，零双计）；L78 pre-loop abort 时累加器仍初始 `{}`（等价现状，无回归）；MUST import sumUsage 从 session-usage-helper | specs/tech/agent/session/[P0]session_usage.md §6.1（旁路 run 由 caller 按 run 结束总量一次性累计）+ §10（RunResult.usage 聚合）；architect 原则#7（chat 返 void，RunResult 仅 forked 传播） | +5/-3 |
| context_engine | app/server/src/agent/context-compact-runner.ts | runCompact（L164 accumulateUsage 调用） | 修改 | 把 `await store.accumulateUsage(sid, 'forked', forkedResult.usage);` 改为 `const chain = await store.accumulateUsage(sid, 'forked', forkedResult.usage);` 后追加 `for (const s of chain) await store.notifyUsageChanged(s);`（fork-1 caller 补 notify） | MUST 先 await accumulateUsage（write 完）再 notifyUsageChanged（读全量 view emit）；MUST 对 chain 数组每个 sid 各调一次 notifyUsageChanged；MUST NOT 在 accumulate 之前 notify；MUST NOT 改 L176 updateContextWindowUsage / L177 dispatchPostCompact 既有顺序与逻辑；MUST NOT 改 runCompact 既有 try/catch + lock.markDone/markFailed 结构 | specs/tech/agent/session/[P0]session_usage.md §3（accumulateUsage 返 `Promise<string[]>` sid 链）+ §6.1 修正口径（本次）；§6.2（递归上报 sid 链） | +3/-1 |
| plugin/consolidation | app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts | startConsolidation（L126 accumulateUsage 调用） | 修改 | 把 `await ctx.store.accumulateUsage(sid, 'forked', result.usage);` 改为 `const chain = await ctx.store.accumulateUsage(sid, 'forked', result.usage);` 后追加 `for (const s of chain) await ctx.store.notifyUsageChanged(s);`（fork-2 caller 补 notify） | MUST 保留 `if (ctx.store)` 守卫（UT fixture 缺 store 跳过）；MUST 先 await accumulate 再 batch notify；MUST NOT 改 runner({...}) 调用与 result.usage 取值方式；MUST NOT 影响 tier2 三 run（公共全局整理零累计口径不变，spec §6.1 末条） | specs/tech/agent/session/[P0]session_usage.md §3 + §6.1 修正口径（本次） | +3/-1 |
| session_usage（spec sync） | specs/tech/agent/session/[P0]session_usage.md | §6.1 旁路 run notify 口径 | 修改 | 把第 2 点「notify：旁路 run **零 notify**——usage 推送由下一轮 main assemble 的 `notifyUsageChanged` 携带」改为「notify：caller `accumulateUsage` 拿到 sid 链后对链上每个 sid 调 `notifyUsageChanged`（让 forked 分区增量即时可见，不依赖下一轮 assemble）；同一 sid 多次 write 时 notify 一次即可（读 write 完成后最终 view）」 | MUST 标 doc-modifier 阶段 5 执行（不进 coding task）；MUST 保留 §6.1 v0.0.204 核心口径（caller 按结束总量一次性累计 + RunLifecyclePort.onUsage 对 forked early return 防双计）；MUST NOT 改 run-lifecycle-port.ts L70 early return 行为；MUST 同步更新 run-lifecycle-port.ts L65-69 / context-compact-runner.ts L159-163 / post-compact-consolidation.ts L120-124 三处 inline 注释中「零推送/下一轮携带」表述（如有） | 本次修复；CLAUDE.md 原则#12（spec↔code 双向对齐，doc-modifier 阶段 5 统一） | +2/-2 |
| session_usage（spec sync） | specs/tech/agent/session/[P0]session_usage.md | §10 「Run schema 加 per-run usage 字段仍 future」补注 | 修改 | 在该段末追加一句：「[v0.0.235] `RunResult.usage`（runReActLoop 返回值，内存对象）已聚合每轮 callLLM usage（修复 v0.0.40 起的回归），但 **Run record 持久化 schema 仍不含累计 usage 字段**（future）；崩溃恢复仍靠 SessionUsageMeta 持久化。」 | MUST 区分两层：「RunResult.usage 内存返回值聚合」（本次修复）vs「Run record 持久化字段」（仍 future）；MUST 标 doc-modifier 阶段 5 执行；MUST NOT 暗示 Run record 已加字段 | specs/tech/agent/session/[P0]session_usage.md §10；本次修复 | +1/-0 |

## 影响面评估

**跨模块**：4 个代码文件（session-usage-helper / run-react-loop / context-compact-runner / post-compact-consolidation）+ 1 个 spec 文件（session_usage.md，2 处）。

**破坏性变更**：无。修复恢复 spec §6.1 v0.0.204 既有设计（caller 按结束总量累计），不改接口签名（accumulateUsage / notifyUsageChanged / RunResult 契约不变）、不改 onUsage early return（run-lifecycle-port.ts L70 保留）、不改前端 component-usage-panel（数据到位自然显示「整理」行）。

**依赖顺序**：sumUsage（helper）必须先实现 → run-react-loop 才能引用；caller 补 notify 与 run-react-loop 聚合解耦（可同 task 内顺序自由）。spec sync 归 doc-modifier 阶段 5，不进 coding task。

**风险点**：
1. **双计风险（已排除）**：main loop 经 attachRunPromise L78 硬编码忽略 RunResult.usage，零双计；forked 仅 caller 总量单计（onUsage early return 防「逐调用+总量」双计）。
2. **L78 pre-loop abort 等价性**：累加器初始 `{}`，pre-loop abort 时未参与 callLLM → 等价现状 `{}`，无回归。
3. **notify 时机**：必须 await accumulateUsage 完成后再 notify（写完才读全量 view，spec §3 顺序契约）。
4. **postCompact snapshot 兼容**：context-compact-runner L175-177 的 buildPostCompactSnapshot + updateContextWindowUsage + dispatchPostCompact 顺序保留——补 notify 在 L164 accumulate 之后立即执行，先于 postCompact phase；postSnapshot 的 updateContextWindowUsage（L176）会触发自己的 notify（既有机制），与本补 notify 独立无害（两发 event 都是全量 view 全量替换）。

## 验收要点（reviewer 查偏离用）

- run-react-loop.ts 三条 return 全部填 `accumulatedUsage`（grep `{} as never` 在本文件应为 0 命中）
- sumUsage 复用 NUMERIC_KEYS（不重新列字段）；null 入参兼容
- 两个 caller 的 accumulateUsage 调用后紧跟 `for (const s of chain) await ...notifyUsageChanged(s)` 循环
- run-lifecycle-port.ts L70 `if (partition === 'forked') return;` 保留不动
- 不动：component-usage-panel.tsx / onUsage / attachRunPromise / NUMERIC_KEYS 字段集合

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
