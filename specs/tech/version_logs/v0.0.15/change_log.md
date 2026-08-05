# v0.0.15 Change Log（Agent 实现层追赶 spec）

> 2026-06-22 · 性质：「实现层追赶 spec」——v0.0.16 已定稿 `specs/tech/agent/agent_interface_and_loop/` 8 个 P0 spec，但实现仍停在 v0.0.13/14 扁平架构。本版本把实现层对齐 spec 的 20 项差异（research.md 清单）。
> 验证：UT + AT 真 LLM 6 条新路径 R-W 全覆盖 + 回归路径 D/H/K PASS。

## 1. 背景

v0.0.16 spec 三层重组（Phase A，已定稿）把 agent loop 拆成 base（机制层）+ eager_drain（主对话编排）+ forked（旁路多轮 loop）三层，同时引入 Agent interface 统一、AgentRun instance、AgentManager 门面化、AbortController 内存对象模型、groupKey+modeKey 全链路、abort 收窄搬运工化六大演进。

但实现层停在 v0.0.13/14：
- `agent-loop.ts` 单体 492 行（机制 + eager 编排糅合）
- `forked-agent.ts` 单次非流式 LLM call（无 ReAct 多轮）
- `AgentManager` 散落方法（无三策略类 / 无 agentRuns+abortControllers map / 无 forkedRun 入口）
- AbortController 用 Web API（`signal.aborted` 三条件）而非 `{runId, aborted}` 内存对象
- groupKey 裸 `session_id:<sid>`（无 `_amt:<modeKey>` 后缀）
- AgentEvent 缺 modeKey 必填字段

权威输入：`reqs/v0.0.15/research.md`（20 项差异清单 + P0/P1/P2 修复优先级 + 6 个风险点）。spec 权威源：`specs/tech/agent/agent_interface_and_loop/` 8 个 P0 spec。

## 2. 落地变更（对齐 research.md P0/P1/P2 共 20 项）

### 2.1 P0 架构地基（Critical 5 + not-allowed 门控）

| # | 对齐项 | 实现要点 | spec 权威源 |
|---|--------|---------|------------|
| P0.1 | Agent interface + AgentRun + 三策略类骨架 | 新建 Agent interface（run/activate/enqueue/cancel 四方法，无 abort）；EagerDrainAgent / ForkedAgent implements Agent；LazyDrainAgent P2 future；AgentRun instance（sessionId/modeKey/runId/groupKey/state/promise/result） | `[P0]agent_interface.md` v1.1 + `[P0]agent_manager.md` v5.1 |
| P0.2 | AbortController 内存对象 + controller 注入模型 | `{runId, aborted}` 自定义对象替代 Web AbortSignal；manager 创建+注入 loop；abort 校验 `controller.runId === runId`；webAbort 存 callLLM 局部作用域（chunk 循环每 chunk 查 controller.aborted，命中即 webAbort.abort() + break） | `[P0]agent_interrupt.md` v1.5 §1-§1.1 |
| P0.3 | abort 签名扩展 + 收尾精简 | `abort(sessionId)` → `abort(sessionId, runId, modeKey)`；HTTP body `{runId, modeKey}` + 响应 `{ok, accepted}`；abort api 退化为搬运工（不补 interrupted tool_result、不重组 partial），悬空 tool_call 协议兜底归 assemble 视图层；forked 不走 4 步，直接置 controller.aborted | `[P0]agent_interrupt.md` v1.5 §3-§4 + `[P0]agent_manager.md` v5.1 §3 |
| P0.4 | groupKey + modeKey 全链路 | 所有 emit group 走 `session_id:<sid>_amt:<modeKey>`；AgentEventBase 加 modeKey 必填；`subscribe(sid)` → `subscribe(sid, modeKey)`；前端 SSE sub 协议 + UT/AT group 断言同步改（破坏性变更一次性改完） | `[P0]agent_interface.md` v1.1 §4 + `[P0]agent_event.md` + `[P0]agent_manager.md` §2 subscribe |
| P0.5 | not-allowed tool 门控 + 中文文案 | toolEngine.execute 加 `allowedTools?: string[]` 参；不在白名单返中文 tool_result「工具 '...' 在当前会话不允许调用，请仔细阅读任务说明，不要再次尝试调用该工具」；LLM 自修正换思路 | `[P0]agent_loop_base.md` v1.2 §2.2 |

### 2.2 P1 行为对齐（Major 10）

| # | 对齐项 | spec 权威源 |
|---|--------|------------|
| P1.1 | `manager.forkedRun(opts)` 入口（compact 经此入口，caller 传 snapshot 保 KV 缓存命中） | `[P0]agent_manager.md` v5.0 §2 forkedRun |
| P1.2 | ForkedAgent 多轮 ReAct（while + ① LLM / ② Tool / ③ Exit；answer = extractFinalText 最后一轮 assistant text 聚合；compact maxIter=1 单次路径不变） | `[P0]agent_loop_forked.md` v2.2 §4 |
| P1.3 | forked emit 默认开（group=`session_id:<sid>_amt:<modeKey>`），emit:false 可关 | `[P0]agent_loop_forked.md` v2.0 §10 |
| P1.4 | forked controller 注入（manager 创建，forked loop 检查点退出） | `[P0]agent_loop_forked.md` v2.1 §9 |
| P1.5 | activate 返 AgentRun（running 时返同一对象引用，ActivateResult 联合废弃） | `[P0]agent_interface.md` v1.1 + `[P0]agent_manager.md` v5.0 §2 |
| P1.6 | SessionConfig.loopMode 字段（默认 eager-drain）+ manager.agentByMode 路由表 | `[P0]agent_manager.md` v5.0 §2.2 + §4 |
| P1.7 | base 原语抽取（callLLM / executeTools / isInterrupted 纯函数，eager/forked 注入调用，D1 策略注入形态） | `[P0]agent_loop_base.md` v1.2 §1.2 + §2 |
| P1.8 | AgentLoop 删 abort() 方法（中断唯一入口归 AgentManager.abort） | `[P0]agent_loop_eager_drain.md` v2.1 §2 |
| P1.9 | EagerDrainAgent 策略类化（activate 创建 AgentLoop，不再由 manager 直接 new） | `[P0]agent_loop_eager_drain.md` v2.1 §2 |
| P1.10 | agentRuns / abortControllers / loops 三 map + cleanupRun（key=`${sid}_${modeKey}`，loops 仅 `${sid}_current`） | `[P0]agent_manager.md` v5.0 §4 + §5 |

