# Tech Change Log — v0.0.13（S3 + S4 only）

> 本 change_log 仅覆盖本架构任务范围的 **S3（minimax usage 校准）+ S4（session-state event 前端接线）**。
> S1（context plugin 化）/ S2（forked agent + compact + summaryTask + 启动清理）/ S5（bug1 enqueue clear）归其他架构任务，不在本文件。
> 设计源：`states/v0.0.13/design.md` S3 + S4 章节（含自主决策 D3.1~D3.3 / D4.1~D4.2）。
> PRD：`specs/prd/version_logs/v0.0.13/change_log.md`（路径 P usage 准确 + 路径 O session 状态变化前端实时收到）。

## 1. Scope

### S3 — minimax usage 校准（核心 = per-call 13 字段）

| 决策 | 内容 |
|---|---|
| [D3.1] outputCharCount 口径 | **纯 TextBlock 字符数**（不含 reasoning/tool_call/tool_result，最小确定口径）。stream 路径 StreamConsumer 累加 `text_delta.text.length`；非流式 call 累加 `CanonicalResponse.message.content` 里 TextBlock.text 字符数 |
| [D3.2] minimax 币种 | **CNY**（minimax 国内计费）。modelConfig.pricing.currency 配 `"CNY"`；Anthropic/OpenAI 系默认 USD |
| [D3.3] accumulateUsage | **stretch**（核心 S3 = per-call 13 字段校准；session 级累计视 scope）。若激活需：run schema 加 token usage 字段 + 三分区累加 + getUsageView 真聚合 + 真发 session_usage_update。schema/接口签名不变 |
| minimax pricing | **config 数据**（非 spec）。minimax provider record 须配 `pricing:{inputPerMillion, outputPerMillion, cacheReadPerMillion?, cacheWritePerMillion?, currency:"CNY"}`，实际数值在校准报告 |

### S4 — session-state event 前端接线（仅前端，后端不动）

| 决策 | 内容 |
|---|---|
| [D4.1] 后端 event 状态 | **已就绪无需改**。v0.0.12 已全接好：6 CAS + reconcile emit、bus、registerTopic、SessionStore→StateMachine 注入、SSE 白名单含 session_panel（`handlers/sse.ts:21`） |
| [D4.2] sessionRunning 权威源 | **切 session_panel**。session_status_update 含 interrupting/interrupted 中间态，比 agent_loop run_start/run_stop 派生更准。chat 页 subscribe `session_panel` topic + reducer 处理 session_status_update |

## 2. 文件变更清单

### MODIFY

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `specs/tech/agent/providers_and_models/[P0]llm_client_interface.md` | 修改 | stream() 函数：yield 前对 `{type:"usage"}` 事件补 `computeCost(usage)` + `pricing.currency`；新增 §3.7 stream 路径 cost/currency 闭环决策；版本 2.0→2.1 |
| `specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md` | 修改 | 明确 `parseStream` 的 usage 事件**只填 token 字段**（不填 cost/currency/char）；minimax 同 anthropic_messages impl 的 3 个语义差异风险点（input_tokens 含 cache?/reasoning 字段/cache_creation）待 raw 实测后于 anthropic_impl 固化；版本 2.1→2.2 |
| `specs/tech/agent/providers_and_models/anthropic_impl.md` | 修改 | 头部注明同时服务 Anthropic + minimax（同 path）；新增 §5.1 parseAnthropicUsage 校准点（3 字段语义差异表 + 校准流程：插日志→抓 raw→决策→固化）；版本 1.0→1.1 |
| `specs/tech/agent/session/[P0]session_usage.md` | 修改 | §1 明确 outputCharCount 口径 = 纯 TextBlock 字符数 [D3.1] + minimax 币种 CNY [D3.2]（pricing 是 config）；新增 §10 accumulateUsage 激活 stretch 条件 [D3.3]（4 条：run schema 加 usage 字段 / 三分区累加 / getUsageView 真聚合 / session_usage_update 真发）；schema/接口签名不变；版本 3.1→3.2 |
| `specs/tech/app/frontend/[P0]sse_channel.md` | 修改 | 新增 §9 chat 页 `session_panel` 订阅（topic + group 契约 + reducer 行为 + 生命周期 + 与 agent_loop 并存）；版本 1.0→1.1 |
| `specs/ui/overall/02-llm-chat.md` | 修改 | 顶部加 `[v0.0.13]` 备注（chat 页前端 subscribe session_panel + reducer + sessionRunning 权威源切 session_panel [D4.2]，后端不动 [D4.1]）；版本 2.1→2.2 |
| `specs/ui/components/chat-page/_overview.md` | 修改 | 顶部加 `[v0.0.13 S4]` 备注；§5 交互 6 「running 状态来源」明确权威源切 session_panel（[D4.2]） |

