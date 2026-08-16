# v0.0.354 change_plan — 一轮多 tool 结果逐个 SSE 推送

> 依据：`states/bugs/BUG-multi-tool-result-sse-batch-[open].md`（方案 A，架构期已复核）。
> 基线：worktree `v0.0.354-tool-result-streaming`（dev1@4e55655e1）。
> 纯技术改动（SSE 时序优化，无 UI 概念变化）跳 PRD。

## 决策记录

| # | 决策 | 依据 |
|---|------|------|
| D1 | 采用方案 A：engine 增量回调 `onResult`，emit 随执行逐个发 | BUG 报告 §5；改动最小且不动落盘/前端 |
| D2 | `execute()` 返回值 `{results, pending}` 契约不变（等长同序 + HITL pending 语义） | 落盘模型（ingestToolResults 整批一条 tool 消息）与 HITL 整批配对（INV-1）不动 |
| D3 | span 粒度顺带修复：start 逐个化，快工具 span 时长不再被拉长到含排队时间 | BUG 报告 §3.6；durationMs 语义回归真实执行时长 |
| D4 | **修正报告一处假设**：forked 路径 `wireEmitCtx` 与 main 一样由 build-run-deps 装配（`executeToolsForSpec` L314 硬要求非空，无 emitCtx 即 throw），不存在「forked 无 emitCtx → emit no-op」分支 | 源码实证 `build-run-deps.ts:147,248` + `run-react-loop.ts:313-314` |

## 现状实证复核（报告结论抽查，全部确认）

- `agent-loop-stage-tool.ts:71-91`：`toolSpanStarts` 在 execute 前批量预起（含排队时间）→ `await baseExecuteTools`（汇合点，最慢工具决定全部可见时间）→ 同步 for 循环逐个 emit + endSpan。**根因确认**。
- `engine.ts:132-240`：串行 for...of，7 处 `results.push` 分支（not-in-whitelist reject / not-registered reject / invalid-input / deny / ask-pending / interaction-pending / runTool 正常+超时+异常）。**回调需覆盖全部 7 路径**。
- `agent-loop-emitters.ts:264-291` emitToolResult：per-result 独立 messageId + start/delta/end 三帧。**emit 粒度本就正确，纯时机问题**。
- `agent-loop-base.ts:332-364` ExecuteToolsInput.toolEngine 是结构化鸭子类型；`agent-loop-stage-tool.ts:30` `config: Parameters<ToolExecutionEngine['execute']>[0]`——**两处类型需同步扩 onResult**。
- `run-react-loop.ts:184-197`：emitToolExecutionStart → executeToolsForSpec → ingestToolResults → emitToolExecutionEnd。执行中逐个 emit 后帧序仍满足「全部 result 帧先于 execution_end」。
- `sse-channel.ts` 逐帧即写，无通道攒批（排除项维持）。

## 契约表（method 级）