### 2.3 P2 命名清理（Minor 5）

| # | 对齐项 | spec 权威源 |
|---|--------|------------|
| P2.1 | forked 命名对齐（taskMessage→userMessage / toolsConstraint→allowedTools+toolDefinitions / 加 taskType/modeKey/emit） | `[P0]agent_loop_forked.md` v2.0 §3 |
| P2.2 | AbortResult.reason 取值对齐（`run_id_mismatch` / `no_active_controller` / `cas_failed`） | `[P0]agent_interface.md` v1.1 §3 |
| P2.3 | loops map key 对齐 `${sid}_current` | `[P0]agent_manager.md` v5.0 §4 |
| P2.4 | SessionConfig 加 loopMode 字段 | `[P0]agent_manager.md` v5.0 §2.2 |
| P2.5 | ForkedAgentOptions → ForkedRunOptions | `[P0]agent_loop_forked.md` v2.1 §3 |

## 3. 不变量（设计自主决策汇总）

- **forked loop 是旁路**（默认无副作用，内存 buffer 不写 store）；forked 被中断无收尾（丢弃 buffer 即可）。
- **中断条件单一内存源**（`controller.aborted`），loop 不读持久化 state/currentRunId。
- **abort api 是搬运工**（不解析/不分类/不补全）；悬空 tool_call 协议合法性归 assemble 视图层（非 abort 加工）。
- **controller chunk 循环中断**（webAbort 存 callLLM 局部作用域，controller 保持纯 `{runId, aborted}`）；fetch 等待期接受短暂延迟。
- **forked compact 保持 maxIter=1 单次路径**（summary 任务），memory_extract 用多轮（maxIter>1，taskType 字段已落但本版本不交付 memory_extract 实际任务）。
- **groupKey 改名是破坏性变更**，前端 SSE sub + UT/AT + API doc 一次性改完（research §6.3 推荐）。

## 4. 排除项（沿用 PRD §1.1）

| 排除项 | 理由 |
|--------|------|
| lazy-drain 策略类 | spec `[P2]agent_loop_lazy_drain.md` 标 future；本版本只交付 eager-drain + forked 两个 P0 策略类 |
| hitl（human-in-the-loop 审批） | 沿用 v0.0.8 OUT；agent_interface §5 矩阵保留 require_approval 枚举但不触发 |
| 多 AgentManager 实例 | research §6.5 留 future；维持 bootstrap 单例 |
| error 态 half-data 收尾 | 沿用 v0.0.12 OUT；只对齐 interrupted 收尾 |
| memory_extract 实际任务 | taskType 字段落位但本版本只交付 summary；memory_extract 多轮路径 future |

## 5. 文档同步（本次完成）

| 文件 | 更新点 |
|---|---|
| `specs/tech/progress.md` | 新增「v0.0.15 落地状态」段（实现层追赶 spec）；`agent_interface_and_loop` 状态从 working → done（spec 与 code 已对齐） |
| `specs/prd/overall/03-llm-chat.md` | §3.1 行为条实现细节对齐 spec v0.0.16（groupKey/modeKey/forkedRun/AgentRun）；§4 追加 v0.0.15 关键用户路径 R-W；版本 bump 1.4 → 1.5 |
| `specs/prd/overall/03-llm-chat-features.md` | 无需改（无 agent 细节，只引用 §3.1） |
| `specs/api/overall/04-agent-session.md` | 已对齐（v0.0.16 修订段记录了 abort 三参 + accepted + modeKey 必填，本版本是「实现层落地」） |

## 6. 工程欠债

本版本 base 原语抽离后，原 `agent-loop.ts` 492 行拆为机制层 + 编排层。具体行数以代码实际落地为准；若仍超 300 行红线，后续版本继续拆。

## 7. 验证产出

- UT：controller 内存模型 / groupKey 命名（`session_id:<sid>_amt:<modeKey>`）/ not-allowed 门控 + 中文文案 / activate 返 AgentRun（running 时同一对象引用）/ forkedRun 拒并发 / AgentLoop 无 abort() 方法。
- AT（真 LLM，不 mock）：路径 R/S/T/U/V/W 6 条 + 回归 D/H/K。
- ET：UC-R（主对话）+ UC-S（forked summary）两条核心 E2E。
- 产出位置：`states/v0.0.15/verify/`。

## 8. 版本

v0.0.15（实现层追赶 spec：Agent interface 统一 + AgentRun instance + AbortController 内存模型 + groupKey+modeKey 全链路 + abort 收窄搬运工化 + forked 旁路多轮 ReAct 重写；对齐 8 个 P0 spec 20 项差异）。
