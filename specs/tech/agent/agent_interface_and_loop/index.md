---
type: index
title: Agent Interface & Loop 子系统总起（agent 执行核心）
priority: P0
updated: 2026-08-04
---

# Agent Interface & Loop 子系统总起（agent 执行核心）

## ① 是什么

本 KB = **agent 执行的统一单 run 契约 + 统一 ReAct 骨架 + RunLifecyclePort 注入 + scopeId 纯拼接 + 门面管理 + 中断/入队/事件**。v0.0.204 终版：`Agent` 只剩 `run(spec, loop)`（两参——spec + loop 句柄），主链 run（RunKind='main'）/旁路 run（RunKind='summary'|'consolidate'）共用一份 `runReActLoop(spec)` 骨架，差异下沉为 RunSpec 字段（profile.runShape 驱动）+ RunLifecyclePort（单 impl 按 profile 字段分派）+ emit 闭包。装配入口合并为单 `buildRunDeps(opts)`（替原 buildMainDeps/buildForkedDeps 二元分裂）。`AgentScopeRouter` 删除（scopeId=SessionKind.canonicalId() 纯拼接，零路由表）。`AgentManager` 仍是 session 级门面（路由 + 句柄管理 + 中断收尾），`activate`/旁路 run 入口降为 thin wrapper。

| 核心概念 | 一句话 |
|---|---|
| **Agent interface** | 单 run 契约：只有 `run(spec: RunSpec, loop: LoopHandle) → AgentRun`（**删 enqueue/cancel/activate**，无 abort，中断归 manager） |
| **RunSpec** | 入口参数 = 身份（kind + sessionId + runId）+ RunLifecyclePort + observability + toolDefinitions/allowedTools/maxIter/scopeId/controller/runKind + profile.runShape 字段（drainMode/backgroundPath/...） |
| **AgentRun** | run 产出的 run 实例（caller 视图，不暴露 controller）；可 `await run.promise` |
| **Unified Skeleton** | `runReActLoop(spec)` 骨架：主链/旁路 run 共用一份，差异全在 RunSpec 字段 + RunLifecyclePort + emit（profile.runShape 单源驱动） |
| **[v0.0.204] buildRunDeps** | 单装配入口（替原 buildMainDeps/buildForkedDeps）：profile 驱动 RunSpec 装配（runShape/lifecycleHooks/eventChannel/toolDefinitionsSource 全字段驱动）；两 LifecyclePort 合并为 RunLifecyclePort 单 impl 按 profile.runShape 字段分派；两 LoopHandle 合并为 RunLoopHandle（releasesScopeSession 旗标承载旁路 run per-run buffer 回收）；forked 命名体系退役（ForkedLifecyclePort/MUTED_BUS → RunLifecyclePort/silentBus） |
| **[v0.0.204] RunKind** | 扁平闭合枚举 3 值（`'main'`/`'summary'`/`'consolidate'`）；替代原 modeKey 字段（current→main / summary→summary / memory_extract→consolidate）；scopeId=canonicalId 纯拼接（无路由表） |
| **scopeId** | v0.0.204 起纯字符串拼接 = `SessionKind.canonicalId()`（4 段：`${biz}-${role}:${derivation}:${runKind}`），单行函数 `scopeIdOf(kind)`（scope-id.ts），零决策逻辑 |
| **AgentManager** | session 级门面 + 状态持有者：`run(spec, loop)` 唯一 loop 启动入口；enqueue/cancel 写 inbox（session 职责），activate/旁路 run thin wrapper，abort 收尾唯一执行者，subscribe 转 hub.sub |
| **AbortController** | 自定义内存对象 `{ runId, aborted, childRegistry? }`（非 Web API）；manager 创建注入 loop，abort 时校验 runId 后置 aborted=true + `childRegistry.killAll()` 杀在途子进程（[v0.0.130.hang]） |
| **InboxEntry** | session 级独立队列条目（联合 `kind=message|cancel`）；与 SessionStore transcript 解耦 |
| **StopReason** | 7 态联合（`no_tool_call`/`no_new_messages`/`max_iterations`/`doom_loop`/`error`/`tool_pending`/`interrupted`）；[v0.0.101] `tool_pending` 通用悬挂退出（tool interaction() 返非 null → pending result + session=suspended） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| Agent interface（单 `run(spec, loop)`）+ RunSpec + AgentRun + groupKey 命名（sid+runKind）+ scopeId=canonicalId 拼接 | SessionConfig 字段语义 / studio 分支（→ `../session/` + `../../squad/`） |
| 统一骨架 `runReActLoop(spec)` + RunLifecyclePort 契约 + buildRunDeps 单装配 | session 六态机 + CAS API（→ `../session/[P0]session_state.md`） |
| SessionKind/SessionContext/runKind（→ `../session/[P0]session_kind.md`） | Session/Run 字段持久化（→ `../session/[P0]session_store.md`） |
| AgentManager 门面（路由/句柄/abort 收尾/subscribe/run 唯一入口）| LLM 调用编排（错误归一化/retry/超时/length → `../llm_caller/`） |
| agent_loop_base 机制原语（callLLM/executeTools/中断/退出检查/StopReason） | event bus/hub transport（→ `../event/`） |
| abort 4 步收尾 + half-data 收集 + AbortController 内存模型 | message 类型（→ `../message/`）；context snapshot/ingest/assemble/compact（→ `../context/`） |
| inbox 机制 + enqueue/cancel + a2a 入口 enrich | context EP/impl 链（→ `../context/[P0]extension point and implementations.md`） |
| AgentEvent 联合（topic=agent_loop）+ API/SSE 不漏契约 | tool 执行引擎 / 工具集（→ `../tools/`） |
| 旁路 run 不变量（不持久/不碰状态机/per-run buffer 回收/abort noop）由 profile 字段承载 | scope 注册/预建（→ `../../plugin_system/` + dev-config） |

