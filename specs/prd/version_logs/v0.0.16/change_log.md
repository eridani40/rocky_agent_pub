# v0.0.16 PRD 变更日志

## 概述

本版本围绕 chat topbar 新增 **usage 可视化面板**（圆环 + 展开）、完善 **compact 状态管理**（手动触发 + 状态反馈 + 消息留痕）、新增 **clear 清空功能**（保留 session 清内容 + 确认），并修复 **context spec 与代码对齐**（3 Critical + 7 Major）。

一句话：**让用户「看见 token 用了多少、主动整理上下文、一键清空重来」，并把 context/usage 后端数据真正接到前端。**

权威输入：`reqs/v0.0.16/req.md` + `reqs/v0.0.16/mqnbr367-easy-opc-chat-v9a.html`（视觉契约）。spec 权威源：`specs/tech/agent/session/`（五态机 + SummaryTask + SessionUsage 三分区）+ `specs/tech/agent/context/`（ContextWindowUsage / compact）+ `specs/ui/components/chat-page/_overview.md`。

---

## 1. 版本定位

### 1.1 范围

**IN（v0.0.16 5 方向）**：
1. **context spec 与代码对齐**：ContextWindowUsage 字段补全（7 字段）+ cache 字段语义统一（比率）+ CanonicalRequest.system 注入路径核对 —— 架构层修复，PRD 仅记录「用户感知行为正确」
2. **usage 面板**（chat topbar）：头部圆环（占用/总）+ 展开按钮 + compact/clear 两按钮；展开后 context window 占用（进度条 + 4 分布）+ 累积消耗表格（三分区行 × 输入/缓存率/输出/合计）
3. **compact 状态完善**：session 状态汇总（会话状态 + compact 状态并发消费）+ 手动 compact 按钮 + compact 消息留痕（API 端点 + transcript 插 system message）
4. **clear 功能**：新增 clearSession（保留 session 清内容）+ 确认对话框 + 并发处理（先 abort 再 clear）
5. **usage-panel 组件 spec**（架构阶段产出 `specs/ui/components/chat-page/` 下新增组件 spec）

**OUT（本版本明确排除）**：

| 排除项 | 理由 |
|--------|------|
| lazy-drain 策略类 | future（v0.0.15 已声明） |
| HITL 审批工具 | future |
| memory_extract 实际任务 | future（taskType 字段落位但只交付 summary） |
| Run record per-run usage 字段 | future（沿用 SessionUsageMeta 落盘） |
| tooltip 具体行项文案 | 设计稿 CSS 占位但 React 未渲染内容；v0.0.16 tooltip 只展示「累积消耗合计」（最简实现，行项文案不强制） |

### 1.2 用户授权默认值（沿用）

无 HITL / system prompt 固定 / 自动化测试不 mock（真 LLM + 真服务，遵循 memory `no-mock-api-e2e-tests`）/ usage 面板 v0.0.16 起对用户可见。

---

## 2. 需求清单（产品视角）

### 2.1 usage 面板 [v0.0.16]

**描述**：在 chat topbar 右侧显示当前会话的 token 用量。头部是紧凑的圆环 + 「已用/总」（如 23k/200k）；点展开按钮弹出完整面板，含 context window 占用进度条 + 4 色分段（系统/消息/工具/输出预留）+ 累积消耗表格（按来源分区）。

**优先级**：P0

**用户故事**：作为对话用户，我希望一眼看到「上下文还剩多少、累积消耗多少 token」，以便判断是否需要整理或清空。

**展示信息**（对齐 `ContextWindowUsage` 7 字段 + `AccumulatedUsage` 三分区）：

- 头部（收起态）：圆环（随占用率变色）+ `已用/总`（如 23k/200k，k 单位）
- 展开面板：
  - **context window 占用**：圆环（大号）+ `{used} / {total}` + `{pct}% 已占用 · 剩余 {free}`
  - **分段进度条**：系统 / 消息 / 工具 / 输出预留 4 段（各占宽度按 token 比例）
  - **分段图例**：每段配色点 + label + token 值（4 行）
  - **累积消耗表格**（cumulative）：
    - 行：会话（current 分区，始终展示）/ 整理（forked 分区，total=0 隐藏）/ 子Agent（sub 分区，total=0 隐藏）+ 合计行
    - 列：来源 / 输入 / 缓存率（百分比，accent 色高亮非零值，0% muted）/ 输出 / 合计

