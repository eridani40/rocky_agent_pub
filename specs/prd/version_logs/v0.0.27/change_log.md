# v0.0.27 PRD 变更日志 — Session 未读红点（explicit-bool 模型）

## 概述

本版本交付一个**会话列表的未读提示**：用户离开时某些 session 跑完了，回来在会话列表一眼看到红点；点进去即清除。**布尔红点，不计数；单端 electron，不多端同步。**

技术方案已在概念 spec 定稿（**explicit-bool 模型**——`unread: boolean` 持久化存储字段，两个离散 timing 各写一次：产生/消除）。本 PRD 仅做产品化表达 + 关键用户路径，**不重新设计**。

| 维度 | v0.0.27（本版） |
|------|----------------|
| **模型** | explicit-bool——`Session.unread: boolean` 持久化存储字段（GET 直接返回，非派生） |
| **产生**（session 层自治） | **session 层**（SessionUnreadOps runtime，非 agent-loop、非状态机）订阅状态机 emit 的 `session_status_update(state→idle\|error)` completion 信号 → 查 `isSessionActive(sid)`=false（非前台）→ CAS `unread: false→true`。agent-loop 只调 markIdle/markError，状态机只 CAS + emit 信号，均不碰 unread/前台。 |
| **消除** | 前端进入会话时显式 `POST /session/:id/read` → handler `markRead(sid)` CAS `unread: true→false` + emit `session_read_update` |
| **视觉** | conv-item 右上角 7px 红点 `#DC2626`，`unread && !active` 时渲染（active 不显示） |

权威输入：`reqs/v0.0.27/req.md`；概念权威源：见 §5 对齐确认。

---

## 1. 用户故事

> 用户在 session A 触发一个长任务后切去做别的事（切到 session B 或最小化）→ A 在后台跑完 → 用户回到会话列表 → **A 的列表项右上角冒红点** → 一眼知道「A 有新内容我没看过」→ **点 A 进去**（前端 GET /session/A + POST /session/A/read）→ **红点消失**。

**核心价值**：跨会话/多任务场景下，用户不需要逐个点开 session 确认是否跑完——列表红点是「未读」的视觉提醒，降低认知负担。

**为什么不计数**：本版本只做布尔红点（有/无未读），不做数字 badge（「3 条新消息」）。计数需要更复杂的产生/消除口径（每条消息分别 track），布尔模型已覆盖核心价值（提醒用户「该看了」）。

---

## 2. 关键用户路径（MANDATORY — = 测试最低覆盖要求）

每条路径至少一个 API 或 E2E case。verifier 不得低于此覆盖。无 mock（遵循 memory `no-mock-api-e2e-tests`：真 LLM + 真服务）。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 1【产生】**：非前台完成 → 冒红点 | session A 触发 run → 用户切到 session B（unsubscribe A 的 session_panel）→ A 的 run 完成（`markIdle`/`markError`，状态机 emit session_status_update(state→idle\|error) → **session 层**订阅到 completion 信号，查 `isSessionActive(A)=false` → CAS `unread: false→true`，**不发 session_read_update**）→ `GET /session` 列表 A.unread=true → conv-item-A 渲染红点 | `POST /session/:id/messages` · `markIdle`→session_status_update · session 层 `isSessionActive`+CAS unread · `GET /session`（unread 字段）· conv-item-unread-dot UI | AT（路径 X）+ ET（UC-27.1） |
| **路径 2【消除】**：用户点带红点的 A → 红点消失 | 用户点击 conv-item-A → `onSelect(A)` → 前端 `GET /session/A`（纯读）+ `POST /session/A/read`（CAS `unread: true→false` + emit `session_read_update`）→ 响应 session.unread=false → conv-item-A 红点消失 | `POST /session/:id/read`（新增）· `markRead` CAS · SSE `session_read_update` · conv-item reducer | AT（路径 Y）+ ET（UC-27.2） |
| **路径 3【前台不产生】**：在 A 时 A 完成 → 不冒红点（no-op） | 用户保持在 session A（subscribe session_panel:A 持续）→ A 的 run 完成（`markIdle`，session 层收到 completion 信号后查 `isSessionActive(A)=true` → **no-op**，不置 true 也不置 false）→ `GET /session` A.unread=false（前提：进入 A 时已 POST /read 清零）| `markIdle`→session 层 `isSessionActive=true` no-op 路径 | AT（路径 Z） |
| **路径 4【持久化】**：app 重启 → 未读 session 仍冒红点 | A 处 unread=true 状态 → app 重启 → bootstrap 不动 unread 字段（崩溃恢复 reconcileOnStartup **不产生未读**，session 保持崩溃前 unread 值）→ `GET /session` A.unread=true → 红点仍显示 | `reconcileOnStartup` 不动 unread · `Session.unread` 持久化字段 | AT（路径 X 持久化变体） |
| **路径 5【abort 不产生】**：用户 abort A → A 不冒红点 | 用户在 A 触发 run → 切到 B → 用户（或自动）`POST /session/A/abort` → A 走 abort 4 步收尾 → state `running→interrupting→interrupted` → **abort 不算完成，session 层仅响应 state∈{idle,error}，不触发 unread=true**（markInterrupted/markInterrupting emit 的 state 不在订阅过滤范围）→ `GET /session` A.unread=false | abort api 4 步 · session 层仅响应 idle/error（不响应 interrupted） | AT（abort 路径回归 + GET /session unread=false 断言） |

