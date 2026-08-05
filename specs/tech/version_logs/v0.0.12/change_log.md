# Tech Change Log — v0.0.12

> 增量记录 v0.0.12 相对 v0.0.11 的技术架构变更。
> 全量概念权威：`specs/tech/agent/`、`specs/tech/config/`、`specs/tech/app/`。
> PRD：`specs/prd/version_logs/v0.0.12/change_log.md`。
> v0.0.12 = **session/状态/中断核心**：消息重复根治（移除乐观插入）+ Session 五态状态机 + agent loop 中断 + abort api 收尾 + 崩溃恢复 + nav-brand E→R。
> 设计源：`states/v0.0.12/design.md`（板块 4/5/6/9 权威）。

## 1. Scope 与口径

**IN SCOPE（v0.0.12 新增/重构 — 本 tech spec 覆盖 session/状态/中断）**：

- **Session 运行态字段**：Session 加 `state`（五态枚举）/ `running: bool`（冗余高频查询）/ `currentRunId: string | null`。
- **五态状态机**：idle / running / interrupting / interrupted / error；CAS 原子条件写（markRunning/markInterrupting/markInterrupted/markIdle/markError）。
- **Run.status 加 interrupted**（abort 收尾 / 崩溃恢复终态）。
- **崩溃恢复 reconcileOnStartup()**：扫描 running/interrupting → idle + Run=interrupted。
- **核心中断分工**：abort api（AgentManager.abort）是**收尾唯一执行者**（4 步）；agent loop **单纯退出不做任何收尾**。
- **abort api 4 步流程**：step1 state=interrupting+清 currentRunId+loop.abort(signal)；step2 等 loop 退出+subscribe 回放+重组 partial（复用 message_start id）+补 interrupted tool_result+ingest；step3 clearReplay(group)；step4 emit run_stop(interrupted)+state=interrupted。
- **loop 中断三条件**：signal.aborted OR state∈{interrupting,interrupted} OR currentRunId≠self；高频检查（LLM fetch/tool/emit/ingest/iteration 边界）。
- **half-data 三场景**：A partial text 持久化+标 interrupted；B/C 悬空 tool_call 补 interrupted tool_result；外部副作用不可回滚。
- **activate 三情况**：running→already_activated；idle/interrupted/error→新 loop；interrupting→循环等待（poll 100ms）。
- **session_event 加 session_status_update**：data:{state,running,currentRunId}。
- **内存缓存结论**：loop 高频检查用 AbortController.signal（内存级 O(1)），不缓存 session 状态。

**OUT OF SCOPE（本 tech spec 不覆盖，归其他 spec/版本）**：

| 项 | 归属 |
|----|------|
| HTTP API 层（POST /session/:id/abort、GET /session 加 state 字段、§3.2 409 改 enqueue） | `specs/api/overall/04-agent-session.md`（API spec） |
| UI 层（enqueue view / abort btn / 移除乐观插入 / running 状态渲染） | `specs/ui/components/chat-page/`（UI spec） |
| nav-brand E→R + brand 契约 | `specs/ui/components/framework/nav-rail.md`（UI spec） |
| AgentManager.activate 闸门从内存 Map 改 session 持久化状态 + AgentManager.abort 扩展 | `[P0]agent_manager.md`（同目录，**v0.0.12 后续 spec 任务**，本 change_log 列入清单） |
| AgentLoop §4 引用中断判断 + run_end 设 state + abort signal 注入 LLM/tool | `[P0]agent_loop.md`（同目录，**v0.0.12 后续 spec 任务**） |
| AgentEvent §4.3 修正（user 进 enqueue view）+ StopReason 加 interrupted | `[P0]agent_event.md`（同目录，**v0.0.12 后续 spec 任务**） |
| bootstrap 集成 reconcileOnStartup | `specs/tech/app/`（bootstrap spec，**v0.0.12 后续 spec 任务**） |
| error 态 half-data 收尾（统一 finalizeRun） | future（design §6.8，v0.0.12 不实现） |

## 2. 状态机决策（design §4）

