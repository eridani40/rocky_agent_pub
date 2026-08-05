# v0.0.16 技术变更日志

> 概述：本版本围绕 chat topbar 新增 usage 可视化面板、完善 compact 状态管理（手动触发 + 消息留痕）、新增 clear 清空功能，并修复 context spec 与代码对齐（3 Critical + 7 Major 由架构层修复）。
> PRD 权威：`specs/prd/version_logs/v0.0.16/change_log.md`；视觉契约：`reqs/v0.0.16/mqnbr367-easy-opc-chat-v9a.html §143-258`；API 增量：`specs/api/version_logs/v0.0.16/change_log.md`（如有）。

## 1. 六项已定决策（直接采纳）

| 决策点 | 选择 | 落地 |
|---|---|---|
| **CanonicalRequest.system** | 改 spec 对齐实现：system 走 messages[0] role=system，**不新加字段** | `context_snapshot_interface.md §2` v1.2 + 文件头清理 v0.0.13「必须注入」表述 |
| **ContextWindowUsage** | 补全 7 字段 + assemble 读 store.getRatio + 历史数据 normalize 兜底 | `context_snapshot_interface.md §2`（7 字段默认值表 + normalize）+ `context_usage_detail.md §3`（assemble 读 getRatio 不硬编码 1.0） |
| **cache 字段语义** | 比率（cache_read_tokens / input_total_tokens，0-1 小数）；SessionUsageView 加派生字段 cacheRate | `session_usage.md §8` 加 4 个 cacheRate 派生字段 + `context_usage_detail.md §5` |
| **clear 并发** | clear 前 abort current run + markSummaryFailed（若 compact in-flight）+ 重置 idle | 新建 `session_clear.md §5`（并发处理编排） |
| **compact 消息留痕** | compact 成功后向 transcript 插 role=system message（metadata.kind=compact_notice）+ POST /compact 端点 | `context_compact_detail.md §6.5`（buildCompactNoticeMessage + 落点）+ `04-agent-session.md §7` |
| **session 状态汇总** | 复用 GET /session（已含 state/summaryTask/usage）+ 两路 SSE，不新造统一视图 | API 不增统一视图，沿用 session_panel topic（summary_task_update / session_usage_update / session_status_update 共三 event） |

## 2. 后端 tech spec 修复清单

### 2.1 `specs/tech/agent/context/[P0]context_snapshot_interface.md`（修改）

| 章节 | 变更 |
|---|---|
| 文件头 | 清理 v0.0.13「必须注入 CanonicalRequest.system」表述（A.1 决策）；清理 v0.0.8「accumulate no-op / ratio 硬编码 1.0」过期标注（v0.0.14 已 supersede） |
| §2 ContextSnapshot.system | 注释改为「system 走 messages[0] role=system，caller 直接发 messages 即可」 |
| §2 ContextWindowUsage | 7 字段默认值表（systemTokens/messageTokens/toolTokens/totalTokens/maxOutputTokens=20000/tokenLimit/remainingTokens）+ 历史数据 normalize 兜底（参考 normalizePartition 模式） |
| §5 版本 | 1.1 → 1.2 |

### 2.2 `specs/tech/agent/context/[P0]context_usage_detail.md`（修改）

| 章节 | 变更 |
|---|---|
| 文件头 | 加 v0.0.16 cache 比率语义标注 + assemble 读 store.getRatio 标注 |
| §3 估算 | `ratio = session.getRatio(sessionId)` 替代硬编码 1.0；ContextWindowUsage 7 字段全激活 |
| §5（新） | cache 字段语义表（cacheRate = input_cache_read / input_total_tokens；分母 0 时返 0；UI 显示百分比） |
| §6 版本 | 3.0 → 3.1 |

### 2.3 `specs/tech/agent/context/[P0]context_compact_detail.md`（修改）

| 章节 | 变更 |
|---|---|
| 文件头 | 加 v0.0.16 手动触发 + 消息留痕 + 触发算式对齐标注 |
| §1 触发算式 | `remainingTokens = tokenLimit − totalTokens − maxOutputTokens`（修原实现漏减 maxOutputTokens） |
| §2 流程 | step 5 加 appendMessages(compact_notice)；step 2 system 注入路径改为「走 messages[0] role=system」 |
| §2b（新） | 手动触发路径（POST /session/:id/compact 端点契约 + 触发条件 + 执行路径与自动共用） |
| §6.4 fork 契约 | system 行改为「走 messages[0] role=system」；副作用行加注「system message 留痕由 caller 显式 appendMessages，非 forked agent 写入」 |
| §6.5（新） | compact 消息留痕——buildCompactNoticeMessage 构造 + 落点（setSummary 后 / markSummaryDone 前）+ 时机（自动/手动共用、失败不插）+ 用现有 schema 不新造类型 |
| §8 版本 | 3.0 → 3.1 |

