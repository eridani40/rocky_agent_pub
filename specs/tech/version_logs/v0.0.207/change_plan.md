# v0.0.207 变更计划书 — abort 副作用权威转移（authority transfer）+ assemble 去重

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。
> coder 对实现细节有最终决策权；偏离本表须向 orchestrator 汇报。事后偏差写进 `change_log.md`。

## 架构原则：Authority Transfer（权力交接）

> abort api step1 `markInterrupting` + `controller.aborted=true` 那一刻，loop 持有的所有对外副作用句柄被**吊销（revoke）**，loop 调这些句柄 = no-op；loop 唯一职责 = 感知 aborted → break。副作用唯一权威 = abort api。

**为什么是句柄集中吊销**（不是 loop 各点查 `aborted` 标志）：
- 「loop 各点自觉查标志」分散易漏——某个 emit/ingest 点忘查就破
- 「句柄集中吊销」= loop 代码零侵入，调用照旧但句柄已失效 → no-op
- 单一吊销点（`loop.revokeSideEffects()`）= 单一权威，不会漏

**吊销与豁免边界（核心约束 — 硬约束）**：

| 句柄 | loop 调用方 | abort api 调用方 | 吊销后行为 |
|---|---|---|---|
| `wireEmitCtx.bus.emit` | `publish(ctx, ...)` 经 `ctx.bus.emit` | `emitInterruptedRunStop` 直接 `bus.emit`（**不经 wireEmitCtx**）| loop emit 全 no-op；abort api emit 豁免 |
| `wireEmitCtx.bus.clearReplay` | `ingestMainAndAssemble`/`refreshSnapshotOnly` 经 `emitCtx.bus.clearReplay` | `abortRun` step3 直接 `bus.clearReplay` | loop clearReplay no-op；abort api 豁免 |
| `wireContextEngine.ingest` | `ingestMainAndAssemble`/旁路 `ce.ingest` | `fillInterruptedToolResults` 走 **`store.appendMessages`**（不经 ce.ingest）| loop ingest no-op；abort api 写入豁免 |
| `wireContextEngine.assemble`/`getCleanSnapshot` | loop 读路径 | — | **不吊销**（透传，read-only 无副作用）|

**实现机制**：JS Proxy 包装。`wrapRevocableEmitCtx` 包 EmitContext（Proxy 包 bus，命中 emit/clearReplay 拦截）；`wrapRevocableContextEngine` 包 ContextEngine（Proxy 命中 ingest 拦截；其他方法透传）。revoke 仅置内部 `revoked` 标志，不改原对象引用。

**T2 不解决 IO 取消**（per-call AbortController 不接 run controller，`engine.ts:260`）—— 见影响面评估「IO 取消分叉建议」。authority transfer 保证「loop IO 跑完后写 result/emit 已被吊销 = no-op」即可修本 bug。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（行粒度 = 符号；新增 class/interface/type 各占一行）|
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号）|
| 预计影响行 | +N / -M |

## 变更清单