**圆环配色**（视觉细节以设计稿 CSS + `_conventions.md` §9 为准）：
- 占用率 < 50%：sage（绿）
- 50% ~ 80%：gold（黄）
- ≥ 80%：`#DC2626`（红）

**交互**（三态：收起 / 展开 / hover tooltip）：
- **收起态**：仅显示圆环 + 数字；hover 显示 tooltip（最小实现：展示累积消耗合计；详细行项文案不强制）
- **展开态**：点 `usage-expand`（chevron）切换；面板浮在 topbar 下方右侧（z-60）；点面板内不关闭，点外部关闭
- **实时性**：订阅 `session_panel` SSE，收到 `session_usage_update` 即刷新（与 `chat-slice-reducer` 同一订阅通道）

**按钮状态**（compact + clear 在 usage 旁，hover 时无位移，遵循布局稳定性原则）：
- compact 按钮：compress 图标，默认 muted；running/interrupting 态 disabled（防重复触发）
- clear 按钮：trash 图标，默认 muted，hover danger 色（`#FEE2E2/#DC2626`）

**E2E Use Cases**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-16.1 | 打开会话 → topbar 右侧见 usage 圆环 + 数字（如 23k/200k）| 圆环显示，颜色随占用率（绿/黄/红） |
| UC-16.2 | 点 usage-expand → 面板展开 → 见 context window 进度条 + 4 分段图例 + 累积消耗表格 | 4 段配色 + token 值；表格至少显示「会话」行 |
| UC-16.3 | 多轮对话进行 → SSE `session_usage_update` 推送 → 圆环数字 + 进度条 + 表格实时刷新 | 数字随 LLM 调用更新，无全量刷新抖动 |
| UC-16.4 | 整理 / 子Agent 分区 total=0 → 表格不显示该行 | 仅显示「会话」行 + 合计行 |

### 2.2 compact 产品行为 [v0.0.16]

**描述**：完善 compact（上下文整理）的用户感知：① 用户可手动触发（不止自动）；② compact 进行中有状态反馈；③ compact 完成后在对话流插入一条 system message 留痕。

**优先级**：P0

**用户故事**：作为长对话用户，我希望手动整理上下文（不等自动触发），并看到「整理中」「整理完成」的明确反馈，知道对话历史已被压缩。

**自动触发**（沿用 v0.0.13+）：assemble 后 `remainingTokens < 0` → agent loop 触发 compact（forked agent 执行，无副作用）。

**手动触发**：
- 入口：topbar compact 按钮（compress icon）
- 行为：点 → `POST /session/:id/compact`（202 fire-and-forget）→ 后端走 forked agent compact 流程
- 触发条件：session 非 interrupting；summaryTask.status ∈ {idle, done, failed}（running 拒绝，按钮 disabled）
- 与自动触发共用同一 compact 执行路径（forked agent + SummaryTask CAS）

**状态反馈**（compact 按钮三态）：
- **idle/done/failed**：按钮可点（默认 muted）
- **running**：按钮 disabled + spinner（视觉细节以设计稿为准），同时 SSE 推 `summary_task_update(status=running)`
- **完成**：SSE 推 `summary_task_update(status=done)` → 按钮恢复可点 + 对话流插入 system message（见下）

**compact 消息留痕**（MANDATORY）：
- compact 成功后，transcript 插入一条 `role=system` message（content 为简短中文提示，如「上下文已整理（v{version}，压缩至 {summaryUpTo}）」）
- 该 system message 在对话流以**居中轻量样式**渲染（区别于 user/agent 气泡；视觉细节归 usage-panel spec）
- 自动 / 手动 compact 都插；compact 失败不插

**E2E Use Cases**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-16.5 | 多轮对话 → remaining<0 → 自动 compact → 对话流出现 system message「上下文已整理…」| 消息插入 + summaryTask 推送 done + 后续对话正常 |
| UC-16.6 | 点 compact 按钮 → 按钮 disabled + spinner → 完成 → 按钮恢复 + system message 插入 | POST /compact 返 202；summaryTask 推送 running→done |
| UC-16.7 | compact 进行中再点 compact 按钮 | 按钮 disabled 无响应（不重复触发） |

