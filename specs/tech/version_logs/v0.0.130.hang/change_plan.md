# v0.0.130.hang 变更计划书 — Agent Hang 系统性修复（tool 超时体系 + 子进程治理 + SSE 阶段事件）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 诊断+方案权威源：`reqs/[working] v0.0.130.hang/{findings.md, plan.md}`。范围 = **A（tool 超时体系）+ B（子进程治理）+ P6（SSE 阶段事件 + UI 渲染）+ C（watchdog 仅留接口）+ F（max_iterations 轮次边界，中途并入，用户裁决）**。E（agent.log breadcrumb）已在 dev1 落地，本版不含。

## 关键设计决策（review 时对照）

1. **超时 race 只裹执行阶段 `runTool`，HITL 绝不进 race**（用户强约束）。`engine.execute` 内 checkPermission-ask / interaction 分支在 `runTool` **之前**走 `buildPendingResult`（现有 pending 路径），race 只包 `await tool.run` 那一步 → ask-question / 审批卡永不被超时杀。
2. **三层超时**：per-call（`call.arguments.timeout` ms，通用约定，bash 已有）> per-tool `Tool.defaultTimeoutMs` > engine 默认 30s；全局硬天花板 **600s**。`effective = clamp(perCall ?? tool.defaultTimeoutMs ?? 30000, 1, 600000)`；engine 兜底 race 触发点 = `min(effective + GRACE(≈5s), 600000)`（**backstop 语义**：bash 等自带超时的工具先由自身 timer 触发优雅清理，engine 仅在工具自身处理失效时才补刀）。
3. **超时经 AbortSignal 触发真实清理**（非"不 await 了"）。engine 为每个 `runTool` 建 per-tool `AbortController`，`ctx.signal = controller.signal`；超时 → `controller.abort()` → bash `wireChildLifecycle` 的 signal 监听 → **进程组** kill（B 修）→ pipe 释放 → close 触发 → `tool.run` resolve。同时产 `[TIMEOUT] <tool> 超过 <X>ms` tool_result（isError=true），loop 继续，**不留 dangling tool_use**。
4. **ChildProcessRegistry 归属**：tools 层本地新类（`tools/child-process-registry.ts`），**挂在 `AbortControllerHandle.childRegistry`**（run 级唯一取消对象，agent-manager 建 controller 时一并建）。注册链：`run-react-loop` 经 `spec.controller.childRegistry` → 沿现有 `opts` 透传链（executeToolsForSpec→executeAndEmit→executeTools→engine.execute）→ `ctx.childRegistry` → bash → `ExecOpts.childRegistry` → `wireChildLifecycle`（spawn 时 register(pid,pgid)，close 时 unregister）。`killAll()` = 遍历 SIGTERM→500ms→SIGKILL 杀进程组。**killAll 触发点**：(a) run abort/interrupt → `abort-finalize` 调 `controller.childRegistry?.killAll()`；(b) 单 tool 超时由 ctx.signal 自清（不调 killAll，killAll 是 run 终止级 sweep）。**reconcile 不接 killAll**（重启后新进程内存 registry 为空，旧进程子进程已孤儿——B 的组杀在进程存活期即防孤儿，故 reconcile 接 killAll 是死代码，明确排除）。
5. **新 SSE 事件 `tool_execution_start {toolNames, toolCallIds}` + `tool_execution_end {}`**：**不复用 `tool_result_start`**（其语义=结果开始返回=执行已结束）。emit 位置 = `runReActLoop ③ tools 段`，与已存在的 `loop_tools_begin/end` agent.log breadcrumb 同址（execute 前 / ingest 后），走 `spec.wireEmitCtx`。事件经 bus→SSE 通用转发（无 encoder 白名单，已核实无服务端 exhaustive switch）。
6. **前端**：`tool_execution_start` → `loadingPhase='tool_executing'`（在**执行开始**而非结果返回时；现状仅 `tool_result_start` 才置 tool_executing → hang 时永停「思考中」）+ 存 `runningToolNames` → `ComponentLoadingStatus` 渲染「运行工具: bash」。stopReason 外显复用现有 `lastRunFinish`+`component-run-finish`+`localizedStopReason`（tool_pending/error/interrupted 已覆盖）；`[TIMEOUT]` 作为 tool_result isError 在 tool batch 内呈现（loop 续跑，非 stopReason）。
7. **C watchdog 仅留接口**：新 stub 文件 `agent/loop-watchdog.ts`（interface + 180s-no-progress→abort 语义注释），**本版不 wire 进 runReActLoop**。

