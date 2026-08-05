# v0.0.15 PRD 变更日志

## 概述

本版本是「**实现层追赶 spec**」——`specs/tech/agent/agent_interface_and_loop/` 下 8 个 P0 spec 已在 v0.0.16 三层重组（Phase A）定稿，但实现仍停在 v0.0.13/14 的扁平架构（单 AgentLoop + 单次 ForkedAgent）。本 PRD 性质是**对齐确认**，不发明新概念。

一句话：**把 agent 实现层从「单 mode 主对话 + 简单 ForkedAgent」演进到 spec v0.0.16 的「三层策略类 + 门面 + AbortController 内存模型 + groupKey+modeKey 全链路 + forked 旁路多轮重写」，对齐 8 个 P0 spec 的 20 项差异。**

权威输入：`reqs/v0.0.15/research.md`（差距清单 + P0/P1/P2 修复优先级 + 6 个风险点）。spec 权威源：`specs/tech/agent/agent_interface_and_loop/` 8 个 P0 spec（version 1.1~5.1）。

---

## 1. 版本定位

### 1.1 范围

**IN（v0.0.15 实现层对齐 spec）**：
- Agent interface + AgentRun + 三策略类骨架（EagerDrainAgent / ForkedAgent；LazyDrainAgent 排除）
- AgentManager 门面化（agentRuns / abortControllers / loops 三 map + forkedRun 入口）
- AbortController 内存对象（`{runId, aborted}`，替代 Web AbortSignal）+ controller 注入模型
- abort 签名 `(sessionId, runId, modeKey)` + 收尾精简（搬运工，协议兜底归 assemble 视图层）
- groupKey + modeKey 全链路（`session_id:<sid>_amt:<modeKey>` + AgentEventBase.modeKey + subscribe(sid, modeKey)）
- not-allowed tool 门控 + 中文文案（toolEngine 加 allowedTools 参）
- forked 旁路重写：ForkedAgent 策略类化 + 多轮 ReAct + emit 默认开 + controller 注入 + manager.forkedRun 入口 + 命名对齐
- 演进 6 大块（research §1.3）：interface 统一 / AgentRun instance / AbortController 内存模型 / groupKey+modeKey 全链路 / abort 收窄搬运工化 / forked 旁路重写

**OUT（本版本明确排除）**：

| 排除项 | 理由 |
|--------|------|
| **lazy-drain 策略类** | spec `[P2]agent_loop_lazy_drain.md` 标 future；本版本只交付 eager-drain + forked 两个 P0 策略类 |
| **hitl（human-in-the-loop 审批）** | 沿用 v0.0.8 OUT（无 HITL 审批）；agent_interface §5 矩阵保留 require_approval 枚举但不触发 |
| **多 AgentManager 实例** | research §6.5 留 future；本版本维持 bootstrap 单例（spec §5 无强制要求） |
| **error 态 half-data 收尾逻辑** | 沿用 v0.0.12 OUT；本版本只对齐 interrupted 收尾 |
| **新 UI 概念** | 本版本纯后端对齐，不改 UI 契约；前端 SSE sub 协议同步改（groupKey 改名是破坏性变更，UT/AT 同步） |

### 1.2 与 v0.0.13/14 的关系

v0.0.13 落地的 forked agent（单次非流式 call）+ summaryTask + plugin 化 context engine 是**实现基线**——本版本在此基础上把 forked agent 升级为策略类 + 多轮 ReAct、把 manager 升级为门面、把 abort 模型重写为 controller 内存对象。v0.0.13 PRD（`03-llm-chat.md` §3.1 + 路径 L-Q）的全部产品语义保持不变，仅实现层机制对齐 spec。

---

## 2. 修复范围（对齐 research.md P0/P1/P2）

> 详细技术差距 + 文件:行号证据见 `reqs/v0.0.15/research.md` §2-§5。本 PRD 只列产品语义，不重复技术细节。

