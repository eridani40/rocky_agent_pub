# v0.0.12 PRD 变更日志

## 概述

本版本围绕 chat 域的**可靠性**做一次根治，权威设计 = `states/v0.0.12/design.md`（板块 3/5/7/9）。两件事：

1. **消息重复根治 + 输入/对话区展现逻辑重做**（核心）：移除客户端乐观插入（消除 `local-<ts>` 与服务端 ULID 的 id 双轨制），BUG-006 启发式去重 workaround 删除；引入 enqueue view（running 时排队区）；对话区唯一来源 = 服务端 SSE `message_start`。
2. **running 状态 + 中断 + 崩溃恢复**（核心）：session 引入五态状态机（idle/running/interrupting/interrupted/error）+ `running`/`currentRunId`/`state`；新增 `POST /session/:id/abort` 收尾链路（abort api 负责收尾，loop 单纯退出）；bootstrap `reconcileOnStartup()` 扫描崩溃残留 session 修复。

附带小需求：nav-brand「橙色 E」→「R」（板块 8，UI spec 范畴，本 PRD 不展开）。

## 主文件改动（`specs/prd/overall/03-llm-chat.md`）

### §3.1 Chat 对话 [v0.0.12 修订]

- 「打开 session + 发消息」行为改写：**对话区只渲染服务端 SSE Message**（来源 = `message_start` 服务端 ULID）；**移除客户端乐观插入**（`local-<ts>` 临时气泡作废）；BUG-006 启发式去重 workaround 删除。user 消息经 enqueue → drain → `message_start(user)` 落库后出现在对话区。

### §4 关键用户路径 — 新增 v0.0.12 路径 G–K（MANDATORY 测试最低覆盖）

| 路径 | 链路 | 最低 case |
|------|------|----------|
| **路径 G：running 时排队 → 逐条 drain** | run 中连发 N 条 → enqueue view 显 pending（`session.running && pending 非空` 才显）→ eager drain 逐条处理 → `message_start(user)` 落库后移入对话区 + 移除队列 | AT（`POST /messages` running 时**不返 409，入列排队** + 落库顺序）+ ET（enqueue view 2 pending → 逐条移除 → 对话区出现） |
| **路径 H：中断 run** | run 中 → 输入框左侧红色中断按钮（`session.running` 才可见）→ 点 → `POST /session/:id/abort`（202 异步收尾）→ state `running→interrupting→interrupted` + Run `interrupted` + `run_stop(interrupted)` → run-finish「已中断」+ loading 消失 | AT（`POST /abort` → 202 + state→interrupted + Run=interrupted + run_stop）+ ET（点 abort-btn → run-finish「已中断」+ loading 消失） |
| **路径 I：崩溃恢复后打开 running/interrupted session** | 进程被杀 → 重启 → `reconcileOnStartup()` 扫描 running + interrupting → markIdle + currentRunId=null + Run=interrupted → 打开 session 显正确状态（**非虚假 running**） | AT（构造 running/interrupting → 重启 → GET 断言 state=idle + Run=interrupted）+ ET（run 中切走再切回仍显正确运行态 / 重启后非虚假 running） |
| **路径 J：对话区无重复（BUG-006 根治回归）** | 发 1 条 → 对话区仅 1 条 user 气泡（移除乐观插入 → 消除 id 双轨制 → 删除去重 workaround） | AT（发 1 条 → `GET /messages` 仅 1 条 user）+ ET（发 1 条 → 对话区仅 1 条 user 气泡） |
| **路径 K：tool_call 配对（中断 in tool 执行）[硬约束]** | abort 命中 tool 执行中 → 已 ingest 的 tool_call 必有配对 interrupted tool_result → transcript 合法（下次 assemble 不 400） | AT（abort in tool → `GET /messages` 断言 tool_call 有配对 interrupted tool_result） |

> 附注：状态机五态 `idle/running/interrupting/interrupted/error`；activate 三情况（running→enqueue / idle·interrupted·error→新 loop / interrupting→循环等待 poll 100ms）；状态转换只由 agent loop(run_end) / abort api / activate 三者设置。

### 版本 bump

`03-llm-chat.md` 版本 1.1 → 1.2。

## 非功能需求（沿用，本版本强调）

- **无 mock**（遵循 memory `no-mock-api-e2e-tests`）：AT/ET 走真 LLM + 真服务，agent 实际写数据查真落库。
- **不变量**（design 板块 11）：abort api 是收尾唯一执行者（loop 中断只退出不收尾）；partial/interrupted message 复用 message_start 的 messageId（禁重新生成）；tool_call 必有配对 tool_result（悬空必补 interrupted result）；外部副作用不可回滚。

## 范围边界

IN（v0.0.12 必须交付）：
- 对话区只渲染服务端消息（移除乐观插入 + 删 BUG-006 workaround + UT）。
- enqueue view（输入框上方，running && pending 才显）。
- session 五态 + `running`/`currentRunId`/`state` + CAS 原子写。
- `POST /session/:id/abort`（202 异步）+ abort api 4 步收尾（half-data 持久化 + 补 interrupted tool_result + clear replay + state 收尾）。
- bootstrap `reconcileOnStartup()`（扫描 running + interrupting → 修复）。
- nav-brand E→R。

OUT（本版本明确排除）：
- error 态 half-data 收尾逻辑（design 板块 6.8 标注「待 spec 细化」，候选统一 `finalizeRun`，不阻塞本版本 PRD 确认）。
- 外部副作用回滚（不可回滚，spec 仅声明）。

## 对齐情况

- 权威设计：`states/v0.0.12/design.md`（板块 3 对话区+enqueue / 板块 4 状态机 / 板块 5 中断 / 板块 6 half-data / 板块 7 崩溃恢复 / 板块 9 spec 变更清单）。
- UI 契约：`specs/ui/components/chat-page/_overview.md`（§5 交互 2 移除乐观插入 + enqueue view + 中断按钮）、`_components.md`（新增 enqueue-view / abort-btn）、`framework/nav-rail.md`（E→R）。
- tech/api：`specs/tech/agent/session/session_store.md`（五态 + CAS）、`agent_interface_and_loop/agent_interrupt.md`（新增）、`agent_manager.md`/`agent_loop.md`/`agent_event.md`（修改）；`specs/api/overall/04-agent-session.md`（Session 响应加 state/running/currentRunId + `POST /abort` + 发消息不再 409）。
- 关联 Bug：BUG-006（v0.0.8 user 消息重复，本版本根治删除 workaround）。