## Spec drift（doc-modifier 阶段5 修）

- **`tools/[P0]tool_execution_engine.md §2/§4`** 已写「`ctx.signal` 传入 tool.run，工具自行响应」+「引擎层可加 overall timeout 兜底」，但**现 engine.ts 构造 ctx 时未设 signal**（`ctx.signal` 恒 undefined → bash.ts:105 `signal: ctx.signal` 当前为死线）且**无 overall timeout**。本版实现 spec 早已承诺的契约。§4 需补三层超时数值表 + ctx.signal 装配 + ChildProcessRegistry。
- findings/plan 行号（engine.ts:215 `await tool.run`、bash-engine.ts killTerm 93-100 / SIGKILL 107 / runShell spawn 141 / SecureBashEngine spawn 240）已逐一核对，结构与现码一致。

---

## 模块 A — Tool 超时体系（owning 级别：文件级 `tools/engine.ts` + `tools/types.ts` + 各 tool 单例 defaultTimeoutMs 字段）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tool-engine | app/server/src/tools/types.ts | `Tool.defaultTimeoutMs?` | 修改 | Tool 接口加可选字段 `defaultTimeoutMs?: number`（per-tool 默认超时 ms，engine 读）；缺省=engine 兜底 30s | MUST 可选（未声明 tool 行为不变）；MUST NOT 放 ToolDefinition（非 LLM 面向，属执行契约） | tool_execution_engine §2；plan §4 数值表 | +3 |
| tool-engine | app/server/src/tools/types.ts | `ToolCtx.childRegistry?` | 修改 | ToolCtx 加 `childRegistry?: ChildProcessRegistry`（tools-local 类型，spawn 型工具注册子进程用） | MUST import 本地 `./child-process-registry`（不 import agent 层，守依赖方向） | 设计决策#4 | +2 |
| tool-engine | app/server/src/tools/engine.ts | `TOOL_TIMEOUT_CEILING_MS` / `DEFAULT_TOOL_TIMEOUT_MS` / `TIMEOUT_GRACE_MS` | 新增 | 模块常量：600000 / 30000 / ≈5000（backstop 余量） | MUST 硬天花板 600000 对所有 tool.run 生效 | plan §4；设计决策#2 | +4 |
| tool-engine | app/server/src/tools/engine.ts | `resolveEffectiveTimeout()` | 新增 | 纯函数：读 `call.arguments.timeout`（number ms，非法则忽略）+ `tool.defaultTimeoutMs` → `clamp(perCall ?? default ?? 30000, 1, 600000)` 返 effective | MUST 只读入参不改；per-call 优先 per-tool 优先默认；封顶 600s | 设计决策#2；tool_execution_engine §4 | +14 |
| tool-engine | app/server/src/tools/engine.ts | `ExecuteRunCtx` | 修改 | opts 类型加 `childRegistry?: ChildProcessRegistry`（沿现有 opts 透传链，不新增 execute 参数） | MUST 复用现 opts 对象（executeTools/executeAndEmit 同步加同名字段） | 设计决策#4；base ExecuteToolsInput.opts | +2 |
| tool-engine | app/server/src/tools/engine.ts | `ToolExecutionEngine.execute()` | 修改 | ctx 构造补 `childRegistry: opts?.childRegistry`；调 `runTool` 时传 effective timeout（由 resolveEffectiveTimeout(tool, call) 算）。**HITL 分支（checkPermission-ask / interaction → buildPendingResult）位置不动，仍在 runTool 之前** | MUST NOT 把 HITL pending 分支纳入超时 race；MUST 只给 §4 step4 的真实 run 套超时 | tool_execution_engine §4/§5；设计决策#1 | +6/-2 |
| tool-engine | app/server/src/tools/engine.ts | `ToolExecutionEngine.runTool()` | 修改 | 建 per-tool `AbortController` → `ctx.signal`；`Promise.race([tool.run(input,ctx), timeoutPromise])`，timeout=`min(effective+GRACE,600000)`；超时 → `controller.abort()`（触发工具真实清理）+ 返 `errorResult('[timeout] <name> exceeded <effective>ms')`（isError=true，用 `ToolErrorCode.TIMEOUT`）。正常 resolve 清 timer。签名加 `effectiveTimeoutMs: number` 参 | MUST 超时经 AbortSignal 触发清理（非仅丢弃 promise）；MUST 产合法 tool_result 不留 dangling；MUST NOT 吞正常 isError 结果 | 设计决策#2/#3；tool_execution_engine §4 step4；ToolErrorCode.TIMEOUT（types.ts:267 已存在） | +34/-3 |
| tool-engine | app/server/src/tools/file-read.ts / file-write.ts / file-edit.ts / file-glob.ts / file-grep.ts | `fileReadTool` / `fileWriteTool` / `fileEditTool` / `fileGlobTool` / `fileGrepTool` | 修改 | 各单例加 `defaultTimeoutMs: 10000` | MUST 仅加字段，run 逻辑不动 | plan §4（只读快工具 10s） | +1×5 |
| tool-engine | app/server/src/tools/web-fetch/tool.ts / web-search/tool.ts | `webFetchTool` / `webSearchTool` | 修改 | 各加 `defaultTimeoutMs: 30000` | MUST 仅加字段（工具内部自有网络超时仍在，engine 为 backstop） | plan §4（网络 30s） | +1×2 |
| tool-engine | app/server/src/tools/bash.ts | `bashTool` | 修改 | 加 `defaultTimeoutMs: 120000`（与 DEFAULT_TIMEOUT 对齐；LLM 可 per-call 传更大，封顶 600s）；run 内 `getBashEngine().exec` 的 opts 传 `childRegistry: ctx.childRegistry`（B） | MUST 与 bash MAX_TIMEOUT 600s 一致；per-call>default | plan §4；bash_tools §2 | +2 |
| tool-engine | app/server/src/agent/tools/agent-tool.ts | `agentTool` | 修改 | 加 `defaultTimeoutMs: 600000`（spawn sync follow-child 上限） | MUST 仅加字段 | plan §4（agent.spawn sync 600s） | +1 |

