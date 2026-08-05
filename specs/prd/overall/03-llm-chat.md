# LLM + Plugin + Chat — 产品需求文档

> version: 1.15 · 引入版本 v0.0.3 · **v0.0.130.hang 修订**：§3.1 loading 条加 P6 工具执行阶段外显（`tool_execution_start` 驱动 `tool_executing` 阶段显「运行工具: X」、修 hang 时假「思考中」）；技术权威 `specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §5.6` + UI `specs/ui/components/chat-page/_overview.md §4.10`；详见 `specs/prd/version_logs/v0.0.130.hang/change_log.md` · **v0.0.81 修订**：移除 compact_notice system message 留痕（compact summary 改 role=user message 落库，不再插 system notice / 不再渲染居中 pill；技术权威 `specs/tech/agent/context/[P0]context_compact_detail.md §6`）· [v0.0.56 modified] SessionKind 统一 session 类型维度——subagent 派生描述 type='subagent'→derivation='subagent'（用户行为不变）。详见 `specs/prd/version_logs/v0.0.56-session_type/change_log.md` · 最后更新：2026-07-01（**v0.0.47 修订：playground 三件 UI 优化**——§3.1 加「session 名字可编辑 + AI 起名 + 名字位置/展开逻辑」条目（激活后点 title 进编辑 + PUT /session/:id + 首条 query 并行 LLM 起名 + 应用条件「AI 名仅当 title 仍是默认名时应用，否则作废」+ scope=playground + 复用 LlmClient + conv-item 移除 twisty 占位使名字左对齐 + 行点击展开 subagent-tree 到 running 段+分割线 + 点分割线展开 terminated 灰显）；§4 追加 v0.0.47 关键用户路径 TT-YY（6 条：编辑保存刷新 / 并行 AI 起名 / 人工改名作废 / 行点击展开 / 应用设置合并页 / nav 底部三入口）。设置入口三合一详见 `04-config-center-ui.md §3.9.10`。新概念「默认名 vs 已命名区分机制」+「AI 起名 service」+「应用设置合并页 layout」需同步落 specs/tech/ + specs/ui/components/。详见 `version_logs/v0.0.47-ui_opt/change_log.md`）· **v0.0.45 修订：@ mention 系统**——§3.1 加「@ mention 系统」条目（共享 ChatComposer + MentionPopover + MentionPill + MessageContent 结构化 + MentionProviderRegistry + FileProvider/SkillProvider + GET /mention/search + 全局 BizType/SessionType alias）；§4 追加 v0.0.45 关键用户路径 M1-M8（8 条：playground @ skill / playground @ file / mate @ file / squad @ file / leader @ skill / Esc 收起 / pill 删除 / 历史回放）。新概念需同步落 specs/ui/components/ + specs/tech/。详见 `version_logs/v0.0.45-mention-system.md`）· **v0.0.42 修订：session/run 两层状态分离 + 切走切回 spinner 恢复**——§3.1 loading 条改写：session 层（GET /session + session_panel）驱动 stop 按钮（圆环动画 + 中心实心方框，interrupting 减速 2.5s），run 层（agent_loop）驱动 on-message spinner（贴流式尾部，spinner+phase 同控件状态各自决定，testid `chat-run-spinner`）；移除原浮动 loading 胶囊（§4.10 职责错位）+ 红方块 abort bg；切走切回 spinner 恢复靠块1 replay 粘住（agent_loop bus 注入 `lifecyclePredicate`，`run_start`/`run_end` 写独立 sticky slot，clearReplay 不清，**sticky-exclusive：命中事件不进 buffer** 避免回放两次；reviewer 已知权衡：硬编码 `run_start` replace 待未来泛化为 replaceGroups 配置）。§4 追加 v0.0.42 关键用户路径 RR-SS（切走切回 spinner 恢复 / abort interrupting 减速）。**无新 HTTP 端点**——abort/messages/session/sse 全复用现有。技术权威 `specs/tech/app/frontend/[P0]sse_channel.md §9.1/§10.7` + `[P0]component_architecture.md §3.7` + `specs/tech/agent/event/[P0]event_bus.md §4.3`；UI `specs/ui/components/chat-page/_overview.md §4.10/§4.11b`；详见 `version_logs/v0.0.42/change_log.md`）· v0.0.31 修订：a2a 协议对齐（inbox 中枢 + AgentRef 上下文兑现）——§3.1 加「a2a 协议对齐」条目：inbox 入口 enrich（deliverTo 层反查发送方 session record 补 AgentRef.type/name + needReply 必填 + inReplyTo + ref 校验 warn）+ 出口消费（drain 透传 sender.agent + prompt 渲染 `[Message from ...]` 前缀，兑现 v0.0.28 spec 已声明的渲染规则）；sender 严格判别联合（needReply = source='agent' a2a 专属）；deliverTo 去 config 重构 + user POST 收敛；MessageSource enum 'scheduled' 并入 'system'；inbox 补 enqueuedAt；KNOWN-ISSUE BUG-034 explorer 模板 systemPrompt 未引导 child 回 a2a（非协议 bug）。技术权威 `specs/tech/agent/message/[P0]agent_message_interface.md §5` + `[P0]agent_inbox_enqueue.md §2.5` + `[P0]agent_manager.md §2-§2.4` + `specs/tech/multi_agent/[P1]a2a_protocol.md §4/§5`；详见 `version_logs/v0.0.31/change_log.md`）· v0.0.28 修订：multi-agent subagent 派生 + a2a + 模板 + scope + subagent UI**——§3.1 加「多智能体派生」条目；§4 追加 v0.0.28 关键用户路径 II-QQ（9 条：sync spawn 模板 / async spawn inherit / 模板带 modelId / query swarm / abort child / UI 展开 swarm / UI 只读页 / scope 结构约束 / 模板管理）。技术权威 `specs/tech/multi_agent/` 五件 + `specs/tech/agent/tools/[P1]agent_tools.md` 1.0；API `specs/api/overall/{10-multi-agent.md, 10a-multi-agent-tool-ref.md}`；UI `specs/ui/components/chat-page/{_overview.md §4.2/§4.2a/§4.3/§8, component-subagent-tree.md}`；详见 `version_logs/v0.0.28/change_log.md`。**严守范围红线：只 multi_agent，不碰 squad/角色/团队层**）· v0.0.27 修订：session 未读红点（explicit-bool 模型）+ session_meta 广播 topic——§3.1 期望行为加「未读红点 + session_meta 广播」条目；§4 v0.0.27 路径 EE-HH 措辞从「agent-loop 查 isSessionActive」改为「**session 层** SessionUnreadRuntime 订阅状态机 completion 信号 + 查 isSessionActive + CAS」（归属层最终决策，对齐 unread-model-decision.md §6）；explicit-bool 模型核心段同步改 session 层 + 加 session_meta 广播 topic 段。技术权威 `specs/tech/agent/session/[P0]session_state.md §6` + `specs/tech/version_logs/v0.0.27/{unread-model,session-meta-broadcast}-decision.md`；API `specs/api/overall/04-agent-session.md §2.3/§2.3.1/§4.2`；UI `specs/ui/components/chat-page/_overview.md §4.2/§5 交互7`）· v0.0.22 修订：prompts refine — 纯后端内容优化，用户视角行为不变（system prompt 内容优化（identity 5 要素 + rules 拆 3 section）+ compact prompt 结构化（CC 口径 NO_TOOLS 双保险 + 9 板块 + analysis/summary 双 block + identifier 保留）+ prompt 正文文件化（新增 `app/server/src/prompts/` 模块，plugin 层 mapper 变薄委托 handler；无新 API、无 UI）；详见 `version_logs/v0.0.22/change_log.md`，技术权威源 `specs/tech/agent/context/[P0]prompt_content_files.md`）· v0.0.17 修订：§4 追加 v0.0.17 关键用户路径 DD-II [workspace 工作区面板 + lazy watcher + lazy 文件树 + 切目录 + reminder 接线]；workspace 概念权威源 `specs/ui/components/chat-page/component-workspace-panel.md` + `specs/tech/agent/session/[P0]session_workspace.md`）· v0.0.16 修订：§3.1 加 usage 面板 + 手动 compact + clear 行为条 + BUG-001 compact_notice 实时 SSE 修复 · v0.0.15 修订：Agent 实现层对齐 spec [Agent interface 统一 + AgentRun + 三策略类 + AgentManager 门面三 map + AbortController 内存对象 + groupKey+modeKey 全链路 + abort 搬运工 + forked 多轮 ReAct + manager.forkedRun 入口 + not-allowed tool 门控]；§3.1 行为条实现细节对齐 spec v0.0.16；§4 追加 v0.0.15 关键用户路径 R-W）· v0.0.14 修订：accumulateUsage 激活 [session usage view 可用 + session_usage_update event 真发 + ratio 学习 3 轮收敛] + BUG-003 fixed [PluginManager default 注入]
> 本文是 v0.0.3 的全量产品定义，经 v0.0.4 UI 修订 + 配置归属完善。底座 v0.0.1（脚手架/三环境/打包/测试流程）+ v0.0.2（persistence 引擎 CrudStore）之上，引入 config 三域、plugin 静态内核、provider/protocol/model 三件套，并落地一个**简单 chat UI 验证 LLM 配置**。
> **v0.0.4 修订**（见 §2.2 / §4 / §5.7 / `-features.md` §3.5/§3.7/§3.8）：sidebar 改图标栏；provider/model UI 入口挪 app 设置页；插件页改纯 plugins+ext impls（按 EP.group 分区）；EP.group 必填；inventory group-centric。增量见 `version_logs/v0.0.4/change_log.md`。
> 全量产品文档目录另见 `01-product-framework.md`（v0.0.1 脚手架）；本文不重复脚手架内容。

## 目录

| 章节 | 说明 |
|------|------|
| §1 产品概述 | v0.0.3 的定位、目标用户、核心价值 |
| §2 UI 风格与布局 | sidebar 图标栏（v0.0.4）、theme 切换 |
| §3 功能需求（详） | 8 个功能模块；详见本文及 `-features.md` |
| §4 关键用户路径（MANDATORY） | 测试最低覆盖要求（v0.0.4 六条） |
| §5 设计决策（已确认） | chatRoute / configAggregation / v0.0.4 UI 修订（§5.7） |
| §6 非功能需求 | 安全限制、可测试性、风格一致 |
| §7 范围边界（IN / OUT） | scope.in 7 项 / scope.out 7 项 |
| §8 验收口径 | v0.0.3 验收口径 |

---

## 1. 产品概述

### 1.1 产品定位 [v0.0.3]

v0.0.3 在 v0.0.1（工程基座）+ v0.0.2（persistence CrudStore）之上，交付一条**最小可用的 LLM 链路**：用户能在应用内配置 provider/model、发起一次 chat，看到 assistant 的 thinking + answer 流式分段回复。

一句话：**v0.0.3 的产出不是「完整的 AI agent」，而是「能配置、能调通、能看回复」的 LLM 配置验证切片**。

v0.0.3 的 chat **是简化形态**：无 session 持久化、无工具调用、无 agent loop、前端只记最近 10 条 message。其唯一目标是**验证 config + plugin + provider/protocol/model + 流式链路端到端跑通**。

### 1.2 目标用户 [v0.0.3]

- **终端用户**：能在桌面 app 里配 provider、选 model、发 chat，看到流式回复。
- **开发者**：能经 app_config 技术调参组（agent/context/logs 等，v0.0.89 前经已废弃的 DevConfig）调参，经 App/PluginConfig 管理 provider/model 实例。
- **自动化（verifier agent）**：能 curl `/chat`、`/config`、`/provider`、`/model`，Playwright 驱动 chat UI 截图验证流式分段。

### 1.3 核心价值 [v0.0.3]

1. **可配置**：三域 config（app/plugin/dev）落地，overlay 聚合模型跑通。
2. **可调通**：内置 anthropic_compatible provider + anthropic_messages protocol，能真实调 Anthropic Messages API。
3. **可观测**：chat 流式分段（thinking block / text block 分开显示），用户能看到「模型在想什么」。
4. **可扩展**：plugin 静态内核落地（ExtensionPoint + Registry + PluginManager），为后续工具/MCP 等扩展铺路。

---

## 2. UI 风格与布局 [v0.0.3]

### 2.1 整体风格（沿用 v0.0.1 暖色 token）

视觉契约唯一来源仍是 `specs/tech/app/frontend/[P0]design_system.md`：暖色系（米色底 + terracotta 主色）、Inter / JetBrains Mono / Playfair Display 三字体、4/6/8/10/12px 圆角档位。

v0.0.3 新增落地：
- **theme 切换**：app_config `appearance.theme` = `dark` / `light`，控制深浅色主题。token 经 CSS 变量定义，切 theme 即切变量集（详见 `-features.md` §3.1）。
- **chat 气泡**：user 气泡（`fg-2` 底）+ assistant 气泡（`surface` 底），thinking 折叠面板（`bg-warm` 底），均符合 design_system 词表。

### 2.2 布局：chat 2 栏 / 配置页 3 栏 [v0.0.3] [v0.0.4 modified] [v0.0.5 modified]

- **chat 主界面**：2 栏（功能导航 + 主区）。详见 §3.1。
- **配置页（app/dev/plugin config）** [v0.0.5 modified]：**3 栏**（功能导航 + group 列表 + 配置区域/扩展点区）。详见 `04-config-center-ui.md` §3.9.2 / §3.9.4。
- **左栏（窄图标栏 nav-rail）** [v0.0.4 modified]：固定 **~56px** 宽度，纯图标栏，4 个图标自上而下：
  1. **会话图标**（chat）→ 切 `currentView=chat`（v0.0.4 修复 v0.0.3「会话不可点击」bug）。
  2. **app 设置图标**（user/gear）→ 打开 app 设置页（**三栏**：appearance group + providers group [v0.0.4]）[v0.0.5]。
  3. **插件设置图标**（puzzle）→ 打开 plugin config 页（**2 tab：插件 / 扩展点**，扩展点 tab 三栏 group 列表 + 扩展点区）[v0.0.5 modified]。
  4. **dev 设置图标**（wrench）→ 打开 dev 设置页（**三栏**：llm_request group）[v0.0.5]。
  - **hover tooltip**：鼠标悬停图标显示文字说明（「会话」「应用设置」「插件」「开发者」）。
  - **激活态**：当前 `currentView` 对应图标有视觉强调（terracotta 边框 / sage 圆点 / 背景色块之一）。

> v0.0.3 旧布局（220px 文字窄菜单 + 会话区占位不可点击 + 3 设置按钮下对齐）**已被 v0.0.4 替换**；v0.0.4 配置页单栏纵向堆叠**已被 v0.0.5 三栏化取代**。详见 `version_logs/v0.0.3/change_log.md` + `version_logs/v0.0.5/change_log.md`。

### 2.3 布局稳定性（沿用 v0.0.1 MANDATORY）

按钮/图标出现/消失/激活态切换/hover tooltip 出现 不得导致相邻元素位移：预留固定空间（`visibility: hidden` / `opacity: 0`）或绝对定位，禁止 `display: none` + 常规流导致跳动。chat 流式时 thinking 折叠面板展开/折叠同理——折叠状态预留高度槽位。tooltip 用绝对定位浮层，不占常规流空间。

---

## 3. 功能需求（总览）

7 个功能模块分述于本文 §3.1–§3.4（核心 4 项）与 `-features.md` §3.5–§3.7（设置与配置 3 项）。每项含「描述 / 优先级 / 用户故事 / 行为 / E2E Use Cases」。

### 3.1 Chat 对话 [v0.0.3] [v0.0.8 replaced]

> **[v0.0.8 replaced]**：v0.0.3 旧「无 session、单轮、模拟」chat（`POST /chat` SSE + thinking/answer 分段 + 前端内存 10 条）**已作废**，被 v0.0.8「真实 agent 基础对话页」彻底替换（删旧 `POST /chat` + 旧 `ChatPage/chat-store/sse-client`）。v0.0.3 旧完整描述见 `version_logs/v0.0.3/change_log.md`（overall 不再保留全文）。新版见下文；UI 概念权威 = `specs/ui/components/chat-page/_overview.md`；增量见 `version_logs/v0.0.8/change_log.md`。
>
> **v0.0.8 真实 agent 基础对话页**

**描述**：把 chat 升级为「session 化、agent loop + inbox + 工具、SSE 流、transcript 持久化」的基础 agent 对话页。用户新建/选中/删除会话，发消息触发真实 agent run，看流式回答、工具调用合并展示、loading 阶段胶囊、空态、run 结束 finish reason（异常附 error desc），多轮超限自动 compact，打开旧会话读最近 50 条 transcript + 上滑续载。
**优先级**：P0 · **用户故事**：作为用户，我希望能像用真实 AI agent 一样，在会话里发消息、看 agent 边思考边调用工具边回答、历史会话可回看，而不是一次性的配置验证。
**权威源**：UI = `specs/ui/components/chat-page/_overview.md`；视觉 = `reqs/v0.0.8/easy-opc-chat-v9a.html`；数据/事件 = `specs/tech/agent/message/[P0]agent_message_interface.md`（Message+ContentBlock）+ `agent_interface_and_loop/[P0]agent_event.md`（AgentEvent，**[v0.0.15] AgentEventBase.modeKey 必填**）+ `specs/tech/app/frontend/[P0]sse_channel.md`（SSE topic=`agent_loop` **[v0.0.15] group=`session_id:<sid>_amt:<modeKey>`**，主对话 modeKey=`current`）；agent 契约 = `agent_interface_and_loop/[P0]agent_interface.md`（**[v0.0.15] Agent interface 统一 + AgentRun instance**）+ `[P0]agent_manager.md`（**[v0.0.15] 门面 + agentRuns/abortControllers/loops 三 map + forkedRun 入口**）+ `[P0]agent_interrupt.md`（**[v0.0.15] AbortController `{runId, aborted}` 内存对象 + abort 搬运工**）。