| 模块 | 文件 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计行 |
|------|------|----------|------|---------|------|------|--------|
| tools | app/server/src/tools/engine.ts | `ExecuteRunCtx` | 修改 | 增可选 `onResult?: (result: ToolResultBlock, index: number) => void` | MUST：可选字段，不传=现状（零行为变化）；MUST NOT：不改变 results/pending 语义 | BUG 报告 §5 | +3 |
| tools | app/server/src/tools/engine.ts | `ToolExecutionEngine.execute` | 修改 | 抽 `pushResult(result)` 私有 helper（push results + try/catch 调 `opts?.onResult?.(result, index)`），7 处 `results.push(...)` 全部替换 | MUST：7 路径全走回调（reject/invalid/deny/pending×2/runTool 三态）；onResult 抛错 fail-silent 吞掉（绝不影响执行主流程，对齐 writeToolLog 风格）；MUST NOT：回调内不得再触发 IO 阻塞执行串行 | 同上 | ~25 |
| agent | app/server/src/agent/agent-loop-base.ts | `ExecuteToolsInput.toolEngine` | 修改 | execute 结构类型签名同步加 `onResult`（对齐 engine ExecuteRunCtx） | MUST：鸭子类型与真实 engine 签名保持一致 | base §2.2 | +1 |
| agent | app/server/src/agent/agent-loop-stage-tool.ts | `ExecuteAndEmitInput.opts` | 修改 | opts 增可选 `onResult`（透传 baseExecuteTools） | 同上 | 同上 | +2 |
| agent | app/server/src/agent/agent-loop-stage-tool.ts | `executeAndEmit` | 修改 | ① 删除 `toolSpanStarts` 批量预起 + 后置 emit 循环；② 改为回调注入：每个 result 到达即 `emitToolResult` + 逐个 `startToolSpan`（进一个起一个，startTime=该 tool 真实开始时刻）→ 执行完 `endToolSpan`；③ 返回值 `{results, pending}` 不变 | MUST：forked/main 共用本函数，emitCtx 两态均安全（publish 有开关）；MUST NOT：不把 emit/ingest 职责挪进 engine（engine 只回调，emit 留 loop 层） | BUG §5 A-2 | ~35 |
| agent | app/server/src/agent/run-react-loop.ts | `executeToolsForSpec` | 修改 | opts 透传不变（onResult 在 executeAndEmit 内部注入，不经 spec） | MUST NOT：RunSpec 不加字段（回调是 loop 内部编排细节，不是 run 级依赖） | 同上 | 0 |
| tests | app/server/src/tools/__tests__/engine-onresult.test.ts | 新增 | 新增 | UT：①快慢工具时序（fast A → slow B → fast C，断言回调序=[A,B,C] 且 A 的回调显著早于 B，用 fake timers/可控 deferred promise）；②7 路径逐一断言 onResult 触发（reject/invalid-input/deny/ask-pending/interaction-pending/runTool 正常+超时）；③onResult 抛错不影响执行与返回值；④不传 onResult 行为不变（回归） | MUST：断言逐帧到达间隔（A.emitTick < B.emitTick），非仅顺序 | planner 验收标准 | ~150 |
| tests | app/server/src/agent/__tests__/stage-tool-incremental-emit.test.ts | 新增 | 新增 | UT：executeAndEmit 级——快慢 mock 工具，断言 ①事件序：每 result 的 start/delta/end 相邻且 execution_end 在全部 result 之后（不变式保持）；②SSE 帧到达间隔：fast result 帧先于 slow result 帧；③span 修复：slow tool 的 span durationMs 不含 fast tool 排队时间（endToolSpan startTime=逐个起点） | MUST：mock obs 记录 start/end 时间戳 | BUG §5 验证建议 | ~120 |
| tests | 既有 agent-loop 相关 UT | 修改 | 修改 | run-react-loop.test.ts mock 了 `executeAndEmit: vi.fn()`（L?）——签名不变（返回值/入参结构不变，仅 opts 增可选字段），预期零改；若有断言 emit 时序的用例需按新时序修正 | MUST：tsc -b 全量过 | typecheck 硬验收 | ~10 |

## 风险清单

| 风险 | 验证点 |
|------|--------|
| HITL 整批配对被破坏 | pending 占位 block 仍在 results 同序返回（D2）；stage-tool UT 覆盖 ask-pending/interaction-pending 路径回调后 results/pending 与现状全等 |
| 落盘整批 ingest 语义漂移 | ingestToolResults 零改动（run-react-loop 编排不变）；UT 断言 toolMessage.content=results 整批 |
| 前端帧序兼容 | 不变式保持：每 result 三帧相邻 + 全部 result 先于 tool_execution_end（reducer 按独立 messageId 建节点，v0.0.19 契约，逐帧到达即逐个渲染） |
| onResult 回调抛错炸执行链 | engine pushResult try/catch fail-silent（对齐 writeToolLog）+ UT ③ |
| span 时长失真修复引入新失真 | durationMs=真实执行时长（start 逐个化）；UT ③ 用 mock obs 断言 slow span 不含 fast 排队 |
| emitCtx 开关态（forked proxy） | publish 内部按 group 开关早退（emitters.ts:56-61 既有逻辑），回调注入两态安全 |

## 影响面外（零改动）

- `loop-stage-context.ts` ingestToolResults / `agent-loop-emitters.ts` emitToolResult / `sse-channel.ts` / 前端全部 / `RunSpec`（loop-ports.ts）
- AT/ET：默认冒烟集回归即可（无新端点、无新不确定场景，不新增持久 case）；按版本执行标准属「后端逻辑改动」→ AT 默认跑既有冒烟集。