---

## 模块 B — 子进程治理（owning：新文件 `child-process-registry.ts` 整文件 + `bash-engine.ts` 方法级 + registry 集成的方法级散点）

### B-1 bash-engine 组杀 + detached（同一根因：孙进程继承 pipe → close 永不触发）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| bash-impl | app/server/src/tools/bash-engine.ts | `killProcessGroup()` | 新增 | 本地组杀 helper：`process.kill(-child.pid, sig)` 杀进程组，ESRCH/失败 fallback `child.kill(sig)`（照搬 chrome-launcher.ts:179 pattern，本地实现避免 tools→browser 跨模块耦合） | MUST 用负 pid 杀组；MUST 兼容进程已退（catch ESRCH） | chrome-launcher.ts:179 killProcessGroup；findings §3 修法 | +16 |
| bash-impl | app/server/src/tools/bash-engine.ts | `wireChildLifecycle()` | 修改 | `killTerm` 的 `child.kill('SIGTERM')`（:96）改 `killProcessGroup(child,'SIGTERM')`；500ms 后 `child.kill('SIGKILL')`（:107）改 `killProcessGroup(child,'SIGKILL')`；signal 联动 killTerm（:115-118）保留但走组杀。新增：spawn 后 `opts.childRegistry?.register(child)`，`finish()` 内 `opts.childRegistry?.unregister(child.pid)` | MUST 组杀（杀 shell+python+tail 全树）；MUST close/error 时 unregister（防 registry 泄漏）；MUST NOT 改输出合并/timedOut 语义 | findings §3；设计决策#3/#4 | +12/-4 |
| bash-impl | app/server/src/tools/bash-engine.ts | `ExecOpts` | 修改 | 加 `childRegistry?: ChildProcessRegistry`（bash tool 透传，wireChildLifecycle 注册用） | MUST 可选（非 bash 调用方不受影响） | 设计决策#4 | +2 |
| bash-impl | app/server/src/tools/bash-engine.ts | `runShell()` | 修改 | `spawn(...)`（:141）加 `detached: true`（建进程组 pgid=child.pid）；childRegistry 经 opts 透传给 wireChildLifecycle | MUST detached:true 建组（否则组杀打不到孙进程）；MUST NOT 改 shell/cwd/stdio 合并语义 | findings §3；chrome-launcher spawnChromeProcess:167 | +3/-1 |
| bash-impl | app/server/src/tools/bash-engine.ts | `SecureBashEngine.exec()` | 修改 | `spawn('/usr/bin/sandbox-exec', ...)`（:240）加 `detached: true`；opts.childRegistry 透传 wireChildLifecycle | MUST detached:true；非 darwin passthrough 分支已走 runShell（同步获组杀） | findings §3；bash_tools §4 | +3/-1 |