**期望行为**（视觉细节对齐 `_overview.md`，此处只列产品语义）：
- **Session 化**：conv-panel 列会话；新建 → 空会话 + empty-state；选中切消息流；删除（hover 固定槽位入口，不抖动）。**空态**：无消息显 empty-state。
- **打开 session + 发消息**：`GET /session/:id/messages?limit=50` 读最近 50 条 + 订阅 SSE；`chat-send`/Enter → `POST /session/:id/messages` → `AgentManager.enqueue` → `manager.activate(config)` 返 `AgentRun(modeKey="current")`。**[v0.0.12 修订]** **对话区只渲染服务端 SSE Message**（来源 = `message_start` 携带的服务端 ULID）；**移除客户端乐观插入**（旧 `local-<ts>` 临时气泡作废，BUG-006 启发式去重 workaround 删除）。user 消息经 enqueue → drain → `message_start(user)` 落库后出现在对话区。**[v0.0.15 修订]** 订阅主对话事件流：`subscribe(sid, "current")` → group=`session_id:<sid>_amt:current`；activate 重复调用返同一 AgentRun 对象引用（running 时），无需 status 分支。
- **流式回答**：SSE 增量 → agent answer 气泡 markdown 流式追加；part key = `messageId + toolCallId/text-index`。
- **工具调用合并展示**：assistant 产 tool_call → 视图层连续合并为单个 tool-batch（**跨消息边界，位置连续即合并**）；item 展开 KV 参数/结果；**result 永远附着对应 call**；严禁原始 JSON/生硬代码框。
- **Loading 阶段胶囊 / Run 结束 finish reason / Markdown answer**：悬浮输入框左上方，一次 run 唯一，随事件切文案；run 结束即隐藏；仅 last run 末条下渲染 run-finish（正常「✓ 已完成」/ `max_iterations`·`doom_loop` 警告 / `error` 错误卡片显 `error.message`+`error.code` / `require_approval` 枚举保留不触发）；answer 支持段落/加粗/行内代码/列表/代码块（卡片态）。**[v0.0.42 modified]** **两层状态严格分离**——session 层（GET /session + `session_panel`）驱动 **stop 按钮**（圆环动画 + 中心实心方框，interrupting 减速 2.5s）；run 层（`agent_loop`）驱动 **on-message spinner**（贴流式尾部，spinner+phase 同控件状态各自决定，testid `chat-run-spinner`）。**移除原浮动 loading 胶囊**（`absolute left-10 bottom-[72px]`，§4.10，职责错位——用 run 层状态表达 session 在跑语义）；移除红色方块 abort bg（改外圈旋转环 + 实心方框）。切走切回 spinner 恢复靠块1 replay 粘住（agent_loop bus 注入 `lifecyclePredicate`，`run_start`/`run_end` 写独立 sticky slot，clearReplay 不清）。详见 `specs/ui/components/chat-page/_overview.md §4.10/§4.11b` + `specs/tech/app/frontend/[P0]sse_channel.md §9.1/§10.7`。 **[v0.0.130.hang modified]** **工具执行阶段外显 + hang 时不再假「思考中」**：on-message spinner 新增 `tool_executing` 阶段由 SSE `tool_execution_start`（工具执行**开始**即到，早于结果返回）驱动——以往仅 `tool_result_start`（结果返回）才切阶段，工具卡死时结果永不返回、UI 永停「思考中」看不出问题；现执行一开始就切「运行工具: `<tool 名>`」（如「运行工具: bash」，i18n `loading.toolExecutingNamed` 中英双语），用户能区分「LLM 思考中」vs「正在跑某工具」。停止原因（stopReason）仍走现有 run-finish 外显（`max_iterations`/`doom_loop`/`error`/中断/`tool_pending` 覆盖）；工具超时以 `[timeout] <tool> exceeded <ms>ms` tool_result（isError）在 tool batch 内呈现，loop 续跑非 stopReason。**[v0.0.253 modified]** **answer 里的 markdown 链接可点击分发**：`[文本](target)` 由 `PrimitiveMarkdownView` 渲染为 `<a>`（既有，样式 `cursor-pointer` + 常驻下划线），点击按 target 分发——web scheme（http/https/mailto）→ 系统默认浏览器（Electron `shell.openExternal`）；本地路径扩展名属 12 格式（md/json/jsonl/yaml/xml/toml/csv/tsv/txt/ini/env/log）→ 内置 viewer 只读打开（`ComponentModalMdEditor` readOnly=true）；其它本地（图片/pdf/代码/未知）→ 系统默认应用（`shell.openPath`）；危险协议（javascript:/vbscript:/data:）保留 `isDangerousScheme`（原 isSafeUrl 提取为单一权威）降级纯文本。渲染范围覆盖全部 PrimitiveMarkdownView 消费方（agent 回复 / md-editor view / skill 预览 / feishu doc），user 气泡（MentionRender）不动；**链中链（md-editor viewer 内 md 链接）v1 简化 = 系统打开**（viewer 未包 ChatLinkHandlerContext → 12 格式本地链接降级 `openPath`，不弹第二内置 viewer）。个人 agent app 信任任意路径直接打开（v1 不加白名单，区别 workspace 面板 whitelistResolve）。system prompt `rules.md` 配套提示 LLM 用 `[文本](路径)` 语法输出（覆盖 standalone/subagent/academy）。技术权威 `specs/tech/app/package/[P0]package_structure.md §4.4`（IPC）+ `specs/ui/components/common/component-modal-md-editor.md`（viewer）+ `specs/ui/components/chat-page/component-chat-link-viewer.md`（挂载层）；详见 `specs/prd/version_logs/v0.0.253.md`。
- **Transcript 分页续载 / 工具**：上滑到 50 条尽头若 `hasMore` → `beforeId=<最旧id>` 续载前插；工具含 file（read/write/edit/glob/grep）+ bash，tool_result 回灌 agent 续答。
- **自动 compact**：char 估算 context window 超阈值 → ContextEngine.compact（snapshot + user → LLM → 解析 `<summary>` → 推进 summaryUpTo）；assemble 含 head 3 + tail 3 + recent + summary；用户无感。**[v0.0.13 修订]** compact 由 **side run**（旧名 forked agent，v0.0.204 rename）执行（共享父 agent id、无 session.state/run 记录/bus 副作用、继承父 system prompt + 压缩任务作末尾 user message、NO_TOOLS；修 latent gap：snapshot.system 真正注入 LLM 请求）；compact 期间 session 持有 `summaryTask` 单值字段（idle/running/done/failed，1 session 仅 1 个，旁路 CAS 不干扰五态机）；assemble 由 plugin 驱动（`rocky_context` plugin 26 个 ext impl，base_builder head/tail fraction 替换硬编码 head3+tail3；ratio 学习在 accumulateUsage 激活前 fallback 1.0）。**[v0.0.15 修订]** compact 经 `manager.sideRun({runKind:"summary", ...})` 入口（caller 传 snapshot 保 KV 缓存命中，旧名 `forkedRun` 已 rename）；side run loop 升级为多轮 ReAct 策略类（compact maxIter=1 保持单次路径，memory_extract 多轮 future）；前端可 `subscribe(sid, "summary")` 看 compact 进度（group=`session_id:<sid>_amt:summary`，事件 runKind=summary）；side-run controller 由 manager 创建注入，可被 `manager.abort(sid, runId, "summary")` 中断（无 4 步收尾，直接置 controller.aborted）。**[v0.0.22 修订]** compact prompt **内容结构化**（CC 口径：NO_TOOLS preamble+trailer 双保险 + 9 板块指令 + analysis/summary 双 block 输出 + identifier 保留），压缩指令正文从代码常量抽到文件 `app/server/src/prompts/content/compact.md`（compact runner 委托 `CompactHandler` 读取 + 运行时 serialize transcript 拼接）；compact 执行路径（CAS / sideRun / extractTag / setSummary / appendMessages / markSummaryDone）全不变，产品行为同前。
- **enqueue 清理**：**[v0.0.13 修订 / v0.0.15 简化]** enqueued message 经 drain 处理后**正确从排队区移除**（修复 v0.0.12 假修复回归 BUG-002 重开真修；S5 cancel 时序同步修复，详见 `specs/api/overall/04-agent-session.md` POST /messages 响应 `enqueueId` + `activate`（测试专用）参数；cancel 统一走专用端点 `POST /session/:id/messages/:enqueueId/cancel`，**v0.0.15 移除 v0.0.13 曾引入的 `cancelEnqueueId` 多余概念**）。
- **session 运行态前端来源**：**[v0.0.13 修订]** 前端 session 运行态来源由 agent_loop run_start/run_stop 派生 → 补充订阅 `session_panel` 事件流（`session_status_update`，含 interrupting/interrupted 中间态，后端 v0.0.12 已全接好无需改）；中断按钮与 enqueue view 据此更准确刷新（权威源切 session_panel）。
- **中断（abort）**：**[v0.0.15 修订]** 中断唯一入口 `POST /session/:id/abort` body `{runId, modeKey}` → `AgentManager.abort(sid, runId, modeKey)`；manager 校验 `controller.runId === runId` → 主对话走 CAS markInterrupting + 4 步收尾（搬运工：loop 已产出数据原样保存，悬空 tool_call 协议兜底归 assemble 视图层）+ emit run_stop(interrupted)；side run（modeKey != current）跳过 4 步直接置 controller.aborted（旁路无 half-data 收尾）。**AbortController = `{runId, aborted}` 内存对象**（非 Web API），中断条件单一内存源 `controller.aborted`，loop 不读持久化 state/currentRunId；chunk 循环每 chunk 检查 controller.aborted，命中即退出。
- **usage 面板 / 手动 compact / clear（v0.0.16 新增）**：topbar 右侧挂 usage-panel（圆环占用率变色 + 「已用/总」+ expand 切换面板 4 分段进度条 + 累积消耗表格三分区行）+ compact 按钮（compress icon，三态 idle/running disabled+spinner/done，POST /compact 复用 side run 路径；[v0.0.81 修订] compact 成功后 summary 落库（role=user message），不再插 compact_notice system message / 不再渲染居中 pill）+ clear 按钮（trash icon hover danger，弹确认 modal，POST /clear 同步原子清空内容保留实体，前置 abort+markSummaryFailed）。**[v0.0.16 修订]** 自动 compact 触发算式补 `− maxOutputTokens`（remainingTokens = tokenLimit − totalTokens − maxOutputTokens）；ContextWindowUsage 7 字段全激活（assemble 读 store.getRatio 真值，不再硬编码 1.0）；cacheRate 派生字段（input_cache_read / input_total_tokens，分母 0 返 0，UI 显示百分比）。详见 §4 v0.0.16 关键用户路径 X-CC。
- **未读红点 + session_meta 广播（v0.0.27 新增，explicit-bool 模型）**：conv-item 右上角 7px `#DC2626` 红点（`unread && !active` 条件渲染，testid `conv-item-{id}-unread-dot`），数据源 = `Session.unread: boolean` 持久化存储字段（GET /session 直接返回，非派生）。**产生**（**session 层**自治，非 agent-loop、非状态机）：状态机 markIdle/markError CAS 成功 → emit `session_status_update(state→idle|error)` → **session 层**（SessionUnreadRuntime）订阅 completion 信号 → 查 `isSessionActive(sid)=false`（非前台）→ CAS `unread: false→true`（**不发 session_read_update**）。**消除**：用户进入会话 → `GET /session/:id`（纯读）+ `POST /session/:id/read`（CAS `unread: true→false` + emit `session_read_update`）。**关注点分离**：agent-loop 只调 markIdle/markError（干活），状态机纯 CAS 不感知 SSE/unread/前台，session 层自治未读+前台。**session_meta 广播 topic**（列表实时刷新）：`SessionMetaBroadcaster`（session 层 producer）在任何 session 状态/meta 变更时 emit `session_meta_update`（topic=`session_meta`，共享广播 group `_all`，payload=`SessionMetaView` 全量最新态，replayable=false）→ 列表 subscribe `(session_meta, _all)` 一次 + reducer 按 sessionId 整条替换。**三条 no-op 情形**：前台完成 / abort·interrupted·interrupting / 崩溃恢复 reconcileOnStartup 均不产生未读。详见 §4 v0.0.27 关键用户路径 EE-HH；权威 `specs/tech/agent/session/[P0]session_state.md §6` + `specs/tech/version_logs/v0.0.27/unread-model-decision.md` + `specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md`；API `specs/api/overall/04-agent-session.md §2.3/§2.3.1/§4.2`；UI `specs/ui/components/chat-page/_overview.md §4.2/§5 交互7`。
- **多智能体派生（v0.0.28 新增，parent↔subagent 派生 + a2a + 模板 + scope + subagent UI）**：parent agent 在执行任务时可经 `agent` 工具（单工具 3 action：spawn/query/abort，LLM tool call 非 HTTP）**派生 sub-agent**（隔离上下文、独立 session、隔离上下文只读探查等专项子任务），与之 **a2a 通信**（send_message，needReply 必填 + inReplyTo thread）；subagent session 是一等 session（type=subagent/parentSessionId/scope=subagent/subAgentTemplateType/origin 5 字段暴露）。**会话列表展开 subagent swarm**（parent conv-item twisty → 三段：running 列表 / 分割线「非运行中 (N)」/ terminated 灰显，indigo dot 11px rounded-3px `#3730A3` identity）+ **subagent 只读页面**（SectionChatSession readOnly mode（chrome.readOnly）：隐藏 input-bar/ClearBtn，保留 usage-panel/消息流/CompactBtn（**[v0.0.54 modified]**：subagent 必须 support compact，CompactBtn 不再隐藏）；model-tag 不可点；id-tag.id-subagent「子AGENT · 只读」）。**scope=extension point**：subagent scope 工具可见集不含 agent 工具 → 结构上不可再派生（allowedTools 白名单实现，复用 engine.ts:46-73 门控；修 v0.0.26 连线 bug：bootstrap 注入 activationStore + buildSessionConfigFromDeps 加 scope）。**D8 model 解析**：模板可带 modelId（走模板→child model=template.modelId）；自定义（inline 无 templateRef）只能 inherit parent；spawn 入参无 modelId（不可覆盖）。**模板系统**：dev_config `sub_agent_templates` 配置组（list/copy/edit/delete，builtin explorer 只读可复制衍生；预配 explorer tools=[read/web_search/web_fetch/send_message]）。**a2a 消息标记**：transcript 中 a2a 消息 `sender.source='agent'`（与 user-source 区分）。**HTTP 语义收窄**：subagent session 的 POST /messages/abort/clear 返 403 subagent_readonly（a2a deliverTo 不经 HTTP 不受影响）；**compact 例外**——subagent 必须 support compact（长跑上下文也会爆炸），不再受 readonly 限制（**[v0.0.54 modified]**，原版含 compact）。**严守范围红线**：只 multi_agent，不碰 squad/角色/团队层（后续版本）。详见 §4 v0.0.28 关键用户路径 II-QQ + `specs/prd/version_logs/v0.0.28/change_log.md`；权威 `specs/tech/multi_agent/` 五件 + `specs/tech/agent/tools/[P1]agent_tools.md` 1.0；API `specs/api/overall/{10-multi-agent.md, 10a-multi-agent-tool-ref.md}`；UI `specs/ui/components/chat-page/{_overview.md §4.2/§4.2a/§4.3/§8, component-subagent-tree.md}`。
- **a2a 协议对齐（v0.0.31 新增，inbox 中枢 + AgentRef 上下文兑现）**：兑现 v0.0.28 spec 已声明的 a2a 协议——**inbox 成为 a2a 上下文中枢**：入口 enrich（deliverTo 层反查发送方 session record 补 AgentRef.type/name + needReply 必填 + inReplyTo 透传 + ref 校验 warn）+ 出口消费（drain 透传 sender.agent + prompt assemble 渲染前缀 `[Message from <name> (<type>, needReply=<bool>)]:`）。**用户视角行为变化**：subagent 收到 a2a 消息时 prompt 里**真正看到**「这是 parent 发的、是否需回复」上下文（v0.0.28 spec 声明渲染规则但代码零渲染，v0.0.31 兑现）。**sender 严格判别联合**（按 source 分流 4 变体：user/agent/system/approval；needReply = source='agent' a2a 专属，user/system/approval 不存在此字段；user 变体落库 `{source:'user'}` 无扁平 agentName/agentId 残留）。**deliverTo 去 config 重构**（agent_manager enqueue/activate 去 config，user POST `/messages` 收敛 deliverTo）。**MessageSource enum** `'scheduled'` 并入 `'system'`（heartbeat/cron/reminder 由 system.kind 承载）。**InboxEntry 补 `enqueuedAt`**。**[KNOWN-ISSUE BUG-034]** explorer builtin 模板 systemPrompt 未引导 child 用 send_message 回复 a2a（**非协议 bug**，判别联合 + enrich + drain 透传 + 渲染前缀机制全工作；留后续版本修模板）。技术权威 `specs/tech/agent/message/[P0]agent_message_interface.md §5`（判别联合）+ `[P0]agent_inbox_enqueue.md §2.5`（enrich）+ `[P0]agent_manager.md §2-§2.4`（去 config）+ `specs/tech/multi_agent/[P1]a2a_protocol.md §4/§5`；详见 `specs/prd/version_logs/v0.0.31/change_log.md`。
- **长期记忆用户侧可见（v0.0.55 新增 / v0.0.131 承载迁移）**：session 长期记忆管理（列出当前 session 的 `session_memory.md` entry + 查看/编辑/归档/新建）**[v0.0.131]** 从 ws-panel「长期记忆」tab 迁至聊天区右上悬浮菜单弹层（见下条）；应用设置（`page-app-settings-merged`）侧边栏「全局长期记忆」group 列出 `user_memory.md`（跨 session 稳定）entry 不变。两处走 **UI 专用 HTTP 端点**（不复用 agent 的 `memory_manage` 工具——用户路径与 agent 路径正交）。技术权威 `specs/tech/agent/memory/`（memory_definition §2 user/session scope）；详见 `specs/prd/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`。
- **会话区 2 升级：历史 query minimap + 右上悬浮菜单（v0.0.131 新增，纯前端）**：① **历史 query minimap**——聊天区右缘竖排小 bar（≤10 个，对应会话中渲染为**右侧 user 气泡**的历史提问，按 message-flatten 同款 side 判定而非裸 kind——群聊 a2a inbox 靠 side 排除）+ 悬停 Dock 式梯度放大 + 左侧预览气泡（query 摘要 + 回答头部截断）+ 点击 scrollIntoView 跳转到该 query；仅定位辅助不展全文，三处 chat（playground / studio 单聊 / 群聊）统一都有。② **右上悬浮菜单**——聊天区右上竖向工具条收纳原 ws-panel「长期记忆」「定时任务」两项 → 点菜单项开对应弹层管理，弹层内「列表 ↔ 新建/编辑」走**二级视图导航（顶部返回按钮，不再弹层套弹层）**；菜单项带 badge 计数（记忆数 / active cron 数，=0 隐藏，用户 CRUD 即时刷新、agent 侧写入非实时 known-boundary）；squad 群聊隐藏「定时任务」项（cron 无主）。③ **ws-panel tab 收敛**——右侧 ws-panel tab bar 仅剩「工作区」（memory/cron tab 彻底移除，不留僵尸）。无后端 API/schema 变更（复用 `/memory/session` + `/session/:id/cron` CRUD）。UI 权威 `specs/ui/components/chat-page/{component-history-minimap.md, component-chat-float-menu.md, component-chat-right-overlay.md, component-memory-modal.md, component-cron-modal.md}`；详见 `specs/prd/version_logs/v0.0.131/change_log.md`。
- **todo 待办视图（v0.0.223 新增 / v0.0.228 实时化 + UI 收敛，session 级双层待办只读入口）**：chat 悬浮菜单加**第 4 项「待办」**（skills 下方，aria `chat:floatMenu.todo`，badge=**未完成主 item 数**）→ 弹双层树只读弹层：主 item 状态徽章 + desc + 步骤进度 N/M，**悬停主 item** 展开结构化详情（来源 source=任务/用户消息/Agent + 输出 output=文件/回复会话/回复 Agent + 备忘 memo）。**todo = 当前 session 手头双层待办**（agent 自主维护的工具数据，用户只读不编辑——与 memory/cron 的「用户 CRUD」模式不同）；**todo ≠ task**（task 是 squad 团队跨 session 工作项）。后端 = `todo` 工具（7 action free-form 5 态）+ 独立 store + `/session/:id/todos` HTTP CRUD + `[todo]` reminder 注入（每轮提醒 agent 手头进度）。**[v0.0.228 modified]** ① **SSE 实时化**：TodoStore 写成功 emit `session_todo_changed`（复用 session_panel topic）→ fanout 扇出 → badge 与已开弹层秒级自动刷新，60s 轮询退役；② **打开即最新**：每次打开弹层由弹层侧 refetch 一次；③ **尺寸响应式**（720px 档 + 92vw 兜底 + ≤88vh）；④ **hover 收敛**（仅主 item 行触发、弹层在主 item 正下方）；⑤ **done 徽章 success 绿**与 not_started 灰拉开。技术权威 `specs/tech/agent/tools/[P1]todo_tools.md` + `specs/api/overall/20-todo.md` + `specs/ui/components/chat-page/component-todo-modal.md`；详见 `specs/prd/version_logs/v0.0.223.md` §2.3/§2.6 + `specs/prd/version_logs/v0.0.228.md`。