**为什么五态而非两态**：原 Session 仅 `status:"active"|"archived"` + 内存 loops Map 判 running。问题：(1) 持久化缺 running 无法 SSE/打开恢复；(2) activate 闸门靠内存 Map，abort→loop 退出有窗口挡不住新 run；(3) 无中断态表达「收尾中」「被中断后」。五态 + CAS 把闸门下沉到持久化层，abort 与 activate 互斥由 CAS 保证。

**关键决策**：

- **interrupting 临时态**：abort step1 写、step4 清，期间 activate 循环等待（不并发起 loop），保证 clear replay 期间无其他 loop 写 buffer（design §5.6 B 方案，竞态消除）。
- **CAS 全条件写**：所有状态转换带 WHERE 子句防并发交错。markInterrupting CAS `currentRunId=expectedRun AND state=running`，并发 abort 只有一个胜出。
- **running bool 冗余**：state ∈ {running, interrupting} ⇔ running=true，高频查询用（前端 GET /session、UI 渲染中断按钮）避免枚举解析。
- **崩溃恢复只动 running/interrupting**：error/interrupted/idle 已终态/初始，不动。

## 3. 中断核心分工（design §5）

**为什么 abort api 收尾而非 loop**：loop 被中断后若自己收尾，需在「检查 signal→做收尾」之间再检查 signal（TOCTOU 竞态），且 loop 持有的中间状态（partial text、悬空 tool_call）分散在各阶段，loop 自己收尾代码复杂易错。分工后：loop 只管「检测到中断就退出」；abort api 作为外部协调者，subscribe 回放拿到完整事件流，统一处理 half-data。

**half-data 三场景**：

| 场景 | 协议约束 | 处理 |
|---|---|---|
| A partial text | 软（纯 text 合法） | 重组 partial + 标 interrupted + ingest |
| B 悬空 tool_call（已 ingest 无 result） | 硬（下次 assemble 400） | 补 interrupted tool_result（配对 toolCallId） |
| C 工具执行中已改外部世界 | 硬（同 B） | 补 interrupted tool_result；**外部副作用不可回滚** |

**message ID 顺序硬约束**：abort api 重组 partial **复用 message_start 的 messageId**（t1 时刻 ULID），必然 < 新 query ULID(t2)。禁重新生成。对照：enqueued message「处理时生成 messageId」（agent_loop §4 ①）；partial「message_start 时即分配」。

**session 写串行**：per-session 写锁 + abort api 收尾优先，保证 `partial(t1) < tool_result(t_abort) < 新query(t_b)` 顺序。

## 4. 内存缓存结论（design §5.5）

loop 高频检查中断用 **AbortController.signal**（abort step1 设置），内存级 O(1) 读，**不读 store、不需缓存 session 状态**。session 状态持久化是低频写（abort/activate/run_end 三处），abort step1 同步设置 signal + markInterrupting，两者一致。loop 见 signal.aborted 与下次读 store state=interrupting 等价。

## 5. 文件级变更清单（汇总）

**新增**：