### B-2 ChildProcessRegistry + run 生命周期集成

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tool-engine | app/server/src/tools/child-process-registry.ts | `ChildProcessRegistry` | 新增 | 新文件新类：`register(child: ChildProcess)`（记 pid+pgid）/ `unregister(pid)` / `killAll(): Promise<void>`（遍历 `process.kill(-pgid,'SIGTERM')`→500ms→`SIGKILL`，ESRCH 容错）/ `size`。run 级实例，内存 only 不落盘 | MUST 组杀（负 pgid）；MUST killAll 幂等 + 全 catch（单个失败不阻断其余）；单文件 ≤300 行 | 设计决策#4；chrome-launcher killProcessGroup pattern | +60 |
| agent-loop | app/server/src/agent/agent-interface.ts | `AbortControllerHandle` | 修改 | 加可选 `childRegistry?: ChildProcessRegistry`（run 级子进程 registry 挂载点；type-only import tools 层） | MUST 可选（auto-naming 等零参构造 controller 不受影响）；agent→tools 依赖方向合法 | 设计决策#4 | +3 |
| agent-loop | app/server/src/agent/agent-manager.ts | controller 创建（:263 + :391 两处） | 修改 | `const controller: AbortControllerHandle = { runId: newRunId, aborted: false, childRegistry: new ChildProcessRegistry() }` | MUST 两处 run 启动点都建 registry（主对话 + 另一入口）；MUST NOT 改 CAS markRunning 时序 | 设计决策#4；agent-manager.ts:263/:391 | +2 |
| agent-loop | app/server/src/agent/abort-finalize.ts | `abortRun()` | 修改 | step1 置 `controller.aborted=true` 后（主对话 & forked 旁路两分支）调 `void controller.childRegistry?.killAll()`（直接杀在途子进程 → 卡死 tool 的 pipe 释放 → tool.run resolve → loop 到检查点退出 interrupted） | MUST 在 aborted=true 后触发（让阻塞在 hung tool 的 loop 能真正被中断）；MUST fire-and-forget 不阻塞 abort 收尾 | 设计决策#4；agent_interrupt §3 | +3 |
| agent-loop | app/server/src/agent/run-react-loop.ts | `executeToolsForSpec()` | 修改 | opts 补 `childRegistry: spec.controller.childRegistry`（沿 opts 透传链下沉引擎→ctx→bash） | MUST 经 spec.controller 取（run 级唯一源）；MUST NOT 每 step 新建 registry | 设计决策#4；run-react-loop:291-306 | +1 |
| agent-loop | app/server/src/agent/agent-loop-stage-tool.ts | `ExecuteAndEmitInput.opts` + `executeAndEmit()` | 修改 | opts 内联类型 `{ runId?: string }` 加 `childRegistry?: ChildProcessRegistry`；executeAndEmit 原样透传给 baseExecuteTools（无逻辑改动） | MUST 仅透传字段 | opts 透传链 | +2 |
| agent-loop | app/server/src/agent/agent-loop-base.ts | `ExecuteToolsInput.opts` + `execute` 签名 | 修改 | ExecuteToolsInput.opts 及内嵌 toolEngine.execute 的 `opts?: {runId?}` 内联类型加 `childRegistry?`（type 对齐 engine ExecuteRunCtx） | MUST 类型对齐 engine 层 opts | agent-loop-base.ts:299-317 | +2 |

---