- **@ mention 系统（v0.0.45 新增 / v0.0.86 报文重构，共享 ChatComposer + mention pill + 单字符串 content）**：全部 chat 输入区**统一使用共享 `ChatComposer` 组件**（由统一输入区 `chat-page/component-chat-session-input` 装配，身份三元组 biz/role/derivation 由 chrome 派生 → `resolveMentionProviders`）。输入 `@` 唤起 **MentionPopover**（多 tab：Files / Skills + search input + 滚动结果列表，固定尺寸，每次 20 条 cursor 分页）。**focus 管理**：唤起后 focus 在 mention search input → `Esc` 收起恢复主输入区 → 失焦也收起。**选中**（鼠标/回车）→ `@...` 替换为 **mention pill**（默认 `@` 开头，原子节点整颗删除）。**消息 content = 单字符串**（`POST /messages` body `{ content: string }`，mention 以**单行自闭合 XML tag**内嵌）；server 零处理透传——落库 / SSE / LLM prompt / 回显**同一份字符串**；前端按正则扫 tag 渲染 pill。`[v0.0.86 modified]` mention tag 改 flat 全属性 `<mention type=".." {address} {display}/>`（address = `path` / `kind`+`id` / `id`；display = `icon` / `label` / `badge?`，与 address 同串持久化；纠正 v0.0.45/v0.0.68 旧 `<mention type path/>` + path 末段推导 label 的设计）。**搜索 API**：`GET /mention/search?provider=file|skill|workitem|member&query=...&sessionId=...&limit=20&cursor=...`（响应含 `display` + `listView` 双视图，前端透传不解释）。**Provider 层**：server-side 轻量 `MentionProviderRegistry`（不挂 plugin EP），内置 `FileProvider` / `SkillProvider`（v0.0.68）/ `WorkItemProvider`（v0.0.68）/ `MemberProvider`（v0.0.68）。**全局 type 提取**：`BizType = 'playground' | 'studio'` + `SessionType = 'rocky' | 'leader' | 'mate' | 'squad' | 'subagent'`（`'rocky'` 新增 = playground 主会话）→ `app/shared/src/types/session-types.ts`，顺手收敛 5+ 处内联 union。**editor 升级**：`<textarea>` → pill-aware 编辑器（Tiptap `@tiptap/react` + `@tiptap/suggestion`；PRD 只要求 pill 节点 + 键盘交互 + focus 管理能力）。详见 `specs/prd/version_logs/v0.0.45-mention-system.md` + `specs/prd/version_logs/v0.0.86.mention_refactor.md`；§4 v0.0.45 关键用户路径；mention 子系统权威源 `specs/tech/mention/`。
- **粘贴剪切板图片（v0.0.177 新增，输入区交互扩展）**：用户在 ChatComposer 编辑器内 Cmd/Ctrl+V 粘贴**含图片**的剪切板内容 → 前端拦截 image item → POST `/session/:id/workspace/save-image` 落盘到 `<workspaceDir>/images/image-<ulid>.<ext>`（filename server 单一权威生成）→ 光标位置插 `@file` pill（path=相对 workspaceDir 的 POSIX 路径，复用既有 file mention 渲染链，下游 see_image v0.0.141 零改动可消费）。**多图顺序处理**（保 pill DOM 顺序与剪切板 items 一致），单图失败 console.warn 不阻塞其他；**非 image 文件**（如 .txt）不拦截，走 Tiptap 默认。新概念需同步落 `specs/ui/components/chat-page/chat-composer.md §粘贴图片` + `specs/api/overall/04-agent-session.md §2.6.6`。详见 `specs/tech/version_logs/v0.0.177/change_plan.md`。
- **ask-question tool + 通用 pending-tool-calls 悬挂机制 + 会话列表指示器 + workspace 绝对路径修复（v0.0.101 新增，三件合并）**：① **ask-question tool**（结构化提问：单 tool call 内多问题 = UI 多 tab；每题单选/多选 + 必带「其他」展开输入框；全答完才亮「提交」，无取消按钮；提交回填为 tool result）+ 通用悬挂机制（loop 遇悬挂型 tool → 写 pending 占位 result + 入 `pendingToolCalls` 队列 → `StopReason=tool_pending` 退出 + session=`suspended`（新第六态，落盘）→ 回填走 inbox（`tool_reply` 消息类型，复用 deliverTo）→ pre-process 按 **handleType 三分发**（direct_result / approval / callback）编辑 content block；4 情况 a/b/c/d 映射；HITL 蓝图 `agent_hitl.md` 从 `[future]` 落地 canonical + 新增 feedback 分支，ask-question 首消费者，tool-approval 未来复用）。② **会话列表 running/suspended 指示器**（playground main+subagent + studio 群聊+leader+mate；running spinner + suspended「?」；复用 `component-abort-btn` 旋转环；与 unread 红点错位共存；studio `use-studio-unread` 补提取 `running`+`state`）。③ **workspace 绝对路径修复**（bash cwd=`session.workspaceDir` 不多套层 / file `path`=绝对路径不接受相对 / reminder 告 LLM 路径与实际落盘一致；历史不迁移；studio member 同理）。**核心动机**：loop 不原地等待、能退出 → 「等待用户输入」从进程内阻塞变成跨进程/跨设备持久化状态 → 服务端部署 / 多渠道（手机+电脑）统一架构。**OUT**：tool-approval 完整审批流 + handleType=callback 实例（仅留扩展点）；提问卡草稿缓存（YAGNI）；file 沙箱 A/B 决策待用户拍板。**无设计稿 → 视觉保真度门禁跳过**。详见 `specs/prd/version_logs/v0.0.101.ask_question_tool/change_log.md`；§4 v0.0.101 关键用户路径。
- **session 名字可编辑 + AI 起名 + 名字位置/展开逻辑（v0.0.47 新增，playground 三件 UI 优化）**：① **title 可编辑**——激活 conv-item 后**再点 title 文本**进入编辑（inline 输入框预填原值），Enter/失焦 保存（`PUT /session/:id {title}`，沿用 §2.5）+ 触发 `session_meta_update` 广播（v0.0.27 列表订阅契约，**对齐 `04-agent-session.md §4.2`**）；Esc 取消；未激活 session 不可编辑（防误触）。② **AI 自动起名**——新建 session（默认名 `'新会话'`）发出**首条 query**（POST /messages 首次成功）→ 后台**并行**触发 LLM 起名（复用 session 的 provider/model，非流式 `LlmClient.call`；不阻塞主 run）→ AI 名返回时若**当前 title 仍是默认名**（用户未改）→ 应用 AI 名；**已不是默认名**（用户已改名 / 已应用过 AI 名）→ 作废不覆盖；LLM 失败静默保留默认名；**只触发一次**（后续 query 不再起名）。**「默认名 vs 已命名」区分机制 = tech spec 待定义字段**（候选 `titleSource: 'default'\|'user'\|'ai'`，title 字符串比对不可靠——用户可能改回「新会话」又改回）。**scope 限定**：仅 `bizType==='playground'` 顶层 session 起名（studio squad/leader/mate/subagent 不起名，对齐 `[P0]session_biztype.md`）。③ **名字左对齐 + 行点击展开**——conv-item **移除左侧 `conv-item-{id}-twisty` 占位**（chevronRight icon / placeholder span 全删），title 贴 conv-item 左侧；点 conv-item 行（onSelect）→ **同时**切 session + **自动展开 subagent-tree 到 running 段 + 「非运行中 (N)」分割线**（terminated 段保持折叠）；再点分割线才展开 terminated 灰显列表。**布局稳定性**（MANDATORY）：编辑态/只读态切换 + subagent-tree 展开/折叠 + 「展开系统配置」分割线 dev tabs 出现消失**绝不导致相邻元素位移**——预留固定空间 / 绝对定位吸收布局变化，禁 `display:none` 入常规流。详见 `specs/prd/version_logs/v0.0.47-ui_opt/change_log.md`；§4 v0.0.47 关键用户路径。**OUT**：studio 域 session 不起名；AI 起名不在前端显示进度提示（静默后台）；本版本无设计稿→视觉保真度门禁跳过。

- **会话列表即时排序 + playground 会话置顶（v0.0.231 新增，统一比较器 + pinned 字段）**：① **即时排序**——列表顺序 = 统一排序规则：置顶组在前、非置顶组在后，同组内按 updatedAt desc；新建/对话/置顶/meta 更新/刷新重拉任何变化列表**立即自动归位**（修复新建会话沉底、对话后位置不动），排序是常驻属性非一次性初始顺序；重排只动位置，active/unread/running/suspended/subagent 树行为不变。② **置顶（仅 playground）**——顶层 conv-item 右键菜单新增「置顶/取消置顶」（与「复制 Session ID」并列）；置顶组与非置顶组两个分组各自按时间排，无组头分隔线；置顶 item 最右侧常驻 pin 图标 + 整个背景灰色加重（走 token 禁字面 hex），active 态仍最强可辨；pinned 落盘 per session（lazy-default false 无 migration），经 `PUT /session/:id` + `session_meta` 广播多 tab 一致。**OUT**：academy/studio 列表不接置顶、排序不变；subagent 子项不置顶；无拖拽排序/组头 UI；`GET /session` 排序契约不变。详见 `specs/prd/version_logs/v0.0.231.md`；§4 v0.0.231 关键用户路径。**无设计稿 → 视觉保真度门禁跳过**。

**用户授权默认值**（不重新争论，详见 `version_logs/v0.0.8/change_log.md` §2）：无 HITL 审批 / system prompt 固定默认 / usage 不展示（内部 char 估算触发 compact）/ 自动化测试走 mock（`ROCKY_TEST_MOCK_LLM=1`），真机冒烟走 minimax/glm / 彻底替换旧 chat / dev1 `v0.0.8-agent` 分支（不开 worktree）。**[v0.0.14 注]**：accumulateUsage 已激活（后端三分区累计 + session_usage_update event 真发 + ratio 学习收敛），但「前端 UI 是否展示 usage 面板」仍是独立产品决策（v0.0.14 未引入前端 usage UI；后端 view/event 已就绪可被订阅）。**[v0.0.15 注]**：实现层对齐 spec v0.0.16 的产品语义不变（用户视角的对话/compact/abort/cancel 行为同 v0.0.13/14），仅实现机制对齐（Agent interface 统一 / controller 内存模型 / groupKey+modeKey / forkedRun 入口）；groupKey 改名 `session_id:<sid>_amt:<modeKey>` 是破坏性前端 SSE sub 协议变更（一次性改完无兼容旧 group）；compact 前端可观测性增强（可 `subscribe(sid,"summary")` 看 compact 进度，v0.0.13 前完全不 emit）。

**E2E Use Cases**（v0.0.8）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.1.10 | 点 `conv-new-btn` → 主区；删除会话 | 新建空会话选中显 `chat-empty-state`；删除则列表移除（删 active 切下一个或空态） |
| UC-3.1.11 | 发 query（mock） | user 气泡入列 → loading「思考中→生成回答」→ assistant answer 流式追加 → run_end → loading 消失 + run-finish「✓ 已完成」 |
| UC-3.1.12 | 发触发 bash 工具的 query（含跨消息边界连续多工具） | 单个折叠 tool-batch（位置连续即合并）→ tool_result 回灌绑定 → agent 续答；展开见各 item + KV 参数/结果 |
| UC-3.1.14 | run 异常（error 事件） | run-finish 错误卡片显 `run-finish-error-desc` + `run-finish-error-code` |
| UC-3.1.15 | 多轮对话超限 | 自动 compact 触发；summary 生成；对话继续无报错 |
| UC-3.1.16 | 选旧会话 → 上滑到顶 | 读最近 50 条渲染；上滑续载前插更多历史 |

### 3.2 Provider / Model 管理 [v0.0.3]（详见 `-features.md` §3.5）

在插件设置页 providers_and_models 下添加 provider（anthropic_compatible + apiKey/baseURL）、在 provider 下添加 model（选 message 协议），chat 可选该 model。详见 `-features.md`。

### 3.3 Config 三域（App / Dev / Plugin） [v0.0.3]（详见 `-features.md` §3.5–§3.7）

三域 service 落地，底经 CrudStore（v0.0.2）。详见 `-features.md`。

### 3.4 Plugin 静态内核 [v0.0.3]（详见本文）

**描述**：落地 plugin_system P0 静态内核——ExtensionPoint（llm_provider / llm_protocol，均 cardinality=list）+ Registry + PluginManager.getExtensionImpls；native 内置 plugin（llm_anthropic）启动时注册，默认 enabled。
**优先级**：P0
**用户故事**：作为框架，我希望有一个统一的扩展点机制，让 provider/protocol（以及未来的 tool/MCP）以同一套机制注册、检索、按配置投影。

**期望行为**：
- 内置 plugin `llm_anthropic`，manifest 声明 2 个 ext impl：
  - `anthropic_compatible`（point=llm_provider）：实现 `buildAuthHeaders(config) → { "x-api-key": ..., "anthropic-version": "2023-06-01" }`。
  - `anthropic_messages`（point=llm_protocol）：自承载 `path="/v1/messages"` / `contentType="application/json"` / `encode` / `parse` / `parseStream`。
- `PluginManager.getExtensionImpls("llm_provider")` 返回 active 列表（registry ∩ enabled，P0 默认全开）。
- v0.0.3 **不实现**外部插件发现/安装/origin 信任（P1）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.4.1 | 启动应用 → 检查 PluginManager.getExtensionImpls("llm_provider") | 返回含 `anthropic_compatible` 的列表（默认 enabled） |
| UC-3.4.2 | 检查 PluginManager.getExtensionImpls("llm_protocol") | 返回含 `anthropic_messages` 的列表 |

### 3.5 可观测性 + 验证 oracle [v0.0.24]

**用户故事**：作为开发者/验证者，我希望 langfuse 不只是观测后端（运维/成本），还能当**独立验证 oracle**——读 langfuse trace 断言「agent 真的对了吗」（内容对不对 / 工具结果真不真 / 多轮记全没），而不只断「agent 跑了吗」。