### 2.4 `specs/tech/agent/session/[P0]session_clear.md`（新建）

| 章节 | 内容 |
|---|---|
| §1 概述 | clearSession 语义（保留实体清内容），区别 delete |
| §2 接口 | `clearSession(sid): Promise<Session>`（单事务同步原子） |
| §3 清理范围表 | transcript / summary（version=0,summaryUpTo=null,content=null）/ runs / usage 三分区 + RatioWindow + contextWindowUsage / summaryTask=idle / state=idle；tokenLimit 保留 |
| §4 clear vs delete | 职责边界表 |
| §5 并发处理 | caller 职责：abort current run（4 步收尾）+ markSummaryFailed（若 compact in-flight）+ clearSession 原子 + emit events（session_status_update / session_usage_update / messages_cleared）+ force 可选语义 |
| §6 状态转换图 | 任意 state → idle（强制重置） |
| §8 版本 | 1.0 |

### 2.5 `specs/tech/agent/session/[P0]session_usage.md`（修改）

| 章节 | 变更 |
|---|---|
| §8 SessionUsageView | 加 4 个派生 cacheRate 字段（current/sub/forked/total）；AccumulatedUsage 不增字段（cacheRate 派生） |
| §11 版本 | 4.0 → 4.1 |

## 3. API 文档变更

### `specs/api/overall/04-agent-session.md`（修改，1.3 → 1.4）

新增三个端点：

| 端点 | 方法 | 路径 | 响应 | 说明 |
|---|---|---|---|---|
| **usage** | `GET` | `/session/:id/usage` | `200` + `SessionUsageView` | 初始拉取，含 ContextWindowUsage 7 字段 + 三分区 AccumulatedUsage + 4 个 cacheRate |
| **compact** | `POST` | `/session/:id/compact` | `202` `{ ok: true }` / `409` | 手动触发 fire-and-forget；409 拒绝 running/interrupting |
| **clear** | `POST` | `/session/:id/clear` | `200` `{ ok, session }` | 同步原子；前置 abort+markSummaryFailed；body `{ force?: boolean }` 可选 |

错误码：409 恢复（仅 compact 路径，`compact_in_progress` / `session_interrupting`）。

AT 路径新增 R/S/T/U/V/W（usage 拉取 / session_usage_update / 手动 compact + system message / compact 并发拒绝 / clear 清空 / running 中 clear 先 abort）。

## 4. UI spec 变更

### `specs/ui/components/chat-page/component-usage-panel.md`（新建）

含子组件：UsageRing / UsageTrigger / UsageExpandBtn / UsagePanel / CompactBtn / ClearBtn。

- 数据契约：`GET /session/:id/usage`（初始）+ SSE `session_usage_update` / `summary_task_update`（增量）。
- 三态交互：收起（圆环+数字+hover tooltip）/ 展开（面板 4 分段进度条 + 累积消耗表格）/ 按钮状态（CompactBtn 绑定 summaryTask 四态，ClearBtn hover danger + 确认 modal）。
- 视觉基线：从 `mqnbr367-easy-opc-chat-v9a.html §143-258` CSS 提取（配色 sage/gold/#DC2626 三档、4 分段配色 accent/sage/gold/#475569、表格 cum-table grid 布局）。
- system message 渲染样式（§6）：compact_notice 居中轻量 pill（区别于 user/agent 气泡）。

### `specs/ui/components/chat-page/_overview.md`（修改）

- §2 rule5b 新增：system message compact_notice 居中 pill 渲染分支（testid `msg-system-{id}-notice`）。
- §4.4 topbar 加 `.topbar-right`：usage-panel + divider + compact-btn + clear-btn。

## 5. 关键设计原则（MANDATORY — 核心约束记录）