## ③ 与系统的关系

```
                          ┌── event/              (EventBus transport + EventHub 路由；topic=agent_loop)
   interface_and_loop     │
   KB (本目录) ───────────┼── session/            (六态机 CAS / SessionStore transcript / SessionConfig + SessionKind/SessionContext/runKind)
                          │
                          ├── context/            (ContextEngine snapshot/ingest/assemble/compact)
                          │
                          ├── llm_caller/         (LlmCaller.invoke：错误归一化+retry+超时+length)
                          │
                          ├── message/            (Message/ContentBlock/MessageSender 类型)
                          │
                          ├── tools/              (ToolExecutionEngine + allowedTools 门控 + SessionTypePolicy.resolveToolSet)
                          │
                          ├── observability/      (loop = observability 唯一 producer)
                          │
                          └── multi_agent/        (deliverTo wrapper + children 追踪 + 级联 abort + spawn 泛化)
```

**对外协作点**：
- 门面落地：`app/server/src/agent/agent-manager.ts`（`AgentManagerImpl`）。
- 统一骨架：`app/server/src/agent/run-react-loop.ts`（`runReActLoop`，主链/旁路 run 共用）。
- deps 装配：`app/server/src/agent/build-run-deps.ts`（`buildRunDeps` 单装配，profile 驱动 RunSpec）+ `run-loop-handle.ts`（RunLoopHandle）+ `run-lifecycle-port.ts`（RunLifecyclePort + mapUsagePartition）。
- 旁路 run snapshot 装配：`loop-stage-context.ts` 的 `buildSideRunSnapshot(contextEngine, config, snapshot?)`（可选双路径：复用/完整重建）。
- scopeId 拼接：`app/server/src/agent/scope-id.ts`（`scopeIdOf(kind) = kind.canonicalId()` 单行）。
- loop 机制：`app/server/src/agent/agent-loop-base.ts`（原语）+ `agent-loop-call-via-invoker.ts`（LLM 调用编排）+ `agent-loop-stage-{pre,llm,tool}.ts`（①②③ 阶段拆分）。
- inbox：`app/server/src/agent/inbox.ts`（`InboxStore`）+ `inbox-enrich.ts`（a2a 入口 enrich）。
- abort 收尾：`app/server/src/agent/abort-finalize.ts`（4 步 + half-data）。

## ④ 核心设计原则（跨文件不变量）