**期望行为（v0.0.24 范围）**：
- 提供 oracle 方法论 skill（`.claude/skills/langfuse-verification/`）+ 可复用 lib（`tests/api/lib/langfuse_verify.py` + `provider_resolve.py` + `langfuse_setup.sh`）+ 3 oracle 用例（内容一致性 / 工具结果保真 / 多轮 generation）。
- api-verifier 测完 API 后，读 langfuse trace 验内容/结果一致性（嵌入流程）。
- **不动 app 源码**（adapter v0.0.10 已够用）；**不新增 e2e 用例**（langfuse 是 server-side，e2e 截图判定不到，仅提醒）；**无设计稿**。

**关键技术约束**（影响验证用例能否跑通）：
- observability **必须**在 `app_config`（runtime/observability，v0.0.89 迁自废弃 dev_config）配置 enabled 项才记 trace——server v0.0.11+ **不读 `LANGFUSE_*` env**，空/全 disabled = Noop = oracle 无源（test env 用 `langfuse_setup.sh` 自保）。
- API 的 `providerId` = provider 配置 record 的 **`data.id`**，**不是**配置文件名（用 `provider_resolve.py` 解析）。

详见 `specs/prd/version_logs/v0.0.24/change_log.md`；技术权威源 `specs/tech/agent/observability/[P0]overall.md §10` + `specs/tech/version_logs/v0.0.24/change_log.md`。

---

## 4. 关键用户路径（MANDATORY — 测试最低覆盖要求）

每条路径至少一个 API / E2E case。verifier 不得低于此覆盖。

> v0.0.4 修订：v0.0.3 旧路径（sidebar 文字菜单 / provider 在插件页）已替换。v0.0.3 原路径 1（chat 流式）/ 路径 2（配置聚合）/ 路径 6（overlay）仍有效，作为底层回归保留（并入路径 5 / 路径 2）。

| 路径 | 链路 | 涉及环境/接口/UI | 最低 case |
|------|------|---------------------|----------|
| **路径 1：sidebar 会话导航 [v0.0.4]** | 点 sidebar「会话」图标 → `currentView=chat` → 主区切 chat view → 会话图标显激活态 | UI · sidebar 图标栏 · hover tooltip | ET（sidebar 4 图标导航 + 激活态 + tooltip） |
| **路径 2：app 设置页配 provider + model [v0.0.4]** | 点 sidebar「app 设置」→ app 设置页 → providers 区添加 provider(anthropic_compatible + apiKey) → 添加 model(选 anthropic_messages 协议) → overlay 聚合（LlmClient resolveProviderConfig deepMerge） | dev · `/provider` `/model` CRUD（handlers 不变）· app 设置页 providers 区 | AT（provider/model CRUD）+ ET（app 设置页 providers 区添加后 chat 可选） |
| **路径 3：插件页看 ext impls [v0.0.4]** | 点 sidebar「插件」→ 插件设置页 → 看 plugins + ext impls（按 EP.group='provider' 分区：anthropic_compatible + anthropic_messages）→ enabled 展示（P0 全开可切） | dev · `/config/plugin` inventory（group-centric）· 插件设置页 group 分区 | AT（inventory group-centric 返回结构）+ ET（插件页按 group 分区渲染） |
| **路径 4：sidebar 设置导航 [v0.0.4]** | 点 sidebar「app」「插件」「dev」图标 → 各切对应设置页 → 激活态视觉强调 | UI · sidebar 图标栏 | ET（路径 1 并覆盖，4 图标全切换） |
| **路径 5：chat 流式（回归 v0.0.3）** | app 设置页配好 model → 切 chat → 选 model → 发 user query → server `/chat` SSE → assistant thinking + answer 分段流式 | dev · `/chat` SSE · chat UI 气泡 + thinking 折叠 | AT（`/chat` curl SSE）+ ET（chat 流式 UI） |
| **路径 6：theme 切换（回归 v0.0.3）** | app 设置页 → appearance 区切 `theme` dark/light → 持久化 → 全局生效（含刷新首屏） | dev · `/config/app` appearance · theme token | AT（set/get theme）+ ET（切换后视觉变化 + 刷新首屏正确） |

### v0.0.8 关键用户路径 [v0.0.8]（真实 agent 对话，详见 `version_logs/v0.0.8/change_log.md` §6）

> v0.0.8 是 chat 域的主路径，覆盖优先级高于上面 v0.0.3/v0.0.4 回归路径。每条至少 1 个 AT + ET case。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 A：新建会话 → 空态 → 纯文本流式回复** | 点新建 → empty-state → 发消息 → 收纯文本流式回复 → run 结束（finish reason=正常完成） | `POST /session` · `POST /session/:id/messages` · SSE agent_loop · chat UI | AT + ET（UC-3.1.10/11） |
| **路径 B：发消息 → 调工具（bash/file）→ tool_result 回灌 → 继续回复** | 发触发工具 query → tool-batch 合并展示 → KV 参数/结果 → result 附着 call → agent 续答 | SSE tool_call/tool_result 事件 · 工具执行引擎 · tool-batch UI | AT + ET（UC-3.1.12） |
| **路径 C：run 异常 → run-finish 展示 error desc** | 发 query → error 事件 → run_end(stopReason=error) → run-finish 错误卡片显 desc + code | SSE error/run_end · run-finish UI | AT + ET（UC-3.1.14） |
| **路径 D：多轮对话 → 上下文超限 → 自动 compact → 继续** | 多轮积累 → char 超阈值 → compact → summary 生效 → assemble 含 summary → 继续正常 | ContextEngine.compact/assemble · SessionStore summary | AT + ET（UC-3.1.15） |
| **路径 E：打开旧会话 → 读最近 50 → 上滑续载** | 选旧会话 → 读最近 50 条 → 上滑到顶 → 续载前插 | `GET /session/:id/messages?limit=50&beforeId=` · transcript 分片 | AT + ET（UC-3.1.16） |
| **路径 F：连续多工具跨消息边界 → 视图层合并** | 发触发跨消息边界连续 tool_call 的 query → 合并进同一 tool-batch | tool-batch 视图层合并 · SSE tool_call 序列 | ET（UC-3.1.13） |

### v0.0.12 关键用户路径 [v0.0.12]（消息重复根治 + 排队 + 中断 + 崩溃恢复，详见 `version_logs/v0.0.12/change_log.md`）

> v0.0.12 是 chat 域的运行态/可靠性主路径。每条至少 1 个 AT + ET case。**权威设计 = `states/v0.0.12/design.md`（板块 3/5/7/9）**。无 mock（遵循 memory `no-mock-api-e2e-tests`：真 LLM + 真服务、agent 实际写数据查真落库）。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 G：running 时排队 → 逐条 drain** | run 进行中 → 连发 N 条 → `enqueue view` 显示 pending（输入框上方，`session.running === true && pending 非空` 才显示）→ agent loop eager 下轮 drain 逐条处理 → `message_start(user)` 落库后移入对话区 + 移除队列 | SSE `message_enqueued`/`enqueued_message_processed` · `POST /messages`（running 时**不返 409，入列排队**）· enqueue-view UI | AT（`POST /messages` 排队生效 + 落库顺序）+ ET（enqueue view 2 pending → 逐条移除 → 对话区出现） |
| **路径 H：中断 run** | run 进行中 → 输入框左侧红色中断按钮（`session.running === true` 才可见）→ 点 → `POST /session/:id/abort`（返 202，异步收尾）→ state `running → interrupting → interrupted` + Run `interrupted` + SSE `run_stop(stopReason=interrupted)` → run-finish 渲染「已中断」+ loading 胶囊消失 | `POST /session/:id/abort` · abort api 4 步收尾（half-data 持久化 + 补 interrupted tool_result + clear replay + state 收尾）· abort-btn / run-finish UI | AT（`POST /abort` → 202 + state→interrupted + Run=interrupted + run_stop）+ ET（点 abort-btn → run-finish「已中断」+ loading 消失） |
| **路径 I：崩溃恢复后打开 running/interrupted session** | 进程被杀（有活跃 loop 或收尾中的 session）→ 重启 → bootstrap `SessionStore.reconcileOnStartup()` 扫描 running + interrupting → markIdle + currentRunId=null + Run.status=interrupted → 打开 session 显示正确状态（**非虚假 running**） | bootstrap reconcile · `GET /session/:id`（响应含 `state`/`running`/`currentRunId`）· chat UI 状态来源 | AT（构造 running/interrupting session → 重启 → GET 断言 state=idle + Run=interrupted）+ ET（run 中切走再切回仍显示正确运行态 / 重启后打开非虚假 running） |
| **路径 J：对话区无重复（BUG-006 根治回归）** | 发 1 条消息 → 对话区仅出现 1 条 user 气泡（移除客户端乐观插入 → 消除 id 双轨制 → BUG-006 启发式去重 workaround 删除） | 对话区来源 = 服务端 SSE message_start 唯一 · `chat-slice-reducer` 删 BUG-006 去重 | AT（发 1 条 → `GET /messages` 仅 1 条 user）+ ET（发 1 条 → 对话区仅 1 条 user 气泡） |
| **路径 K：tool_call 配对（中断 in tool 执行）[硬约束]** | abort 命中 tool 执行中 → 已 ingest 的 tool_call 必有配对 interrupted tool_result → `GET /messages` transcript 合法（下次 assemble 不 400） | abort api step2 补 interrupted tool_result（悬空必补） | AT（abort in tool → `GET /messages` 断言 tool_call 有配对 interrupted tool_result） |

> **状态机五态**（设计板块 4）：`idle / running / interrupting / interrupted / error`。activate 三情况：running→enqueue（不启新 loop）/ idle·interrupted·error→新 loop / interrupting→循环等待（poll 每 100ms）。**状态转换只由 agent loop(run_end) / abort api / activate 三者设置**。

### v0.0.13 关键用户路径 [v0.0.13]（context engine 完善，详见 `version_logs/v0.0.13/change_log.md`）

> v0.0.13 是 chat 域的 context engine / 运行态可靠性主路径。每条至少 1 个 AT + ET case（适用项）。**权威设计 = `states/v0.0.13/design.md`（5 stream）**。无 mock（遵循 memory `no-mock-api-e2e-tests`）。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 L：长对话 → 自动 compact（side run）→ summary 生效 → 继续对话** | 多轮积累超阈值 → 触发 compact → side run 执行（无副作用、继承父 system、NO_TOOLS）→ summary 写入 session（summaryTask idle→running→done）→ 重新 assemble 含 summary → 继续对话正常 | ContextEngine.compact/assemble · side run · summaryTask CAS · SessionStore summary | AT（真 LLM 多轮超阈值 → 触发 compact → GET messages/summary 断言 summary 存在 + summaryUpTo 推进 + summaryTask 终态）+ ET（UC-3.1.15 重跑） |
| **路径 M：session running 中再发消息 → enqueue → 处理后清理（S5 回归）** | run 进行中 → 连发 N 条 → enqueue view 显 pending → eager drain 逐条处理 → 每条 `message_start(user)` 落库后**从排队区移除**（不再残留） | `POST /session/:id/messages`（running 入列不 409 + 返 enqueueId）· `enqueued_message_processed` event · enqueue-view reducer | AT（`POST /messages` 排队 + 真 LLM 处理后 GET messages 仅落库消息无残留 enqueue）+ ET（enqueue view 2 pending → 逐条移除 → 对话区出现） |
| **路径 N：config 页查看 / 配置 context 扩展点（S1）** | 插件设置页 → 扩展点 tab → `group-item-context`（context group）→ 看 6 个 EP（context_ingest_handler / context_assemble_mapper / context_assemble_reducer / system_prompt_mapper / system_prompt_reducer / system_reminder，全 ordered）及其 impl（rocky_context plugin 共 26 个）→ 切开关 / 拖动调序 / 改 schema 阈值 → 保存 → 对话行为按新配置生效 | `PUT /config/plugin`（setEnabled/setOrder/setImplConfig）· 扩展点 tab UI（ordered 拖拽+开关+schema 弹层） | AT（inventory 含 context group + 6 EP + 26 impl；setImplEnabled/setOrder/setImplConfig 真 LLM 行为变化）+ ET（扩展点 tab 显 context group；切开关 + 改 schema 阈值；对一新会话发触发 query 验证生效） |
| **路径 O：session 状态变化 → 前端实时收到（S4）** | session 进入 running → 前端订阅 `session_panel` 收到 `session_status_update(state=running)` → 用户点中断 → state `running→interrupting→interrupted`，前端每态收到 event 实时刷新；不依赖 agent_loop 派生 | SSE `session_panel` topic（group=`session_id:<sid>`）· `session_status_update` event · chat-slice reducer | AT（SSE 订阅 session_panel + 触发 running/interrupting/interrupted → 断言收到对应 session_status_update 序列）+ ET（中断按钮态/loading 据此刷新） |
| **路径 P：对话 usage 准确（S3）** | 发对话 → minimax 真实 wire usage 返回 → per-call 13 字段（含 cost/currency/char）校准反映真实消耗；cost 按定价计算（CNY） | minimax provider · parseAnthropicUsage · computeCost · minimax pricing record | AT（真 LLM minimax 一轮 → usage 视图断言 input/output token 合理 + cost>0 + currency=CNY + inputCharCount/outputCharCount 非零 + 无字段恒 0 异常） |
| **路径 Q：app 重启 → 残留 summary 执行中态被清理（S2 启动清理）** | compact 进行中被杀 → session 残留 summaryTask.status=running → 重启 bootstrap → 启动清理扫 summaryTask.running → 复位 idle（Run=interrupted 由 v0.0.12 reconcileOnStartup 已有）→ 打开 session 非卡死态 | bootstrap start_up reconcile · summaryTask CAS · SessionStore summary | AT（构造 summaryTask.running → 重启 → GET 断言 summaryTask.status=idle + session 非 running）+ ET（重启后打开 session 显正确非卡死态） |

### v0.0.15 关键用户路径 [v0.0.15]（Agent 实现层对齐 spec，详见 `version_logs/v0.0.15/change_log.md`）

> v0.0.15 是 chat 域的实现机制对齐主路径：用户视角行为同 v0.0.13/14，但底层机制全部对齐 spec v0.0.16（Agent interface / AgentRun / controller 内存模型 / groupKey+modeKey / forkedRun / forked 多轮 ReAct / not-allowed 门控）。每条至少 1 个 AT（真 LLM，不 mock）+ 适用项 ET。覆盖优先级高于回归路径；**回归路径 D（自动 compact）/路径 H（中断 run）/路径 K（tool_call 配对）必须重跑 PASS**（实现层机制变更可能影响）。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 R：主对话 ReAct（groupKey+modeKey 全链路）** | enqueue user → `manager.activate` 返 AgentRun(modeKey=current) → `subscribe(sid, "current")` → SSE 流式 message_* 事件（group=`session_id:<sid>_amt:current`）→ LLM 产 tool_call → tool 执行 → tool_result 回灌 → LLM 续答 → run_end | `POST /session/:id/messages` · `subscribe(sid,"current")` · SSE group=`session_id:<sid>_amt:current` · AgentEventBase.modeKey="current" | AT（enqueue+activate+subscribe 真 LLM 主对话 → 断言事件 group 含 `_amt:current` + 每事件 modeKey=current + 落库校验）+ ET（重跑 UC-3.1.11/12） |
| **路径 S：summary side run（compact 经 manager.sideRun）** | 主对话多轮超阈值 → 触发 compact → `manager.sideRun({runKind:"summary", allowedTools:[], maxIter:1, emit:true})` → 前端可 `subscribe(sid, "summary")` 看 compact 进度（group=`session_id:<sid>_amt:summary`，事件 runKind=summary）→ `await run.promise` 拿 answer → setSummary → 主对话重新 assemble 含 summary 继续正常 | ContextEngine.compact · manager.sideRun · subscribe(sid,"summary") · SSE group=`session_id:<sid>_amt:summary` | AT（真 LLM 多轮超阈值 → 触发 sideRun → subscribe(sid,"summary") 收到 run_start/message_*/run_end + answer 落地 summary + summaryUpTo 推进）+ ET（重跑 UC-3.1.15） |
| **路径 T：中断主对话（controller 内存模型 + 搬运工收尾）** | 主对话 run 进行中 → `POST /session/:id/abort {runId, modeKey:"current"}` → manager.abort(sid, runId, "current") → 校验 controller.runId === runId → CAS markInterrupting → 置 controller.aborted=true → loop chunk 循环退出（不收尾）→ abort step2 收集 loop 已产出 half-data 原样保存（不补 interrupted tool_result、不重组 partial）→ step3 clearReplay → step4 emit run_stop(interrupted) + markInterrupted | `POST /session/:id/abort` body 含 runId+modeKey · controller 内存对象 · abort 4 步搬运工 · AgentEvent run_stop | AT（abort in tool 执行中 → 202 + state→interrupted + run_stop(interrupted) + GET messages 含 loop 已产出原样数据，不加工）+ ET（重跑路径 H 中断按钮交互） |
| **路径 U：中断 summary side run（直接置 aborted，无 4 步收尾）** | summary side run 进行中 → `POST /session/:id/abort {runId, runKind:"summary"}` → manager.abort(sid, runId, "summary") → 校验 controller.runId === runId → **跳过 CAS markInterrupting**（side run 不参与五态机）→ 直接置 controller.aborted=true → side-run loop 下一检查点退出（内存 buffer 丢弃，无 half-data 持久化）→ run.promise reject → cleanupRun → 主对话不受影响 | `POST /session/:id/abort` body runKind="summary" · side-run controller · side-run loop 无收尾 | AT（summary side run 进行中 → abort(runKind:"summary") → 202 + side-run run.state=interrupted + 主对话 state 不变 + GET messages 不含 side-run 产出） |
| **路径 V：cancel 排队消息（enqueue view 清理回归）** | 主对话 run 进行中 → 连发 q1/q2 → `POST /messages` 返 enqueueId1/enqueueId2 → `POST /session/:id/messages/:enqueueId1/cancel` → loop drain 同批配对 → q1 emit `enqueued_message_canceled`（不落库）+ q2 正常 processed 落库 | `POST /session/:id/messages` · `POST /session/:id/messages/:enqueueId/cancel` · enqueued_message_canceled event | AT（enqueue q1/q2 → cancel q1 → 真 LLM 处理后 GET messages 仅含 q2 落库 + q1 不残留 enqueue + q1 不进 transcript）+ ET（重跑路径 M enqueue view 2 pending → cancel 1 → 仅剩 1） |
| **路径 W：not-allowed tool 门控（side run 自修正）** | side run allowedTools=[] 时（summary 任务），LLM 仍 tool_call → base.executeTools 拦截 → 产 not-allowed tool_result（中文「工具 '...' 在当前会话不允许调用，请仔细阅读任务说明，不要再次尝试调用该工具」）→ 喂回 LLM → LLM 下轮看到后自修正（产 text 不再 tool_call）或继续 tool_call 直至 maxIter | side run allowedTools=[] · base.executeTools 门控 · not-allowed 中文文案 | AT（side run allowedTools=[] + 构造 LLM tool_call → 断言 tool_result 文案含中文 not-allowed + LLM 下轮 text） |