### 2.1 P0 架构地基（Critical 5 + not-allowed 门控）

| # | 对齐项 | 产品语义（用户视角） | spec 权威源 |
|---|--------|---------------------|------------|
| P0.1 | Agent interface + AgentRun + 三策略类骨架 | 主对话（current）与旁路任务（summary/memory_extract）统一为「Agent run」概念，前端可观测每个 run 的生命周期 | `[P0]agent_interface.md` v1.1（interface + AgentRun + 三 mode 矩阵）+ `[P0]agent_manager.md` v5.1（门面 + 三策略类实例） |
| P0.2 | AbortController 内存对象 + controller 注入模型 | 中断生效延迟 < 一次 chunk 量级；中断主对话不影响 forked summary；中断 forked 不影响主对话 | `[P0]agent_interrupt.md` v1.5 §1-§1.1（自定义 `{runId, aborted}` + 生产-持有-触发） |
| P0.3 | abort 签名扩展 + 收尾精简 | 中断 API 接受 runId+modeKey 精准定位；中断后落库数据是「loop 已产出原样」，不加工；悬空 tool_call 的协议合法性归 assemble 视图层 | `[P0]agent_interrupt.md` v1.5 §3-§4 + §4 协议兜底归 assemble 视图层认知 |
| P0.4 | groupKey + modeKey 全链路 | 前端订阅 `session_id:<sid>_amt:current` 看主对话，订阅 `session_id:<sid>_amt:summary` 看 compact 进度；同一 session 多流互不污染 | `[P0]agent_interface.md` v1.1 §4 + `[P0]agent_event.md`（AgentEventBase.modeKey 必填）+ `[P0]agent_manager.md` §2 subscribe |
| P0.5 | not-allowed tool 门控 + 中文文案 | forked summary 任务（allowedTools=[]）若 LLM 仍 tool_call，agent 回中文「工具 '...' 在当前会话不允许调用...」，LLM 自修正换思路 | `[P0]agent_loop_base.md` v1.2 §2.2（门控逻辑 + 文案） |

### 2.2 P1 行为对齐（Major 10）

| # | 对齐项 | 产品语义 | spec 权威源 |
|---|--------|---------|------------|
| P1.1 | forkedRun 入口 | compact 经 `manager.forkedRun({modeKey:"summary",...})` 入口，caller 传 snapshot 保 KV 缓存命中 | `[P0]agent_manager.md` v5.0 §2 forkedRun + §3.2 forked compact 典型流程 |
| P1.2 | ForkedAgent 多轮 ReAct | summary 是单次（maxIter=1），memory_extract 是多轮（maxIter>1，带工具自修正）；answer=最后一轮 assistant text 聚合 | `[P0]agent_loop_forked.md` v2.2 §4（while 循环 + ①②③）+ §6 taskType 表 |
| P1.3 | forked emit 默认开 | 前端可订阅 `session_id:<sid>_amt:summary` 看 compact 进度（之前完全不 emit）；emit:false 可关 | `[P0]agent_loop_forked.md` v2.0 §10（默认 true） |
| P1.4 | forked controller 注入 | forked 也能被中断；caller 经 `manager.abort(sid, runId, "summary")` 中断，forked loop 下一检查点退出 | `[P0]agent_loop_forked.md` v2.1 §9 + ForkedRunOptions.controller 必填 |
| P1.5 | activate 返 AgentRun | activate 重复调用返同一对象引用（running 时），调用方无需 status 分支 | `[P0]agent_interface.md` v1.1（ActivateResult 废弃）+ `[P0]agent_manager.md` v5.0 §2 activate |
| P1.6 | loopMode 字段 + 路由表 | SessionConfig.loopMode 默认 eager-drain；manager.agentByMode(loopMode) 路由（lazy-drain future） | `[P0]agent_manager.md` v5.0 §2.2 SessionConfig + §4 agentByMode |
| P1.7 | 机制库抽 base 原语 | callLLM / executeTools / isInterrupted 抽为纯函数，eager/forked 注入调用（非模板方法） | `[P0]agent_loop_base.md` v1.2 §2（D1 策略注入形态） |
| P1.8 | AgentLoop 删 abort() 方法 | 中断唯一入口归 `AgentManager.abort()`，loop 不参与 | `[P0]agent_loop_eager_drain.md` v2.1 §2 + agent_interface v1.1 |
| P1.9 | EagerDrainAgent 策略类化 | AgentLoop 由 EagerDrainAgent.activate 创建（不再由 manager 直接 new） | `[P0]agent_loop_eager_drain.md` v2.1 §2 |
| P1.10 | agentRuns/loops map + cleanupRun | 三 map key=`${sid}_${modeKey}`，Run 结束自动 cleanupRun | `[P0]agent_manager.md` v5.0 §4 + §5 内部架构 |