1. **system 走 messages[0] role=system**：不另填 CanonicalRequest.system 字段。assemble 时 system 同时写入 `snapshot.messages[0]`（role=system），caller 直接发 messages 即可。v0.0.13「必须注入 CanonicalRequest.system」表述已废弃（对齐实现）。
2. **ContextWindowUsage 7 字段全激活**：systemTokens / messageTokens / toolTokens 分别 char×ratio 估算（不再合并值）；assemble 读 `session.getRatio(sessionId)` 真值（不再硬编码 1.0）；历史数据（3 字段 record）反序列化 normalize 兜底。
3. **cacheRate 是派生值，不存 AccumulatedUsage**：`cacheRate = input_cache_read / input_total_tokens`（分母 0 时返 0）；SessionUsageView 聚合时算 4 个（current/sub/forked/total）。
4. **compact 触发算式对齐**：`remainingTokens = tokenLimit − totalTokens − maxOutputTokens`（不再漏减 maxOutputTokens）。
5. **compact 消息留痕用现有 schema**：role=system message（metadata.kind=compact_notice），不新造类型；自动/手动共用、失败不插；落点在 setSummary 后 / markSummaryDone 前。
6. **clear 是同步原子**：用户感知即时完成（200 响应）；内部前置 abort current run（4 步收尾）+ markSummaryFailed（若 compact in-flight）避免悬空；clearSession 单事务清空所有范围；tokenLimit 保留（来自 modelConfig 非累加值）。
7. **session 状态汇总走两路 SSE**：不新造统一视图；GET /session 已含 state/summaryTask/usage 字段，前端订阅 session_panel topic 收 session_status_update / summary_task_update / session_usage_update 三 event 实时刷新。

## 6. 不在 v0.0.16（future）

| 排除项 | 落地版本 |
|---|---|
| ingest truncate offload（raw/tool_result offload 落地） | future（context_ingest_detail 仍标 future） |
| compact prompt 9 板块强校验 | future（v0.0.13 已声明，v0.0.16 不强校验单 `<summary>` 简化路径） |
| compact 增量 merge | future（v0.0.13 已声明，每次全量重写 summary） |
| Run record per-run usage 字段 | future（沿用 SessionUsageMeta 内存累计） |
| tooltip 详细行项文案 | future（v0.0.16 tooltip 最简实现仅展示累积消耗合计） |
| lazy-drain / HITL / memory_extract 实际任务 | future（v0.0.15 已声明） |

## 7. 实现层落地细节（code 对齐 spec）

> v0.0.16 spec → code 全部对齐，验证全绿（UT 1146/1146 + AT 9 PASS+1 SKIP 真 LLM + ET 核心 PASS + 视觉保真 V1-V11 无 Major）。

### 7.1 ContextWindowUsage normalize + assemble getRatio（T1）

- `context-usage-calc.ts`（新）：ContextWindowUsage 7 字段计算 + `normalizeContextWindowUsage(record)` 历史数据兜底（缺字段补默认值 maxOutputTokens=20000/tokenLimit=DEFAULT/totalTokens=system+message+tool/remainingTokens=tokenLimit-total-max）。
- `context-engine.ts` assemble：改读 `session.getRatio(sessionId)` 真值（不再硬编码 1.0）；`snapshot.messages[0]` role=system 注入（替代 CanonicalRequest.system 字段）。
- `context-engine.ts` compact 触发：`remainingTokens = tokenLimit − totalTokens − maxOutputTokens`（修原实现漏减 maxOutputTokens）。

### 7.2 cacheRate 派生 + GET /session/:id/usage（T2）

- `session-store-types.ts:177-190`：`SessionUsageView` 简写键（current/sub/forked/total + ratio + contextWindowUsage? + 4 cacheRate）；`ZERO_USAGE_VIEW` 零值常量。
- `session-usage-helper.ts`：`deriveUsageView(meta, cw)` 派生 SessionUsageView + 4 cacheRate（input_cache_read / input_total_tokens，分母 0 返 0）。
- `handlers/session-usage.ts`（新）：GET /session/:id/usage handler，调 `sessionStore.getUsageView(sid)` 返 SessionUsageView。
- `router.ts`：新增 GET /session/:id/usage 路由分发。

### 7.3 POST /session/:id/compact + compact 消息留痕（T3）

- `context-compact-runner.ts`（新）：compact 执行路径编排（markSummaryRunning → forked agent → setSummary + appendMessages(compact_notice) → markSummaryDone/failed）。
- `context-ingest-pipeline.ts`（新）：compact_notice message 构造 + appendMessages 落点（setSummary 后 / markSummaryDone 前；失败不插）。
- `handlers/session-compact.ts`（新）：POST /session/:id/compact handler，校验触发条件（409 拒绝 interrupting/compact_in_progress）+ 调 compact 执行路径 + 202 fire-and-forget。
- compact_notice 走标准 emit 序列（message_start + text_block_delta + message_end，含 metadata.kind=compact_notice）—— **[BUG-001 修复]** 前端按 message+part key 订阅渲染（非离线补插）。