### T2 — loop 对外副作用权威转移

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-loop | app/server/src/agent/revocable-side-effects.ts | RevocableHandle | 新增 | `interface RevocableHandle { revoke(): void }` — 吊销句柄契约 | MUST 单方法 revoke；MUST NOT 携带状态（纯操作接口）| authority transfer 原则（本文头部）| +3 |
| agent-loop | app/server/src/agent/revocable-side-effects.ts | wrapRevocableEmitCtx() | 新增 | 包 EmitContext：返回 `{ ctx, revoke }`；ctx.bus 是原 bus 的 Proxy，revoke 后 `emit`/`clearReplay` 命中返 no-op，其他属性（subscribe/isReplayable/`now` 等）透传 | MUST 用 Proxy 包 bus（不改原 bus 引用——abort api 直发 bus 不受影响）；MUST 拦截 `emit`+`clearReplay` 两个写方法；MUST NOT 拦截 read 方法 | 原则：loop emit 通道吊销 / abort api emit 豁免（abort-finalize.ts:178 走 bus.emit 独立）| +22 |
| agent-loop | app/server/src/agent/revocable-side-effects.ts | wrapRevocableContextEngine() | 新增 | 包 ContextEngine：返回 `{ ce, revoke }`；ce 是原 ce 的 Proxy，revoke 后 `ingest` 命中返 `() => Promise.resolve()`（async no-op），其他方法（assemble/getCleanSnapshot/getSideRunner/compact/clearScopeSession/...）透传 | MUST 仅拦截 `ingest`（写咽喉）；MUST NOT 拦截 `assemble`/`getCleanSnapshot`（read-only）/`compact`（独立 sideRun 路径，自带 controller）；MUST返 `Promise.resolve()` 保 `await` 安全 | 原则：loop ingest 吊销 / abort api fillInterruptedToolResults 走 store.appendMessages 独立（abort-finalize.ts:163）| +18 |
| agent-loop | app/server/src/agent/run-loop-handle.ts | LoopHandle.revokeSideEffects | 新增 | `LoopHandle` interface 加可选方法 `revokeSideEffects?(): void`；RunLoopHandle 类构造器加第 4 参 `revokeFn?: () => void`，存私有字段；方法实现调 `revokeFn?.()`（未传则 no-op） | MUST 可选（向后兼容 forked + 现有 UT 直接 `new RunLoopHandle(kind,spec,release)` 三参构造）；MUST NOT 在 start()/finally 自动调（revoke 时机由 abort api 控制）| authority transfer：吊销点单一在 abort api step1 | +12 |
| agent-loop | app/server/src/agent/build-run-deps.ts | buildRunDeps() | 修改 | 装配期调 wrapRevocableEmitCtx(emitCtx) + wrapRevocableContextEngine(opts.contextEngine)；spec.wireEmitCtx/wireContextEngine 用包装后的；组合 revoke `() => { r1.revoke(); r2.revoke(); }` 传 `new RunLoopHandle(runKind, spec, !isMain, revoke)` | MUST main + forked 都包（forked 走包装但不被调 revoke，无副作用）；MUST wireEmitCtx/wireContextEngine 指向 proxy（不是 real）；MUST NOT 改 wireStore/opts.bus（abort api 直发用原 bus）| 本文头部原则；T2 | +10/-2 |
| abort-finalize | app/server/src/agent/abort-finalize.ts | abortRun() | 修改 | 主对话分支（runKind===RUN_KIND_MAIN）：`controller.aborted=true` 后立即从 `loops.get(loopKey(sessionId))` 取 loop，调 `loop?.revokeSideEffects?.()`（在 `void childRegistry?.killAll()` 之后、`waitForLoopExit` 之前）；复用同一 loop 变量后续 waitForLoopExit/cleanup | MUST revoke 在 `controller.aborted=true` 之后（保序：标志先置再吊销）；MUST 在 `waitForLoopExit` 之前（让 loop 退出过程中所有副作用已 no-op）；forked 分支（runKind!==RUN_KIND_MAIN）不调 revoke（forked 无 4 步收尾、in_memory 写无副作用） | `[P0]agent_interrupt.md §3.1`（abort 4 步）；authority transfer 原则（本文头部）| +6/-1 |