### 2.3 P2 命名清理（Minor 5）

| # | 对齐项 | spec 权威源 |
|---|--------|------------|
| P2.1 | forked 命名对齐：`taskMessage→userMessage` / `toolsConstraint→allowedTools` + `toolDefinitions` / 加 `taskType` / `modeKey` / `emit` 字段 | `[P0]agent_loop_forked.md` v2.0 §3 ForkedRunOptions |
| P2.2 | AbortResult.reason 取值对齐（`run_id_mismatch` / `no_active_controller` / `cas_failed`） | `[P0]agent_interface.md` v1.1 §3 |
| P2.3 | loops map key 对齐 `${sid}_current`（仅主对话缓存句柄） | `[P0]agent_manager.md` v5.0 §4 |
| P2.4 | SessionConfig 加 loopMode 字段 | `[P0]agent_manager.md` v5.0 §2.2 |
| P2.5 | ForkedAgentOptions → ForkedRunOptions | `[P0]agent_loop_forked.md` v2.1 §3 |

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖要求）

> 本版本新增 6 条路径（R-W）。v0.0.8/12/13 路径（A-Q）作为回归保护，**至少路径 D（自动 compact）/路径 H（中断 run）/路径 K（tool_call 配对）必须重跑 PASS**——因实现层机制变更可能影响这些路径。