> **不变量**（v0.0.15 设计自主决策汇总）：
> - **side run loop 是旁路**（默认无副作用，内存 buffer 不写 store）；side run 被中断无收尾（丢弃 buffer 即可）。
> - **中断条件单一内存源**（`controller.aborted`），loop 不读持久化 state/currentRunId。
> - **abort api 是搬运工**（不解析/不分类/不补全）；悬空 tool_call 协议合法性归 assemble 视图层（非 abort 加工）。
> - **controller chunk 循环中断**（webAbort 存 callLLM 局部作用域，controller 保持纯 `{runId, aborted}`）；fetch 等待期接受短暂延迟。
> - **side run compact 保持 maxIter=1 单次路径**（summary 任务），memory_extract 用多轮（maxIter>1）。
> - **groupKey 改名是破坏性变更**，前端 SSE sub + UT/AT + API doc 一次性改完（无兼容旧 group）。

> **已知 issue / 边界**（v0.0.15）：
> - **lazy-drain 策略类 / hitl / 多 AgentManager 实例 / memory_extract 实际任务**：均 future（taskType 字段落位但本版本只交付 summary）。
> - **工程欠债**：base 原语抽离后原 `agent-loop.ts` 拆为机制层 + 编排层；若仍超 300 行红线，后续版本继续拆。
> - 其余 v0.0.14 已知 issue（Run record per-run usage 字段 / memory+todo impl no-op / prevSnapshot 增量 append）沿用未变。

### v0.0.16 关键用户路径 [v0.0.16]（usage 可视化 + compact 完善 + clear，详见 `version_logs/v0.0.16/change_log.md`）

> v0.0.16 是 chat 域的 usage 可视化 + compact 状态完善 + clear 主路径。每条至少 1 个 AT（真 LLM，不 mock）+ 适用项 ET。**权威设计 = `reqs/v0.0.16/req.md` + `reqs/v0.0.16/mqnbr367-easy-opc-chat-v9a.html`（视觉契约）**。无 mock（遵循 memory `no-mock-api-e2e-tests`）。**回归路径 D（自动 compact）/ 路径 H（中断 run）/ 路径 K（tool_call 配对）必须重跑 PASS**。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 X：打开会话 → 见 usage 圆环 → 展开 → 见 4 分布 + 表格** | 选会话 → topbar 见圆环 + 「已用/总」→ 点 expand → 面板展开（context window 进度条 + 系统/消息/工具/输出预留 4 段图例 + 累积消耗表格） | `GET /session/:id/usage`（新增）· SSE `session_panel`/`session_usage_update` · usage-panel 组件（UsageRing/UsagePanel 等 6 子组件） | AT（GET usage 返 ContextWindowUsage 7 字段 + 三分区 + 4 cacheRate）+ ET（UC-16.1/16.2） |
| **路径 Y：多轮对话 → usage 实时更新 → 圆环颜色随占用率变** | 发消息 → LLM 返 usage → accumulateUsage → SSE 推 session_usage_update → 圆环数字 + 进度条 + 表格刷新；占用率跨阈值（<50%→50-80%→≥80%）圆环变色（sage/gold/#DC2626） | `accumulateUsage` · SSE session_usage_update · chat-slice reducer | AT（真 LLM 多轮 → SSE 收 session_usage_update 序列 + GET usage 字段非零）+ ET（UC-16.3/16.4） |
| **路径 Z：自动 compact（remaining<0）→ summary 落库 + summaryTask 事件** [v0.0.81 修订] | 多轮积累 → remainingTokens<0 → side run compact → SSE 推 summary_task_update(idle→running→done) → summary 落库（[v0.0.81] role=user message，不再插 compact_notice system message / 不再渲染 pill） | `remainingTokens<0` 触发 · side run · setSummary · `markSummaryRunning/Done` | AT（真 LLM 多轮超阈值 → GET summary 非 null + summaryTask 终态 done）+ ET（UC-16.5） |
| **路径 AA：手动 compact 按钮 → POST /compact → loading → 完成** [v0.0.81 修订] | 点 compact 按钮 → POST /session/:id/compact（202）→ 按钮 disabled+spinner → SSE summary_task_update(running→done) → 按钮恢复 + summary 落库（[v0.0.81] role=user message） | `POST /session/:id/compact`（新增）· summaryTask CAS · setSummary | AT（POST /compact → 202 + summaryTask running→done + summary 落库）+ ET（UC-16.6/16.7） |
| **路径 BB：点 clear → 确认 → POST /clear → 清空回到空会话** | 点 clear → 弹确认 modal → 确认 → POST /session/:id/clear（200）→ 对话区 empty-state + usage 归零（圆环 0/200k，表格无行）| `POST /session/:id/clear`（新增）· clearSession（清 transcript/summary/runs/usage/summaryTask/state，保留实体 + tokenLimit） · 确认 modal | AT（POST /clear → 200 + GET messages 空 + summary=初始 + usage 三分区=0 + summaryTask=idle）+ ET（UC-16.8/16.9） |
| **路径 CC：clear 时 session running → 先 abort 再 clear** | running 中点 clear → 确认 → 先 POST /abort（4 步收尾）+ markSummaryFailed（若有 compact）→ 再 POST /clear → state=idle + empty-state | `POST /abort` · `markSummaryFailed` · `POST /clear` · clearSession 原子 | AT（构造 running + 触发 clear → GET state=idle + GET messages 空 + Run=interrupted）+ ET（UC-16.10） |

> **v0.0.16 核心功能**（产品视角）：
> - **usage 面板**（topbar 右侧）：圆环（占用率变色）+ 「已用/总」+ expand 按钮；展开面板含 context window 进度条（4 分段：系统/消息/工具/输出预留）+ 累积消耗表格（三分区行 × 输入/缓存率/输出/合计）。数据契约 `GET /session/:id/usage`（初始）+ SSE `session_usage_update`（实时刷新）。
> - **compact 完善**：① 手动触发（POST /compact，复用 side run 路径）；② 状态反馈（summaryTask idle→running→done，按钮三态 + SSE 推送）；③ 消息留痕（compact 成功后 transcript 插 system message，UI 渲染居中 pill 区别于 user/agent 气泡）。
> - **clear 功能**：保留 session 实体（id/title/config 不变）+ 清空内容（transcript/summary/runs/usage/summaryTask/state），用户感知即时完成（200 同步）；前置并发清理（abort + markSummaryFailed）。
> - **BUG-001 修复**：compact_notice 实时 SSE 推送（标准 emit 序列 message_start + text_block_delta + message_end，含 metadata.kind=compact_notice，前端按 message+part key 订阅渲染）。

### v0.0.17 关键用户路径 [v0.0.17]（workspace 工作区，详见 `version_logs/v0.0.17/change_log.md`）

> v0.0.17 是 chat 域的 workspace 工作区主路径：给每个 session 配一个真实工作目录，右侧新增 ws-panel（可收起/可调宽/lazy 文件树/切换目录/刷新）+ 后端 chokidar lazy watcher + workspace reminder 接线 + 打开文件/文件夹。每条至少 1 个 AT（真 LLM，不 mock）+ 适用项 ET。**权威设计 = `reqs/v0.0.17/req.md` + `reqs/v0.0.17/mqnbr367-easy-opc-chat-v9a.html`（视觉契约 §209-242 + §706-800）**。无 mock（遵循 memory `no-mock-api-e2e-tests`）。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 DD：新建 session → 自动建 workspace → 面板显示** | 点新建 session → 后端建 `<DATA_DIR>/workspaces/<sid>` + 写 `session.workspaceDir` → 前端右侧自动显 ws-panel（路径栏 `…/workspaces/<sid>` + 空文件树）→ 发消息 → reminder 含 `Working directory: …/workspaces/<sid>` | `POST /session`（自动建 workspaceDir + 落字段）· GET tree（顶层 lazy）· ws-panel UI · workspace reminder provider（读 SessionConfig.workdir = session.workspaceDir） | AT（`POST /session` 返 workspaceDir 字段 + 目录存在）+ ET（UC-17.1 面板显示） |
| **路径 EE：切换 workspaceDir（系统 dialog → 持久化）** | 点 ws-switch-btn → 后端 spawn 原生 dialog（mac osascript / win FolderBrowserDialog / linux zenity）→ 选/建目录 → PUT /session/:id（[v0.0.139] switchDir recycle→set，不重启后端监听，前端重新 watch 新根）→ 路径栏更新 + 文件树换内容 + workspaceDir 持久化（重开仍新目录）| `POST /session/:id/workspace/pick-directory`（原生 dialog）· `PUT /session/:id`（switchDir + emit dir_changed）· SSE `session_workspace_dir_changed` · ws-file-tree reducer 重置 | AT（`PUT` 切换 + 重读 GET 持久化 + GET tree 新内容）+ ET（UC-17.9/10） |
| **路径 FF：文件树 lazy 展开/收起（depth=1 + hasChildren）** | 点 ws-item-{path}-expand twisty → 前端 GET `?parent=<relPath>&depth=1` → 子项渲染（每个 dir 含 hasChildren）；收起保留 childrenCache 不重拉；watch event 标 stale 的子目录展开时清缓存重拉 | `GET /session/:id/workspace/tree?parent=<path>`（lazy 一层）· ws-file-tree state（childrenCache / loadingChildren / stalePaths）· ws-tree-loading spinner | AT（`GET ?parent` 返该层 + hasChildren）+ ET（UC-17.x 展开 → ws-tree-loading → 子节点渲染；收起再展开用缓存） |
| **路径 GG：fs watch 推送变化 + 手动刷新兜底（BUG-017-001 回归；[v0.0.139] 懒监听）** | ws-panel 挂载 → 前端 `POST watch{path:''}` 根一层（展开某目录再 watch 该层，depth:0 非递归）→ 外部在**被监听层**touch/rm 文件 → chokidar 检测 → per-session 100ms debounce → emit `session_workspace_file_changed` → SSE 推 → 前端按展开状态分流（已展开局部 re-fetch / 未展开标 stale）→ 点 ws-refresh-btn 重置 + 按 expanded state 逐层补回（BUG-017-001 修复回归）| `WorkspaceChangeEmitter`（per-session 100ms debounce） · SSE `session_workspace_file_changed` · ws-file-tree reducer 局部刷新 · ws-refresh-btn（逐层补回） | AT（前台 session → 外部 touch → SSE 收 file_changed + GET tree 含新文件）+ ET（UC-17.12 自动出现 / UC-17.13 刷新兜底 / 刷新后已展开层补回） |
| **路径 HH：[v0.0.139] 懒监听切走回收 / 切回 GET 补回 + 重新 watch** | session A ws-panel 挂载 → `POST watch` 根 + 展开目录；切到 session B → ws-panel 卸载 → 前端 release-all（`unwatch` 无 path）+ session_panel 订阅归零 1→0 → 兜底 `recycleSession(A)` 回收 A 全部监听（释放 inotify/fd）；外部改 A 文件 → 无 SSE（监听已回收）；切回 A → GET tree（补回切走期间变化）+ `POST watch` 新根 | `SessionWorkspaceManager.releaseTab/recycleSession`（前端显式 release-all + session_panel 1→0 兜底两层回收）· 前端 `useWorkspaceWatch`（挂载 watch 根 / 卸载 release-all）· 前端切回先 GET 后 watch | AT（切走 → 外部 touch → SSE 无 event；切回 → GET tree 含外部变化）+ ET（UC-17.14） |
| **路径 II：收起/拖宽/打开文件/持久化** | 点 ws-collapse-btn → 折叠成 36px ws-rail；点 ws-expand-btn 恢复；拖 ws-resize → clamp [232,560]；hover ws-item → 点「打开」→ POST open → spawn 系统默认应用；刷新 → localStorage per session 保持宽度/收起态 | ws-panel collapsed/expanded 双态 · ws-resize-handle mousedown/mousemove/mouseup · `POST /session/:id/workspace/open`（白名单 + spawn）· localStorage per session | ET（UC-17.2 收起展开 / UC-17.3 拖宽 / UC-17.18/19 打开文件夹/文件 / UC-17.5 刷新持久化） |

> **v0.0.17 核心功能**（产品视角）：
> - **ws-panel 面板**（右侧第 3 栏）：四栏布局（nav-rail 56 + conv-panel 220 + chat-detail flex-1 + ws-panel 232-560 默认 272 / 收起 36px）；header（tab + 切换/刷新/收起 icon-btn）+ path-bar（10px mono ellipsis）+ file-tree（lazy 一层）；拖宽 clamp [232, 560]；localStorage per session 持久化宽度 + 收起态。
> - **workspace 持久化**：Session 加 `workspaceDir: string` 字段；POST /session 缺省自动建 `<DATA_DIR>/workspaces/<sid>`，body 提供时校验（abs+exists+isDir）后用该值（BUG-001 修复）；历史 session lazy 修复（GET 单时补建 + 回填）。
> - **lazy watcher**（v0.0.17 用户决策；**[v0.0.139] 重构为懒监听**）：不再「切前台=递归 watch 整个 workspace」——改为前端显式驱动：ws-panel 挂载 watch 根一层、展开目录 watch 该层、收起 unwatch、卸载/切走 release-all（+ session_panel 1→0 兜底 recycleSession）；监听单元 = chokidar `depth:0` 单目录非递归，成本与树大小解耦（`.venv` 不展开零成本，扫描风暴结构性消失）；切回前端 GET tree 补回切走期间变化 + 重新 watch；per-session 100ms debounce 防 IDE 保存风暴。详见 `specs/tech/agent/session/[P0]session_workspace_manager.md`。
> - **lazy 文件树**（v0.0.17 用户决策）：GET tree 仅返一层（depth=1）；WsTreeNode 用 hasChildren 替代 children?；展开 GET `?parent=<path>` 拉子目录 + 填 childrenCache；收起保留缓存；watch event 已展开局部 re-fetch / 未展开标 stale；手动刷新重置 + 按 expanded state 逐层补回（BUG-017-001 修复）。
> - **workspace reminder**：接线现有 workspace provider（priority 700）读 `session.workspaceDir`（链路 session.workspaceDir → SessionConfig.workdir → provider）；零新增 provider、零破 cache；下一轮 ingest 自动反映新 workspaceDir。
> - **安全**：路径白名单 resolve + realpath + startsWith(workspaceDir)（防 `../` + symlink 穿越外部），所有 GET tree parent / POST open path 都校验；越界 → 400。
> - **ET seed 端点（test-only）**：`/api/workspace/{ensure-dir,touch,ensure}` 仅供 ET seed fs，NODE_ENV=test gate（非 test → 404）。

> **不变量**（v0.0.17 设计自主决策汇总）：
> - **watcher lazy 启停**（替代初版常驻）：subscribe 启 / unsubscribe 停 / DELETE 停 / shutdown stopAll；N session 只 1 前台 watcher；chokidar 重建有延迟 → 切回 GET tree 补回兜底 + 手动刷新兜底。
> - **watch 不按子目录动态管理**：chokidar watch 整个 workspaceDir（固定一个 watcher per 前台 session），与前端展开哪些子目录无关；watch event 按展开状态分流（已展开刷新 / 未展开 stale）。
> - **文件树 lazy 加载**：GET tree 仅一层；展开按需 GET `?parent=<path>`；收起保留缓存；手动刷新重置 + 按 expanded state 逐层补回。
> - **workspaceDir 是 session 持久化真相源，workdir 是 loop 运行时快照**（解耦）：loop 启动时 `SessionConfig.workdir = session.workspaceDir`，不改 workdir 字段语义。
> - **主题默认 light**：theme-init fallback 在 GET /config/app 失败 / 未配 appearance.theme 时回落 light（对齐设计稿亮色基调）。

> **已知 issue / 边界**（v0.0.17）：
> - **跨平台 fs watch 边缘**（NFS / 远程 / 万级文件量）：不保证实时，手动刷新兜底。
> - **多 workspace tab**（设计稿预留 wsIdx 切换）：本版本仅 1 tab，UI 结构留扩展。
> - **workspace ignore glob 配置 UI**：默认 ignore `node_modules` / `.git`，不暴露配置。
> - **time provider 时分精度**：破 prompt cache，明确不做（保日期精度）。

