# v0.0.69.test_refactor — tech: POST /session/:id/run 同步 wrapper

> 测试基建：消除测试侧 poll/SSE 等完成信号的 flakiness。test-only（NODE_ENV=test gate），非生产 API。

## 设计目标
real-LLM case 的"等 run 完成"在测试侧用 `poll_state` / for-i-seq / SSE 鼓捣，易 flaky（如 compact case 查 v0.0.55 删掉的 `summaryTask` 字段静默失效 200s）。改由 server 内部 await run 终态，同步返结果。

## 实现路径（`app/server/src/handlers/session-run.ts`）

### await 信号：复用 `AgentRun.promise`（零新增 API）
**不新增** `AgentManager.awaitRun`——直接用现成的 `AgentRun.promise`：
- `agent-run-registry.ts:attachRunPromise` 在 loop.start() 前给每个 AgentRun 绑了 promise
- loop 正常退出 → promise resolve（state=completed）
- loop 异常退出 → promise reject（state=error）

```
agentRun = await deliverTo(sessionId, userMsg)   // 拿 AgentRun
await Promise.race([agentRun.promise, timeout(5min)])  // 复用现成 settle 信号
```
事件驱动（Promise.race），**非忙轮询**。

### 为何还要 poll session.state（兜底，非主信号）
`agentRun.promise` resolve 时 loop 已退出，但 **abort 路径**有个窗口：
- abort step1 `markInterrupting` → loop 退出 → promise resolve
- → abort step2-4 `finalizeHalfData` + `markInterrupted`（state 才进 interrupted 终态）

promise resolve 那一刻 state 可能仍是 `interrupting` 临时态。若直接返，响应体 state=interrupting 让测试误判。故 promise resolve 后再 poll session.state 到终态（idle/interrupted/error），最多 10s（50ms 间隔），cheap fs read。

### timeout 兜底
`Promise.race` + 5min `timeoutSignal`。超时返 504 `{error:'run_timeout', runId}`，调用方可显式 `POST /session/:id/abort` 或重试。**绝不挂死**。

### 结果读取（落盘的真相）
- `store.getRun(sessionId, runId)` → 真实 `stopReason` + `RunErrorInfo`（loop 退出前 `agent-loop-lifecycle.ts:persistRun` 已落盘）
- `store.getMessagesByRun(sessionId, runId)` → 本次 run 期间 assistant/system/tool messages（user msg 无 runId，天然过滤）

**不复读 agentRun 内存态**——读落盘 RunRecord（= SSE run_end / GET /session 暴露的同一真相）。

## 复用关系
- `manager.deliverTo(sessionId, userMsg)`（v0.0.31 收敛的统一投递入口，`[P0]agent_manager.md §2.4`）—— run 端点绝不重新实现 enqueue/activate
- `resolveProviderModel` + `store.updateSession`（provider/model 校验落持久，与 messages handler 同逻辑）

## Gate 设计（双重）
1. **router 层**（`router.ts:370`）：非 test → 404 短路，不进 handler（对齐 `/api/workspace/*` `router.ts:387` 先例）
2. **handler 层**（`session-run.ts:102`）：同样 gate——handler 是 export 函数，防被未来其他模块 import 绕过 router 直接调

两层零成本（一行 if），换生产 API surface 双重保险。

## 相关 spec / 代码
- API 契约：`specs/api/version_logs/v0.0.69.test_refactor/change_log.md`
- 复用：`[P0]agent_manager.md §2.4`（deliverTo）、`[P0]agent_interface.md §2`（AgentRun.promise）
- 代码：`app/server/src/handlers/session-run.ts`（205 行）、`app/server/src/router.ts:53,175,370-374`、单测 `__tests__/session-run.test.ts`（9 case）
