# API Change Log — v0.0.12

> 增量记录 v0.0.12 相对 v0.0.11 的 HTTP 端点契约变更。
> 全量契约：`specs/api/overall/04-agent-session.md`（已就地更新到 v1.1）。PRD：`specs/prd/version_logs/v0.0.12/change_log.md`。Design 权威：`states/v0.0.12/design.md`（板块 4-6）。

## 1. Scope

v0.0.12 agent session 域三大契约层变更（design 板块 0 子问题 3/6/7 + 板块 4-6）：

1. **Session 响应加 state/running/currentRunId 字段**（§2）——暴露 session 五态机给前端，支撑 running 状态展现 + 打开恢复。
2. **新增 `POST /session/:id/abort`**（§3）——中断当前 run 的异步收尾端点（fire-and-forget，202）。
3. **§3.2 发消息并发语义重做**（§4）——从「running 时 409 报错」改为「enqueue 排队 + interrupting 时 activate 循环等待」，移除 409。

> 内部状态机定义（五态 + CAS + activate 三情况 + abort 4 步收尾 + half-data 三场景）属 tech spec 范畴，不在本 API 契约文件展开。详见 `specs/tech/agent/session/[P0]session_state.md` + `specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md`。

## 2. Session 响应字段扩展

### 2.1 新增字段（破坏性 —— 响应 shape 变化）

```typescript
interface Session {
  // ...原有字段...
  state: "idle" | "running" | "interrupting" | "interrupted" | "error";  // [v0.0.12 新增]
  running: boolean;         // [v0.0.12 新增] state ∈ {running, interrupting} 时 true
  currentRunId: string | null;              // [v0.0.12 新增] 当前活跃 run ULID；非 running 时 null
}
```

影响端点：`POST /session`（201）、`GET /session`（200 list）、`GET /session/:id`（200）—— 响应 shape 一致扩展，三端点同步返新字段。

### 2.2 字段语义

| state | running | currentRunId | 含义 | 前端 UX |
|-------|---------|--------------|------|---------|
| `idle` | false | null | 初始 / 正常结束空闲 | send 可点、无 loading |
| `running` | true | `<runId>` | run 进行中 | send 可点、显示中断按钮、enqueue view 可见（若有 pending） |
| `interrupting` | true | null | abort 收尾中（临时态） | 显示中断中 loading、send 可点（消息排队 + activate 循环等待） |
| `interrupted` | false | null | 中断终态 | send 可点、显示「已中断」 |
| `error` | false | null | 出错终态 | send 可点、显示 error |

### 2.3 状态来源（前端双通道）

- **拉取**：`GET /session` / `GET /session/:id` 直接读 state/running/currentRunId。
- **推送**：SSE `session_status_update` 事件（type/session_event.md 定义）—— state 任一转换时 emit，前端实时更新。
- **打开恢复**：前端切回 session 时 GET 一次拿当前 state；若 running/interrupting 则继续展示 loading + 中断按钮。

> 崩溃恢复（design 板块 7）：server 启动时 reconcile 把 running/interrupting 的 session 改为 idle + Run.status=interrupted，前端打开看到的是已恢复的终态。

## 3. 新增 `POST /session/:id/abort`

### 3.1 契约

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/session/:id/abort` | 中断当前 run + 异步收尾 | 无 | `202` + `{ ok: true }` |

### 3.2 语义要点

- **202 Accepted**：服务端已接收中断请求，开始 4 步收尾流程（详见 tech `agent_interrupt.md §2`）。**不 await 收尾完成**。
- **收尾完成感知**：调用方通过 SSE 订阅 `agent_loop` / `session_id:<sid>`，收 `run_end`(stopReason=`interrupted`) 事件；或 `GET /session/:id` 断言 state=interrupted + currentRunId=null。
- **幂等**：
  - session 无活跃 run（state∈{idle, interrupted, error}）→ 返 202（无操作）。
  - 并发多次 abort → CAS 串行化，仅首个 markInterrupting 成功，其余返 202。
- **错误**：`404` session 不存在。

### 3.3 内部 4 步收尾（不展开，引用 tech spec）

1. CAS markInterrupting + loop.abort()(signal)（仅当 currentRunId=thisRun）。
2. 等 loop 退出 → subscribe 回放 → 重组 partial（复用 message_start 的 messageId）+ interrupt 标记 → ingest；补 interrupted tool_result（悬空 tool_call）。
3. bus.clearReplay(group)。
4. emit run_stop(interrupted) + CAS markInterrupted。

详见 `specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md` §2-§6（half-data 三场景 / message id 顺序 / 外部副作用不可回滚 / clear replay 竞态消除）。

## 4. `POST /session/:id/messages` 并发语义重做

### 4.1 移除 409（破坏性）

- v0.0.11 及之前：「session 已有 run 在跑 → `409 Conflict`」（前端 UX：禁用 send）。
- v0.0.12：**废除 409**。running/interrupting 时发消息改为 enqueue 排队，端点始终返 `202 + { runId }`。

### 4.2 按 state 三情况 dispatch（design §4.3）

| state | 端点行为 | 返回 |
|-------|---------|------|
| `idle / interrupted / error` | enqueue + CAS markRunning(newRunId) + 启动新 AgentLoop | `202 + { runId: <newRunId> }` |
| `running` | enqueue 排队（不启动新 loop）；eager loop 下轮 drain 消费 | `202 + { runId: <currentRunId> }` |
| `interrupting` | enqueue 排队 + activate **循环等待**（poll 100ms 重读 state），直到非 interrupting（→ interrupted/idle）再 activate 新 loop | `202 + { runId: <newRunId> }`（循环等待期间保持连接） |

> **runId 字段语义**：idle/interrupted/error/interrupting 时返新 run 的 id；running 时返当前 running run 的 id（消息已排队，会被当前 run 或下个 run 消费）。

### 4.3 前端 UX 影响

- send 按钮**一直可点**（不再 disabled）。
- running 时 send 按钮左边显示**红色中断按钮**（design 板块 0 子问题 4）。
- running/interrupting 时新发的消息进 **enqueue view**（消息流外、输入框上方的排队区），被 `enqueued_message_processed` 后移入对话流（design §3.2）。

## 5. AT 影响（v0.0.12 新增 case 范围）

对应 overall §7 路径 G-J（实际 case 文件在编码前置阶段由 coder 创建到 `tests/api/`）：

- **G 中断 run**：`POST /messages` → run 中 → `POST /abort`（202）→ SSE 断言 run_end(interrupted) + GET state=interrupted。
- **H running 时排队**：run 中 POST /messages 不报 409 + 消息顺序落库。
- **I interrupting 循环等待**：abort 进入 interrupting → 立即 POST /messages（202）→ 新 run 消费 → 断言 `[partial(interrupted) ... 新query]` 顺序。
- **J 崩溃恢复**：构造 running/interrupting session → 重启 → GET state=idle + Run=interrupted。

> 遵循 memory `no-mock-api-e2e-tests`：AT 用真 LLM + 真 service，agent 实际写数据查真落库。中断时点的「run 中」判定可用 SSE 收到首个 `tool_call_*` 或 `text_block_delta` 后触发 abort。

## 6. 版本

version: 1.0（v0.0.12 新建：Session 响应加 state/running/currentRunId；新增 `POST /session/:id/abort`；§3.2 发消息并发语义从 409 改为 enqueue 排队 + interrupting 循环等待，移除 409；AT 路径 G-J）。基线见 `specs/api/version_logs/v0.0.8/change_log.md`（v0.0.8 端点骨架）+ v0.0.11 change_log（dev_config observability，与本版本无关）。