### 2.3 clear 产品行为 [v0.0.16]

**描述**：新增「清空会话」功能——保留 session 实体（id/配置不变），清空所有对话内容（transcript / summary / runs / usage 累计），回到空会话状态。

**优先级**：P0

**用户故事**：作为用户，我希望在同一会话里「清空重来」——保留 session 配置但清掉历史，而不必删整个会话重建。

**确认交互**：
- 入口：topbar clear 按钮（trash icon，hover danger 色）
- 点击 → 弹确认对话框（modal）：标题「清空会话」+ 说明「将清除当前会话的所有消息、整理记录、运行历史与累积用量，操作不可撤销。」+ 确认/取消按钮
- 确认 → `POST /session/:id/clear`（200）→ 清空

**清空范围**：
- transcript（所有 raw / tool_result / transcript 记录）
- summary（SummaryInfo 重置：version=0, summaryUpTo=null, content=null）
- runs（该 session 的所有 Run 记录）
- usage（AccumulatedUsage 三分区 + RatioWindow 重置；ContextWindowUsage 重置）
- summaryTask（重置 idle）
- session.state 重置 idle（若非 idle）

**清空后状态**：
- session 实体保留（id、title、config 不变）
- state=idle, running=false, currentRunId=null
- summaryTask.status=idle
- 对话区显示 empty-state（同新建会话）
- usage 面板归零（圆环 0/200k，表格无行）

**并发处理**（架构层已决策）：
- clear 时 session 处于 running → 先 `abort current run`（走 abort 收尾）+ `markSummaryFailed`（若有 compact in-flight）→ 再 clear → 重置 idle
- clear 时 compact in-flight → markSummaryFailed + 清 forked buffer
- clear 是同步原子操作（用户感知：清空即时完成）

**E2E Use Cases**：

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-16.8 | 点 clear 按钮 → 弹确认对话框 → 点取消 | 对话框关闭，会话内容不变 |
| UC-16.9 | 点 clear → 确认 → POST /clear 200 → 对话区显 empty-state + usage 归零 | transcript/summary/runs/usage 全清；session 实体保留 |
| UC-16.10 | session running 中点 clear → 确认 → 先 abort 再 clear → state=idle + empty-state | 无悬空 run；GET messages 空；summaryTask=idle |

### 2.4 context spec 与代码对齐 [v0.0.16]

**描述**：调研发现的 3 Critical + 7 Major 由架构层修复；PRD 只关心「用户感知行为正确」（usage 数字准、compact 真生效、system prompt 真发给 LLM）。

**优先级**：P0（内部修复，无独立 UC；通过 UC-16.3/16.5/16.6 间接验证）

**关键修复点**（技术细节归架构）：
- ContextWindowUsage 补全 7 字段（systemTokens/messageTokens/toolTokens/totalTokens/maxOutputTokens/tokenLimit/remainingTokens）+ assemble 读 getRatio + 历史数据 normalize
- cache 字段语义统一为「比率」（cache_read/input_total，0-1 小数）—— UI 展示为百分比
- CanonicalRequest.system 注入（修 latent gap：system prompt 真发 LLM）

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

