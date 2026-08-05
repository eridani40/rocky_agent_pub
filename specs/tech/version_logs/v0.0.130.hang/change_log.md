# v0.0.130.hang 变更发布说明 — Agent Hang 系统性修复

> 跨版本发布说明（版本轴）。方法级变更契约见同目录 `change_plan.md`；各 KB 位置轴变更见对应 `log.md`。
> 范围 = A（tool 超时体系）+ B（子进程治理）+ P6（SSE 阶段事件 + UI 渲染）+ F（max_iterations 轮次边界）+ C（watchdog 仅留接口）。E（agent.log breadcrumb）已在 dev1 基线，本版复用其 breadcrumb 作 SSE 阶段事件（一机制两用）。

## 背景

Agent hang 全层失败：live 案例 bash 跑 bge 下载卡死无超时 → session 永 running。根因链：`ctx.signal` 从未装配（spec 早声明契约但代码是死线）+ bash 子进程无组杀（孙进程继承 pipe → close 永不触发 → tool.run 永不 resolve）+ UI 停「思考中」看不出卡在哪 + max_iterations 半轮 dangling tool_use。

## A — Tool 超时体系（`tools/`）

- **三层超时**（`resolveEffectiveTimeout`）：per-call `arguments.timeout` > per-tool `Tool.defaultTimeoutMs`（file×5=10s / web×2=30s / bash=120s / agent=600s / 未声明=30s）> engine 默认 30s；`clamp(1, 600000)` 硬天花板 600s。
- **backstop race**（`runTool`）：每次真实 `tool.run` 建 per-tool `AbortController` → `ctx.signal`；`Promise.race([tool.run, timer])`，timer=`min(effective + GRACE(5s), 600000)`。GRACE 给工具自身超时优先触发余量，engine 只补刀。命中 → `controller.abort()`（触发真实清理）+ `[timeout] <tool> exceeded <ms>ms (engine backstop)` isError result；`finally` 清 timer。
- **统一超时文案**：`formatTimeoutText` 唯一格式化点，engine backstop 与 bash 内部超时两路径同前缀 `[timeout] <name> exceeded <ms>ms`。
- **HITL 结构性豁免**：`checkPermission=ask` / `interaction` 悬挂分支在 `execute()` 内物理早于 `runTool` continue，永不进超时 race。
- 落 `tools/engine-timeout.ts`（常量 + resolveEffectiveTimeout + formatTimeoutText，engine.ts re-export）。spec: `agent/tools/[P0]tool_execution_engine.md §2/§4.2`（承诺→已兑现）。

## B — 子进程治理（`tools/`）

- **bash 组杀根因修复**：`runShell` / `SecureBashEngine.exec` 两处 spawn 加 `detached:true` 建进程组；新 `killProcessGroup`（负 pid 组杀，SIGTERM→500ms→SIGKILL，ESRCH fallback child.kill，全 catch）；`wireChildLifecycle` 三条 kill 路径全走组杀 + registry register/unregister 收支平衡。spec: `agent/tools/[P0]bash_tools.md §4.5`。
- **ChildProcessRegistry**（新 `tools/child-process-registry.ts`）：run 级内存类，`register/unregister/killAll/size`；`killAll` 遍历负 pgid SIGTERM→500ms→SIGKILL，幂等 + 全 catch。挂 `AbortControllerHandle.childRegistry`（agent-manager 两处 controller 创建时 new）。
- **run 级 sweep**：`abort-finalize.abortRun` 在 `aborted=true` 后 fire-and-forget `childRegistry.killAll()`（主对话 & forked 两分支）——解卡在 hung tool 的 loop（pipe 释放 → tool.run resolve → 抵达检查点退出）。**边界裁决**：不硬链 ctx.signal 到 run controller；单 tool 超时 ctx.signal 自清不调 killAll；reconcile 不接 killAll（死代码，排除）。spec: `agent/agent_interface_and_loop/[P0]agent_interrupt.md §3.1`。

## P6 — SSE 阶段事件 + UI 渲染

- **后端**：新增 `ToolExecutionStartEvent{toolNames,toolCallIds}`（③ execute 前）+ `ToolExecutionEndEvent{resultCount?,pendingCount?}`（ingest 后），与 `loop_tools_begin/end` breadcrumb 同址。不复用 `tool_result_start`（语义相反）。经 bus→SSE 通用转发（无 encoder 白名单）。spec: `agent/agent_interface_and_loop/[P0]agent_event.md §5.6`。
- **前端**：`tool_execution_start` → `loadingPhase='tool_executing'`（执行开始即置，修 hang 停「思考中」）+ `runningToolNames`；`ComponentLoadingStatus` 渲染「运行工具: `<names>`」（i18n `loading.toolExecutingNamed` 中英双语）；`tool_execution_end` 清 runningToolNames；`run_end` 兜底归零；`tool_result_start` phase 兜底保留（旧回放）。数据流：`chat-slice-reducer` → `use-messages` → `page-chat` → `section-chat-detail` → `component-message-stream` → `ComponentLoadingStatus`。spec: `specs/ui/components/chat-page/_overview.md §4.10`；prd `03-llm-chat.md §3.1`。

## F — max_iterations 轮次边界（`run-react-loop.ts`）

- 判定从「② callLLM 后、③ 执行前」整块删除，迁到 ④ Exit Check `state.step++` 之后（轮次边界）。一轮 = LLM→工具执行→result 落盘，凡落盘 tool_use 必有配对 tool_result（消灭 dangling 半轮，live 案例 `01KX5WDBT2`）；第 maxIter+1 次 LLM 不再发生。off-by-one：`maxIter=25` 恰 25 完整轮后停，`endStepSpan(state,true)`。行为变化（用户知悉接受）：不再有「第 26 次调用碰巧纯文本走 no_tool_call 优雅收尾」路径。spec: `agent_loop_unified.md §2` + `agent_loop_base.md §6` + index ④ #17。

## C — loop watchdog（仅留接口）

新 stub `agent/loop-watchdog.ts`：interface `LoopWatchdog{reset,stop}` + 180s 无进展→abort 语义注释；本版**不 wire 进 runReActLoop、不实现类、无运行时依赖**（供后续版本实现）。

## dev-logs 补记（spec↔code 对齐）

`enableAgentLog`/`enableErrorLog` 早随 breadcrumb 落 dev1，dev-logs KB 仍写「4 hook」——本版补 §3.5 agent breadcrumb hook + §3.6 error hook（4→6 hook）。`loop_tools_begin/end` 是 P6 SSE 事件同址来源。

## 验证口径

各 task 验证 = UT + code review 全绿（6 task 全 verified）。AT/ET 用户裁决豁免本版（Round1 撞 429 配额、Round2 证实产品实现全对但 case 层 4 处缺陷需再迭代，用户判定继续迭代成本>价值）；5 新 case + 部分修复保留在 tests/ 作后续资产。

## 破坏性 / 兼容性

- `Tool`/`ToolCtx`/`ExecOpts`/`AbortControllerHandle`/opts 均**加可选字段**——向后兼容，无破坏性接口变更。
- 新增 2 个 SSE 事件类型（前后端联合加，通用转发无 encoder 白名单）。
- 无新第三方依赖 / 无新 plugin / 无新运行时 env 键 / 无新文件系统启动入口 → packaged 护栏 BUG-001~004 均不触发（`process.kill`/`spawn detached` 为 node 内建，Electron Node 主进程可用）。
