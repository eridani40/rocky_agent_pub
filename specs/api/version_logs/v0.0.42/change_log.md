# v0.0.42 API 变更日志 — 无新 HTTP 端点

## 概述

**v0.0.42 无 API 变更**——本版本交付的三处对齐（session/run 两层状态 + 消息来源对齐 + IME 守护）均不暴露新 HTTP 端点，全部是后端 event-bus 内部 / 前端 / textarea 行为：

| 块 | 涉及层 | 为何无 API 变更 |
|---|---|---|
| **块 1**：agent_loop replay 粘住生命周期标记 | 后端 event-bus 内部（`event-bus.ts` 加 `lifecyclePredicate` + `bootstrap.ts` 注入） | sticky slot 是 EventBus 实例级配置，**不暴露 HTTP**；SSE 协议/帧格式（`{ topic, group, data, timestamp }`）不变；只是切走切回重订阅 agent_loop 时 replay buffer 行为变了（sticky run_start 不被 clearReplay 清） |
| **块 2**：两层状态前端架构（stop 圆环 + on-message spinner） | 前端组件 | 严格前端组件改造（`component-abort-btn` 圆环 + `component-loading-status` 移除浮动改 on-message spinner），**不涉及 HTTP** |
| **块 3**：`component-message-stream` 加 `sideResolver` | 前端渲染内核 | 前端 prop（左右侧判定），**不涉及 HTTP** |
| **块 4**：IME 守护（studio 两页 textarea） | 前端 textarea onKeyDown | 前端输入处理，**不涉及 HTTP** |

## 复用端点（全部既有，零变更）

- `POST /session/:id/abort`（[v0.0.12] / [v0.0.15] body `{runId, modeKey}`）—— stop 按钮点击调用，202 fire-and-forget。
- `GET /session/:id`（含 `state`/`running`/`currentRunId`）—— 进入会话恢复 sessionRunning 初始态。
- `GET /session/:id/messages?limit=50&beforeId=`—— transcript 拉取 + 分页续载。
- `POST /session/:id/messages`（[v0.0.12] 入列 enqueue）—— 发消息。
- `GET /sse` SSE 流（`agent_loop` / `session_panel` / `session_meta` 三个 topic）—— 帧格式 `{ topic, group, data, timestamp }` 不变。

## agent_loop replay 行为变化（非协议变更，仅实现细节）

`agent_loop` topic 的 bus 在 `bootstrap.ts` 注册时注入 `lifecyclePredicate`（识别 `run_start` / `run_end`），让这两类事件**额外写入独立 sticky slot**（与 content buffer 分离），`clearReplay` 只清 content buffer、不清 sticky；subscribe 时先回放 sticky 再回放 content buffer。

**注意**：这是 EventBus 实现层的内部行为，**不影响 SSE 协议契约**——前端仍按 `agent_loop` topic 订阅、按 AgentEvent 联合类型解析帧。切走切回重订阅时收到的 replay 序列含 sticky run_start（让前端 `runActive` 翻转可恢复），但这是「replay buffer 内部组成变化」，不是新 event 类型 / 新字段 / 新 topic。详见 `specs/tech/agent/event/[P0]event_bus.md §4.3` + `specs/tech/app/frontend/[P0]sse_channel.md §10.7`。

> 旧描述如「replay 不含 run_start / clearReplay 清整个 buffer」已不准确（run_start 现粘在 sticky slot）；本版本 replay 含 sticky run_start（如果当前 run 进行中）。

## 版本

v0.0.42（session/run 两层状态 + 消息来源对齐 + IME 守护。**无新 HTTP 端点**；replay 粘住是 event-bus 内部实现，SSE 协议/帧格式不变；sideResolver / IME / 两层状态 UI 全前端。abort / messages / session / sse 端点全复用现有）。