## 模块 P6-backend — SSE 阶段事件（owning：`agent-event-types.ts` + `agent-loop-emitters.ts` 方法级 + run-react-loop emit 点）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-event | app/server/src/agent/agent-event-types.ts | `ToolExecutionStartEvent` | 新增 | `{ type:'tool_execution_start'; toolNames: string[]; toolCallIds: string[] }` extends AgentEventBase（标记③执行开始，填 message_end→tool_result 之间的空白） | MUST NOT 复用 tool_result_start（语义=执行已结束）；字段与 loop_tools_begin breadcrumb 对齐 | plan §2 SSE 序列；agent_event §3 | +8 |
| agent-event | app/server/src/agent/agent-event-types.ts | `ToolExecutionEndEvent` | 新增 | `{ type:'tool_execution_end'; resultCount?: number; pendingCount?: number }` extends AgentEventBase | MUST 与 loop_tools_end breadcrumb 语义对齐 | plan §2 | +6 |
| agent-event | app/server/src/agent/agent-event-types.ts | `AgentEventType` + `AgentEvent` 联合 | 修改 | 两联合各加 `'tool_execution_start' \| 'tool_execution_end'` / `ToolExecutionStartEvent \| ToolExecutionEndEvent` | MUST 两处都加（discriminated union 闭合） | agent-event-types.ts:51/367 | +4 |
| agent-event | app/server/src/agent/agent-loop-emitters.ts | `emitToolExecutionStart()` | 新增 | `(ctx, toolNames, toolCallIds)` → publish tool_execution_start（复用 base(ctx)+publish，走 groupKeyForMode 路由） | MUST 复用现有 publish/base（不新造 group 逻辑） | agent-loop-emitters.ts:77-96 pattern | +12 |
| agent-event | app/server/src/agent/agent-loop-emitters.ts | `emitToolExecutionEnd()` | 新增 | `(ctx, resultCount, pendingCount)` → publish tool_execution_end | MUST 复用 publish/base | 同上 | +10 |
| agent-event | app/server/src/agent/run-react-loop.ts | `runReActLoop`（③ tools 段 emit） | 修改 | `loop_tools_begin` breadcrumb 处（:184，executeToolsForSpec 前）加 `if(spec.wireEmitCtx) emitToolExecutionStart(spec.wireEmitCtx, toolCalls.map(c=>c.name), toolCalls.map(c=>c.id))`；`loop_tools_end` 处（:190，ingestToolResults 后）加 `emitToolExecutionEnd(spec.wireEmitCtx, results.length, pending.length)` | MUST 与 breadcrumb 同址（execute 前 / ingest 后）；MUST 经 wireEmitCtx（forked 无 emitCtx 则跳过）；MUST NOT 改 pending 悬挂分流逻辑 | plan §1 P6；run-react-loop:184/190；设计决策#5 | +4 |

---

## 模块 P6-frontend — chat 阶段渲染 + tool 名（owning：`chat-slice-reducer.ts` 方法级 + loading-status 组件 + i18n）

> 组件 spec：涉及 `component-loading-status`（chat-page/一级目录 `chat-page/`）。coder 编码前更新 `specs/ui/components/chat-page/component-loading-status.md`（新增「运行工具: <name>」渲染 + tool_executing 触发时机改由 tool_execution_start 驱动）。归属 `component-`，修改。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/store/chat-slice-reducer.ts | `AgentEvent` 联合 | 修改 | 加 `{ type:'tool_execution_start'; toolNames:string[]; toolCallIds:string[] } \| { type:'tool_execution_end' }` 两 variant | MUST 与后端事件字段一致 | chat-slice-reducer.ts:38-90 | +2 |
| ui-chat | app/web/src/store/chat-slice-reducer.ts | `RunContext` | 修改 | 加 `runningToolNames?: string[]`（当前执行中 tool 名，供 spinner 渲染） | MUST 可选 | chat-slice-reducer.ts:112 | +1 |
| ui-chat | app/web/src/store/chat-slice-reducer.ts | `applyAgentEventToMessages`（case tool_execution_start / _end） | 修改 | `tool_execution_start`：`loadingPhase='tool_executing'` + `nextRunCtx={...runCtx, runningToolNames: evt.toolNames}`（**执行开始即置 tool_executing**，修 hang 时停「思考中」）。`tool_execution_end`：清 `runningToolNames`（loadingPhase 保持，待 tool_result_* 覆盖）。`tool_result_start` 的 `loadingPhase='tool_executing'`（:319）保留（快工具兜底/回放） | MUST NOT 删 tool_result_start 的 phase 兜底（无 execution 事件的旧回放仍需）；MUST 纯函数返新 ctx 不 mutate | chat-slice-reducer.ts:309-319；设计决策#6 | +14 |
| ui-chat | app/web/src/store/chat-slice-reducer.ts | slice state `runningToolNames` + 返回 | 修改 | ChatSlice state 加 `runningToolNames: string[]`（派生自 runCtx，run_end 清空）+ reduce 返回体带出 | MUST run_end 归零 | chat-slice-reducer.ts:119-411 | +4 |
| ui-chat | app/web/src/components/chat-page/types.ts | `LoadingStatusProps` 相关 / 状态类型 | 修改 | 若 state 类型集中于此则加 `runningToolNames`（对齐 slice） | MUST 与 slice 一致 | types.ts:355 LoadingPhase | +2 |
| ui-chat | app/web/src/components/chat-page/component-loading-status.tsx | `ComponentLoadingStatus` | 修改 | props 加 `toolNames?: string[]`；phase='tool_executing' 且 toolNames 非空 → 文案追加「运行工具: <names.join(', ')>」（i18n `loading.toolExecutingNamed`，插值 tool 名）；testid/data-phase 不变 | MUST 走 t() 占位符（缺 key 渲染 fallback）；MUST 保 data-testid=chat-run-spinner + data-phase | component-loading-status.tsx；_overview §4.10 | +8 |
| ui-chat | app/web/src/components/chat-page/component-message-stream.tsx | `ComponentMessageStream`（spinner 挂载点 :308） | 修改 | 透传 `toolNames={runningToolNames}` 给 ComponentLoadingStatus | MUST 仅透传 | component-message-stream.tsx:53/308 | +2 |
| ui-chat | app/web/src/i18n/locales/{zh,en}/chat.* | `loading.toolExecutingNamed` | 新增 | 新 i18n key（zh+en 双语），插值 `{{names}}`（「运行工具: {{names}}」/「Running tool: {{names}}」） | MUST 中英双语都加（缺一渲染【资源X不存在】）；MUST 走 t() 占位 | memory i18n-key-add-checklist | +2×2 |

