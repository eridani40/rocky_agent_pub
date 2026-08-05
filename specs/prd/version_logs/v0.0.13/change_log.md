# v0.0.13 PRD 变更日志

## 概述

本版本围绕 **context engine 完善** 做一次产品能力升级，权威设计 = `states/v0.0.13/design.md`（5 条 work stream）。一句话：**把 context 引擎从「简化硬编码版」演进到「plugin 驱动的完整链路」，并在运行时可靠性（forked compact / summary 状态 / 启动清理 / usage 校准 / session-state 实时性 / enqueue 清理 bug）上一并补齐。**

5 条 stream：

| # | 范围 | 用户视角一句话 |
|---|------|---------------|
| S1 | context plugin 化 | 用户在插件设置页能看到并管理 context 这组扩展点（5 个可配 impl + 21 个开关/调序 impl），context 引擎行为由用户配置驱动 |
| S2 | forked agent + compact 重写 + summaryTask + 启动清理 | 长对话自动压缩摘要更稳更准；summary 作为一个 session 任务有状态、可崩溃恢复；app 重启清理残留运行中态 |
| S3 | minimax usage 校准 | 对话过程中 token / cost / char 准确反映 minimax 真实消耗 |
| S4 | session-state event 前端接线 | 前端实时反映 session 运行态（running/interrupting/interrupted），比 agent_loop 派生更权威 |
| S5 | bug1 enqueue clear | 排队消息被处理后能从历史中正确移除（不再残留） |

> 设计原则（沿用 v0.0.12 memory `no-mock-api-e2e-tests`）：AT/ET 走真 LLM + 真服务，agent 实际写数据查真落库。

---

## 主文件改动（`specs/prd/overall/03-llm-chat.md`）

### §3.1 Chat 对话 [v0.0.13 修订]

补 / 改：

- **自动 compact**（§3.1 行为条）：compact 改由 **forked agent** 执行（共享 agent id、无副作用、继承父 system prompt + 压缩任务作末尾 user message、NO_TOOLS）；compact 期间 session 持有 `summaryTask`（idle/running/done/failed，单值，1 session 仅 1 个）；崩溃残留 summaryTask.running 由启动清理复位。
- **enqueue 清理**（§3.1 行为条）：enqueued message 经 drain 处理后**正确从排队区移除**（修复 v0.0.12 假修复回归，重开 BUG-002）。
- **session 运行态前端来源**（§3.1 行为条）：前端 session 运行态来源由 agent_loop run_start/run_stop 派生 → 补充订阅 `session_panel` 事件流（`session_status_update`），含 interrupting/interrupted 中间态，中断按钮与 enqueue view 据此更准确刷新。