1. **单 run 契约 + 统一骨架**——`Agent` 只剩 `run(spec, loop)`；主链/旁路 run 共用 `runReActLoop(spec)`，差异全在 RunSpec 字段 + RunLifecyclePort + emit（profile.runShape 单源驱动）。base 提供单轮原语（callLLM/executeTools/中断检查），骨架调原语 + 在边界回调 port。→ `agent_interface.md §1` + `agent_loop_unified.md §1/§2`
2. **[v0.0.204] buildRunDeps 单装配 + profile 单源**——buildMainDeps/buildForkedDeps 二元分裂合并为 `buildRunDeps(opts)`；profile 始终从 `opts.sessionTypePolicy.profile(kind)` 取（policy 唯一读取入口，对齐 session-type-policy.ts:35 docstring）；main 路径 inline MAIN_DEFAULT_PROFILE 字面量删除（避免 default.yaml 字面漂移风险）。→ `agent_loop_unified.md §3`
3. **中断不在 Agent interface 上**——abort 唯一入口是 `AgentManager.abort(sid, runId, runKind)`；port 不参与，AgentRun 不暴露 controller。→ `agent_interface.md §1` + `agent_interrupt.md §1`
4. **abort api 是收尾唯一执行者；loop 被中断只退出**——loop 不 persistUsage/不 emit run_end/不 ingest；4 步收尾（CAS markInterrupting → 收集 half-data → clearReplay → emit run_stop+markInterrupted）归 manager。仅主链 run（RunKind='main'，对应 `RunLifecyclePort.onInterrupted` 默认 noop；subagent main run 例外——开回报兜底代发旁路，transcript 收尾仍归 abort api，见 `agent_loop_unified.md §3.2`）；旁路 run 直接退出 + 丢弃 buffer。→ `agent_interrupt.md §1/§3` + `agent_loop_unified.md §3.3`
5. **AbortController 内存模型 = 单一布尔位**——loop 中断判定只读 `controller.aborted`（O(1) 内存读），不读 store/currentRunId；runId 守门由 `controller.runId === runId` 单点校验。→ `agent_interrupt.md §2`
6. **groupKey 命名统一**——`session_id:<sid>_amt:<runKind>`（amt = agent mode type）；共 topic=`agent_loop`，group 区分 main/summary/consolidate。→ `agent_interface.md §5`
7. **inbox 与 transcript 解耦**——enqueue 不写主 store（cancel 不需改 transcript），drain 时同批配对判定（cancel = append cancel 条目，非删 inbox）。→ `agent_inbox_enqueue.md §1/§4`
8. **同 (sid, runKind) 不并发**——`agentRuns.get("${sid}_${runKind}")?.state === "running"` → 拒。→ `agent_interface.md §6`
9. **API + SSE 不漏契约**——GET(全量持久化) ∪ SSE replay(上次 ingest 后的半截) ∪ stream(增量)，按 `evt.messageId` merge 不漏；replay 不是补历史。→ `agent_event.md §10`
10. **[v0.0.204] scopeId = SessionKind.canonicalId 纯拼接（零路由表）**——`AgentScopeRouter` 删除；scopeIdOf(kind) 单行函数；所有用到的 scope 组合在 `app/plugins/scopes/` 全量配 yaml 文件（空文件 = 沿 extends 链继承）；runKind 不再驱动 scope 路由（原 modeKey→scopeId 路由层退役）。→ `agent_scope_router.md`（已废止）+ `../session/[P0]session_type_profile.md §2/§5`
11. **compact 防递归靠 scope 隔离**——summary run 的 scope 不激活 shouldCompact EP（exclusive EP 无 active impl）→ tryCompact 兜底跳过 → 结构上不可能递归 compact。→ `agent_loop_unified.md §6` + `../context/[P0]context_compact_detail.md §2c.3`
12. **[v0.0.48+v0.0.204] 旁路 run reminder 注入在 cache 前缀之后**——summary/consolidate run 补 system reminder（自述 + profile.toolBound 实际工具列表）；**不复用** `system_reminder_injector`（旁路 run scope 仍禁用它防污染 cache 前缀），改 `side-run-reminder-injector.ts` 在 buffer 拼装时插入（snapshot 之后、userMessage 之前）。v0.0.204 起：三态文案从 `profile.toolBound` 派生（替代 RunSpec.enableToolWhitelist+toolWhitelist，已删）；`injectSideRunReminder` / `SideRunReminderInput` / `SideRunReminderHandler` / `content/side_run_reminder/` 命名链对齐 runKind=summary/consolidate。→ `side_run_reminder.md §1/§2/§4` + `../tools/[P0]tool_policy.md §3`
13. **[v0.0.54] 旁路 run task message = 纯 directive（核心不变量）**——所有旁路 run caller（compact / consolidate / 任何未来旁路 EP）传入的 task message 必须是**纯指令**：snapshot 是唯一信息源（system + messages + reminder 已在 buffer 中），task message 只下「对上面的对话历史做 X」指令，**不复述** snapshot 任何内容。caller 自检口径：「这条消息的文本能否在没看 snapshot 的情况下独立写出？」能 = 合规 directive；不能 = 违例。→ `agent_loop_side_run.md §1` + `../context/[P0]context_compact_detail.md §3.0`
14. **[v0.0.80.t1+v0.0.204] 旁路 run snapshot 双 clone 不变量 + 可选双路径**——caller 传入的 snapshot 在 tryCompact 谓词 true 后由胶水 `structuredClone(ctx.snapshot)` 一次；旁路 run 入口（agent-side-run.ts）再 `structuredClone(opts.snapshot)` 一次（双保险防篡改）。**v0.0.204 起 snapshot = 可选输入**：有 snapshot=复用路径（自动压缩 caller 传，零拷贝零重建最大化保 prompt cache 前缀；snapshot.tools/messages 引用相等 UT 钉死）；无 snapshot=完整重建路径（手动压缩 caller 不传，`buildSideRunSnapshot` 调 `contextEngine.assemble(config, 'default', null)` 完整重建 + store 持久化全对话）。手动/自动 summary 同 type 同 profile 同组装链（profile 禁任何区分手动/自动的字段，UT 钉死）。→ `agent_loop_side_run.md §1`
15. **[v0.0.101] 悬挂型 tool 不原地等待（pending-tool-calls 机制）**——`Tool.interaction()` 返非 null → pending 占位 + 入 `pendingToolCalls` 队列 → loop `StopReason=tool_pending` 退出 + session=suspended。→ `agent_hitl.md` + `../tools/[P0]tool_execution_engine.md §5`
16. **[v0.0.101] 回填走 inbox + transcript「首次发给 LLM 时冻结」**——用户回填构造 `tool_reply` message → `deliverTo` → pre-process 按 `handleType` **编辑**已写入的占位 content block；append-only 在「首次发给 LLM 时冻结」**而非「写入即冻结」」。→ `agent_inbox_enqueue.md` + `../context/[P0]context_ingest_detail.md §6 allowEdit`
17. **[v0.0.101] handleType 三分发 + suspended 合法存活**——direct_result/approval/callback 三分发；infra 层只管队列+suspended+peek+匹配，不关心 subType/handleType（通用）。suspended 是合法存活态：reconcileOnStartup **保留** suspended + 校验 pendingToolCalls。→ `../session/[P0]session_state.md §1/§5`
18. **[v0.0.130.hang] max_iterations 判定在轮次边界（轮次原子性）**——`checkMaxIter` 判定必须落在 ④ Exit Check 的 `state.step++` **之后**（轮次边界），凡落盘 tool_use 必有配对 tool_result。→ `agent_loop_unified.md §2` + `agent_loop_base.md §6`
19. **[v0.0.130.hang] loop ③ 阶段事件 + run 级子进程 sweep**——③ tools 段 execute 前/后 emit `tool_execution_start/end`；`AbortControllerHandle.childRegistry` 挂 spawn 型工具子进程，abort-finalize `aborted=true` 后 `killAll()` 杀在途进程组。→ `agent_event.md §5.6` + `agent_interrupt.md §3.1`
20. **[v0.0.161] drain 是 msgId 分配唯一权威源（enqueueId ↔ msgId 严格独立）**——所有 source 在 `drainAndPartition` 阶段统一 `newId=ulid()`；write-in 时刻 msgId 是 throwaway 占位（drain 时丢弃，不外泄前端）。→ `agent_inbox_enqueue.md §6/§6.4` + `../message/[P0]agent_message_interface.md §7`
21. **[v0.0.204] 旁路 run 不变量由 profile 字段承载**——不持久（persistsRun=false）/ 不碰状态机（touchesStateMachine=false）/ per-run buffer 回收（RunLoopHandle.releasesScopeSession=true）/ abort onInterrupted 恒 noop；summary/consolidate 共性由 profile 基座（summary.yaml/consolidate.yaml）表达。→ `agent_loop_unified.md §3` + `../session/[P0]session_type_profile.md §4`
22. **[v0.0.207] abort authority transfer — 句柄集中吊销（双层防御第二层）**——loop 各点查 `controller.aborted` 是第一层（分散易漏，tool 执行段零检查点保 tool_use/result 配对）；abort api step1 `controller.aborted=true` 后**主动吊销 loop 对外副作用句柄**（`loop.revokeSideEffects?.()`，`abort-finalize.ts:102`，在 `killAll` 后、`waitForLoopExit` 前）是第二层兜底：`wireEmitCtx.bus.emit/clearReplay` + `wireContextEngine.ingest` 经 Proxy 拦截变 no-op（loop 代码零侵入）；abort api 直发 bus.emit + store.appendMessages 走原对象豁免。→ `agent_interrupt.md §2.5`（吊销/豁免边界表）

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| **统一契约** | | |
| `agent_interface.md` | Agent interface（单 `run(spec, loop)`，删 enqueue/cancel/activate）+ RunSpec（v0.0.204 runKind 替 modeKey）+ AgentRun + groupKey（sid+runKind）| [link]([P0]agent_interface.md) |
| **统一骨架 / scopeId** | | |
| `agent_loop_unified.md` | 统一 `runReActLoop(spec)` 骨架 + RunLifecyclePort 契约 + 骨架直调 contextEngine/base.callLLM + buildRunDeps 单装配（v0.0.204 buildMainDeps/buildForkedDeps 合并）+ snapshot 可选双路径 | [link]([P0]agent_loop_unified.md) |
| `agent_scope_router.md` | **[v0.0.204 废止]** scopeId = SessionKind.canonicalId() 纯拼接（单行 `scopeIdOf(kind)`），`AgentScopeRouter` 删除 | [link]([P0]agent_scope_router.md) |
| **门面** | | |
| `agent_manager.md` | AgentManager 门面（`run(spec, loop)` 唯一 loop 启动入口 + activate/旁路 run thin wrapper + enqueue/cancel/deliverTo/abort/subscribe）+ resolveConfigBySid | [link]([P0]agent_manager.md) |
| **run 不变量** | | |
| `agent_loop_eager_drain.md` | 主链 run 不变量：store 游标（ingestUpTo/llmUpTo）+ cancel 配对 + 六态机 CAS + 副作用策略表 | [link]([P0]agent_loop_eager_drain.md) |
| `agent_loop_lazy_drain.md` | lazy-drain 概念（外循环 drain，run 内不 re-drain）；P2 future 概念定稿 | [link]([P2]agent_loop_lazy_drain.md) |
| `agent_loop_side_run.md` | 旁路 run 不变量：append-only 保缓存 + tool 双维度 + 无副作用边界 + snapshot 可选双路径（手动/自动同 profile）| [link]([P0]agent_loop_side_run.md) |
| **机制层** | | |
| `agent_loop_base.md` | base 机制原语（callLLM/executeTools/中断/退出检查）+ RunState 共享 + StopReason 全集 + RunErrorInfo | [link]([P0]agent_loop_base.md) |
| **中断 / 入队** | | |
| `agent_interrupt.md` | abort 4 步收尾 + AbortController 内存模型 + half-data 收集（原样保存）+ 适用范围（仅主链 run） | [link]([P0]agent_interrupt.md) |
| `agent_inbox_enqueue.md` | inbox 机制（独立队列）+ enqueue/cancel + drain 配对 + a2a 入口 enrich + 三事件生命周期 | [link]([P0]agent_inbox_enqueue.md) |
| **事件 / HITL** | | |
| `agent_event.md` | AgentEvent 联合（topic=agent_loop）+ 各阶段事件 + 事件→Message 重建映射 + API/SSE 不漏契约 | [link]([P0]agent_event.md) |
| `agent_hitl.md` | HITL 悬挂型 tool 流程（canonical）：§1 触发悬挂 + §2 回填处理（handleType 三分发）+ §3 四情况 + §4 INV-1..7 | [link]([P0]agent_hitl.md) |
| **旁路 run reminder** | | |
| `side_run_reminder.md` | 旁路 run reminder 注入（cache 前缀之后零污染）+ 三态文案从 profile.toolBound 派生（v0.0.204）；`injectSideRunReminder`/`SideRunReminderHandler`/`content/side_run_reminder/` 命名链对齐 runKind=summary/consolidate | [link]([P0]side_run_reminder.md) |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