---

## 模块 C — loop watchdog（仅留接口，本版不实现/不 wire）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-loop | app/server/src/agent/loop-watchdog.ts | `LoopWatchdog`（interface + 注释） | 新增 | 新 stub 文件：interface `LoopWatchdog { reset(): void; stop(): void }` + 文档注释（run 级，每次对外进展 reset，180s 无进展→触发 abort，走 markInterrupting→markInterrupted）。**不实现类、不 wire 进 runReActLoop** | MUST NOT 在本版接入 loop（仅占位接口，供后续版本实现）；MUST NOT 引入未使用运行时依赖（纯 type + 注释，避免死代码告警） | plan §P7；findings §修复映射 C later | +18 |

---

## 模块 F — max_iterations 轮次边界（中途并入，用户裁决；owning：`run-react-loop.ts` 方法级 `runReActLoop` + 新 UT 文件整文件）

> **动机（轮次原子性）**：一轮 = LLM 调用 → 工具执行 → tool_result SSE+存储；should-continue 判定必须落在**轮次边界**。旧 max_iterations 判定在 ②（callLLM 之后、③ 工具执行之前）break，此时 assistant（含 tool_use）已落盘已广播，产生「半轮」——dangling tool_use 无配对 tool_result（live 案例 session `01KX5WDBT2509AYT0VKY6D3K3R`，续跑有 provider 400 风险）。移到 ④ 的 `state.step++` 之后判定，保证**凡落盘的 tool_use 必有配对 result**，且第 26 次 LLM 调用不再发生（省 token）。
> **行为变化（用户已知悉接受）**：不再有「第 26 次 LLM 调用碰巧返回纯文本 → 走 `no_tool_call` 优雅收尾」路径。off-by-one 语义：`checkMaxIter=step>=maxIter`，`state.step` 从 0 起、每轮末 `++`，故 `maxIter=25` 时恰 **25 轮完整执行后停**。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-loop | app/server/src/agent/run-react-loop.ts | `runReActLoop`（② 后 maxIter 判定块） | 删除 | **整块删除** 现 :174-179 的 `if (baseCheckMaxIter(state.step, spec.maxIter)) { done=true; stopReason='max_iterations'; endStepSpan(state,false); break; }`——它位于 ③ `no_tool_call` 判定之后、`executeToolsForSpec` 之前，在 assistant 已落盘已广播后、工具执行前 break，产生半轮 dangling tool_use | MUST 整块删净，不留双判定（新判定唯一存在于 ④）；MUST NOT 动相邻 `no_tool_call` 判定块（:163-172）；MUST NOT 改 ③ 段 emit（`loop_tools_begin` / `emitToolExecutionStart` :184-186）、`executeToolsForSpec`、`ingestToolResults`、HITL pending 悬挂分流（:196-209）；`baseCheckMaxIter` import（:31）保留（④ 仍用，勿删 import） | run-react-loop.ts:174-179；agent-loop-base `checkMaxIter`（:101 `step>=maxIter`）；本模块动机（轮次原子性） | -6 |
| agent-loop | app/server/src/agent/run-react-loop.ts | `runReActLoop`（④ step++ 后 maxIter 判定） | 新增 | 在 ④ Exit Check 的 `state.step++`（:219）之后、`spec.observability.endStepSpan(state, true)`（:220）之前插入：`if (baseCheckMaxIter(state.step, spec.maxIter)) { state.done = true; state.stopReason = 'max_iterations'; spec.observability.endStepSpan(state, true); break; }`。step++ 后判定 = 轮次边界，凡落盘 tool_use 必有配对 tool_result | MUST 判定在 `state.step++` **之后**（off-by-one：25 轮完整执行后停）；MUST 用 `endStepSpan(state, true)`（hasTool=true，本轮已执行工具，区别于旧块的 `endStepSpan(state,false)`）；MUST 位于 doom_loop 判定（:213-218）**之后**——doom 先于 step++，顺序不动；命中 break 后不再触及 :220 的 `endStepSpan`（每轮恰一次 endStepSpan）；MUST NOT 复活第 26 次 LLM 调用 | run-react-loop.ts:211-220；agent-loop-base `checkMaxIter`；observability `endStepSpan(state, hasTool)`（agent-loop-observability.ts:184） | +6 |
| agent-loop | app/server/src/agent/__tests__/max-iterations-round-boundary.test.ts | `describe('max_iterations round boundary')` | 新增 | 新 UT 文件：fake `RunSpec`（`maxIter=2`）驱动真实 `runReActLoop`；照 `child-registry-mount-chain.test.ts` fake-spec 模式 mock context/llm/helpers/emitters/lifecycle（**绝对路径 vi.mock**），`callLLMForSpec` 每轮返含 tool_use 的 assistant、`extractToolCalls` 返非空。断言：**① `callLLMForSpec` 恰调 2 次（无第 3 次 LLM 调用）；② `stopReason==='max_iterations'`；③ `RunResult.rounds===2`（恰 2 完整轮）；④ 最后一轮 tool_use 有配对 tool_result（`ingestToolResults` 收到本轮 results，即执行发生在 step++ 之前）** | MUST 走真实 `runReActLoop`（不 stub 骨架本体，只 mock 非工具阶段）；MUST 断言 `callLLMForSpec` callCount===2（钉死无第 3 次调用）；MUST 覆盖「落盘 tool_use 必有配对 result」（每轮 executeToolsForSpec 产 results 后才 step++）；MUST 绝对路径 vi.mock（memory `test-vitest-mock-absolute-path`：bun+jsdom 下相对路径静默失效）；vitest 须 bun runtime 跑 | `__tests__/child-registry-mount-chain.test.ts`（fake-spec 驱动模板）；本模块 Row1/Row2；memory test-vitest-mock-absolute-path / vitest-must-run-under-bun | +~90 |