### §4 关键用户路径 — 新增 v0.0.13 路径 L–Q（MANDATORY 测试最低覆盖）

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 L：长对话 → 自动 compact（forked agent）→ summary 生效 → 继续对话** | 多轮积累超阈值 → 触发 compact → forked agent 执行（无副作用、继承父 system）→ summary 写入 session（summaryTask idle→running→done）→ 重新 assemble 含 summary → 继续对话正常 | ContextEngine.compact/assemble · forked agent 执行器 · summaryTask CAS · SessionStore summary | AT（真 LLM 多轮超阈值 → 触发 compact → `GET /session/:id/messages` 或 summary 查询断言 summary 存在 + summaryUpTo 推进 + summaryTask 终态）+ ET（UC-3.1.15 重跑） |
| **路径 M：session running 中再发消息 → enqueue → 处理后清理（S5 回归）** | run 进行中 → 连发 N 条 → enqueue view 显示 pending → eager drain 逐条处理 → 每条 `message_start(user)` 落库后**从排队区移除**（不再残留到历史） | `POST /session/:id/messages`（running 入列不 409）· `enqueued_message_processed` 事件 · enqueue-view reducer | AT（`POST /messages` 排队 + 真 LLM 处理后 `GET /messages` 仅含落库消息，无残留 enqueue 项）+ ET（enqueue view 2 pending → 逐条移除 → 对话区出现，无残留） |
| **路径 N：config 页查看 / 配置 context 扩展点（S1）** | 插件设置页 → 扩展点 tab → `group-item-context`（context group）→ 看 6 个 EP（context_ingest_handler / context_assemble_mapper / context_assemble_reducer / system_prompt_mapper / system_prompt_reducer / system_reminder）及其 impl（共 26 个，ordered 拖拽+开关；其中 5 个有 schema config 齿轮）→ 切某 impl 开关 / 拖动调序 / 打开 schema 弹层改阈值 → 保存 → 对话行为按新配置生效（如 truncate 阈值改变） | `PUT /config/plugin`（setEnabled/setOrder/setImplConfig）· plugin-config 扩展点 tab UI（type=ordered）· schema-config-modal | AT（inventory 含 context group + 6 EP + 26 impl；`setImplEnabled`/`setOrder`/`setImplConfig` 真 LLM 对话后行为变化）+ ET（扩展点 tab 显 context group；切 impl 开关 + 改 schema 阈值并保存；对一新会话发触发该 impl 的 query 验证生效） |
| **路径 O：session 状态变化 → 前端实时收到（S4）** | session 进入 running → 前端订阅 `session_panel` 收到 `session_status_update(state=running)` → 用户点中断 → state `running→interrupting→interrupted`，前端每态收到 event 实时刷新中断按钮/loading；不依赖 agent_loop 事件派生 | SSE `session_panel` topic（group=`session_id:<sid>`）· `session_status_update` event · chat-slice reducer | AT（SSE 订阅 session_panel + 触发 running/interrupting/interrupted → 断言收到对应 session_status_update 序列）+ ET（中断按钮态/loading 态据 session_panel 刷新，含 interrupting 中间态可见） |
| **路径 P：对话 usage 准确（S3）** | 发对话 → minimax 真实 wire usage 返回 → per-call 13 字段（含 cost/currency/char）校准反映真实消耗；input_total 不虚高、reasoning（若 M3 返回）正确、cost 按定价计算（CNY） | minimax provider · parseAnthropicUsage · computeCost · minimax pricing record · usage view | AT（真 LLM minimax 一轮对话 → usage 视图断言 input/output token 合理 + cost>0 + currency=CNY + inputCharCount/outputCharCount 非零 + 无字段恒 0 异常） |
| **路径 Q：app 重启 → 残留 summary 执行中态被清理（S2 启动清理）** | compact 进行中被进程杀 → session 残留 summaryTask.status=running → 重启 bootstrap → 启动清理扫 summaryTask.running → 复位 idle（Run=interrupted 由 v0.0.12 reconcileOnStartup 已有）→ 打开 session 非卡死态 | bootstrap start_up reconcile · summaryTask CAS · SessionStore summary | AT（构造 summaryTask.running → 重启 → GET 断言 summaryTask.status=idle + session state 非 running）+ ET（重启后打开 session 显正确非卡死态） |

> **不变量（design 各 stream 自主决策）**：
> - S1 [D1.1] memory + todo impl 优雅 no-op（依赖缺失返回空贡献，plugin 完整 + 前向兼容）；[D1.2] base_builder head/tail fraction 算法替换 v0.0.8 简化版（ratio 学习 S3 激活前仍 fallback 1.0）；[D1.3] plugin id = `rocky_context`。
> - S2 [D2.1] forked agent 新建轻量执行器（不复用 AgentLoop，无 session.state/run 记录/bus 副作用）；[D2.2] 修 system 注入 gap（snapshot.system 真正注入 LLM 请求）；[D2.3] summaryTask 单值字段（不扩五态机，旁路 CAS）；[D2.4] 共享 agent id = 继承父 SessionConfig 身份（client/modelId/system），产出进 SummaryInfo 非 transcript。
> - S3 [D3.1] outputCharCount 口径 = 纯 text block 字符数；[D3.2] minimax pricing 币种 = CNY；[D3.3] accumulateUsage 激活为 stretch（核心 = per-call 13 字段校准）。
> - S4 [D4.1] 后端 event v0.0.12 已全接好，本版本仅前端 subscribe；[D4.2] sessionRunning 权威源切 session_panel（含 interrupting/interrupted 更准）。
> - S5 [D5.1] 重开 BUG-002（v0.0.12 closed 标记为假修复）；[D5.2] 修复后必须真 LLM AT PASS。

