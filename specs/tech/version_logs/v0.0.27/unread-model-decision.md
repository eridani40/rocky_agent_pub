# v0.0.27 未读模型选型决策（watermark vs explicit-bool）

> version: 1.0
> 本文件外迁自 `[P0]session_state.md §6` / `[P0]sse_channel.md §7` / `[P0]session_store.md` 版本段 的决策表，控制核心 spec 文件长度 ≤300 行。
> 设计源：`states/v0.0.27/` 用户需求「session 完成但用户未读 → 会话列表红点；产生与消除逻辑尽量统一」。

## 1. 模型选型（watermark vs explicit-bool）

初版（已废弃）采纳 **watermark 模型**：Session 加 `lastReadAt` + `lastFinishedAt` 两个 timestamp，unread 由 `lastFinishedAt > lastReadAt` 派生；标读 = 推进 lastReadAt；GET /session/:id 内隐式 markRead。

用户两轮反馈否决，最终采纳 **explicit-bool 模型**：Session 加 `unread: boolean` 显式存储字段，产生与消除各一次离散 CAS 置位，无 timestamp 比较。

| 维度 | watermark（初版，废弃） | explicit-bool（最终，采纳） |
|---|---|---|
| **字段** | `lastReadAt: string\|null` + `lastFinishedAt: string\|null` | `unread: boolean`（单字段） |
| **未读判定** | 派生：GET 时实时算 `lastFinishedAt > lastReadAt` | 存储值：GET 直接返回 `session.unread` |
| **标读** | markRead → `lastReadAt = now()`（无条件覆盖 timestamp） | markRead → CAS `unread: true→false`（带 WHERE 幂等） |
| **产生未读** | 被动：什么都不做（水位线不动，新 lastFinishedAt 自然超过） | 主动：agent-loop 完成时点查前台，非前台 CAS `unread: false→true` |
| **GET /session/:id** | 隐式标读（handler 内调 markRead，违反纯读） | **纯读无副作用**（标读走独立 POST /session/:id/read） |
| **统一性表述** | 「同一字段 lastReadAt，产生被动/消除主动」 | 「同一字段 unread，产生与消除各一离散 timing」 |
| **不变量复杂度** | lastReadAt 单调、lastFinishedAt 仅 markIdle/markError 写、派生计算分支（null 处理） | CAS WHERE 子句互斥（产生 `WHERE unread=false`、消除 `WHERE unread=true`） |

### 1.1 否决 watermark 的核心理由（用户反馈）

1. **派生模型要求 GET 隐式标读才能消除**：watermark 下「消除」必须推进 lastReadAt，否则 lastFinishedAt 永远晚于 lastReadAt → unread 恒 true。最自然的实现是 GET /session/:id 内隐式 markRead（零新端点）。但 **GET 是查询语义，混入写操作（改字段 + 发事件）违反接口纯读性、不可缓存、调试时难定位**。
2. **timestamp 比较的不变量繁琐**：lastReadAt 单调、lastFinishedAt 写入时机限定、null 分支（从未标读/从未完成）等派生计算分支多，易出错。
3. **「产生是被动 no-op」反直觉**：开发者期望「产生未读」是一个明确的写操作，而非「什么都不做靠时间戳自然超过」。

### 1.2 采纳 explicit-bool 的优势

- GET 保持纯读（无副作用、可缓存、调试清晰）。
- 产生与消除对称（各一离散 CAS），代码直观。
- 不变量简单（CAS WHERE 子句互斥即幂等保护）。
- 「unread 是存储值」与前端 prop 模型天然对齐（`unread: boolean` 直接驱动红点）。

## 2. explicit-bool 模型的两个离散 timing（权威见 session_state.md §4.4/§6）

| timing | 触发 | 调用方（**都在 session 层**） | CAS |
|---|---|---|---|
| **产生（→true）** | 状态机 markIdle/markError CAS 成功 → emit `session_status_update(state→idle\|error)` → **session 层**（SessionUnreadOps runtime，订阅 statusBus）观察到 completion 信号 **且** `isSessionActive(sid)===false` | **session 层**（SessionUnreadOps runtime，监听 session_status_update；**非 agent-loop、非状态机**） | `UPDATE session SET unread=true WHERE id=:sid AND unread=false` |
| **消除（→false）** | 用户调 `POST /session/:id/read` | server SessionHandler（session 层；调 SessionUnreadOps.markRead） | `UPDATE session SET unread=false WHERE id=:sid AND unread=true` |

**三种 no-op 情形**（不写 unread）：
- 前台完成（isSessionActive=true）
- abort / interrupted / interrupting（不算完成）
- 崩溃恢复 reconcileOnStartup（异常修复，不算完成）