**F 影响面 / packaged 护栏**：纯 agent loop 控制流迁移，无新依赖、无新 plugin、无新 env 键、无新文件系统入口 → BUG-001~004 均不触发。无接口/schema/落库变更（stopReason 值集不变，`max_iterations` 已存在）→ 无前后端联合改动。**共文件下钻**：`run-react-loop.ts` 现被三处方法级共享——Task B-registry（`executeToolsForSpec` 加 childRegistry）、Task P6-backend（`runReActLoop` ③ emit 点）、Task F（`runReActLoop` ②删除 + ④新增判定）；三者动 run-react-loop 的不同区段（② maxIter 块 / ③ emit / ④ Exit Check），须方法级+区段级切分不重叠，合并时逐段核对。

---

## 影响面评估

- **跨模块**：tools（engine/types/bash-engine/bash/file×5/web×2/新 registry）、agent（interface/manager/abort-finalize/run-react-loop/stage-tool/loop-base/event-types/emitters/新 watchdog）、web（chat-slice-reducer/loading-status/message-stream/types/i18n）。
- **破坏性**：`Tool`/`ToolCtx`/`ExecOpts`/opts 均**加可选字段**——向后兼容，无破坏性接口变更。新增 2 个 SSE 事件类型（前后端联合同步加，通用转发无 encoder 白名单，已核实）。
- **依赖顺序**（底层先于上层）：① `tools/child-process-registry.ts`（新类）→ ② `tools/types.ts`（字段）→ ③ `tools/engine.ts` + `bash-engine.ts` + `bash.ts` + 各 tool defaultTimeoutMs → ④ `agent-interface.ts`/`agent-manager.ts`/`abort-finalize.ts` + opts 透传链 → ⑤ `agent-event-types.ts`/`emitters` + run-react-loop emit → ⑥ 前端 reducer/组件/i18n。C stub 独立可并。
- **风险点**：(1) 超时 race 误裹 HITL（review 硬门禁：race 只在 runTool，HITL 分支在其前）；(2) detached spawn 后组杀负 pgid 在非 darwin 需 runShell 同样 detached（已覆盖）；(3) engine backstop timeout 与 bash 自身 timer 双触发——GRACE 保 bash 优先，双触发也仅各产一次组杀+result（Promise.race 取先者），无 dangling；(4) registry unregister 必须挂 close/error（防内存泄漏）；(5) i18n key 中英双语缺一即渲染占位符。
- **packaged 护栏**：本版无新第三方依赖、无新 plugin、无新运行时 env 键、无新文件系统启动入口 → BUG-001~004 四类均不触发（`process.kill`/`spawn detached` 为 node 内建，Electron Node 主进程可用）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列尤其**超时 race 裹进 HITL**、影响行严重偏离）→ 退 coder。
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
- coder 按代码实际调整时（spec drift）汇报 orchestrator，记 task-board doc-sync 待办，doc-modifier 阶段5 统一修 spec。