### 版本 bump

`03-llm-chat.md` 版本 1.2 → 1.3。

---

## 04-config-center-ui.md 改动（S1 落 UI 表达）

config center UI 契约本版本**无结构变更**（沿用 v0.0.5 两 tab + 扩展点 tab group-centric + ordered 拖拽/开关 + schema config 弹层）。S1 仅**数据层新增 context group**——扩展点 tab 的 group 列表多出 `group-item-context`，其下 6 个 EP（全部 `cardinality: ordered`），UI 自动按既有 ordered 渲染（拖拽手柄 + 开关 + 有 schemaConfig 的显「配置」齿轮）。

新增 testid 仅 follow 现有规则（见 `specs/ui/overall/03-config-center.md` §4.2）：
- `ext-point-context_ingest_handler` / `ext-point-context_assemble_mapper` / `ext-point-context_assemble_reducer` / `ext-point-system_prompt_mapper` / `ext-point-system_prompt_reducer` / `ext-point-system_reminder`
- 各 impl 行：`ext-impl-{implId}` / `-drag` / `-toggle` /（仅 5 个有 config schema 的）`-config-btn`

> 实际 ui 组件 spec 细化（context 扩展点渲染）留 coder 阶段按 `_conventions.md` 落 component spec，PRD 不展开。

---

## 非功能需求（沿用，本版本强调）

- **无 mock**（memory `no-mock-api-e2e-tests`）：S2/S3/S5 涉及真 LLM 链路验证必须真 minimax 调用 + 真落库，不接受 mock。S5 真 LLM AT PASS 是合并门禁（吸取 b6f6ccd 教训）。
- **不变量**（design 自主决策汇总）：compact 无副作用（forked agent 不碰 session.state / run 记录 / bus / 不 ingest 父 transcript）；状态转换只由 agent loop(run_end) / abort api / activate 三者设置（summaryTask 是旁路 CAS，不干扰五态机）；崩溃恢复只动 running/interrupting/summaryTask.running（终态不修复）；ordered 的 order 与 enabled 正交（layout 稳定性）。
- **工程红线**：单文件 ≤ 300 行；forked agent 执行器 / rocky_context 各 impl 模块 / summaryTask CAS 各自单文件单一职责。

---

## 范围边界

### IN（v0.0.13 必须交付）

**S1（context plugin 化）**：
- 6 个 context EP 定义（全 `group:"context"` `cardinality:"ordered"`）：context_ingest_handler / context_assemble_mapper / context_assemble_reducer / system_prompt_mapper / system_prompt_reducer / system_reminder。
- rocky_context plugin（id=`rocky_context`）声明 26 个 ext impl。
- ContextEngine 改造：构造注入 PluginManager；ingest/assemble/system_prompt/system_reminder 四处调 `getExtensionImpls(pointId)` 跑 ordered 链；现有简化逻辑下沉为 builtin impl 兜底。
- 5 个 spec 点名 impl 给 `ExtImpl.configSchema`（JSON Schema 校验）+ `schemaConfig`（per-key UI 控件）。
- [D1.1] memory + todo impl 优雅 no-op；[D1.2] base_builder head/tail fraction 替换简化版（ratio 未激活前 fallback 1.0）；[D1.3] plugin id = `rocky_context`。
- 用户视角：config 页可见并配置；对话行为按配置生效。

**S2（forked agent + compact 重写 + summaryTask + 启动清理）**：
- 新建 forked agent 轻量执行器（输入：parent SessionConfig + ContextSnapshot + task user message + tools 约束；组 CanonicalRequest 含 system 注入；调 client.call；无副作用；返回 answer）。
- compact 重写用 forked agent（markSummaryRunning → forked agent（snapshot + compact msg + NO_TOOLS + system 注入）→ answer 提取 `<summary>` → setSummary → markSummaryDone/failed）。
- Session 加 `summaryTask` 单值字段 + CAS 方法（markSummaryRunning/Done/Failed/Idle）。
- reconcileOnStartup 扩展：扫 summaryTask.status=running → idle。
- [D2.2] 修 system 注入 gap（agent loop 主路径 + forked agent 把 snapshot.system 真正注入 LLM 请求）。