> v0.0.16 是 chat 域的 usage 可视化 + compact 完善 + clear 主路径。每条至少 1 个 AT（真 LLM，不 mock）+ 适用项 ET。**权威设计 = `reqs/v0.0.16/req.md` + `mqnbr367-easy-opc-chat-v9a.html`（视觉契约）**。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 A：打开会话 → 见 usage 圆环 → 展开 → 见 4 分布 + 表格** | 选会话 → topbar 见圆环 + 数字 → 点 expand → 面板展开（context window 进度条 + 系统/消息/工具/输出预留图例 + 累积消耗表格）| `GET /session/:id/usage`（新增）· SSE `session_panel`/`session_usage_update` · usage-panel 组件 | AT（GET usage 返 7 字段 ContextWindowUsage + 三分区 AccumulatedUsage）+ ET（UC-16.1/16.2） |
| **路径 B：多轮对话 → usage 实时更新 → 圆环颜色随占用率变** | 发消息 → LLM 返 usage → accumulateUsage → SSE 推 session_usage_update → 圆环数字 + 进度条 + 表格刷新；占用率跨阈值（< 50% → 50-80% → ≥80%）圆环变色 | `accumulateUsage` · SSE session_usage_update · usage-panel reducer | AT（真 LLM 多轮 → SSE 收 session_usage_update 序列 + GET usage 字段非零）+ ET（UC-16.3） |
| **路径 C：自动 compact（remaining<0）→ system message + summaryTask 事件** | 多轮积累 → remaining<0 → forked agent compact → SSE 推 summary_task_update(idle→running→done) → transcript 插 system message「上下文已整理…」→ 对话流出现 | `remainingTokens<0` 触发 · forked agent · `markSummaryRunning/Done` · system message 插入 | AT（真 LLM 多轮超阈值 → GET messages 含 system message + summaryTask 终态 done）+ ET（UC-16.5） |
| **路径 D：手动 compact 按钮 → POST /compact → loading → 完成（system message + 复位）** | 点 compact 按钮 → POST /session/:id/compact（202）→ 按钮 disabled+spinner → SSE summary_task_update(running→done) → 按钮恢复 + system message 插入 | `POST /session/:id/compact` · summaryTask CAS · system message 插入 | AT（POST /compact → 202 + summaryTask running→done + system message 落库）+ ET（UC-16.6） |
| **路径 E：点 clear → 确认 → POST /clear → 清空回到空会话** | 点 clear → 弹确认 modal → 确认 → POST /session/:id/clear（200）→ 对话区 empty-state + usage 归零（圆环 0/200k，表格无行）| `POST /session/:id/clear`（新增）· clearSession（清 transcript/summary/runs/usage） · 确认 modal | AT（POST /clear → 200 + GET messages 空 + summary=初始 + usage 三分区=0 + summaryTask=idle）+ ET（UC-16.9） |
| **路径 F：clear 时 session running → 先 abort 再 clear** | running 中点 clear → 确认 → 先 POST /abort（4 步收尾）+ markSummaryFailed（若有 compact）→ 再 POST /clear → state=idle + empty-state | `POST /abort` · `markSummaryFailed` · `POST /clear` · clearSession 原子 | AT（构造 running + 触发 clear → GET state=idle + GET messages 空 + Run=interrupted）+ ET（UC-16.10） |

**回归路径**（必须重跑 PASS）：
- v0.0.12 路径 H（中断 run）/ 路径 K（tool_call 配对）
- v0.0.13 路径 L（自动 compact forked agent）
- v0.0.15 路径 R（主对话 ReAct）/ 路径 S（forked summary）/ 路径 T（中断主对话）

---

## 4. 对齐 ui/tech spec 声明

### 4.1 引用的已有概念（PRD 对齐 spec）

| 概念 | spec 来源 | PRD 用法 |
|------|----------|---------|
| session 五态机 | `session/[P0]session_state.md §1` | clear 重置 idle；compact 不进五态机 |
| SummaryTask 四态 | `session/[P0]session_state.md §3a` | compact 按钮状态反馈（idle/running/done/failed） |
| AccumulatedUsage 三分区 | `session/[P0]session_usage.md §2/§4` | usage 表格行（current=会话 / forked=整理 / sub=子Agent） |
| ContextWindowUsage 7 字段 | `context/[P0]context_snapshot_interface.md §2` | usage 进度条 4 分段（system/message/tool + maxOutputTokens=输出预留） |
| SessionUsageView | `session/[P0]session_usage.md §8` | `GET /session/:id/usage` 返回类型 |
| session_event 三 type | `session/[P0]session_event.md §2` | usage 面板订阅（session_usage_update）+ compact 状态（summary_task_update） |
| compact（forked agent） | `context/[P0]context_compact_detail.md §2` | 手动 compact 复用同一执行路径 |
| deleteSession（已存在） | `session/[P0]session_store.md` | clear 不走 deleteSession（保留 session） |
| chat-page topbar | `ui/components/chat-page/_overview.md §4.4` | usage/compact/clear 挂在 topbar 右侧 |
| 圆环配色 + 4 分段 + 表格 | `reqs/v0.0.16/mqnbr367-easy-opc-chat-v9a.html §150-207` | 视觉契约（_conventions §9） |

### 4.2 新概念（待架构补 spec — PRD 不发明）