每条新路径至少 1 个 AT（真 LLM，不 mock，memory `no-mock-api-e2e-tests`）+ 适用项 ET。覆盖优先级高于回归路径。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 R：主对话 ReAct（groupKey+modeKey 全链路）** | enqueue user → activate → subscribe(sid, "current") → SSE 流式 message_* 事件（group=`session_id:<sid>_amt:current`）→ LLM 产 tool_call → tool 执行 → tool_result 回灌 → LLM 续答 → run_end | `POST /session/:id/messages` · `subscribe(sid,"current")` · SSE group=`session_id:<sid>_amt:current` · AgentEventBase.modeKey="current" | AT（enqueue+activate+subscribe 真 LLM 主对话 → 断言事件 group 含 `_amt:current` + 每事件 modeKey=current + 落库校验）+ ET（重跑 UC-3.1.11/12） |
| **路径 S：forked summary（compact 经 manager.forkedRun）** | 主对话多轮超阈值 → 触发 compact → `manager.forkedRun({taskType:"summary", modeKey:"summary", allowedTools:[], maxIter:1, emit:true})` → 前端可 `subscribe(sid,"summary")` 看 compact 进度（group=`session_id:<sid>_amt:summary`，事件 modeKey=summary）→ `await run.promise` 拿 answer → setSummary → 主对话重新 assemble 含 summary 继续正常 | ContextEngine.compact · manager.forkedRun · subscribe(sid,"summary") · SSE group=`session_id:<sid>_amt:summary` | AT（真 LLM 多轮超阈值 → 触发 forkedRun → subscribe(sid,"summary") 收到 run_start/message_*/run_end + answer 落地 summary + summaryUpTo 推进）+ ET（重跑 UC-3.1.15） |
| **路径 T：中断主对话（controller 内存模型 + 搬运工收尾）** | 主对话 run 进行中 → `POST /session/:id/abort {runId, modeKey:"current"}` → manager.abort(sid, runId, "current") → 校验 controller.runId === runId → CAS markInterrupting → 置 controller.aborted=true → loop chunk 循环退出（不收尾）→ abort step2 收集 loop 已产出 half-data 原样保存（不补 interrupted tool_result、不重组 partial）→ step3 clearReplay → step4 emit run_stop(interrupted) + markInterrupted | `POST /session/:id/abort` body 含 runId+modeKey · controller 内存对象 · abort 4 步搬运工 · AgentEvent run_stop | AT（abort in tool 执行中 → 202 + state→interrupted + run_stop(interrupted) + GET messages 含 loop 已产出原样数据，不加工）+ ET（重跑路径 H 中断按钮交互） |
| **路径 U：中断 forked（直接置 aborted，无 4 步收尾）** | forked summary 进行中 → `POST /session/:id/abort {runId, modeKey:"summary"}` → manager.abort(sid, runId, "summary") → 校验 controller.runId === runId → **跳过 CAS markInterrupting**（forked 不参与五态机）→ 直接置 controller.aborted=true → forked loop 下一检查点退出（内存 buffer 丢弃，无 half-data 持久化）→ run.promise reject → cleanupRun → 主对话不受影响 | `POST /session/:id/abort` body modeKey="summary" · forked controller · forked loop 无收尾 | AT（forked summary 进行中 → abort(modeKey:"summary") → 202 + forked run.state=interrupted + 主对话 state 不变 + GET messages 不含 forked 产出） |
| **路径 V：cancel 排队消息（enqueue view 清理回归）** | 主对话 run 进行中 → 连发 q1/q2 → `POST /messages` 返 enqueueId1/enqueueId2 → `POST /session/:id/messages/:enqueueId1/cancel` → loop drain 同批配对 → q1 emit `enqueued_message_canceled`（不落库）+ q2 正常 processed 落库 | `POST /session/:id/messages` · `POST /session/:id/messages/:enqueueId/cancel` · enqueued_message_canceled event | AT（enqueue q1/q2 → cancel q1 → 真 LLM 处理后 GET messages 仅含 q2 落库 + q1 不残留 enqueue + q1 不进 transcript）+ ET（重跑路径 M enqueue view 2 pending → cancel 1 → 仅剩 1） |
| **路径 W：not-allowed tool 门控（forked 自修正）** | forked allowedTools=[] 时（summary 任务），LLM 仍 tool_call → base.executeTools 拦截 → 产 not-allowed tool_result（中文「工具 '...' 在当前会话不允许调用，请仔细阅读任务说明，不要再次尝试调用该工具」）→ 喂回 LLM → LLM 下轮看到后自修正（产 text 不再 tool_call）或继续 tool_call 直至 maxIter | forked allowedTools=[] · base.executeTools 门控 · not-allowed 中文文案 | AT（forked allowedTools=[] + 构造 LLM tool_call → 断言 tool_result 文案含中文 not-allowed + LLM 下轮 text） |

### 3.1 E2E Use Cases（R-W 路径对应）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-R | 订阅 `session_id:<sid>_amt:current` → 发 query 触发 ReAct | 收到 message_start → text_block_* / tool_call_* / tool_result_* → message_end，每事件 modeKey=current，落库正确 |
| UC-S | 多轮对话超阈值 → 订阅 `session_id:<sid>_amt:summary` | 看到 forked summary run 的 run_start → message_* → run_end，主对话流（current）不被污染，summary 落地后主对话继续正常 |
| UC-T | 主对话 run 中点中断按钮 | run_stop(stopReason=interrupted) + run-finish 显「已中断」+ loading 消失；GET messages 含 loop 已产出原样数据（不加工） |
| UC-U | forked summary run 中调 `abort(modeKey:"summary")` | forked run 终止 + 主对话继续 + GET messages 不含 forked 产出 |
| UC-V | enqueue q1/q2 → cancel q1 → drain | enqueue view 仅剩 q2 pending；q1 显 canceled 不落库；q2 正常落库进对话区 |
| UC-W | forked allowedTools=[] + LLM tool_call | tool_result 显中文 not-allowed 文案；LLM 下轮自修正产 text |