## 3. isSessionActive 实现选型（3 选 1，采纳 a；**消费方=session 层**）

未读产生 timing 需要「session 当前是否在前台」的判定。SseChannel 的 subs Map 此前只用于转发去重，需聚合为查询能力。**注意**：isSessionActive 的**实现**（查 subs Map）与本节选型无关地确定；其**消费方**（调用 isSessionActive 的层）见 §6 决策——最终为 **session 层**（非 agent-loop、非状态机）。

| 选项 | 评估 | 取舍 |
|---|---|---|
| **(a) 复用 SSE 订阅信号聚合**（**采纳**） | chat 页进入会话已 subscribe `session_panel:session_id:<sid>`；离开 unsubscribe。SseChannel 加 `isSessionActive(sid)` 查 subs Map 即可 | ✅ 零新 API、零新状态、零心跳、O(1) Map.has、与「订阅=在看」语义天然对齐 |
| (b) 显式 active-session registry / 心跳 | 需新建 registry 组件 + 前端定期心跳保活 + 超时清理；多一套状态机要维护 | 否决：过度设计，与已有订阅信号重复 |
| (c) 仅靠 GET /session/:id 进入时刻 | 无「离开」感知，无法支撑产生逻辑（run 完成时若已切走，c 仍认为在前台 → 漏标未读） | 否决：无法实现产生逻辑 |

**实现（`specs/tech/app/frontend/[P0]sse_channel.md §5`）**：
```typescript
isSessionActive(sessionId: string): boolean {
  return this.subs.has(`session_panel:session_id:${sessionId}`);
}
```

## 4. 事件策略（产生不发，消除发）

- **产生 unread=true 不发 `session_read_update`**：产生 timing 用户未订阅该 session 的 panel（isSessionActive=false）→ 即便发也无人收；list 拉取可见即可。
- **消除 unread=false 发 `session_read_update`**：订阅方场景 = 同 session 多 tab 时 A tab 标读、B tab 同步清红点。
- **payload 收敛为 `{unread: boolean}`**（删 lastReadAt/lastFinishedAt）。

## 5. 涉及 spec 清单（闭环）

| 文件 | 角色 |
|---|---|
| `specs/tech/agent/session/[P0]session_store.md` | 字段定义（unread: boolean）+ markRead API（**两 timing 都在 session 层**） |
| `specs/tech/agent/session/[P0]session_state.md` | 模型权威（§4.4 两 timing 调用方=session 层 + §6 不变量） |
| `specs/tech/agent/session/[P0]session_event.md` | session_read_update 事件（payload + 产生不发判断） |
| `specs/tech/app/frontend/[P0]sse_channel.md` | isSessionActive 实现（subs Map 查询，不变）+ §7 调用方=session 层 |
| `specs/api/overall/04-agent-session.md` | Session 响应字段 + GET 纯读 + POST /session/:id/read 端点 |
| `specs/ui/components/chat-page/_overview.md` | conv-item 红点 + 进入会话交互（GET + POST /read） |

## 6. 产生未读归属层决策史（v0.0.27 二次修订 — 关注点分离）

> 用户确认的核心分工（不可违背）：**Agent Loop = 干活的**（跑 LLM/工具循环完成工作，不碰 SSE/前台/未读）；**Session = 和用户交互 + 保持状态**（未读=状态、前台=交互，都是 session 自己的事）；**状态机保持纯粹**（只做状态 CAS，不感知 SSE/unread/前台）。

产生未读（state→idle/error 后 CAS unread=true）的**归属层**经过三次设计，前两次均错：

| # | 归属层（错） | 设计 | 否决理由 |
|---|---|---|---|
| (1) | **agent-loop** | agent-loop 在 markIdle/markError 后串调 `maybeMarkUnread()`；`SessionPresenceProbe`（=SseChannel 的 isSessionActive）通过 `setSseChannel()` 注入 AgentLoop（agent-manager 透传） | **违反关注点分离**：agent-loop 是「干活的」（跑 LLM/工具循环完成工作），不该碰 SSE/前台/未读——未读与前台是 session 自己的事。让 agent-loop 持有 sseChannel、查前台、写 unread，是把 session 的交互+状态职责错塞进干活层。 |
| (2) | **状态机注入 SSE** | 状态机在 markIdle/markError CAS 内部直接查 isSessionActive + 写 unread（或注入 sseChannel 到 stateMachine） | **违反「状态机不感知 SSE」纯粹原则**：状态机只做状态 CAS（markIdle/markError/...），不该感知 SSE / unread / 前台。让状态机查 SSE 维度信号会污染其单一职责，破坏既有不变量。 |
| (3) **采纳** | **session 层**（状态机之上的「交互+状态」层）自治 | session 层（`SessionUnreadOps` runtime）订阅状态机 emit 的 `session_status_update` completion 信号（状态机在 markIdle/markError CAS 成功后已 emit，零额外协议）；收到 `state→idle\|error` 时查 `sseChannel.isSessionActive(sid)`；false（非前台）→ CAS `unread=true` | **符合关注点分离**：未读+前台都是 session 的事，由 session 层自己持有/查询/写入。agent-loop 还原原始职责（只调 markIdle/markError）；状态机保持纯粹（只 CAS + emit completion 信号，不知 unread/SSE/前台的存在）。 |

