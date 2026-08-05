# v0.0.69.test_refactor — API 变更

> 版本类型：测试基建重构（tests 框架）。**仅一个新端点**，且为 test-only，不进生产 API 契约（`specs/api/overall/04-agent-session.md` 不动）。

## 新增：`POST /session/:id/run`（test-only 同步 wrapper）

**[v0.0.69.test_refactor]** 专给黑盒测试用的同步端点：POST /messages 的 enqueue+activate + **server 内部 await run 终态** + 同步返最终结果。消除测试侧所有 poll/SSE 等完成的 flaky 代码（如旧 compact case 查 v0.0.55 删掉的 `summaryTask` 字段静默失效 200s）。

### Gate（双重，生产绝不暴露）
- **router 层**（`router.ts:370`）：`process.env.NODE_ENV !== 'test'` → 直接 404，不进 handler（对齐 `/api/workspace/*` 先例 `router.ts:387`）
- **handler 层**（`session-run.ts:102`）：同样 gate，防 handler 被 import 绕过直接调

### 请求
| method | path | body | 说明 |
|---|---|---|---|
| `POST` | `/session/:id/run` | `{content: string, providerId?: string, modelId?: string, sender?: {source: string}}` | 与 POST /messages 同，但**不支持 `activate`**（run 端点始终 activate + await） |

### 响应
`200`（**同步**，不是 202——已 await 到终态）：
```jsonc
{
  "runId": "01KWR...",          // AgentRun.runId（ULID）
  "enqueueId": "",              // deliverTo 不返 enqueueId（与 messages handler 一致）
  "state": "idle",              // session 终态：idle | interrupted | error | unknown
  "stopReason": "no_tool_call", // 从 RunRecord 取（no_tool_call / interrupted / error 等）
  "error": null,                // stopReason='error' 时：RunErrorInfo={errorCategory, displayReason, errorDetail?}
  "messages": [ /* 本次 run 期间产生的 assistant/system/tool messages（user msg 无 runId，自然过滤）*/ ]
}
```

### 状态码
| code | 场景 |
|---|---|
| 200 | 同步完成（state 进入 idle/interrupted/error 终态） |
| 400 | body 非法 / content 空 / provider-model 不存在 |
| 403 | subagent session（readonly，对齐 messages handler） |
| 404 | session 不存在 / **非 test env（gate）** |
| 405 | 非 POST |
| 500 | deliverTo activate 失败（session 找不到 / AgentLoop 构造失败） |
| 504 | 5min run 未到终态（调用方可显式 abort 或重试） |

### 行为细节
1. session 存在 + 非 subagent 校验（对齐 messages handler）
2. body 解析 + provider/model 校验并落 session 持久（同 messages handler）
3. 构造 user message（`sender={source:'user'}`，无 agent 字段——判别联合 user 变体）
4. `manager.deliverTo(sessionId, userMsg)` 拿 AgentRun（复用，不重新实现 enqueue/activate）
5. `await Promise.race([agentRun.promise, timeoutSignal(5min)])`——复用 `AgentRun.promise`（loop 退出时 settle）
6. poll `session.state` 直到终态（防 abort 路径下 `interrupting` 临时态：loop 退出/promise resolve 后 abort step2-4 markInterrupted 之间有窗口）
7. `store.getRun` 拿真实 stopReason + error；`store.getMessagesByRun` 拿本次 run 期间 messages
8. 200 同步返回

### 实测（2026-07-05）
curl POST /run `{content:"Reply briefly with token PONG-RUN-TEST", providerId, modelId}` → 3.77s 返 200，`state=idle, stopReason=no_tool_call, messages=[{role:assistant, content:"PONG-RUN-TEST"}]`。curl 阻塞到 run 完成（同步语义验证）。

### 不影响现有契约
- POST /messages（§3.2）**零改动**——run 是独立端点
- 不进 `04-agent-session.md` overall（test-only，版本级记录在此）