> **不变量**（设计自主决策汇总）：
> - forked loop 是旁路（默认无副作用，内存 buffer 不写 store）；forked 被中断无收尾（丢弃 buffer 即可）。
> - 中断条件单一内存源（`controller.aborted`），loop 不读持久化 state/currentRunId。
> - abort api 是搬运工（不解析/不分类/不补全）；悬空 tool_call 协议合法性归 assemble 视图层（非 abort 加工）。
> - controller chunk 循环中断（webAbort 存 callLLM 局部作用域，controller 保持纯 `{runId, aborted}`）；fetch 等待期接受短暂延迟。
> - forked compact 保持 maxIter=1 单次路径（summary 任务），memory_extract 用多轮（maxIter>1）。
> - groupKey 改名是破坏性变更，前端 SSE sub + UT/AT + API doc 一次性改完（research §6.3 推荐）。

---

## 4. 验收标准

### 4.1 实现对齐 spec（research §1.2 共 20 项差异）

- **Critical 5 + not-allowed 门控**：全部修复（P0.1-P0.5）
- **Major 10**：全部修复（P1.1-P1.10）
- **Minor 5**：全部修复（P2.1-P2.5）
- 排除项（lazy-drain / hitl / 多 AgentManager 实例 / error 态 half-data）明确豁免

### 4.2 测试覆盖（MANDATORY）

- **UT**：controller 内存模型 / groupKey 命名（`session_id:<sid>_amt:<modeKey>`）/ not-allowed 门控 + 中文文案 / activate 返 AgentRun（running 时同一对象引用）/ forkedRun 拒并发（同 sid+modeKey）/ AgentLoop 无 abort() 方法
- **AT（真 LLM，不 mock）**：路径 R/S/T/U/V/W 6 条全覆盖 + 真实落库校验（GET messages / summary / session state 断言）+ 回归路径 D/H/K
- **ET**：主对话（UC-R）+ forked summary（UC-S）两条核心 E2E
- **typecheck 通过**（`bun run typecheck`）

### 4.3 工程红线

- 单文件 ≤ 300 行（research §附录：`agent-loop.ts` 492 行 / `agent-manager.ts` 416 行 / `session-state-machine.ts` 370 行 需拆分）
- 抽 base 原语后 AgentLoop/ForkedLoop 各自薄编排（机制层 vs 编排层分离）

---

## 5. 对齐 spec 声明（MANDATORY — 概念先行）

**本 PRD 不发明概念**。所有组件/接口/行为/命名引用 `specs/tech/agent/agent_interface_and_loop/` 下 8 个 P0 spec 权威源：

### 5.1 PRD 引用 ↔ spec 权威源对齐表

