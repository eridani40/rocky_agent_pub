# v0.0.354 change_log — 一轮多 tool 结果逐个 SSE 推送

> 依据：`states/bugs/BUG-multi-tool-result-sse-batch-[open].md`（方案 A）+ change_plan（本目录）。纯技术改动（SSE 时序优化）跳 PRD。

## 变更摘要

| # | 内容 | commit |
|---|------|--------|
| T1 | engine 增量回调 onResult + executeAndEmit 逐个 emit/span + span 时长修复 | `f8ead0e3e` |
| — | T1 code review PASSED | `1aaa954a8` |

## T1 实现记录

- **engine.ts**：`ExecuteRunCtx` 增可选 `onResult?: (result, index) => void`；抽 `pushResult` helper（push results + try/catch 调回调，fail-silent 对齐 writeToolLog）；**7 条产出路径**（白名单外/未注册/invalid-input/deny/ask-pending/interaction-pending/runTool）全走 helper；`for...of` → indexed loop（回调需下标）。
- **agent-loop-stage-tool.ts**：删「批量预起 span + await 全批后同步连发」旧流程；改回调注入——每 result 到达即 `emitToolResult` + 逐个 `startToolSpan`/`endToolSpan`（finally 闭合防 span 悬挂）；**span startTime 串行推导**（上一 result 完成时刻 = 下一 tool 开始时刻，首 tool 用 execute 起点）→ durationMs 回归真实执行时长（不再含批内排队）。
- **agent-loop-base.ts**：`ExecuteToolsInput.toolEngine` 鸭子类型签名同步扩 onResult（+1）。
- **不变式**：返回值 `{results, pending}` 等长同序不变；落盘整批 ingest 不变（ingestToolResults 仍在 executeAndEmit 返回后调用）；帧序不变式保持（每 result 三帧相邻、全部 result 帧先于 tool_execution_end）；RunSpec 零改动（回调是 loop 内部编排细节）。

## 编码期偏离记录

| # | 偏离 | 处置 |
|---|------|------|
| ① | bun.lock 被 bun install 污染 | 还原未提交（review §6 核实 0 残留） |
| ② | stop-reason-and-loop-pending mock 引擎补 opts 参数 + onResult 模拟 | mock 契约补齐（模拟真实 engine 每 result 回调；不补则 emit 全不发生）；零断言删除/放宽，review 判定成立 |

## 验证

- UT：定向 21/21（engine-onresult 11 + stage-tool-incremental-emit 3 + stop-reason-and-loop-pending 7）；全量 `bun run test` **10735 passed / 4 skipped / 0 failed**；`tsc -b` 0 error。
- Review：**PASSED**（6 重点独立实证，states/v0.0.354/verify/review/code-review-t1.md）。
- AT：冒烟 5/5（mr_tc1-4 + sse_message_stream，39.7s）——sse_message_stream 帧时序断言直接相关（run_start/run_end 各 1 帧 + 顺序 + 无 error）。报告 `states/v0.0.354/verify/api-test/AT_report_smoke.md`。
- ET：**豁免**——前端零改动（行为变化在服务端帧到达时机；reducer 按独立 messageId 建节点逐帧渲染，帧序不变式保持）；UT 时序断言 + AT 帧序断言已覆盖。豁免理由记 task-board Check [11:50]。

## Bug 闭环

`BUG-multi-tool-result-sse-batch`（中）：根因 executeAndEmit await 全批后同 tick 连发（最慢工具扣住全部结果可见时间）+ span 批量预起含排队时间——本版本方案 A 关闭（快慢时序 UT 量化断言 + span 时长断言钉住）。

## doc-sync（2026-08-15）

| 文件 | 变更 |
|------|------|
| `specs/tech/agent/tools/[P0]tool_execution_engine.md` | §3 签名补 `opts?: ExecuteRunCtx`（onResult 契约 7 路径/fail-silent/不传=现状）；§4 伪代码 pushResult helper 化 |
| `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_base.md` | §2.2 emit 时机逐个化（onResult 回调 + span 串行推导 + 不变式）；§7.2 帧序表 [v0.0.354] 注记（到达即逐个发出） |
| `specs/tech/agent/observability/[P0]observability_interface.md` | ToolSpanMetadata.durationMs 注释（真实执行时长，不含批内排队） |
| KB log ×3（tools / agent_interface_and_loop / observability） | 位置轴条目 |
| `states/v0.0.354/task-board.md` | Check 补 review/ET 豁免/doc-sync 三行 |
| 未改（核实无需） | unified（③ 编排不变）/ agent_hitl（INV-1 整批收集语义仍正确）/ api spec（契约零变化，仅帧到达时机）/ langfuse_adapter（字段映射不变） |