### 7.4 POST /session/:id/clear + clearSession 单事务 + 并发编排（T4）

- `session-clear-op.ts`（新）：`clearSessionStoreOp(crud, statusBus, sid)` 单事务清空（transcript/summary/runs/usage 三分区 + RatioWindow + contextWindowUsage/summaryTask=idle/state=idle）；保留实体 + tokenLimit + maxOutputTokens；**store 内 emit 三事件**（session_status_update / session_usage_update / messages_cleared）—— 对齐 stateMachine「store 内 state 变化→emit」模式。
- `handlers/session-clear.ts`（新）：POST /session/:id/clear handler，前置并发清理（abort current run 4 步收尾 + markSummaryFailed if compact in-flight）+ 调 clearSession + 200 同步返 Session。
- `router.ts`：新增 POST /session/:id/clear 路由分发。

### 7.5 usage-panel UI 6 子组件 + chat-slice 订阅 + compact_notice 居中 pill + clear-modal（T5）

- `component-usage-panel.tsx`（新）：UsagePanel 展开面板（4 分段进度条 + 累积消耗表格三分区行）。
- `component-usage-ring.tsx`（新）：UsageRing 圆环（占用率变色 <50% sage / 50-80% gold / ≥80% #DC2626）+ UsageTrigger + UsageExpandBtn。
- `component-clear-confirm-modal.tsx`（新）：clear 确认 modal（防误操作）。
- `chat-slice-reducer.ts`：处理 SSE `session_usage_update` / `summary_task_update` / `messages_cleared` 事件，更新 usage 面板状态。
- `message-flatten.ts`：compact_notice system message 渲染分支（居中轻量 pill，testid `msg-system-{id}-notice`）。
- `section-chat-detail.tsx` + `page-chat.tsx`：topbar 挂 `.topbar-right`（usage-panel + divider + compact-btn + clear-btn）+ 订阅 session_panel topic。

### 7.6 BUG-001 闭环（compact_notice 实时 SSE）

- **现象**：compact_notice 走「直接 ingest + 离线补插」路径，前端订阅 agent_loop topic 时错过 message_start（compact_notice 不在标准 emit 序列里），导致 UI 不渲染。
- **根因**：compact_notice 应走标准 emit 序列（message_start + text_block_delta + message_end），前端按 message+part key 订阅渲染。
- **修复**：`context-ingest-pipeline.ts` 改走标准 emit 序列（含 metadata.kind=compact_notice），前端按既有 message+part key 订阅路径渲染。
- **验证**：AT path T（手动 compact）+ ET UC-16.5/16.6 PASS（system message 渲染居中 pill + summaryTask 推送 running→done）。

---

## 8. 验证结果

- **UT**：1146/1146 PASS（含新增 context-compact-notice / session-clear / session-usage / handlers session-clear/compact/usage / chat-slice-usage / component-usage-ring / component-clear-confirm-modal / message-flatten-system-notice 等 test 套件）。
- **AT**：9 PASS + 1 SKIP（真 LLM，无 mock）。覆盖路径 R-W（usage 初始拉取 / session_usage_update / 手动 compact + system message / compact 并发拒绝 / clear 清空 / running 中 clear 先 abort）。
- **ET**：核心 PASS。覆盖 UC-16.1 ~ UC-16.10（usage 圆环 + 展开面板 + 实时刷新 + compact 按钮 + clear 确认 modal + running 中 clear 先 abort）。
- **视觉保真**：V1-V11 全维度 PASS（无 Major）。对齐设计稿 `reqs/v0.0.16/mqnbr367-easy-opc-chat-v9a.html §143-258`（layout/font/border/color/brand 逐维度 compare）。
- **BUG**：BUG-001（compact_notice 实时 SSE）已闭环 fixed + AT/ET 回归 PASS。

---

## 9. 版本

version: 1.1（v0.0.16 补实现层落地细节 §7 + 验证结果 §8 + BUG-001 闭环）。1.0（v0.0.16 新建：context 修复 3 项（snapshot_interface / usage_detail / compact_detail）+ session_clear 新建 + session_usage 加 cacheRate + usage-panel UI 组件 + 3 API 端点 + 6 决策记录）。