**S3（minimax usage 校准）**：
- 抓 minimax wire raw → 校准 parseAnthropicUsage（确认 input_tokens 语义、cache_creation 有无、reasoning token 有无/字段名）。
- 补 stream 路径 cost/currency。
- 补 minimax pricing record（CNY）。
- 补 inputCharCount（← snapshot.inputCharCount）/ outputCharCount（← StreamConsumer 累积纯 text block 字符数）。
- [stretch] 激活 accumulateUsage（三分区累加 + getUsageView 真聚合 + session_usage_update 真能发，接 S4）。

**S4（session-state event 前端接线）**：
- 前端 page-chat.tsx 加 `subscribe('session_panel', 'session_id:'+sid, ...)`；写 reducer 处理 session_status_update → 更新 sessionRunning / 中断按钮 / enqueue view。
- sessionRunning 权威源切 session_panel（含 interrupting/interrupted）。
- 后端不动（v0.0.12 已全接好）。

**S5（bug1 enqueue clear）**：
- 重开 BUG-002（改名 `[reopen]`，记录假修复证据）。
- 真 LLM 调试定位根因 + 修复（stagePreProcess user 分支 / peek-continue / isInterrupted 门控三条线索）。
- 重跑 AT（messages_enqueue_tc1 + messages_cancel_tc1）真 LLM PASS（last_run.json PASS 才提交）。

### OUT（本版本明确排除）

| 排除项 | 理由 |
|--------|------|
| **外部插件发现 / 安装 / origin 信任** | 沿用 v0.0.3 OUT，P1；rocky_context 是 builtin 内置 plugin |
| **long_term_memory / task_tools impl 真实业务实现** | [D1.1] 注册为 builtin impl 但依赖缺失时优雅 no-op；真实业务实现留后续版本 |
| **forked agent 的第二类任务（反思 memory/skills 调工具产副作用）** | req 提及但本版本只交付 summary 任务；forked agent 执行器接口为未来任务预留，但不实现第二类 |
| **tokenizer 精确计数** | 沿用 v0.0.3，char×ratio 估算（S3 stretch 激活后真 ratio 学习，否则 fallback 1.0） |
| **compact `<analysis>` 9 板块结构化输出强校验** | forked agent 产出尽量贴合 spec 但不强校验（沿用 v0.0.8 实现基线口径） |
| **S3 accumulateUsage 激活（非 stretch 部分）** | [D3.3] per-call 13 字段校准为核心；session 级累计若 scope 不够则文档化为后续 |
| **error 态 half-data 收尾逻辑** | 沿用 v0.0.12 OUT |

---

## 与 specs/ui + specs/tech 对齐说明（MANDATORY）

PRD 引用的组件 / 概念 / 接口与已有 spec 一致；新概念已在 design.md 规划落 ui/tech spec 计划，本 PRD 引用之：

### 已有概念对齐（PRD 引用 = spec 现状）

| PRD 引用 | spec 权威源 | 对齐点 |
|---------|------------|--------|
| plugin 扩展点 tab + ordered 拖拽/开关 + schema config 弹层（S1 UI 表达） | `specs/ui/overall/03-config-center.md` §4（扩展点 tab）+ §5（schema-config-modal）+ `specs/ui/components/plugin-config-page/` | 复用 v0.0.5 既有组件，无新组件；S1 仅数据层新增 context group |
| Session 五态 + CAS + reconcileOnStartup（S2 复用模式） | `specs/tech/agent/session/[P0]session_state.md` | summaryTask CAS 复用五态 CAS 模式（design [D2.3]）；启动清理扩展复用 reconcileOnStartup |
| SessionEvent / session_status_update / session_panel topic / session_id group（S4） | `specs/tech/agent/session/[P0]session_event.md` §2-§3 | 后端 event v0.0.12 已全接好（design [D4.1]），S4 仅前端 subscribe |
| Usage 13 字段 + char + cost + currency（S3） | `specs/tech/agent/session/[P0]session_usage.md` §1 + `specs/tech/agent/context_and_memory/[P0]context_usage_detail.md` | S3 校准既有类型定义，不改 schema |
| ContextEngine.compact/assemble + SummaryInfo（S2） | `specs/tech/agent/context_and_memory/[P0]context_engine.md` + `[P0]context_compact_detail.md` | forked agent 是 spec 标 future 的部分（§2 step 2 / §6.4），本版本落地为 current |
| enqueue view + enqueued_message_processed + 排队区清理（S5） | `specs/ui/components/chat-page/`（enqueue-view）+ v0.0.12 PRD 路径 G | S5 是 v0.0.12 路径 G 的回归（重开 BUG-002 假修复） |