| 新概念 | 待落 spec | 说明 |
|--------|----------|------|
| **usage-panel 组件** | `specs/ui/components/chat-page/component-usage-panel.md` + `.tsx`（架构阶段产出） | 含 UsageRing / UsagePanel / CompactBtn / ClearBtn 子组件；视觉基线对齐设计稿 §150-207 |
| **GET /session/:id/usage** | `specs/api/overall/01-sessions.md`（架构补充） | 返 SessionUsageView（含 ContextWindowUsage + 三分区 AccumulatedUsage） |
| **POST /session/:id/compact** | `specs/api/overall/01-sessions.md` + `specs/tech/agent/context/[P0]context_compact_detail.md`（架构补充手动触发路径） | 手动触发 compact，复用 forked agent 执行 |
| **POST /session/:id/clear** | `specs/api/overall/01-sessions.md` + 新增 `specs/tech/agent/session/[P0]session_clear.md` | clearSession：保留 session 清内容；并发处理（先 abort + markSummaryFailed） |
| **compact 消息留痕** | `specs/tech/agent/context/[P0]context_compact_detail.md` + `specs/tech/agent/message/`（架构补充） | compact 成功后 transcript 插 system message |
| **system message 渲染样式** | `specs/ui/components/chat-page/_overview.md`（架构补充 §4.x） | 居中轻量样式，区别于 user/agent 气泡 |

> 上述 6 项新概念在 PRD 确认后由架构阶段（arch agent）落 spec，PRD 不擅自定义字段级细节。

---

## 5. 不覆盖项

| 排除项 | 理由 |
|--------|------|
| tooltip 详细行项文案 | 设计稿 CSS 占位但未渲染内容；v0.0.16 tooltip 最简实现（仅展示累积消耗合计），行项文案 future |
| Run record per-run usage 字段 | future（沿用 SessionUsageMeta 落盘） |
| lazy-drain / hitl / memory_extract | future（v0.0.15 已声明） |
| compact prompt 9 板块强校验 | future（v0.0.13 已声明，单 `<summary>` 简化路径） |
| 增量 merge compact | future（v0.0.13 已声明，每次全量重写） |
| 视觉保真度像素级一致 | 设计稿 HTML 原型，按 `_conventions.md §9`「整体风格基本一致」口径验收 |

---

## 6. BUG-001 闭环（compact_notice 实时 SSE）

- **现象**：compact_notice（compact 成功后插入的 system message）最初走「直接 ingest + 离线补插」路径，前端订阅 agent_loop topic 时错过 message_start（compact_notice 不在标准 emit 序列里），导致 UI 不渲染居中 pill。
- **根因**：compact_notice 应走标准 emit 序列（message_start + text_block_delta + message_end，含 metadata.kind=compact_notice），前端按 message+part key 订阅渲染（对齐 message ID 在 agent loop 首次分配的核心设计原则）。
- **修复**：`context-ingest-pipeline.ts` 改走标准 emit 序列；前端按既有 message+part key 订阅路径渲染。
- **验证**：AT path T（手动 compact → SSE 收 summary_task_update running→done + message_start role=system metadata.kind=compact_notice + GET messages 含 system message）+ ET UC-16.5/16.6 PASS（system message 渲染居中 pill）。

---

## 7. 验证结果

- **UT**：1146/1146 PASS。
- **AT**：9 PASS + 1 SKIP（真 LLM，无 mock；遵循 memory `no-mock-api-e2e-tests`）。覆盖路径 R-W。
- **ET**：核心 PASS。覆盖 UC-16.1 ~ UC-16.10（usage 圆环 + 展开面板 + 实时刷新 + compact 按钮 + clear 确认 modal + running 中 clear 先 abort）。
- **视觉保真**：V1-V11 全维度 PASS（无 Major）。对齐设计稿 `reqs/v0.0.16/mqnbr367-easy-opc-chat-v9a.html §143-258`（layout/font/border/color/brand 逐维度 compare，遵循 `_conventions.md §9`「整体风格基本一致」口径）。
- **BUG**：BUG-001（compact_notice 实时 SSE）已闭环 fixed + AT/ET 回归 PASS。

---

## 8. 版本

version: 1.1（v0.0.16 补 BUG-001 闭环 §6 + 验证结果 §7）。1.0（v0.0.16 新建：usage 面板 + compact 状态完善 + clear 功能 + context spec 对齐修复）。