## 建议 task 切分（5 个）

1. **Task A — tool 超时体系**：`tools/types.ts`(defaultTimeoutMs/ctx.childRegistry) + `tools/engine.ts`(常量/resolveEffectiveTimeout/execute/runTool/ExecuteRunCtx) + 各 tool defaultTimeoutMs（file×5/web×2/bash/agent）。coversFiles: engine.ts；coversMethods: types.ts 的两字段 + 各 tool 单例字段。
2. **Task B-bash — bash 子进程组杀**：`tools/bash-engine.ts`(killProcessGroup/wireChildLifecycle/ExecOpts/runShell/SecureBashEngine.exec) + `tools/bash.ts`(childRegistry 透传)。coversFiles: bash-engine.ts。
3. **Task B-registry — registry + run 集成**：`tools/child-process-registry.ts`(新) + `agent-interface.ts`/`agent-manager.ts`/`abort-finalize.ts`/`run-react-loop.ts(executeToolsForSpec)`/`agent-loop-stage-tool.ts`/`agent-loop-base.ts` 的 opts 透传 + **C stub `loop-watchdog.ts`**。coversFiles: child-process-registry.ts, loop-watchdog.ts；coversMethods: 其余文件的具体符号。
4. **Task P6-backend — SSE 阶段事件**：`agent-event-types.ts` + `agent-loop-emitters.ts` + `run-react-loop.ts`(③ emit 点)。coversMethods: run-react-loop 与 Task B-registry 共文件须下钻方法级不重叠（B-registry 动 executeToolsForSpec，P6 动 runReActLoop ③ emit）。
5. **Task P6-frontend — chat 渲染**：`chat-slice-reducer.ts` + `component-loading-status.tsx` + `component-message-stream.tsx` + `types.ts` + i18n。coversFiles: 前端各文件。

> **共文件下钻提示**（planner 注意）：`run-react-loop.ts` 被 **三处** 方法级共享——Task B-registry（`executeToolsForSpec` 加 childRegistry）、Task P6-backend（`runReActLoop` ③ emit）、**Task F（`runReActLoop` ② maxIter 块删除 + ④ Exit Check 新增判定）** → 三者动不同区段（③ 执行链透传 / ③ emit / ② 与 ④ 控制流），须方法级+区段级切分不重叠。`tools/bash.ts` 被 Task A（defaultTimeoutMs）与 Task B-bash（childRegistry 透传）共享 → 同理。`tools/types.ts` 被 Task A（defaultTimeoutMs）与 Task B-registry（ctx.childRegistry）共享 → 字段级切分。
>
> **Task F 切分建议（中途并入）**：F 是 `run-react-loop.ts` 的独立控制流迁移（②删/④加）+ 1 个新 UT，与 P6-backend 同文件不同区段。可**并入 Task P6-backend 作为 run-react-loop 的第二处方法级改动**（同 owning 文件、无区段重叠），或独立为一个小 task；无论何种切法，coversMethods 须精确到 `runReActLoop` 的 ②/④ 区段，与 P6-backend 的 ③ emit 区段不重叠。