### 新概念（design.md 已规划落 ui/tech spec，PRD 引用之）

| 新概念 | 落 spec 计划（architect 阶段） | PRD 引用语义 |
|--------|------------------------------|-------------|
| **6 个 context EP + 26 个 impl + rocky_context plugin manifest** | NEW `specs/tech/agent/context_and_memory/extension point and implementations.md` + builtin_plugins_directory.md 加 rocky_context 条目 + MODIFY context_engine.md / context_ingest_detail.md §3 / context_assemble_detail.md §3-§5 | S1 用户视角：config 页能看到这组扩展点（管理范畴），context 引擎行为由 plugin 驱动 |
| **forked agent 执行器**（fork 契约 + 无副作用边界 + answer 回收） | NEW `specs/tech/agent/agent_interface_and_loop/[P0]forked_agent.md` + MODIFY context_compact_detail.md（§2 forked agent future→current） | S2 用户视角：长对话自动 compact 由 forked agent 执行（共享 agent id、无副作用） |
| **summaryTask 单值字段 + CAS + reconcile 扩展** | MODIFY `specs/tech/agent/session/session_store.md` + `session_state.md` + NEW `specs/tech/app/start_up/[P0]startup_reconcile.md` | S2 用户视角：summary 作为 session 任务有状态、可崩溃恢复；app 重启清理残留 |
| **minimax wire usage 校准 + stream cost + char 口径** | MODIFY `specs/tech/agent/providers_and_models/llm_client_interface.md` + `llm_protocol_interface.md`（stream 路径 cost/currency 边界 + outputCharCount 口径）+ `session_usage.md`（accumulateUsage 激活条件若 stretch 做） | S3 用户视角：对话 usage 准确反映真实消耗 |
| **前端 subscribe session_panel + sessionRunning 权威源切换** | MODIFY 前端 spec（chat-page / sse_channel 前端侧） | S4 用户视角：前端实时反映 session 运行态 |

> **orchestrator 核对结论**：PRD 引用的组件命名（plugin-config / ext-point / ext-impl / schema-config-modal / enqueue-view / abort-btn）、布局（三栏 config / 两 tab plugin）、数据概念（Session 五态 / SessionStatus / Usage 13 字段 / SummaryInfo / summaryUpTo）、接口语义（PUT /config/plugin setEnabled/setOrder/setImplConfig / POST /messages / POST /session/:id/abort / SSE session_panel+session_id group）全部与已有 specs/ui + specs/tech 一致。新概念（context EP + impl / forked agent / summaryTask / start_up reconcile / minimax usage 校准细节）design.md 已规划落 tech/ui spec 计划，PRD 仅引用产品语义不发明实现细节，符合「概念先行 + PRD 对齐」原则。

---

## overall 同步建议（doc-modifier 阶段执行）

本版本完成后 overall 需小幅更新（实际同步留 doc-modifier 阶段，不在本 PRD 范围）：

- `specs/prd/overall/03-llm-chat.md` §3.1 自动 compact 条改 forked agent 表述 + enqueue 清理 + session 状态来源；§4 追加 v0.0.13 路径 L–Q；版本 bump 1.3。
- `specs/prd/overall/04-config-center-ui.md` §4 / §6 注明扩展点 tab 新增 context group（数据层，UI 渲染规则不变）。
- tech/api overall 同步（落 architect + coder 产出）由 architect / doc-modifier 处理。

---

## 版本

v0.0.13 PRD（context engine 完善：S1 context plugin 化 + S2 forked agent/compact/summaryTask/启动清理 + S3 minimax usage 校准 + S4 session-state event 前端接线 + S5 enqueue clear bug 回归）。