### 6.1 产生触发的具体机制（hook / event / wrapper 三选一，采纳 event）

session 层观察 markIdle/markError 完成有三种候选机制：

| 选项 | 评估 | 取舍 |
|---|---|---|
| **(a) 状态机 completion hook**（回调） | markIdle/markError CAS 成功后调 `onComplete(sid, newState)` 回调，session 层注册 | 否决：状态机为订阅者定制 hook，仍把「完成语义」耦合进状态机接口；多订阅者难扩展 |
| **(b) 复用既有 `session_status_update` event**（**采纳**） | 状态机在每次 CAS 成功后已 emit `session_status_update(state, running, currentRunId)` 到 statusBus（topic=`session_panel`，group=`session_id:<sid>`，v0.0.12 既有的零额外协议）。session 层（SessionUnreadOps runtime）订阅此 bus，过滤 `state∈{idle,error}` 即得 completion 信号 | ✅ 零额外协议（事件 v0.0.12 已就绪、状态机本来就在 emit）、状态机接口零改动、session 层是普通订阅者（与前端 chat 页订阅同一 event 同构）、扩展性强 |
| (c) store 包装 markIdle/markError（wrapper） | session-store 层包装 stateMachine.markIdle/markError，调完原方法后串查 isSessionActive + CAS unread | 否决：包装层重复了 markIdle/markError 的调用点（agent-loop 仍直接调 stateMachine，绕过 wrapper 即失效）；且把 unread 决策塞回 store 调用链，仍是「调用方决定」模式 |

**采纳 (b) 的关键优势**：状态机只 emit 它本来就在 emit 的 event（不知有谁订阅、不知 unread），session 层作为普通订阅者自治决策。**completion 信号 = 既有 `session_status_update` event，零新协议、零状态机接口改动**。

### 6.2 崩溃恢复豁免（reconcile 不产生未读的实现）

`reconcileOnStartup()` 也调 markIdle 把 running/interrupting → idle，同样会 emit `session_status_update(state=idle)`。session 层订阅者会看到此信号，但需**豁免**（崩溃恢复不算正常 run 完成）：

- 实现：session 层订阅者识别 reconcile 路径——`reconcileOnStartup` 标记 run 终态=`interrupted`（非正常完成的 idle），session 层过滤「run 终态=interrupted 的 state=idle」跳过 unread CAS；或 reconcile 走专用 emit channel（不复用 session_status_update，避免触发订阅者）。
- 选型由 coder 读 `session-state-machine.ts` reconcile 路径定，spec 只约束结果：**reconcile 路径不产生 unread=true，session 保持崩溃前 unread 值**（不变量 §6.3-4）。

### 6.3 代码落地提示（coder 参考，非 spec 约束）

- 既有 `app/server/src/agent/session-unread-ops.ts`（`markUnreadTrue` / `markReadAndEmit`，已是 session 层模块）保留——其调用方从 agent-loop 改为 session 层订阅者。
- 删除 `agent-loop.ts` 的 `maybeMarkUnread()` + `sseChannel`/`SessionPresenceProbe` 注入；删除 `agent-manager.ts` 的 `setSseChannel` + 透传逻辑——agent-loop 还原为只调 markIdle/markError。
- 新增 session 层订阅者（建议落 `app/server/src/agent/session-unread-runtime.ts` 或 bootstrap 接线）：subscribe statusBus `session_panel`/`session_id:<sid>`，on `session_status_update` 过滤 state∈{idle,error}（+ reconcile 豁免）→ 调 `sseChannel.isSessionActive(sid)` → false 则 `markUnreadTrue(sid)`。
- 状态机 `session-state-machine.ts` **零改动**（继续 emit session_status_update）；`sse-channel.ts` 的 `isSessionActive` 实现**零改动**（消费方改 session 层）。