### NEW（本任务范围无 NEW spec 文件）

S3/S4 无新建 spec 文件 —— 全部 MODIFY 既有 spec（S3 = 补既有 Usage schema 的赋值点/口径/边界；S4 = 仅前端订阅，后端 spec 已就绪）。

## 3. 文件级代码变更清单（planner/coder 依据 — 非本架构任务执行）

> 本节列架构层推导出的代码变更点，供 planner 拆 task / coder 编码依据。实际执行归后续 coding 阶段。

### S3 代码变更

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/llm/client.ts` | 修改 | stream() 方法：在 yield StreamEvent 前对 `evt.type === "usage"` 分支补 `evt.usage.cost = computeCost(evt.usage)` + `evt.usage.currency = modelConfig.pricing.currency`（§3.7） |
| `app/server/src/llm/protocol-parse-stream.ts` | 修改 | `parseAnthropicUsage(raw)`：按 raw 抓取结果校准 3 字段映射（input_tokens 含 cache?/reasoning 字段/cache_creation）；临时插日志代码（debug 完移除） |
| `app/web/.../app_config/.../01KVJMPG2FA9ZSWDND60HV56N2.json`（dev + test） | 修改 | minimax modelConfig record 加 `pricing:{inputPerMillion, outputPerMillion, cacheReadPerMillion?, cacheWritePerMillion?, currency:"CNY"}`（实际单价按 minimax 官网） |
| agent loop stream 路径（`agent-loop.ts` 或 StreamConsumer） | 修改 | 构造 Usage 时填 `inputCharCount`（← snapshot.inputCharCount）+ `outputCharCount`（← StreamConsumer 累加 text_delta.text.length）；调用 `accumulateUsage(sid,"current",usage)`（stretch 激活则真累加，否则 no-op） |
| `[stretch] app/server/src/agent/session-store.ts` / schema | 修改 | 若激活 accumulateUsage：去 no-op + 三分区累加 + 递归 sub + ratio 学习；Run schema 加 per-run usage 字段 |

### S4 代码变更（仅前端）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/web/src/components/chat/page-chat.tsx`（或 section-chat-detail） | 修改 | active sid 变化时除 subscribe `agent_loop` 外，加 `subscribe("session_panel", "session_id:"+sid, onSessionEvent)`；切会话/离开 unsubscribe |
| `app/web/src/store/chat-slice.ts`（或 chat-store） | 修改 | 新增 `onSessionEvent` reducer：`event.type === "session_status_update"` → set sessionRunning/sessionState/currentRunId（驱动 abort-btn / enqueue-view / 中断按钮态）；session_usage_update 分支可分流到 usage 面板 reducer |

## 4. 一致性自检

1. **Usage 13 字段 schema 未改只补赋值**：`session_usage.md §1` Usage interface 字段集（9 token + inputCharCount/outputCharCount + cost + currency）**保持不变**；v0.0.10 已落地。本任务只补**赋值点**（stream cost/currency 闭环）+**口径**（outputCharCount = 纯 TextBlock）+**边界**（parseStream 只产 token，cost/currency 归 client，char 归 agent loop）。✅
2. **S4 前端订阅与后端 session_status_update 结构对齐**：前端 reducer 按 `session_event.md §2` 的 `SessionStatus = {state:"idle"|"running"|"interrupting"|"interrupted"|"error", running:boolean, currentRunId:string|null}` 解析；触发时机表（§3）6 CAS + reconcile 全覆盖；topic=`session_panel` + group=`session_id:<sid>` 与后端 registerTopic / SSE 白名单一致。✅
3. **cost/currency stream 路径闭环**：stream 与 call 同源 —— 都在 LlmClient 边界补 `computeCost(usage)` + `pricing.currency`（§3.7）；agent loop 默认走 stream → 现在能拿到 cost/currency；accumulateUsage（若激活）/ session_usage_update 都基于带 cost 的 Usage。✅
4. **后端 spec 不改约束（[D4.1]）**：`session_event.md` / `session_state.md` / `handlers/sse.ts` 白名单 / bus 注入链路 v0.0.12 全部就绪，本任务不触碰。✅
5. **minimax 同 path 约束**：不新建 protocol impl，minimax 走 `anthropic_messages` + `anthropic_compatible` provider，差异仅在 wire usage 字段语义（待 raw 实测后于 `anthropic_impl.md §5.1` 固化，不预先写死避免猜测）。✅
6. **单文件 ≤ 300 行**：7 个修改 spec 文件全部 ≤ 300 行（最大 `_overview.md` 281 行）。✅

## 5. 版本

v0.0.13 tech change_log（S3 + S4 only）。S1/S2/S5 spec 变更归其他架构任务。