### T3 — assemble reducer 同 toolCallId 去重（兜底）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| context-assemble | app/plugins/builtins/rocky_context/assemble/dedup_tool_result.ts | DedupToolResultReducer | 新增 | class extends ContextImplBase implements AssembleReducer；`reduce(data, input, ctx)`：扫描所有 role='tool' message 内 tool_result block，按 toolCallId 分组；多 result 时挑 keeper（优先 `isError===false` 完整结果，否则首条），非 keeper 从 message.content 过滤掉；命中写 error log（鸭子类型 ctx.config.logWriter，try/catch fail-silent）| MUST 不可变处理（input 不变，返新数组）；MUST 优先 isError=false（完整结果 > interrupted 占位）；MUST NOT 重排 message 顺序（orphan_tool_call 后续处理邻接）；MUST 保留 message（即便 content 变空也交 empty_message 兜底）| `[P0]context_assemble_detail.md §5b`（clean_view_reducer 表）；同链 reducer 模式参考 `fill_empty_text.ts` | +85 |
| plugin-config | app/plugins/builtins/rocky_context/plugin.json | extImpls[].dedup_tool_result | 新增 | 在 `context_clean_view_reducer` EP 登记新 impl：`{ implId: "dedup_tool_result", point: "context_clean_view_reducer", impl: "./assemble/dedup_tool_result.ts", description: "__MSG_..." }` | MUST implId 与 default.yaml impls 列表一致；MUST impl 路径相对 plugin.json | 同 EP 现有 6 impl（orphan_tool_call 等）登记模式 | +6 |
| scope-config | app/plugins/scopes/default.yaml | context-assemble.context_clean_view_reducer.impls | 修改 | impls 列表头插 `dedup_tool_result`（顺序：dedup_tool_result → snip_handler → orphan_tool_call → think_remove → fill_empty_text → empty_message → role_merge）| MUST 排在 `orphan_tool_call` 之前（dedup 先去重，orphan 再判配对——否则 orphan 见双 result 都当 paired 全留，T3 兜底失效）；其他 scope（summary/consolidate）per-EP 继承 default，无需改 | `[P0]context_assemble_detail.md §3 ordered EP`；default.yaml 注释「数组顺序即 order」| +1 |

## 影响面评估

**跨模块**：agent-loop（revocable handle 新机制）+ abort-finalize（吊销点接入）+ context-assemble（兜底 reducer）。

**破坏性变更**：无。
- `LoopHandle.revokeSideEffects` 加可选方法，现有 UT 直接 `new RunLoopHandle(kind, spec, release)` 三参构造不受影响（revokeFn 缺省 no-op）。
- `buildRunDeps` 包装层透明：loop 内所有 `spec.wireContextEngine`/`spec.wireEmitCtx` 用法不变（Proxy 透传）。
- T3 reducer 加在 default.yaml clean_view_reducer 链头，其他 scope（summary/consolidate）per-EP 继承 default 自动获得，无需逐 scope 改。

**依赖顺序**：revocable-side-effects.ts（基础工具）→ run-loop-handle.ts（接口扩字段）→ build-run-deps.ts（装配接入）→ abort-finalize.ts（吊销点接入）。T3 独立，可与 T2 并行。

**风险点**：
1. Proxy 性能：`ingest`/`emit` 是热路径但 Proxy get 拦截开销极小（单次属性访问 + boolean 检查），可接受。
2. forked run 也包了 revocable 但不被调 revoke：无副作用（revoke 永不触发，proxy 行为等同透传）。
3. T3 reducer 误删合法 result：仅当同 toolCallId 多 result 才触发（正常路径一个 toolCallId 一个 result，零命中）。

**IO 取消分叉建议（orchestrator 裁决）**：

per-call AbortController 不接 run controller（`engine.ts:260`）→ tool fetch IO 不响应 abort。两个选项：

- **方案 A（推荐，本版本不做）**：T2 留 IO 取消为后续版本。理由：(1) 本 bug（k3 tokenization failed）根因 = 双写，authority transfer 已根治；(2) 现有 `[v0.0.130.hang] childRegistry.killAll()` 已处理最坏情况（hung bash 子进程）；(3) web_search fetch 完成后 result 被 authority transfer 丢弃 = 浪费 IO 但无害；(4) IO 取消需 per-tool 信号 plumbing（fetch/bash/...各工具实现 ctx.signal 检查），独立版本才有空间做对。
- 方案 B（不推荐）：T2 一并修 IO 取消。会扩范围到 engine.ts + 每个工具实现，blast radius 失控。

**建议**：本版本走方案 A。IO 取消另立版本（如 v0.0.209 tool io cancel）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现更优实现可合理偏离本表具体行，但 MUST 向 orchestrator 汇报偏离项 + 理由 + 影响范围
