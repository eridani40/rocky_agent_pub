---
title: 调研 2 — ET case 全量盘点
type: research-finding
feature: et_refactor
updated: 2026-07-13
---

# 调研 2：ET case 全量盘点

## 总览

**46 case**，13 模块。按迁移动作汇总：

| 动作 | 数量 | 说明 |
|------|------|------|
| **迁**（迁到新框架，保留语义） | 39 | 1:1 迁到 case.yaml，step 拆分（js: fetch → requests；js: 等待 → wait/poll；dom 断言保留） |
| **并**（多 case 合一） | 5 → ~3 | 合并语义重叠的 case（如 approval 3 card 合并为 2 个 multi-path case） |
| **弃**（删除/降级为 UT） | 2 | 纯视觉对齐类（compare-only，新框架用 compares[] 保留或转 selftest） |

## 按模块盘点（46 → 预计 39 case 迁后）

### chat (12 case → 11 迁)

| 旧 case | llm | vision | dom | compare | 动作 | 新 case.yaml 要点 |
|---------|-----|--------|-----|---------|------|-------------------|
| `model_picker_input_bar` | any | 3 | 9 | 0 | 迁 | UI 交互 step（navigate/click/type）+ requests（GET provider/model list）|
| `conv_item_state_tc1` | none | 0 | 15 | 0 | 迁 | 纯 dom 断言（state 变化），无 LLM；setup 建 session 走 requests |
| `chat_basic_tc1` | any | 0 | 7 | 0 | 迁 | 发消息基础流：requests POST /messages → wait agent_loop → dom 验消息渲染 |
| `usage_panel_format_tc1` | any | 0 | 11 | 0 | 迁 | requests POST /messages → wait session_usage_update SSE → dom 验 usage 文本 |
| `bubble_dual_source_switch_tc1` | real | 0 | 7 | 0 | 迁 | 多 LLM 切换：requests 改 provider → 重发 → dom 验气泡 |
| `ws_panel_collapse_tc1` | off | 0 | 11 | 0 | 迁 | 纯 UI（折叠面板），无网络；click + dom 验折叠态 |
| `ask_question_card` | real | 0 | 16 | 0 | 迁 | 复杂：ask_question 工具 → SSE 事件 → card 渲染；requests + wait + dom |
| `chat_pagination_scroll_tc1` | mock | 0 | 9 | 0 | 迁 | mock LLM 大量消息 → 滚动加载；新框架 record 1 次 LLM 调用回放 |
| `abort_run_finish_tc1` | off | 0 | 6 | 0 | 迁 | run 中断：requests POST /messages → wait running → requests POST /abort → wait interrupted |
| `chat_clear_tc1` | real | 0 | 10 | 0 | 迁 | 清空会话 UI 流；setup 建 session 走 requests |
| `enqueue_mention_pill_tc1` | off | 0 | 4 | 0 | **并→** `enqueue_combined` | 与 enqueue_tc1 合并（同队列渲染） |
| `enqueue_tc1` | off | 0 | 6 | 0 | **并→** `enqueue_combined` | 同上 |

### studio (13 case → 12 迁 + 1 弃)

| 旧 case | llm | vision | dom | compare | 动作 | 新 case.yaml 要点 |
|---------|-----|--------|-----|---------|------|-------------------|
| `board_edit_tc1` | none | 0 | 11 | 0 | 迁 | board 编辑：setup POST /squad → navigate → click board → edit → dom |
| `board_interaction_tc1` | none | 0 | 13 | 0 | 迁 | board 交互链 |
| `autowork_heartbeat_config_tc1` | none | 0 | 25 | 0 | 迁 | 配置面板 + heartbeat 流 |
| `member_model_hover_default` | any | 0 | 8 | 0 | 迁 | hover 触发 model 默认值显示 |
| `member_skills_tc1` | any | 0 | 17 | 0 | 迁 | skills 列表渲染（GET） |
| `member_skills_visual` | none | 5 | 6 | 0 | 迁（vision 保） | 视觉检查 skills 渲染；vision_checks 转 case.yaml vision_check step |
| `cross_squad_member_click_tc1` | any | 0 | 11 | 0 | 迁 | 跨 squad 点击 member |
| `member_panel_sections` | any | 0 | 10 | 0 | 迁 | member panel 分区渲染 |
| `board_archive_zone_tc1` | none | 0 | 10 | 0 | 迁 | archive zone 显示 |
| `studio_sidebar_visual_align_tc1` | none | 4 | 3 | 0 | **弃**（→compares） | 纯视觉对齐，dom 断言少；转 selftest 或 compares[] 视觉回归 |
| `studio_unread_red_dot_tc1` | any | 2 | 8 | 0 | 迁 | 未读红点 SSE 推送渲染 |
| `board_at_jump_member_chat_tc1` | any | 0 | 9 | 0 | 迁 | @ 跳转 member chat |
| `team_delete_flow_tc1` | none | 0 | 9 | 0 | 迁 | team 删除流；setup POST → delete → dom 验 |