> **三条 no-op 情形**（不写 unread 字段，对齐概念 spec `[P0]session_state.md §4.4`）：
> 1. **前台完成**：markIdle/markError 时 `isSessionActive(sid)=true` → no-op。
> 2. **abort / interrupted / interrupting**：abort 是用户主动中断，非「完成待你看」事件，不产生未读。
> 3. **崩溃恢复 reconcileOnStartup**：异常修复不算完成，不产生未读；session 保持崩溃前 unread 值。

---

## 3. 范围

### 3.1 IN SCOPE

1. **未读产生**（**session 层**自治）：状态机 `markIdle`/`markError` CAS 成功后 emit `session_status_update(state→idle|error)`；**session 层**（SessionUnreadOps runtime，非 agent-loop、非状态机）订阅此 completion 信号 → 查 `isSessionActive(sid)`=false → CAS `unread: false→true`（CAS 幂等保护 `WHERE unread=false`）。agent-loop 只调 markIdle/markError，状态机只 CAS + emit，均不碰 unread/前台。
2. **未读消除**（API + 前端）：新增端点 `POST /session/:id/read`（唯一消除入口，调 `markRead(sid)` CAS `unread: true→false` + emit `session_read_update`）；前端进入会话调 `GET /session/:id`（纯读）+ `POST /session/:id/read`（清未读）。
3. **持久化**：`Session.unread: boolean` 字段持久化（默认 false）；崩溃恢复不动 unread。
4. **conv-item 视觉**：红点 `conv-item-unread-dot` = `absolute top-2 right-2 w-[7px] h-[7px] rounded-full bg-[#DC2626]`，条件渲染 `unread && !active`；testid `conv-item-{id}-unread-dot`。
5. **Session 响应加字段**：`GET /session` / `GET /session/:id` / `POST /session/:id/read` 响应含 `unread: boolean`（显式存储值，非派生）。

### 3.2 OUT OF SCOPE（NON-GOALS）

| 排除项 | 理由 |
|--------|------|
| **未读计数（数字 badge）** | 本版只做布尔红点；计数需 per-message track，复杂度收益不匹配，延后 |
| **多端同步** | 单用户 electron 应用，不考虑多客户端并发未读同步；CAS 串行化已处理同 session 多 tab 并发 |
| **watermark 模型**（lastReadAt/lastFinishedAt 派生） | 初版采纳，用户两轮反馈否决（GET 隐式 markRead 违反纯读、调试难定位）；改 explicit-bool，决策见 `specs/tech/version_logs/v0.0.27/unread-model-decision.md` |
| **视觉保真度比对** | 本版无 HTML 设计稿（仅 `req.md` 文字需求 + 颜色决策 `specs/ui/version_logs/v0.0.27/unread-dot-color-decision.md`），vision_check compare 跳过；e2e 单图功能检查仍覆盖红点出现/消失 |
| **GET /session/:id 隐式标读** | GET 是纯查询，标读走独立 `POST /session/:id/read`（概念 spec 已定） |

---

## 4. E2E Use Cases（conv-item 红点视觉）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-27.1 | 触发 session A run → 切到 session B（A 非前台）→ 等 A 完成 → 截图会话列表 | A 的 conv-item 右上角出现 7px `#DC2626` 红点；B 无红点 |
| UC-27.2 | 承接 UC-27.1（A 有红点）→ 点击 conv-item-A → 截图会话列表 + 会话详情 | A 的红点消失（已进入会话，unread=false）；会话详情区显示 A 的消息流 |
| UC-27.3 | 触发 session A run → **保持在 A**（前台）→ 等 A 完成 → 截图会话列表 | A 不冒红点（前台完成 no-op）；切换到 B 再切回 A，A 仍无红点 |
| UC-27.4 | A 有红点 → 重启 app → 截图会话列表 | A 红点仍在（unread 持久化） |