| PRD 引用 | spec 权威源 | 对齐点 |
|---------|------------|--------|
| Agent interface（run/activate/enqueue/cancel 四方法，无 abort） | `[P0]agent_interface.md` v1.1 §1 | interface 定义对齐 |
| AgentRun instance（sessionId/modeKey/runId/groupKey/state/promise/result） | `[P0]agent_interface.md` v1.1 §2 | 类型定义对齐（ActivateResult 废弃） |
| RunOptions（含 modeKey 必填 / emit / usagePartition） | `[P0]agent_interface.md` v1.1 §3 | 类型定义对齐 |
| groupKey 命名 `session_id:<sid>_amt:<modeKey>` | `[P0]agent_interface.md` v1.1 §4 | 命名规范对齐 |
| 三 mode 支持矩阵 | `[P0]agent_interface.md` v1.1 §5 | forked run ✅ / activate/enqueue/cancel throw 对齐 |
| AgentManager 门面（enqueue/activate/forkedRun/abort/cancel/subscribe） | `[P0]agent_manager.md` v5.1 §2 | 接口签名对齐（activate 返 AgentRun / abort 三参 / subscribe 两参） |
| ForkedRunOptions（含 modeKey / emit / controller 必填，无 abortSignal） | `[P0]agent_manager.md` v5.1 §2.1 + `[P0]agent_loop_forked.md` v2.1 §3 | 字段对齐（taskMessage→userMessage / toolsConstraint→allowedTools+toolDefinitions） |
| SessionConfig.loopMode（eager-drain / lazy-drain，默认 eager-drain） | `[P0]agent_manager.md` v5.0 §2.2 | 字段对齐 |
| agentRuns/abortControllers/loops 三 map + cleanupRun | `[P0]agent_manager.md` v5.0 §4 + §5 | key=`${sid}_${modeKey}`，loops 仅 `${sid}_current` |
| AbortController 内存对象 `{runId, aborted}` | `[P0]agent_interrupt.md` v1.5 §1 | 自定义类型（非 Web API）对齐 |
| Controller 生产-持有-触发-生命周期 | `[P0]agent_interrupt.md` v1.5 §1.1 | manager 创建+注入+abort 校验+cleanupRun 删 map 对齐 |
| abort 4 步收尾（搬运工）+ 协议兜底归 assemble 视图层 | `[P0]agent_interrupt.md` v1.5 §3-§4 | step1-4 对齐 + half-data 原样保存对齐 |
| AbortResult.reason 取值 | `[P0]agent_interface.md` v1.1 §3 | `run_id_mismatch`/`no_active_controller`/`cas_failed` 对齐 |
| forked loop 多轮 ReAct（while + ①②③） | `[P0]agent_loop_forked.md` v2.2 §4 | 内存 buffer 追加 + maxIter 对齐 |
| forked emit 默认开（group=`session_id:<sid>_amt:<modeKey>`） | `[P0]agent_loop_forked.md` v2.0 §10 | 默认 true + groupKey 对齐 |
| forked 中断（controller.aborted，无收尾） | `[P0]agent_loop_forked.md` v2.1 §9 | 直接退出对齐 |
| taskType（summary / memory_extract，纯标签） | `[P0]agent_loop_forked.md` v2.0 §6 | 不映射预设对齐 |
| not-allowed 中文文案 | `[P0]agent_loop_base.md` v1.2 §2.2 + `[P0]agent_loop_forked.md` v2.2 §12 | 文案对齐 |
| base 原语（callLLM / executeTools / isInterrupted + 策略注入 D1） | `[P0]agent_loop_base.md` v1.2 §1.2 + §2 | 机制层 vs 编排层分离对齐 |
| AgentLoop 删 abort() 方法 | `[P0]agent_loop_eager_drain.md` v2.1 §2 | 中断归 manager 对齐 |
| EagerDrainAgent 策略类（implements Agent） | `[P0]agent_loop_eager_drain.md` v2.1 §2 | activate 创建 AgentLoop 对齐 |
| AgentEventBase.modeKey 必填 | `[P0]agent_event.md`（agent_interface §4 引用） | 字段对齐 |
| inbox enqueue/cancel + 三事件 | `[P0]agent_inbox_enqueue.md`（research §2.8 判定已对齐） | 沿用 v0.0.13 实现 |

### 5.2 新概念声明

**本版本无新概念**。所有概念已在 v0.0.16 spec 三层重组（Phase A）定稿，本 PRD 是其产品化表达。v0.0.13 PRD（`03-llm-chat.md` §3.1 + 路径 L-Q）已覆盖的产品语义（session/message/agent loop/forked agent/compact/abort/cancel/inbox/summaryTask/context engine plugin 化）保持不变，仅实现层机制对齐 spec。