> **不变量**（v0.0.16 设计自主决策汇总）：
> - **system 走 messages[0] role=system**（不另填 CanonicalRequest.system 字段，v0.0.13「必须注入」表述废弃）。
> - **ContextWindowUsage 7 字段全激活**（system/message/tool/total/maxOutputTokens/tokenLimit/remainingTokens）；assemble 读 `session.getRatio(sessionId)` 真值（不再硬编码 1.0）；历史数据 normalize 兜底。
> - **cacheRate 是派生值，不存 AccumulatedUsage**（cacheRate = input_cache_read / input_total_tokens，分母 0 返 0）；SessionUsageView 聚合时算 4 个（current/sub/forked/total）。
> - **compact 触发算式对齐**：`remainingTokens = tokenLimit − totalTokens − maxOutputTokens`（修原实现漏减 maxOutputTokens）。
> - **[v0.0.81 修订] compact summary 落库为 role=user message**（不再插 compact_notice system message / 不再渲染居中 pill），自动/手动共用、失败不落库。
> - **clear 是同步原子**（用户感知即时）；内部前置 abort + markSummaryFailed 避免悬空；clearSession 单事务清空；tokenLimit 保留。
> - **session 状态汇总走两路 SSE**（不新造统一视图）：GET /session 已含 state/summaryTask/usage；前端订阅 session_panel 收 session_status_update / summary_task_update / session_usage_update 三 event。

> **已知 issue / 边界**（v0.0.16）：
> - **tooltip 详细行项文案**：设计稿 CSS 占位但未渲染内容；v0.0.16 tooltip 最简实现（仅展示累积消耗合计），行项文案 future。
> - **Run record per-run usage 字段**：沿用 v0.0.14 决策 future（走 SessionUsageMeta 落盘）。
> - **lazy-drain / hitl / memory_extract 实际任务**：沿用 v0.0.15 决策 future。
> - **compact prompt 9 板块强校验 / 增量 merge compact**：v0.0.13 已声明 future，v0.0.16 沿用单 `<summary>` 简化路径 + 全量重写。
> - **api version_log**：v0.0.16 无独立 api version_log（增量直接记录在 `04-agent-session.md` §6-§9 + §10 AT 路径 R-W + §11 文件变更 + §12 版本 1.3/1.4）。

> **已知 issue / 边界**（v0.0.14）：
> - rocky_context plugin 的 `memory` + `todo` impl 注册为 builtin，但依赖（long_term_memory P1 / task_tools）缺失时**优雅 no-op**（返回空贡献，plugin 完整 + 前向兼容、config 页可见）。
> - `accumulateUsage`（session 级累计 + ratio 学习 + session_usage_update 真发 + getUsageView 真聚合）**v0.0.14 已激活**（D3.3 stretch 在 v0.0.14 落地）；ratio 学习 3 轮收敛（sliding window=3 取中位数，冷启动 fallback 1.0，实测 minimax ~0.6009）；session usage view 可用、session_usage_update event 真发。**Run record per-run usage 字段仍 future**（走 SessionUsageMeta 落盘路径）。
> - prevSnapshot 增量 append 路径未激活（性能优化 defer）。
> - 工程欠债：`agent-loop.ts` 485 行 / `session-state-machine.ts` 370 行 / `session-store.ts` 432 行 超 300 行红线（待后续版本拆分）。
> - **BUG-003（PluginManager default 注入）v0.0.14 已 fixed**（extractConfigDefaults 读 properties.{key}.default，manifest default 真注入）。详见 `states/v0.0.14/bugs/`。

### v0.0.27 关键用户路径 [v0.0.27]（session 未读红点，详见 `version_logs/v0.0.27/change_log.md`）

> v0.0.27 是 chat 域的会话列表未读提示主路径：用户离开时某些 session 跑完了，列表一眼看到红点，点进去即清除。**布尔红点，不计数；单端 electron，不多端同步。** 每条至少 1 个 AT（真 LLM，不 mock）+ 适用项 ET。**权威设计 = `reqs/v0.0.27/req.md` + 概念 spec（explicit-bool 模型，已在 tech/ui/api spec 定稿）**。无设计稿 → 视觉保真度门禁跳过（e2e 单图功能检查仍覆盖红点出现/消失 + 颜色 `#DC2626`）。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 EE：非前台完成 → 冒红点** | session A 触发 run → 切到 B（unsubscribe A 的 session_panel）→ A 完成（状态机 `markIdle`/`markError` CAS 成功 → emit `session_status_update(state→idle|error)` → **session 层**（SessionUnreadRuntime，非 agent-loop）订阅 completion 信号 → 查 `isSessionActive(A)=false` → CAS `unread: false→true`，**不发 session_read_update**）→ `SessionMetaBroadcaster` 直调 broadcast → 列表 reducer 收 `session_meta_update` 整条替换 → conv-item-A 红点实时出现 → `GET /session` A.unread=true | `POST /session/:id/messages` · 状态机 markIdle+emit · **session 层**订阅+`isSessionActive`+CAS unread · `session_meta_update` 广播 · conv-item-unread-dot UI（`#DC2626` 7px 右上角，`unread && !active`） | AT（路径 X）+ ET（UC-27.1） |
| **路径 FF：用户点带红点的 A → 红点消失** | 点击 conv-item-A → `GET /session/A`（纯读）+ `POST /session/A/read`（CAS `unread: true→false` + emit `session_read_update`）→ markRead 经 statusBus wrap 被 `SessionMetaBroadcaster` 捕获 → emit `session_meta_update`(unread=false) → 列表 reducer 整条替换 → 红点实时消失 → 响应 unread=false | `POST /session/:id/read`（新增，唯一消除入口）· `markRead` CAS · SSE `session_read_update` · `session_meta_update` 广播 · conv-item reducer | AT（路径 Y）+ ET（UC-27.2） |
| **路径 GG：前台完成不产生红点（no-op）** | 保持在 A（subscribe session_panel:A）→ A 完成（状态机 markIdle emit → **session 层**收到 completion 信号后查 `isSessionActive(A)=true` → no-op，既不置 true 也不置 false）→ `GET /session` A.unread=false | 状态机 markIdle+emit · **session 层**订阅+`isSessionActive=true` no-op 路径 | AT（路径 Z） |
| **路径 HH：abort 不产生红点** | A 触发 run → 切到 B → abort A（state→interrupted）→ abort 不算完成，**session 层**仅响应 state∈{idle,error}（markInterrupted emit 的 state 不在订阅过滤范围）→ 不触发 unread=true → `GET /session` A.unread=false | abort api 4 步 · **session 层**仅响应 idle/error（不响应 interrupted） | AT（abort 路径回归 + unread=false 断言） |

> **explicit-bool 模型核心**（概念 spec `[P0]session_state.md §6`）：`Session.unread: boolean` 是**持久化存储字段**（非派生），两个离散 timing 各写一次——**产生**（**session 层** SessionUnreadRuntime 订阅状态机 markIdle/markError emit 的 `session_status_update` completion 信号 → 查 isSessionActive 非前台 → CAS true）/ **消除**（POST /read markRead CAS false）。**关注点分离**：agent-loop 只调 markIdle/markError（干活），状态机纯 CAS 不感知 SSE/unread/前台，session 层自治未读+前台。**三条 no-op 情形**：前台完成 / abort·interrupted·interrupting / 崩溃恢复 reconcileOnStartup 均不产生未读。CAS 幂等保护（`WHERE unread=false` 产生 / `WHERE unread=true` 消除）。**session_meta 广播 topic**（实时通知列表）：`SessionMetaBroadcaster`（session 层 producer）在任何 session 状态/meta 变更时 emit `session_meta_update`（topic=`session_meta`，共享广播 group `_all`，payload=`SessionMetaView` 全量最新态，replayable=false），列表 subscribe 一次 + reducer 按 sessionId 整条替换。决策见 `specs/tech/version_logs/v0.0.27/unread-model-decision.md` §6（归属层）+ `specs/tech/version_logs/v0.0.27/session-meta-broadcast-decision.md`（广播 topic）。
>
> **OUT OF SCOPE**：未读计数（数字 badge，本版只布尔）/ 多端同步（单端 electron）/ watermark 模型（初版否决，决策见 `specs/tech/version_logs/v0.0.27/unread-model-decision.md`）。

### v0.0.28 关键用户路径 [v0.0.28]（multi-agent subagent 派生 + a2a + 模板 + scope + subagent UI，详见 `version_logs/v0.0.28/change_log.md`）

> v0.0.28 是 multi_agent 基础设施的首版：parent agent 派生 subagent + a2a 通信 + 模板系统 + scope 工具可见集 + subagent 只读 UI。**严守范围红线：只 multi_agent，不碰 squad/角色/团队层**。每条至少 1 个 AT（真 LLM ROCKY_TEST_MOCK_LLM=0，subagent 实际写数据查真落库）+ 适用项 ET。**权威 = `reqs/v0.0.28/req.md` + 概念 spec `specs/tech/multi_agent/` 五件 + `specs/tech/agent/tools/[P1]agent_tools.md` 1.0**。有设计稿 `easy-opc-squad-v10.html`（squad 外壳，仅取 subagent 相关区域 .sq-sub/.sq-subitem/.sq-divider/.id-dot.id-subagent/.id-tag.id-subagent 作视觉契约）→ 视觉保真度门禁对 subagent 区域启用（BUG-002 layout/font known-issue 待用户人工复核）。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 II：sync spawn 模板** | parent session 对话 → LLM 调 `agent(action=spawn, templateRef=explorer, mode=sync, task=...)` → 创建 explorer subagent（type=subagent/scope=subagent/隔离上下文/只读工具集）→ sync 阻塞 `await run.promise` → subagent 跑完把结果写进 final answer（needReply=false 不 send_message 回）→ parent 拿 `SpawnAgentResult.sync.answer` 继续 ReAct；usage 递归 sub 上报 parent | `agent.spawn` · createSession(type=subagent/scope) · deliverTo · run.promise · usage §6.2 | AT（spawn_sync_explorer） |
| **路径 JJ：async spawn 自定义 + inherit model** | parent 调 `agent(action=spawn, systemPrompt=自定义, mode=async)` → subagent 用 inherit parent.modelId（无 templateRef→eff.modelId=parent.modelId）→ 立即返 handle `{runId, status:running}` → subagent 完成后 `send_message(to=parent, needReply=false)` 回报结果 → parent `agent.query` 可查 | spawn async · D8 inherit · send_message 回报（sender.source='agent' 标记）· agent.query 轮询 | AT（spawn_async_inherit + send_message_reply） |
| **路径 KK：模板带 modelId** | 用户先在配置页（`sub_agent_templates` 组）copy explorer → 编辑改 modelId 存为新模板 → parent 调 `agent(spawn, templateRef=新模板, ...)` → child model = template.modelId（非 parent.modelId）→ subagent 按模板 model 跑 | app_config 模板 CRUD · D8 解析式 `eff.modelId = template?.modelId ?? parent.modelId` | AT（template_with_modelId） |
| **路径 LL：query swarm** | parent 派生多个 child（有 running 有 terminated）→ 调 `agent(action=query, filter={status?, limit?})` → 返回 children 列表（按 updatedAt 倒序，swarm 视图），可按 status 筛 running/terminated | `agent.query` list_children · 状态分组 · lastUpdatedAt 排序 | AT（query_swarm_groups） |
| **路径 MM：abort child** | parent 调 `agent(action=abort, ref=child)` → child controller 退出 → child state running→interrupted；parent 自身不受影响（单向）；parent abort 时 in-flight child 级联 abort | `agent.abort` · D6 单向级联 · state interrupted | AT（abort_child + abort_cascade） |
| **路径 NN：UI 展开 swarm** | parent 项有 subagent → 点 `conv-item-{id}-twisty` 展开 `subagent-tree` → running 段显示 → 点 `subagent-tree-terminated-toggle` 展开分割线「非运行中 (N)」→ terminated 灰显列表（opacity 0.4） | conv-item-twisty · subagent-tree 三段 · indigo dot 11px rounded-3px · terminated 灰显 | ET（UC-28.1） |
| **路径 OO：UI subagent 只读页** | 点 `subagent-item-{sessionId}` → 切到该 subagent session → SectionChatSession readOnly mode（chrome.readOnly）：**隐藏** input-bar + ClearBtn（**[v0.0.54 modified]** CompactBtn 不再隐藏——subagent 必须 support compact）；**保留** usage-panel + 消息流（subagent 左气泡 indigo identity）+ CompactBtn + topbar（subagent name + model-tag 不可点 + 子AGENT·只读 tag） | readOnly mode · 隐藏/保留清单 · id-tag.id-subagent · model-tag 不可点 | ET（UC-28.2） |
| **路径 PP：scope 结构约束** | spawn 创建 subagent（scope=subagent）→ subagent session 的 allowedTools = 全集 \ {agent} → subagent LLM 工具列表无 spawn/query/abort → **结构上不可再派生**（非 prompt 劝说） | scope=subagent · allowedTools 白名单 · engine.ts:46-73 门控 | AT（scope_no_agent_tool）+ UT（engine 门控） |
| **路径 QQ：模板管理** | 用户进配置页 `sub_agent_templates` 组 → list 看到内置 explorer → copy explorer → 改名/改 systemPrompt/改 tools/改 modelId → 保存为新模板 → parent spawn 引用新模板正常派生 | app_config 模板 CRUD · explorer builtin 只读可复制 · resolution 规则 | AT（template_crud + spawn_with_custom_template） |

> **multi_agent 核心概念**（权威 spec）：①`agent` 单工具 3 action（spawn/query/abort，LLM tool call 非 HTTP）；②subagent session（type=subagent/parentSessionId/scope=subagent/subAgentTemplateType/origin 5 字段）；③a2a send_message（needReply 必填 + inReplyTo thread + 拓扑仅可达 parent + deliverTo 统一投递，a2a 消息 sender.source='agent'）；④生命周期状态分组（running/{terminated: idle|error|interrupted}）+ D6 abort 单向级联 + terminated 重激活；⑤scope=extension point（subagent 无 agent 工具→结构不可再派生）；⑥app_config `sub_agent_templates` 模板组（builtin explorer 只读可复制；v0.0.89 迁自废弃 dev_config）；⑦D8 model 解析（模板带 modelId→走模板；自定义→inherit parent；spawn 不可覆盖）；⑧会话列表 subagent 展开树（三段：running/分割线/terminated 灰显）；⑨subagent 只读页面（SectionChatSession readOnly mode（chrome.readOnly））。决策见 `specs/tech/multi_agent/design.md` §5a（含 Bug1-4 留痕）。
>
> **OUT OF SCOPE**：squad/角色/团队层（leader/member/SquadChat/charter/RoleSpec/团队 budget/team/task/goal 工具，后续版本）/ agent_manager deliverTo 全收敛（v0.0.28 wrapper 已加，全收敛待后续）/ 工具全量 EP impl 化（未来增强）/ 跨 squad 寻址（squad 层）/ 顶层非-squad session 的 type 归属（squad 层）。

### v0.0.45 关键用户路径 [v0.0.45]（@ mention 系统，详见 `version_logs/v0.0.45-mention-system.md`）

> v0.0.45 是 mention 系统首版：三处输入区统一 ChatComposer + @ mention pill + 结构化 content + provider 搜索。每条至少 1 个 AT + ET case。**无设计稿，视觉保真度门禁跳过**。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 M1：playground @ skill → pill → 发送 → LLM 收 payload** | 输入 `@` → MentionPopover（tab: Files/Skills）→ 切 Skills → 输入关键词 → 选中 → `@query` 替换 pill → Enter 发送 → 会话区 pill → server 落库 content[] mention 节点 → LLM 收到 `<mention>` payload | ChatComposer + MentionPopover + MentionPill · `GET /mention/search?provider=skill` · `POST /messages` body `content[]` | AT（search + messages 结构化）+ ET（UC-M1） |
| **路径 M2：playground @ file → pill → 发送** | 输入 `@` → Files tab（默认）→ 搜索文件名 → 选中 → pill → 发送 → 会话区 pill | ChatComposer · `GET /mention/search?provider=file` · FileProvider 搜 session.workspaceDir | AT（search file）+ ET（UC-M2） |
| **路径 M3：studio mate 单聊 @ file → 搜索范围 = member workspace** | mate 单聊 → `@` → Files → 结果限定 member.workspaceDir | ChatComposer（bizType=studio, sessionType=mate）· server 解析 workspaceDir | AT（mate scope）+ ET（UC-M3） |
| **路径 M4：squad 群聊 @ file → 搜索范围 = team workspace** | squad 群聊 → `@` → Files → 结果限定 teamWorkspaceDir | ChatComposer（bizType=studio, sessionType=squad）· server 解析 workspaceDir | AT（squad scope）+ ET（UC-M4） |
| **路径 M5：leader 单聊 @ skill → 搜索范围 = team 可见 skill** | leader 单聊 → `@` → Skills → 结果 = leader 可见 skill 集 | ChatComposer（bizType=studio, sessionType=leader）· SkillProvider 按 sessionType 过滤 | AT（leader skill scope）+ ET（UC-M5） |
| **路径 M6：Esc 收起面板 + focus 恢复** | `@` → MentionPopover → focus search input → `Esc` → 面板收起 → focus 回主输入区 | MentionPopover 键盘交互 · focus 管理 | ET（UC-M6） |
| **路径 M7：pill 后按删除 → 整颗 pill 删除** | 插入 pill → 光标 pill 后 → Backspace → 整颗 pill 一次性删除 | ChatComposer pill 节点删除交互 | ET（UC-M7） |
| **路径 M8：历史会话回放 → pill 正确渲染** | 发含 pill 消息 → 重新打开 → `GET /messages` 返 content[] → 前端按 kind=mention 渲染 pill | `GET /messages` · 消息渲染层 pill 解析 | AT（content[] mention 节点）+ ET（UC-M8） |

> **mention 系统核心概念**：①共享 `ChatComposer` 组件（替换三处独立 textarea）；②`MentionPopover`（多 tab 搜索浮层，固定尺寸 + cursor 分页）；③`MentionPill`（原子内联节点，`@` 开头，整颗删除）；④`MessageContent[]` 结构化数组（text + mention 节点，兼容旧 string）；⑤`MentionProviderRegistry`（轻量 server-side Registry，不挂 plugin EP）；⑥`FileProvider` + `SkillProvider`（按 bizType/sessionType 解析 workspaceDir / skill 可见集）；⑦`GET /mention/search` 统一搜索 API；⑧全局 `BizType` / `SessionType` alias（新增 `'rocky'`）。
>
> **OUT OF SCOPE**：`/` `#` 触发字符（仅 `@`）/ `.gitignore` 默认开启（dev config 开关，默认关）/ 扩展 plugin system 到前端 / 第三方 mention provider 贡献机制 / manifest。