### config (5 case → 5 迁)

| 旧 case | llm | vision | dom | compare | 动作 | 新 case.yaml 要点 |
|---------|-----|--------|-----|---------|------|-------------------|
| `appearance_merged` | any | 0 | 8 | 1 | 迁 | config 保存 + compares 视觉保真（有设计稿）|
| `provider_independent_save` | any | 0 | 7 | 1 | 迁 | 同上 |
| `request_settings` | any | 0 | 8 | 1 | 迁 | 同上 |
| `web_search_provider_switch` | replay | 0 | 28 | 0 | 迁 | provider 切换；llm=replay 已对齐 AT 模式 |
| `tab_switch_save_cancel` | any | 0 | 14 | 1 | 迁 | tab 切换 UI |

### sse_channel (5 case → 5 迁)

| 旧 case | llm | vision | dom | compare | 动作 | 新 case.yaml 要点 |
|---------|-----|--------|-----|---------|------|-------------------|
| `sse_single_channel_persistent` | none | 0 | 7 | 0 | 迁 | SSE 单通道持久化；wait step 验事件序列 |
| `studio_member_messages_render` | any | 0 | 7 | 0 | 迁 | member 消息渲染（SSE 推送）|
| `squad_no_polling` | none | 0 | 7 | 0 | 迁 | 验 squad 不轮询（订阅 SSE 而非 GET poll）|
| `squad_chat_usage_live_tc1` | any | 0 | 6 | 0 | 迁 | usage live 更新（req.md backlog 提到的 budget cache 缺失此 case 难测）|
| `multi_component_subscribe` | any | 0 | 8 | 0 | 迁 | 多组件订阅同一通道 |

### approval (3 case → 2 并 + 1 弃合并)

| 旧 case | llm | vision | dom | compare | 动作 | 新 case.yaml 要点 |
|---------|-----|--------|-----|---------|------|-------------------|
| `approval_card_allow_tc1` | replay | 0 | 14 | 0 | **并→** `approval_card_allow_deny`（与 AT `approval_allow_deny` 对齐） | allow + deny 双路径合一，setup 建 2 session，并行断言 |
| `approval_card_deny_tc1` | replay | 0 | 13 | 0 | **并→** 同上 | 同上 |
| `approval_card_recover_tc1` | replay | 0 | 12 | 0 | 迁 | recover 路径独立 case（语义不同：deny 后允许重审）|

### 其他模块（11 case → 11 迁）

| 模块 | case | llm | dom | 动作 |
|------|------|-----|-----|------|
| sidebar | `sidebar_nav_tc1` | none | 10 | 迁（含 1 vision_check：nav 视觉）|
| channel | `channel_page_tc1` | none | 15 | 迁 |
| connector | `connector_page_tc1` | none | 9 | 迁（含 3 vision_check：渲染视觉）|
| mention | `mention_flow_tc1` | any | 18 | 迁（@ mention 触发）|
| i18n | `locale_switch_tc1` | none | 16 | 迁（含 8 vision_check：多语言视觉对比）|
| memory | `memory_ui_tc1` | none | 19 | 迁 |
| skill | `skill_nav_tc1` | none | 10 | 迁 |
| skill | `skill_page_tc1` | none | 14 | 迁 |

## llm_mode 分布（迁移影响）