---

## 6. 风险点（来自 research §6）

| # | 风险 | 应对（本版本决策） |
|---|------|-------------------|
| 6.1 | abort 收尾精简的回归风险（悬空 tool_call 是否致 LLM 协议错误） | 按 spec v1.5 §4 认知——「协议兜底归 assemble 视图层，非 abort 加工」。本版本 abort api 退化为搬运工（不补 interrupted tool_result、不重组 partial），悬空 tool_call 协议合法性由 assemble pipeline 容错处理；现有 `finalizeHalfData` 认知为视图层兜底（未来下沉到 assemble pipeline） |
| 6.2 | controller 派生 Web AbortSignal 的实现细节 | 按 spec v1.5 §2.3 + base §2.1——webAbort 存 callLLM 局部作用域（随 callLLM 生灭），chunk 循环每个 chunk 检查 controller.aborted，命中即 webAbort.abort() + break。controller 保持纯 `{runId, aborted}` 不派生 Web AbortSignal；fetch 等待期（chunk 循环前）的 abort 接受短暂延迟 |
| 6.3 | groupKey 改名的破坏性影响（前端 SSE sub + UT/AT + API doc） | 一次性改完（research 推荐）。spec 已定，兼容只会延长迁移痛。本版本同步改：前端 SSE sub 协议 + 所有 emit group 调用点 + UT/AT group 断言 + API doc |
| 6.4 | forked 多轮 ReAct 与 compact 的兼容（maxIter>1 时 answer 口径） | 按 spec §4——answer = extractFinalText(state.messages)（最后一轮 assistant text 聚合）。**compact 调用时 maxIter=1 保持单次路径不变**（summary 任务），仅 memory_extract 用多轮（maxIter>1）。本版本 compact 仍是单次路径，memory_extract 是 future（taskType 字段已落但本版本不交付 memory_extract 实际任务） |
| 6.5 | AgentManager 单例 vs 多实例 | 维持单例（spec §5 无强制要求）。多 AgentManager 实例留 future |
| 6.6 | 本版本未覆盖的关联点（session_state 五态机 / event_hub / event_bus / api 04-agent-session） | research §6.6 判定基本对齐，本版本不深入核查 reconcileOnStartup 边界；api 04-agent-session 的 abort/cancel 端点 group 命名偏离属 P0.4 一部分，同步改 |

---

## 7. 非功能需求（沿用，本版本强调）

- **无 mock**（memory `no-mock-api-e2e-tests`）：6 条新路径 R-W 的 AT 全部真 LLM 调用 + 真落库校验，不接受 mock。回归路径 D/H/K 同样真 LLM PASS。
- **不变量**：forked 旁路无副作用（默认）；中断单一内存源；abort 搬运工不加工；chunk 循环中断模型；compact 单次 maxIter=1。
- **工程红线**：单文件 ≤ 300 行（research §附录点名 3 个文件超红线需拆分）；base 原语抽离后机制层 vs 编排层职责清晰。

---

## overall 同步建议（doc-modifier 阶段执行）

本版本完成后 overall 需小幅更新（实际同步留 doc-modifier 阶段）：

- `specs/prd/overall/03-llm-chat.md` §3.1 行为条更新实现细节对齐 spec v0.0.16（groupKey/modeKey/forkedRun/AgentRun）；§4 追加 v0.0.15 路径 R-W；版本 bump 1.5。
- `specs/prd/overall/03-llm-chat-features.md` 同步 forked agent 表述对齐策略类化。
- tech/api overall 同步（落 architect + coder 产出）由 architect / doc-modifier 处理。

---

## 版本

v0.0.15 PRD（实现层追赶 spec：Agent interface 统一 + AgentRun instance + AbortController 内存模型 + groupKey+modeKey 全链路 + abort 收窄搬运工化 + forked 旁路多轮 ReAct 重写；对齐 8 个 P0 spec 20 项差异）。