### v0.0.101 关键用户路径 [v0.0.101]（ask-question tool + 通用 pending 悬挂机制 + 会话列表指示器 + workspace 修复，详见 `version_logs/v0.0.101.ask_question_tool/change_log.md`）

> v0.0.101 三件合并：① ask-question tool + HITL 蓝图落地（agent loop 不原地等待、能退出 → 跨进程/跨设备持久化状态）；② 会话列表 running/suspended 指示器；③ workspace 工具绝对路径修复。每条至少 1 个 AT（真 LLM，不 mock）+ 适用项 ET（#2 按 UT+ET 1 case+AT 豁免）。**无设计稿，视觉保真度门禁跳过**。权威 = `reqs/[done] v0.0.101.ask_question_tool/` + 概念 spec（HITL 蓝图 `agent_hitl.md` 从 `[future]` 落地 canonical）。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 AAA：LLM 调 ask-question → 提问卡 → 逐题答 → 提交 → loop 续跑** | 发触发 query → LLM 产 ask-question tool call → 引擎识别悬挂 → 写 pending 占位 result + 入 `pendingToolCalls` → StopReason=`tool_pending` 退出 + session=`suspended`（落盘）→ emit `require_human_input` → 前端弹提问卡（多 tab 多问题）→ 用户单选/多选/「其他」展开输入 → 全答完亮「提交」→ POST /messages（`tool_reply` 消息）→ pre-process 按 handleType=direct_result 编辑 block（pending→success + 占位→真实 selections）→ 删一条 pendingToolCalls → 无 pending 续 LLM → LLM 看到答案续答 → run_end | ToolResultBlock 三态 + suspended 第六态 + PendingToolCall 落盘 + `require_human_input` SSE + `GET /pending-tool-call` + `tool_reply` 消息类型 + handleType 三分发 + 提问卡 UI（复用 enqueue-view 位置模式） | AT（P1+P5+P6）+ ET（UC-P1） |
| **路径 BBB：多 pending tool call 串行展示逐条处理** | LLM 同时产出多个悬挂 tool call（t2 需 approval + t3 需 feedback 或两个 ask-question）→ 串行生成 pending result → emit 队首 → 用户处理完第一个 → pre-process 编辑 + 删一条 → 还有则 emit 下一个 + 回 suspended → 逐条清空 → 续 LLM | pendingToolCalls 队列串行 + peek 队首单条 + 多 pending ≠ 多 tab（D4 两层不混） | AT（P2） |
| **路径 CCC：提问态用户直接发 query（= 放弃，c 路径）** | 提问态（suspended）→ 用户在 composer 输入框打 query 回车（composer 提问态不禁用）→ 关闭提问框 + user query 进 inbox → running → pre-process 检测「有 pending + 是 user query」→ **不编辑**（占位 result 保持 pending 原样）→ 清空 pendingToolCalls → 正常处理 query → LLM 看到「need_feedback 但未反馈」+ 用户新 query 自行判断 | 无取消/跳过按钮 + composer 保持可用 + 占位 result 原样发 LLM + pair 合法 | AT（P3）+ ET（UC-P3） |
| **路径 DDD：提问中切走/关 app → 重回 session 提问卡恢复** | 提问态 → 切到 session B / 关 app → 重启/切回 A → reconcile 保留 suspended + 校验落盘 → 前端 onInit GET /pending-tool-call peek 队首 + agent_loop SSE sticky replay 重渲染提问卡（题目恢复）| pendingToolCalls 落盘 + reconcile 保留 suspended + GET /pending-tool-call + useMessages onInit peek | AT（P4+P7）+ ET（UC-P4） |
| **路径 EEE：workspace 绝对路径修复** | reminder 告 LLM 工作目录 `workspaces/<id>/` → LLM 调 file write/bash 用绝对路径 → 落盘 `workspaces/<id>/a.txt`（外层，无多余 workspace 层）→ 文件 tab / reminder 路径与实际一致 | bash cwd=`session.workspaceDir` / file `path`=绝对 / 拒绝相对路径 / studio member 同理 | AT（P8+P9）+ ET（UC-P8） |
| **路径 FFF：会话列表 running spinner + suspended「?」** | session A running → conv-item-A 出现 spinner（旋转环，复用 abort-btn 视觉）；session B suspended（触发 ask-question）→ conv-item-B 出现「?」；session C idle → 都不出现；与 unread 红点错位共存；studio（群聊/leader/mate）经 session_meta 广播同步显示 | running spinner（`state∈{running,interrupting}`）+ suspended「?」（第六态）+ studio `use-studio-unread` 补提取 running/state + 透传 runningMap/stateMap | ET（UC-P10）+ UT（P10+P11） |

> **v0.0.101 核心概念**（权威 spec，arch 阶段落）：① ToolResultBlock 三态（success/pending/fail）+ pending 带 subState(need_approval/need_feedback) + data；② 通用 pending-tool-calls 机制（ask-question + tool-approval 共用，handleType 三分发 direct_result/approval/callback）；③ session `suspended` 第六态（落盘 + reconcile 保留 + session_meta 广播 + `running` 排除）；④ `PendingToolCall` 持久化 wrapper（定位/策略/渲染/载荷/编辑目标/status）；⑤ 新 StopReason `tool_pending`（通用，不复用 `require_approval`）；⑥ `Tool.interaction()`/`onReply()` 钩子取代 `needsApproval`；⑦ `require_human_input` payload 细化为单个 PendingToolCall；⑧ `tool_reply` 消息类型走 inbox（不独立接口）；⑨ `GET /session/:id/pending-tool-call` peek；⑩ transcript content block 在 LLM 首次消费前可变（占位→真实编辑）；⑪ 提问卡组件（复用 enqueue-view 位置模式 + 多 tab + 单选多选/其他/提交无取消）；⑫ running spinner + suspended「?」指示器。
>
> **OUT OF SCOPE**：tool-approval 完整审批流（allow 补跑 / deny，留后续版本）/ handleType=callback 真实扩展 tool（仅留扩展点 spec）/ 提问卡草稿前端缓存（YAGNI，后端只保证题目恢复）/ 历史 `workspaces/<id>/workspace/` 文件迁移（用户定调「历史不管」）/ file 沙箱 A/B 决策（待用户拍板）/ 视觉保真度 compare（本版无设计稿）。

### v0.0.42 关键用户路径 [v0.0.42]（session/run 两层状态分离，详见 `version_logs/v0.0.42/change_log.md`）

> v0.0.42 是 chat 域的 loading 可见性修复 + 两层状态分离主路径：修切走切回 spinner 丢失 bug（让 `run_start`/`run_end` 在 agent_loop replay buffer 粘住）+ 拆 session 层 stop 按钮（圆环）与 run 层 on-message spinner（贴流式尾部）。每条至少 1 个 AT（真 LLM，不 mock）+ 适用项 ET。**权威设计 = `reqs/v0.0.42.session_state_ui/req.md` + 概念 spec（已在 tech/ui spec 定稿）**。无设计稿 → 视觉保真度门禁跳过（e2e 单图功能检查仍覆盖 spinner 出现/消失 + 圆环减速态）。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 RR：切走切回 spinner 恢复** | 发消息 → session running（stop 按钮圆环转）→ assistant 流式 + on-message spinner 在流式尾部转（phase 随事件切 thinking→answering→...）→ **切走到别的 session → 切回 → stop 按钮仍在（sessionRunning 经 GET /session 恢复）+ spinner 仍在转**（agent_loop 重订阅 → bus 回放 sticky `run_start` → reducer runActive=true 恢复）→ `run_end` → spinner 消失 + stop 按钮消失（sessionRunning=false） | `subscribe agent_loop`（group=`session_id:<sid>_amt:current`）· bus sticky slot（`lifecyclePredicate` 命中 run_start/run_end，clearReplay 不清）· reducer `applyAgentEventToMessages` · `chat-run-spinner` UI | AT（subscribe 后第一帧含 sticky run_start）+ ET（切走切回 spinner 仍在） |
| **路径 SS：abort interrupting 减速** | running 时点 stop 按钮 → POST /abort（202 fire-and-forget）→ `session_panel` 推 `interrupting`（圆环减速 duration 2.5s）→ 推 `interrupted`（sessionRunning=false）→ stop 按钮消失 + spinner 消失（run_end）+ run-finish「已中断」 | `POST /session/:id/abort` · abort api 4 步收尾 · SSE `session_status_update`（running→interrupting→interrupted）· 圆环 `animation-duration` 按 `sessionState` 切换 | AT（POST abort → state 序列 running→interrupting→interrupted）+ ET（点 stop → 圆环减速态 → 消失） |

> **v0.0.42 两层状态核心**（概念权威源 `specs/tech/app/frontend/[P0]sse_channel.md §9.1` + `[P0]component_architecture.md §3.7`）：session 层（粗：跑/中断中/停，GET /session + session_panel）↔ run 层（细：思考/生成/调工具/执行，agent_loop）**两层严格分离**——前者驱动 stop 按钮可见性，后者驱动 on-message spinner；两层各自独立、互不耦合。replay 粘住（块 1）是后端 event-bus 改动（`lifecyclePredicate` + sticky slot + sticky-exclusive：命中事件不进 buffer 避免回放两次），前端 hook 零改动受益。详见 `specs/tech/agent/event/[P0]event_bus.md §4.3`（含 reviewer 已知权衡：硬编码 run_start replace）。
>
> **OUT OF SCOPE（v0.0.42）**：studio squad-chat 不加 loading/stop（纯轮询无 SSE，本版只保 playground + member-chat）；视觉保真度 compare 跳过（无设计稿）；UT 覆盖 replay 粘住逻辑（coder 白盒）。

### v0.0.47 关键用户路径 [v0.0.47]（playground 三件 UI 优化，详见 `version_logs/v0.0.47-ui_opt/change_log.md`）

> v0.0.47 是 playground 会话名字 + 设置入口三件 UI 优化主路径：① title 可编辑 + AI 起名（首 query 并行触发，不覆盖人起的名）；② conv-item 名字左对齐 + 行点击展开；③ 设置入口三合一（app+dev+插件 合为「应用设置」单入口；SKILLS+连接器 移到 nav 底部独立入口）。每条至少 1 个 AT + 适用项 ET。**无设计稿，视觉保真度门禁跳过**。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 TT：激活 → 点 title → 编辑 → 保存 → 列表实时刷新** | 选中 session（conv-item active）→ 点 title 文本 → 改名 → Enter 保存（`PUT /session/:id {title}`）→ 后端 updateSession + emit `session_meta_update`（沿用 v0.0.27 广播）→ 列表 reducer 按 sessionId 整条替换 → conv-item 显示新 title | conv-item 编辑态 · `PUT /session/:id`（title 字段，**对齐 `04-agent-session.md §2.5`**）· `session_meta_update` 广播 · 列表订阅 `(session_meta, _all)` | AT（PUT /session/:id title + session_meta 广播）+ ET（UC-2.1.1） |
| **路径 UU：新建 → 首 query → 并行 AI 起名 → 名字仍默认 → 应用** | 新建 session（默认名 `'新会话'`）→ 发首 query（POST /session/:id/messages）→ **后台并行**触发 LLM 起名（复用 session provider/model + `LlmClient.call` 非流式）→ 主 run 流式回答照常 → AI 名返回时 title 仍是默认名 → 应用 AI 名 → session_meta 广播 → conv-item 显示 AI 名 | `POST /session/:id/messages`（首条触发钩子）· AI 起名 service（tech spec 新增）· `LlmClient.call`（机制层复用）· `session_meta_update` 广播 · **「默认名 vs 已命名」区分机制**（tech spec 待定义字段）· bizType scope=playground | AT（AI 起名 service 触发 + 应用条件 + 广播）+ ET（UC-2.1.4） |
| **路径 VV：新建 → 首 query 期间人工改名 → AI 名返回 → 作废** | 新建 session → 发首 query（AI 起名并行触发）→ **AI 名未返回期间** 人工改名（PUT /session/:id）→ AI 名返回 → 当前 title 已不是默认名（用户已改）→ 作废不覆盖 | AI 起名应用条件 · 人工改名 vs AI 改名竞态 · `session_meta_update` 双发 | AT（AI 起名作废路径）+ ET（UC-2.1.5） |
| **路径 WW：行点击自动展开 running + 分割线** | 点 parent session 行（有 subagent）→ onSelect 同时切 session + 自动展开 subagent-tree 到 running 段 + 「非运行中 (N)」分割线可见（terminated 折叠）→ 点分割线 → terminated 段展开灰显 | conv-item 行点击触发展开 · subagent-tree 三段展开规则（running 始终 / 分割线 toggle / terminated 灰显）· `subagent-tree-terminated-toggle` | ET（UC-2.2.2 + UC-2.2.3） |
| **路径 XX：应用设置 → app tabs → 展开系统配置 → dev tabs + 插件 tab** | nav 底部点「应用设置」→ 默认看 app config tabs（如 appearance/providers）→ 点「展开系统配置」分割线 → dev config tabs + 插件 tab 显示（布局无位移）→ 点 dev tab 切到 dev 配置 → 点插件 tab 切到插件配置 | nav 底部独立入口 · 应用设置合并页 layout（ui spec 新增）· 分割线 toggle · tab 切换 · 沿用 `section-config-layout` + `page-plugin-config` 行为 | ET（UC-2.3.4 + UC-2.3.5 + UC-2.3.6 + UC-2.3.7） |
| **路径 YY：nav 底部独立点 SKILLS / 连接器 / 应用设置** | nav 底部自上而下依次点 SKILLS → 连接器 → 应用设置 → 每次切到对应 view（skill / connector / settings-app） | nav-rail 底部三独立入口（testid `nav-skill` / `nav-connector` / `nav-settings-app`，沿用 v0.0.33.1 子菜单 testid）· view id 路由 | ET（UC-2.3.1 + UC-2.3.2 + UC-2.3.3） |

> **v0.0.47 三件优化核心概念**（权威 spec）：① conv-item title 可编辑（激活态点 title 进编辑，PUT /session/:id）；② AI 起名（首 query 并行 LLM 调用 + 应用条件 + scope=playground）；③ 「默认名 vs 已命名」区分机制（tech spec 待定义 `titleSource`/`titled` 字段，PRD 不发明）；④ conv-item 移除 twisty 占位 + 行点击展开 subagent-tree；⑤ 应用设置合并页（app tabs + 「展开系统配置」分割线 + dev tabs + 插件 tab）；⑥ nav 底部三独立入口（SKILLS / 连接器 / 应用设置）替代齿轮子菜单。详见 `specs/prd/version_logs/v0.0.47-ui_opt/change_log.md` §5 对齐说明 + 新增概念清单。
>
> **OUT OF SCOPE（v0.0.47）**：studio 域 session（squad/leader/mate/studio subagent）不起名（有 member identity / 模板名）；playground subagent session 不起名；AI 起名不在前端显示进度提示（静默后台）；本版本无设计稿→视觉保真度门禁跳过；配置数据/字段零迁移（仅入口合并）。

### v0.0.231 关键用户路径 [v0.0.231]（会话列表即时排序 + playground 置顶，详见 `version_logs/v0.0.231.md`）

> v0.0.231 是 playground 会话列表排序即时化 + 置顶主路径：统一比较器（先 pinned 降序、同组内 updatedAt desc），任何变化自动归位；右键置顶/取消，两组各自时间序，置顶 item pin 图标 + 背景加重。**仅 playground**。本版为普通 feature（确定性 UI/字段透传）——不新增 AT case，UT + 既有 ET 冒烟覆盖。**无设计稿，视觉保真度门禁跳过**。

| 路径 | 链路 | 涉及 | 最低 case |
|------|------|------|----------|
| **路径 P-A：新建会话即时在顶** | 新建会话 → 看列表 | 新会话出现（非置顶组）最上面，不再沉底 | store 统一比较器 · 新建写路径 | UT + ET |
| **路径 P-B：对话即时浮上** | 旧会话发消息 → run 完成（updatedAt 推进）→ 看列表 | 该会话浮到其分组内最上面，无需刷新 | `session_meta_update` 广播 · 比较器重排 | UT + ET |
| **路径 P-C：置顶** | 右键会话 → 「置顶」→ 看分组与视觉 | 进置顶组（列表顶部）；pin 图标最右侧 + 背景加重（token）；组内时间序 | `PUT /session/:id {pinned:true}` · pinned lazy-default · conv-item pinned 视觉 | UT + ET |
| **路径 P-D：取消置顶** | 右键已置顶 → 「取消置顶」→ 看归位 | 回非置顶组按 updatedAt 归位；pin/背景复原 | `PUT /session/:id {pinned:false}` · 比较器归位 | UT + ET |
| **路径 P-E：持久化回归** | 置顶后重启 app | 置顶/非置顶分组与组内顺序保持 | pinned 落盘 · GET /session 携带 pinned | UT |

> **OUT OF SCOPE（v0.0.231）**：academy/studio 会话列表不接置顶、排序不变；subagent 树内子项不置顶；无组头/分隔线 UI、无拖拽排序、无置顶数量上限；`GET /session` 后端排序契约不变（updatedAt desc，置顶分组为前端展示层归位）；编辑态/删除/复制 Session ID/unread 红点不回归。

---

## 5. 设计决策（已与用户确认，写入 task.json keyDecisions）

### 5.1 chat 经 server SSE，key 不暴露前端 [v0.0.3]

**结论**：chat 经 server `/chat` SSE 流式。API key 仅 server 持有（读 app_config file），server 持 LlmClient 调 Anthropic Messages API。前端只发 model 选择 + messages，不接触 key。
**理由**：API key 是高敏感凭证，暴露到前端渲染层等于明文外泄；server 持有 + 流式回推是桌面应用安全的最小正确形态。
**反例**：若前端直连 Anthropic，则 key 必须下发到渲染层，且无法做请求编排/日志/限流。