- `specs/tech/agent/session/[P0]session_state.md`（v1.0，五态状态机 + CAS API + 转换表 + activate 三情况 + reconcileOnStartup）。
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md`（v1.0，核心分工 + loop 中断三条件 + 副作用门控 + abort 生效点 + abort api 4 步 + half-data 三场景 + message id 顺序 + clear replay B 方案）。
- `specs/tech/version_logs/v0.0.12/change_log.md`（本文件）。

**修改**：

- `specs/tech/agent/session/[P0]session_store.md`（v1.3→v2.0）：
  - Session 加 `state: SessionState` / `running: boolean` / `currentRunId: string | null` 字段
  - 新增 `SessionState` 类型（idle/running/interrupting/interrupted/error）
  - Run.status 联合加 `"interrupted"`
  - SessionStore 接口加 6 个状态机方法（markRunning/markInterrupting/markInterrupted/markIdle/markError/reconcileOnStartup）
  - 头部引用 `[P0]session_state.md` 为状态机权威
- `specs/tech/agent/session/[P0]session_event.md`（v1.1→v1.2）：
  - SessionEventType 加 `"session_status_update"`
  - 新增 `SessionStatusUpdateEvent` + `SessionStatus` interface
  - 触发时机表扩展（6 个 CAS API + reconcileOnStartup 各对应一个 session_status_update）
  - producer 描述补「状态机 API」

**待 v0.0.12 后续 spec 任务**（本 change_log 列入清单，本批未改）：

- `specs/tech/agent/agent_interface_and_loop/[P0]agent_manager.md`：activate 闸门从内存 Map 改 session 持久化状态（三情况）；加 `abort(sessionId)` 方法（4 步收尾）。
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_loop.md`：§4 引用 `[P0]agent_interrupt.md`（中断判断 + 副作用门控）；run_end 设 state（markIdle/markError）；abort signal 注入 LLM/tool。
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md`：§4.3 修正「user 进 enqueue view」；StopReason 联合加 `"interrupted"`；partial message 标 interrupted 语义。
- `specs/tech/app/[P0]bootstrap_reconcile.md`（或并入现有 bootstrap）：reconcileOnStartup 接入点。

## 6. 与 v0.0.11 spec 的差异（破坏性变更清单）

| 维度 | v0.0.11 | v0.0.12 | 破坏性 |
|---|---|---|---|
| Session 字段 | status:"active"\|"archived" + usage | 加 state（五态）/ running / currentRunId | **是**（schema 加字段，旧 session 默认 state=idle/running=false/currentRunId=null） |
| Run.status | running/completed/failed/paused | 加 interrupted | **是**（枚举扩展，旧代码 status 判断需兼容） |
| activate 闸门 | 内存 AgentManager.loops Map.isRunning() | session 持久化 state CAS（三情况） | **是**（impl 重写，已落 agent_manager 待改） |
| AgentManager 接口 | enqueue/activate/subscribe | 加 abort(sessionId) | **是**（新方法） |
| SessionEventType | session_usage_update | 加 session_status_update | 否（union 扩展，旧消费方忽略未知 type 即可） |
| StopReason | 6 值（no_tool_call/...） | 加 interrupted（待 agent_event 改） | **是**（枚举扩展） |
| AgentLoop run_end | 自收尾（persistUsage + emit run_end） | 被中断时不收尾；正常/error 仍收尾 + 设 state | **是**（impl 加中断分支） |
| 消息重复（BUG-006 workaround） | 客户端启发式去重 | **删除**（对话区只渲染服务端消息） | **是**（前端 chat-slice-reducer 删 dedup 逻辑 + UT） |

## 7. 关键不变量（design §11 — 写进 spec）

1. abort api 是收尾唯一执行者；loop 被中断只退出，不做任何收尾。
2. 状态转换只由 agent loop(run_end) / abort api / activate 三者设置。
3. partial/interrupted message 复用 message_start 的 messageId，abort api 重组禁重新生成。
4. session transcript 写串行（per-session 写锁），abort api 收尾优先。
5. loop 中断三条件：signal.aborted OR state∈{interrupting,interrupted} OR currentRunId≠self。
6. loop 高频检查用 signal（内存级）；session 状态低频持久化。
7. markRunning/markInterrupting/markInterrupted/markIdle/markError 全 CAS 原子。
8. interrupting 时 activate 循环等待（不并发启动新 loop）→ clear replay 安全。
9. tool_call 必有配对 tool_result（悬空必补 interrupted result）。
10. 外部副作用不可回滚。
11. activate 闸门 = session 持久化状态（非内存 loops Map）。

## 8. 版本

version: 1.0（v0.0.12 新建：session/状态/中断核心 tech spec — 五态状态机 + CAS + activate 三情况 + reconcileOnStartup 崩溃恢复 + 核心中断分工（abort api 收尾 / loop 单纯退出）+ abort 4 步 + half-data 三场景 + message id 顺序 + session_event 加 session_status_update + nav-brand E→R 归 UI spec）。