| mode | 数量 | 迁移策略 |
|------|------|---------|
| `none`/缺失 | 16 | 无 LLM 调用，纯 UI/API；case.yaml 不写 `stub: [llm]` |
| `any` | 15 | 用任意 provider；record 轮录，replay 回放；case.yaml 写 `stub: [llm]` |
| `replay` | 4 | 已是 AT 模式（approval 3 + web_search_provider_switch）；直接对齐 |
| `off` | 5 | 显式禁 LLM（如 abort/ws_panel）；setup 不触发 run |
| `real` | 2 | bubble_dual_source_switch / ask_question_card；可能要保 live 模式 |
| `mock` | 1 | chat_pagination_scroll；改 record 一次 LLM 回放 |

## vision_checks / compares 迁移统计

- **vision_checks 有内容**：8 case（sidebar_nav=1, model_picker=3, connector=3, i18n=8, member_skills_visual=5, studio_sidebar_visual=4, studio_unread=2, 共 ~26 vision check）
- **compares 有内容**：4 case（config 4 个，每个 1 compare；有设计稿）
- **迁移规则**：
  - vision_checks → case.yaml `vision_check` step（按需，遵循 v0.0.100 dom 主判定模型，纯功能 case 不写 vision）
  - compares → case.yaml `compares[]` 字段（保留，run_all 自动跑 `vision_check.py compare`）

## 迁移工作量估算

按迁移难度（旧 case 的复杂度 / SSE 等待 / 多 session）分级：

| 难度 | 数量 | 估算 | 说明 |
|------|------|------|------|
| 简单（纯 UI click+dom，无 SSE） | ~20 | 0.5h/case | sidebar/channel/connector/memory/skill 大部分 + studio 编辑类 |
| 中等（含 requests + SSE wait） | ~18 | 1h/case | chat 系列 + sse_channel 系列 + config |
| 复杂（多 session / 并行 / 多 LLM） | ~6 | 2h/case | approval 合并 + ask_question_card + bubble_dual_source + 多 squad 交互 |
| 弃/降级 | 2 | 0.2h | studio_sidebar_visual_align（转 compares）+ 1 个候选 |

**总估算**：约 50-60 工时（迁 39 case）。建议拆 task：按模块分批（chat/sse_channel 最重，独立 task；其他模块合 task）。

## 迁移映射要点（旧 → 新 step 转换）

| 旧 checkpoint 字段 | 新 case.yaml step | 说明 |
|--------------------|-------------------|------|
| `action: goto:URL` | `navigate: URL` 或 step 内 `navigate: { url }` | step 类型标准化 |
| `action: click:SEL` | `click: { selector }` | 内置 auto-wait（替代 `wait_ms`）|
| `action: type:SEL TEXT` | `type: { selector, text }` | 同上 |
| `action: press:KEY` | `press: { key }` | 同上 |
| `action: js:CODE` | 尽量拆为 `requests`/`click`/`type`；保留 `js_eval` step 兜底 | **关键**：旧 case 大量内嵌 js: fetch+轮询，需拆解 |
| `action: drag:SRC DST` | `drag: { src, dst }` | HTML5 DnD |
| `action: hover:SEL` | `hover: { selector }` | hover |
| `wait_ms: N` | （框架内置 auto-wait）| 禁显式 sleep |
| `dom_asserts` | `check: [ ... ]`（AT 同款原子断言）| 表达式语义对齐 AT check_engine |
| `vision_checks` | `vision_check: { checks }` step（按需）| dom 主判定不变 |
| `compares[]` | `compares: [...]`（顶层）| 视觉保真声明 |
| `llm_mode: replay/record/off` | case 顶层 `mode` 由 run_all 外部传（对齐 AT）| MODE 归执行层 |
| 顶层 `env: { KEY: VAL }` | 同名保留 | env 注入 |

## 边界

- 未深挖每个 case 的具体 step 数（仅看 action/dom/vision/compare 字段分布）
- 弃的 2 case 是基于「vision 主 / dom 少」的粗判，实际迁移时可能保为 compares-only case（视觉回归）
- 并的 5 case（approval 3→2 + enqueue 2→1）的目标 case 数是粗估，designer 阶段定夺
