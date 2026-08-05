# v0.0.10 PRD — 对话页三区布局 + observability 接入

> 基于 v0.0.9（对话页打磨 + 工具可用性收尾）。需求来源 `reqs/v0.0.10/bugs.md`。定性：UI 视觉重构（布局）+ 可观测性能力补齐 + 多项 spec↔impl 一致性修复，无新对外 API。

## 1. 目标
1. **对话页三区布局**：解决 v9a.html 单侧头像布局（user 右 / agent 左）的气泡越界 + 两侧不平衡问题；用户明确推翻单侧方案，改三区对称（左头像 ｜ 中内容 ｜ 右头像）。
2. **Observability 接入**：补齐 agent 执行的可观测性（trace/调试/成本审计），首 backend 用 Langfuse。
3. **Spec↔impl 一致性修复**：基于 v0.0.10 四份审计报告（agent-loop / context-engine / manager-eventbus / event-message-protocol）修复 REAL-GAP + SPEC-OUTDATED，使 specs 重新成为可靠的生命线。

## 2. 需求 → 方案 → 对齐

### #1 对话页三区布局（视觉重构）
- **现状**：v9a.html 单侧头像（user 头像在右、agent 头像在左），气泡越界、两侧不平衡。
- **方案（用户明确授权，推翻单侧）**：`component-message-row` 三区 `flex gap-2.5`：左头像列（w-9）｜中间内容列｜右头像列（w-9），**双边对称**。
  - user 消息：左头像列空占位 + 内容列靠右（`self-end max-w-[600px]`）+ 右头像列 user avatar。
  - agent 消息：左头像列 agent avatar + 内容列靠左（`max-w-[820px]`）+ 右头像列空占位。
  - 气泡不越界（内容列独立受 max-w 约束，头像列固定宽不挤压）。
  - `tool-batch` 折叠胶囊改 `items-start` 收窄。
- **对齐**：`specs/ui/components/chat-page/_overview.md §4.6`（component-message-row 三区布局）。

### #2 Observability 接入（新能力）
- **现状**：agent 执行无可观测性，调试/成本审计只能看日志。
- **方案**：
  - 定义 `ObservabilityAdapter` 接口（Trace/Generation/Span 生命周期）+ `NoopAdapter`（默认零成本）。
  - 首实现 `LangfuseAdapter`（langfuse TS SDK 全局 singleton，trace.id=runId）。
  - agent-loop 边界埋点：run_start/end → trace；每 iteration → step span；② LLM → generation（model + 完整 input/output + usage）；③ tool → tool span（完整 arguments/result）。
  - 凭证来源 dev_config（主）+ ENV 兜底（baseUrl 读 `LANGFUSE_BASE_URL` 主 / `LANGFUSE_HOST` 兜底）。
  - flush 生命周期：node server SIGTERM/SIGINT + electron before-quit 都调 `shutdownObservability()`。
- **对齐**：`specs/tech/agent/observability/[P0]overall.md` + `[P0]langfuse_adapter.md`（spec 用户已写，本版本补 env/flush 落地细节）。

### #3 AgentLoop 结构化重构（行为不变）
- **现状**：impl 是 `agent-loop-stages.ts` 分阶段文件（5 文件 992 行），与 spec §4 单 while 循环描述不符。
- **方案**：删 stages 文件，抽 `ingestAndAssemble` helper，单 while 循环 ①②③④ 顺序内联。**行为完全不变**（12 条对齐条款仍 MATCH）。
- **对齐**：`specs/tech/agent/agent_interface_and_loop/[P0]agent_loop.md §4`。

### #4 ContextEngine assemble 持久化 contextWindowUsage（修 audit Major）
- **现状**：assemble 未调 `store.updateContextWindowUsage`，session 级 contextWindowUsage 永不持久化，`GET /session` 展示的 context 用量脱节。
- **方案**：assemble return 前加 `await this.store.updateContextWindowUsage(config.sessionId, cw)`。
- **对齐**：`context_engine.md §3` + `context_snapshot_interface.md §4` + `context_usage_detail.md §2`。

### #5 EventHub cancel 改 wakePendingSubscribers（修 audit LOW）
- **现状**：cancel 用 `bus.emit(group,{data:undefined})` 哨兵事件唤醒，污染 replayable buffer（新 sub 回放出 undefined 伪事件）。
- **方案**：`ReplayableEventBus` 新增 `wakePendingSubscribers(group)`（只 resolve pending next()，不注入伪事件），cancel 改调它。
- **对齐**：`event_bus.md` + `event_hub.md §3`。

### #6 Usage / cost 全实现（修 audit 2 Major + 1 Minor）
- **现状**：Usage 丢字段 + 全可选 + 索引签名退化；LlmClient 静默缺 computeCost/validate/currency；cache_control 2bp 收益字段落空。
- **方案**：Usage 全字段（9 token + char + cost + currency）+ LlmClient.computeCost/validate（call 边界）+ parseAnthropicUsage（wire→Usage 全字段）。stream 路径 cost 留 future。
- **对齐**：`session_usage.md §1` + `agent_message_interface.md §2` + `llm_client_interface.md §2/§3.3`。

### #7 类型小清理
- CanonicalResponse.usage 用完整 Usage；Message.createdAt 去 readonly。ContentBlock 双份去重（protocol-types.ts thinking 残留）留 future。

## 3. 关键用户路径（每条 ≥1 case）
- 路径A（视觉）：对话页 user/agent 消息三区对称布局，气泡不越界，两侧头像 w-9 对齐（视觉保真度 compare 对照三区实现截图）。
- 路径B（observability）：发消息 → Langfuse 收到完整 trace（run → step span → generation(input/output/usage) → tool span）；关闭 app（node SIGTERM 或 electron before-quit）→ 末尾 trace 已 flush 不丢。
- 路径C（usage/cost）：发消息 → LlmClient.call 返回的 usage 含 cost + currency（按 modelConfig.pricing 算）；GET /session 的 contextWindowUsage 反映真实运行态（assemble 后已持久化）。

## 4. scope out
- HITL 审批 / ratio 学习 / forked agent compact / stream 路径 cost（同 v0.0.8 future）。
- OTel backend（P1，仅 Langfuse 一 backend）。
- ContentBlock 双份去重（protocol-types.ts thinking 残留，留 future）。

## 5. 对齐文档
- tech change_log：`specs/tech/version_logs/v0.0.10/change_log.md`
- UI spec：`specs/ui/components/chat-page/_overview.md §4.6`（三区）
- observability spec：`specs/tech/agent/observability/[P0]overall.md` + `[P0]langfuse_adapter.md`
- 审计来源：`states/v0.0.10/audit-{agent-loop,context-engine,manager-eventbus,event-message-protocol}.md`