### 5.2 多级配置 overlay 聚合 [v0.0.3]

**结论**：有效配置 = 代码默认（provider ExtImpl configSchema default，如默认 baseURL/headers）⊕ app_config（用户配，最高级，apiKey/baseURL 覆盖）。
- **聚合者 = LlmClient 组装层** `resolveProviderConfig: deepMerge(代码默认, app_config)`，app 覆盖。
- **config service 只存取稀疏 delta，不聚合**；消费方（LlmClient）聚合（符合 config spec §6 overlay）。
- app_config 最高级（用户权威）。
**理由**：spec §6 overlay 模型的核心是「树满数据稀疏，树来自 registry」——config 表绝不作为存在性来源。把聚合放在消费方（LlmClient），让 service 保持无业务的纯 KV 读写。

### 5.3 API key 明文存 app_config file [v0.0.3]

**结论**：v0.0.3 API key 明文存 app_config file（engine: file，v0.0.2 CrudStore 不加密）。
**安全限制（标注，非阻塞 v0.0.3）**：生产环境应走系统钥匙串（macOS Keychain / Windows Credential Manager），v0.0.3 明文是临时妥协，**后续版本必须迁移**。明文 file 文件权限应限制为当前用户可读（0600）。

### 5.4 anthropic Messages API + thinking/answer 分段 [v0.0.3]

**结论**：协议 = anthropic_messages（Messages API `/v1/messages`，SSE 流式）。anthropic extended thinking 产出独立 thinking block（与 text block 不同 index），chat 分两段显示。
**理由**：anthropic SSE 的 `index` 字段天然路由 thinking_delta 与 text_delta 到不同 content block，UI 端最自然的渲染就是按 index 分 part。

### 5.5 dev config 两 key 存配置不消费 [v0.0.3]

**结论**：`llm chunk stall timeout`(s) + `max retry times` 存 app_config（`llm_request` group；v0.0.3 曾归 DevConfig，实为 app_config 归属，v0.0.89 DevConfig 废弃后统一 app_config），chat 简化**不消费**（YAGNI for v0.0.3 验证）。
**理由**：req 明确「可以配置就行，不需要实现」。v0.0.3 只验证存取链路，消费留待 agent loop 版本。

### 5.6 布局：2 栏 + 3 设置按钮下对齐 [v0.0.3] [v0.0.4 modified]

**结论**：左窄菜单（会话区在上 + 3 设置按钮下对齐：app/plugin/dev）；右主区（chat 或设置页）。详见 §2.2。
> **[v0.0.4 modified]**：左栏已改为 ~56px 图标栏 + hover tooltip + 4 图标（会话可点击切 chat）。旧文字菜单布局见 `version_logs/v0.0.3/change_log.md`。

### 5.7 v0.0.4 UI 修订与配置归属完善 [v0.0.4]

**背景**：v0.0.3 bugs.md 反馈：sidebar 应更窄（图标化）+ hover 文字 + 会话可点击；provider/model 实例应在 app config（providers group）而非插件页；插件页应管行为主体（provider/protocol ext impls），按 group 分区；group 应是 EP 固有属性。

**5.7.1 sidebar 图标栏**：左栏 ~56px 纯图标，4 图标（会话/app/插件/dev），hover 出 tooltip 文字，会话图标可点击切 chat（修复 v0.0.3 bug），激活态视觉强调。**理由**：纯图标节省横向空间，tooltip 兼顾可发现性，会话是主入口必须可点击。

**5.7.2 provider/model UI 入口挪 app 设置页**：provider/model 实例 CRUD（app_config providers group 数据实体）UI 入口从插件设置页挪到 app 设置页新增 providers 区。**backend handlers/数据结构不变**（仅前端组件迁移）。**理由**：provider/model 是用户数据（app config 实体），UI 归属应与数据归属一致；插件页应聚焦行为主体管理。

**5.7.3 插件设置页改纯 plugins + ext impls**：插件设置页 = 管理插件 + ext impls（行为主体），按 ExtensionPoint.group 分区（provider 区下 anthropic_compatible + anthropic_messages），展示 enabled（P0 全开可切 setEnabled/setImplEnabled）。移除 provider/model 实例 CRUD（已挪 app 设置页）。**理由**：插件管理管「行为主体」（plugin/impl 实体），与「数据实例」（provider/model config）正交，分页清晰。

**5.7.4 EP.group 必填**：ExtensionPoint.group 是必填 string，每个 ext point 直接定义其 group（如 llm_provider/llm_protocol 都 group='provider'），是 EP 固有属性非可选。**理由**：group 是 UI 分区与 inventory 聚合的依据，必须在声明期确定，不能依赖运行期数据。

**5.7.5 inventory group-centric**：PluginConfigService.inventory 改按 EP.group 聚合（`{ [group]: [{ pluginId, pointId, implId, enabled }] }`），UI 按 group 分区渲染。**enabled 门不变**：plugin.enabled ∧ impl.enabled 两级。**理由**：group（展示分区）与 enabled（行为门）正交，group-centric 让 UI 分区天然由 EP 声明驱动，无需中间映射表。

**5.7.6 group 一致性原则**：config 实体 group 字段（`app_config` schema 的 `group: string required` 分片键）是 config 数据分片键 + UI 分区维度。UI 全按 group 分区，无中间映射表。**两个抽象实体（app config）= provider config + model config；两个行为主体（插件管理）= provider + protocol。**

---

## 6. 非功能需求

### 6.1 安全限制 [v0.0.3]

- API key 明文存 app_config file，文件权限 0600（当前用户可读）。**标注为已知限制**，生产迁移钥匙串。
- API key 不下发前端（chat 经 server）。
- 三个 config 文件（app/dev/plugin）落盘 `~/.rocky_agent_{env}/`（沿用 v0.0.1 三环境隔离）。

### 6.2 可测试性 [v0.0.3]

- config 三域 + provider/model CRUD 全部经 HTTP facade 暴露（`/config/{app,dev,plugin}` / `/provider` / `/model`），AT 可黑盒 curl。
- `/chat` SSE 可用 curl + `--no-buffer` 抓流验证事件序列。
- chat UI 可被 Playwright 驱动（web dev server 独立运行，沿用 v0.0.1 §5.2）。

### 6.3 风格一致性 [v0.0.3]

- 前端 token 唯一来源 `design_system.md`，theme dark/light 各自一套 CSS 变量集。
- chat 气泡、thinking 折叠、设置页表单均消费 design_system 词表，不手改 hex。

### 6.4 工程红线（沿用）

- 单文件 ≤ 300 行。
- UT 唯一合规命令 `bun run test`。
- 三环境端口/data_dir 隔离（test 3700/8787 · dev 3710/8788 · prod 3720/8789）。

---

## 7. 范围边界（IN / OUT）

### 7.1 IN SCOPE（v0.0.3 必须交付）

1. **config**：AppConfig(appearance.theme dark/light + llm_request: stall timeout/max retry) + PluginConfig(providers_and_models) service，底经 CrudStore，overlay 增量模型。（v0.0.3 曾有 DevConfig 第三域，v0.0.89 废弃并入 AppConfig。）
2. **plugin 静态内核**：ExtensionPoint(llm_provider/llm_protocol cardinality=list) + Registry + PluginManager.getExtensionImpls + PluginConfigService（P0 静态内核，native 注册默认 enabled）。
3. **llm 三件套**：llm_provider ext impl(anthropic_compatible) + llm_protocol ext impl(anthropic_messages) + providerConfig/modelConfig(app_config 数据) + LlmClient 组装。
4. **server HTTP facade**：`/chat`(SSE 流式) + `/config`(app/dev/plugin get-set) + `/provider`(crud) + `/model`(crud)；LlmClient 调 Anthropic Messages API。
5. **chat UI**：2 栏布局(左窄菜单=会话区+3 设置按钮下对齐；右主区) + 流式 user query/assistant thinking-answer + 输入框选 model 按钮 + theme 切换。
6. **设置 UI**：app 设置(appearance.theme 选项框) + 插件设置(providers_and_models: provider 列表+添加/管理 model) + dev 设置(llm request 两 key)。
7. **三层验证**：UT + AT(`/chat` `/config` `/provider` curl) + ET(chat 流式 + 设置页 Playwright)。

### 7.2 OUT OF SCOPE（v0.0.3 明确排除，含理由）

| 排除项 | 理由 |
|--------|------|
| **agent loop** | chat 简单验证 llm 配置，非完整 agent；后续版本接入。**[v0.0.8 已交付]**：见 §3.1a + `version_logs/v0.0.8/` |
| **session 持久化** | chat 前端记录最近 10 条，不落盘；req 明确要求简单实现。**[v0.0.8 已交付]**：SessionStore transcript + summary |
| **context engine / 压缩** | P1，需独立设计。**[v0.0.8 已交付]**：三接口简化版（ingest 仅存 / assemble mapper / compact 解析 summary） |
| **工具调用 tool use** | chat 简单文本+thinking，不接 tool；后续版本。**[v0.0.8 已交付]**：file（read/write/edit/glob/grep）+ bash + tool-batch 合并展示 |
| **外部插件发现/安装/origin 信任** | P1；v0.0.3 只 native 内置 plugin |
| **tokenizer** | LlmClient 可选参数，v0.0.3 简化省略（countTokens 走字符估算） |
| **API key 加密存储** | v0.0.3 明文 file，标注安全限制（见 §5.3） |

---

## 8. 验收口径

### v0.0.3 — Config + Plugin + LLM + Chat [当前]

**验收口径**：
- 三域 config service 落地，overlay 聚合模型跑通（UT + AT 覆盖路径 2 / 路径 6）。
- plugin 静态内核跑通，内置 `llm_anthropic` 默认 enabled（UC-3.4.x）。
- provider/model CRUD 经 HTTP 可用，UI 可添加（路径 4 AT + ET）。
- `/chat` SSE 流式可调通，前端 thinking/answer 分段流式显示（路径 1 AT + ET）。
- app/dev 设置可存取（路径 3 / 路径 5 AT）。
- theme dark/light 切换全局生效（路径 3 ET）。
- UT + AT + ET 三层全绿，覆盖 §4 六条关键用户路径。

**下一版本预告**：在 v0.0.3 LLM 链路上接入 agent loop / session 持久化 / 工具调用，进入完整 AI agent。

---

## 版本

version: 1.12（v0.0.45 修订：§3.1 加「@ mention 系统」条目 + §4 追加 v0.0.45 关键用户路径 M1-M8（8 条）；新概念 ChatComposer/MentionPopover/MentionPill/MessageContent/MentionProviderRegistry 需同步落 specs/ui/components/ + specs/tech/；详见 version_logs/v0.0.45-mention-system.md）。1.11（v0.0.31 修订：§3.1 加「a2a 协议对齐」条目——inbox 中枢兑现（入口 enrich + 出口 prompt 渲染前缀兑现 v0.0.28 已声明的渲染规则）+ sender 严格判别联合（needReply a2a 专属）+ deliverTo 去 config + MessageSource enum 对齐 + inbox enqueuedAt；KNOWN-ISSUE BUG-034 标注。技术权威 specs/tech/agent/message/agent_message_interface §5 + agent_inbox_enqueue §2.5 + agent_manager §2-§2.4 + multi_agent/a2a_protocol §4/§5；详见 version_logs/v0.0.31/change_log.md）。1.10（v0.0.28 修订：§3.1 加「多智能体派生」条目 + §4 追加 v0.0.28 关键用户路径 II-QQ 9 条（sync spawn 模板 / async spawn inherit / 模板带 modelId / query swarm / abort child / UI 展开 swarm / UI 只读页 / scope 结构约束 / 模板管理）；严守范围红线只 multi_agent 不碰 squad；技术权威 specs/tech/multi_agent/ 五件 + agent_tools.md 1.0 + API 10-multi-agent.md/10a + UI chat-page/{_overview §4.2/4.2a/4.3/8, component-subagent-tree.md}；详见 version_logs/v0.0.28/change_log.md）。1.9（v0.0.27 修订：§3.1 加未读红点 + session_meta 广播条目；§4 追加 v0.0.27 关键用户路径 EE-HH；explicit-bool 模型措辞改 session 层 SessionUnreadRuntime 自治）。1.8（v0.0.22 修订：prompts refine — system prompt 内容优化 + compact 结构化 + prompt 正文文件化；纯后端内容优化，用户视角行为不变；无新 API、无 UI）。1.7（v0.0.17 修订：§4 追加 v0.0.17 关键用户路径 DD-II（workspace 工作区：自动建 workspace / 切换目录 / lazy 文件树 / fs watch + 刷新兜底 / lazy watcher 切走切回 / 收起拖宽打开）+ 核心功能 + 不变量 + 已知 issue）。1.6（v0.0.16 修订：§3.1 加 usage 面板 / 手动 compact / clear 行为条 + 算式补 maxOutputTokens + cacheRate 派生；§4 追加 v0.0.16 关键用户路径 X-CC + 核心功能 + 不变量 + 已知 issue）。1.5（v0.0.15 修订：§3.1 行为条实现细节对齐 spec v0.0.16 [Agent interface + AgentRun + controller 内存模型 + groupKey+modeKey + forkedRun + forked 多轮 ReAct]；§4 追加 v0.0.15 关键用户路径 R-W + 不变量 + 已知 issue；版本 bump）。1.4（v0.0.14 修订：accumulateUsage 激活 + BUG-003 fixed；已知 issue 更新）。1.3（v0.0.13 修订：§3.1 自动 compact 改 forked agent + summaryTask 状态 + assemble plugin 驱动 / enqueue 清理 BUG-002 重开真修 / session 运行态前端来源切 session_panel；新增 v0.0.13 关键用户路径 L-Q）
version: 1.12（v0.0.42 修订：§3.1 loading 条改写——**两层状态严格分离**（session 层 stop 圆环 + run 层 on-message spinner，移除浮动胶囊 + 红方块 abort bg）+ 切走切回 spinner 恢复靠块1 replay 粘住（agent_loop bus 注入 lifecyclePredicate，run_start/run_end 写 sticky slot，clearReplay 不清，sticky-exclusive 命中事件不进 buffer）；§4 追加 v0.0.42 关键用户路径 RR-SS（切走切回 spinner 恢复 / abort interrupting 减速）。技术权威 specs/tech/app/frontend/sse_channel §9.1/§10.7 + component_architecture §3.6/§3.7 + specs/tech/agent/event/event_bus §4.3（含 reviewer 已知权衡：硬编码 run_start replace）；UI specs/ui/components/chat-page/_overview §4.10/§4.11b；详见 version_logs/v0.0.42/change_log.md。**无新 HTTP 端点**——abort/messages/session/sse 全复用现有）。1.11（v0.0.31 修订：§3.1 加「a2a 协议对齐」条目——inbox 中枢兑现（入口 enrich + 出口 prompt 渲染前缀兑现 v0.0.28 已声明的渲染规则）+ sender 严格判别联合（needReply a2a 专属）+ deliverTo 去 config + MessageSource enum 对齐 + inbox enqueuedAt；KNOWN-ISSUE BUG-034 标注。技术权威 specs/tech/agent/message/agent_message_interface §5 + agent_inbox_enqueue §2.5 + agent_manager §2-§2.4 + multi_agent/a2a_protocol §4/§5；详见 version_logs/v0.0.31/change_log.md）。1.10（v0.0.28 修订：§3.1 加「多智能体派生」条目 + §4 追加 v0.0.28 关键用户路径 II-QQ 9 条（sync spawn 模板 / async spawn inherit / 模板带 modelId / query swarm / abort child / UI 展开 swarm / UI 只读页 / scope 结构约束 / 模板管理）；严守范围红线只 multi_agent 不碰 squad；技术权威 specs/tech/multi_agent/ 五件 + agent_tools.md 1.0 + API 10-multi-agent.md/10a + UI chat-page/{_overview §4.2/4.2a/4.3/8, component-subagent-tree.md}；详见 version_logs/v0.0.28/change_log.md）。1.9（v0.0.27 修订：§3.1 加未读红点 + session_meta 广播条目；§4 追加 v0.0.27 关键用户路径 EE-HH；explicit-bool 模型措辞改 session 层 SessionUnreadRuntime 自治）。1.8（v0.0.22 修订：prompts refine — system prompt 内容优化 + compact 结构化 + prompt 正文文件化；纯后端内容优化，用户视角行为不变；无新 API、无 UI）。1.7（v0.0.17 修订：§4 追加 v0.0.17 关键用户路径 DD-II（workspace 工作区：自动建 workspace / 切换目录 / lazy 文件树 / fs watch + 刷新兜底 / lazy watcher 切走切回 / 收起拖宽打开）+ 核心功能 + 不变量 + 已知 issue）。1.6（v0.0.16 修订：§3.1 加 usage 面板 / 手动 compact / clear 行为条 + 算式补 maxOutputTokens + cacheRate 派生；§4 追加 v0.0.16 关键用户路径 X-CC + 核心功能 + 不变量 + 已知 issue）。1.5（v0.0.15 修订：§3.1 行为条实现细节对齐 spec v0.0.16 [Agent interface + AgentRun + controller 内存模型 + groupKey+modeKey + forkedRun + forked 多轮 ReAct]；§4 追加 v0.0.15 关键用户路径 R-W + 不变量 + 已知 issue；版本 bump）。1.4（v0.0.14 修订：accumulateUsage 激活 + BUG-003 fixed；已知 issue 更新）。1.3（v0.0.13 修订：§3.1 自动 compact 改 forked agent + summaryTask 状态 + assemble plugin 驱动 / enqueue 清理 BUG-002 重开真修 / session 运行态前端来源切 session_panel；新增 v0.0.13 关键用户路径 L-Q）