> E2E 用单图功能检查（`vision_check.py` 或 MCP vision）断言红点存在/不存在 + 颜色 `#DC2626` + 位置（conv-item 右上角）。无设计稿 → 不跑 compare。

---

## 5. PRD ↔ 概念 spec 对齐确认（MANDATORY）

逐条引用概念 spec，声明 PRD 与之**无矛盾**——PRD 是概念的产品化表达，不发明新概念。

| PRD 概念 | 概念 spec 权威源 | 对齐确认 |
|----------|------------------|---------|
| `Session.unread: boolean` 持久化字段（默认 false，非派生） | `specs/tech/agent/session/[P0]session_store.md §2`（Session.unread 字段）+ `§4`（markRead API） | ✅ 一致——PRD 引用同一字段，不改名、不改语义 |
| 产生未读 = `markIdle`/`markError` CAS 后状态机 emit completion 信号 → session 层查 `isSessionActive=false` → CAS true | `specs/tech/agent/session/[P0]session_state.md §4.4`（两离散 timing 产生行，**调用方=session 层**）+ `§6`（explicit-bool 模型 + 关注点分离 + 不变量） | ✅ 一致——PRD 路径 1/3/5 完全映射 §4.4 产生 timing（session 层自治）+ 三条 no-op 情形 |
| 消除未读 = `POST /session/:id/read` → `markRead` CAS false + emit `session_read_update` | `specs/api/overall/04-agent-session.md §2.3.1`（POST /read 端点契约）+ `[P0]session_state.md §4.4`（消除 timing） | ✅ 一致——PRD 路径 2 引用同一端点 + 同一事件名 |
| `GET /session/:id` 纯读无副作用（不隐式标读） | `specs/api/overall/04-agent-session.md §2.3`（GET 纯读，修订说明） | ✅ 一致——PRD 路径 2 显式拆 GET + POST /read 两步 |
| conv-item 红点 `unread && !active` + `#DC2626` 7px 右上角 | `specs/ui/components/chat-page/_overview.md §4.2`（conv-item unread prop + 红点视觉）+ `§5 交互7`（产生/消除/active 隐藏）+ `§7`（testid） | ✅ 一致——PRD UC-27.x 引用同一 prop / testid / 颜色 |
| abort 不产生未读（markInterrupted 不调产生逻辑） | `[P0]session_state.md §4.4` no-op 情形 + `§1`（仅 idle/error 算完成） | ✅ 一致——PRD 路径 5 映射此不变量 |
| 崩溃恢复不产生未读（session 保持崩溃前 unread 值） | `[P0]session_state.md §4.4` no-op 情形 + `§5`（reconcileOnStartup 不动 unread） | ✅ 一致——PRD 路径 4 映射此不变量 |
| CAS 幂等保护（产生 `WHERE unread=false`、消除 `WHERE unread=true`） | `[P0]session_state.md §3.1`（SQL 示例）+ `§6.3`（不变量 5） | ✅ 一致——PRD 不引入新 CAS 语义 |
| `isSessionActive(sid)` 单原语点查（订阅聚合） | `[P0]session_state.md §6.2`（前台判定）+ `specs/tech/app/frontend/[P0]sse_channel.md §5/§7` | ✅ 一致——PRD 不发明新前台判定 |

> **无新概念引入**：本版本所有概念（unread 字段、POST /read 端点、session_read_update 事件、isSessionActive、conv-item-unread-dot）均已在概念 spec 定稿。PRD 仅做产品化表达。

---

## 6. 版本

v0.0.27（session 未读红点 — explicit-bool 模型：`Session.unread: boolean` 持久化存储字段；**产生=session 层**（SessionUnreadOps runtime，订阅状态机 session_status_update completion 信号，查 isSessionActive 非前台 → CAS true；agent-loop 只调 markIdle/markError、状态机纯 CAS 不感知 SSE）；消除=POST /session/:id/read markRead CAS false + emit session_read_update；conv-item 右上角 7px `#DC2626` 红点 `unread && !active` 渲染；不计数、不多端同步、无设计稿视觉保真度门禁跳过。**归属层决策史**详见 `specs/tech/version_logs/v0.0.27/unread-model-decision.md` §6）
