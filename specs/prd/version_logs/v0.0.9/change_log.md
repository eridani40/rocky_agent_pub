# v0.0.9 PRD — 对话页打磨 + 工具可用性收尾

> 基于 v0.0.8（已含 BUG-007 encode tools 修复）。需求来源 `reqs/v0.0.9/bugs.md`。定性：bug 修复 + 小增强，无新架构模块。

## 1. 目标
完成 v0.0.8 对话页的 5 个遗留问题，使真实使用体验完整：模型选择交互正确、显示名可读、模型选择持久化、工具真实可用、中文输入法不被 Enter 打断。

## 2. 问题 → 方案 → 对齐

### #1 ModelPicker 下拉方向（向上 → 向下）
- 现状：`app/web/src/components/chat/ModelPicker.tsx` 下拉面板定位向上展开。
- 方案：改定位使面板在 trigger **下方**展开（top-full，向上空间不足时才允许翻转——v0.0.9 先固定向下）。
- 对齐：`chat-page/_overview.md §4.4`（chat-model-picker 可点开选模型，未限定方向；交互常识向下）。

### #2 model-tag 显示名（providerId → provider label）
- 现状：`section-chat-detail.tsx:67` `modelTag = \`${model.providerId}/${model.modelId}\``（显示 ULID）。
- 方案：显示「**provider label** + model 显示名」。前端用 provider label（从 /provider 列表按 providerId 查 label）；model 显示名用 model.label ?? modelId。
- 对齐：`_overview.md §4.4`（chat-model-tag 显示当前 provider/model）。

### #3 手动选 model 持久化到 session
- 现状：Session 无 provider/model 字段；POST /session/:id/messages 的 providerId/modelId 是 per-message 不持久。
- 方案：
  - Session 增 `providerId?: string` / `modelId?: string`（schema + 类型）。
  - **新增 `PUT /session/:id`**（body `{title?, providerId?, modelId?}`，校验 providerId/modelId 命中）→ 持久化。
  - `GET /session/:id` 返回 providerId/modelId。
  - `POST /session/:id/messages`：providerId/modelId 解析顺序改为 **请求体 > session 持久 > app_config 默认**。
  - 前端：选模型时 `PUT /session/:id` 保存；打开 session 用 session 持久值初始化 model-tag/picker。
- 对齐：`specs/api/version_logs/v0.0.8/change_log.md §3.2`（POST messages providerId 解析）扩展；session 持久化是新概念，落 api change_log。

### #4 工具真实可用
- 现状：v0.0.8 BUG-007 已修 `encode` 发 `tools`（**代码已在 v0.0.8-agent → 本分支**）。用户「根本没法调用」= 真机未重启 / 或全链路仍有断点。
- 方案：
  - 确认全链路：SessionConfig.tools（handler 构造 defaultTools）→ agent-loop toolDefinitions → encode 发 tools（✓）→ 真实 LLM tool_use → parse（BUG-003 ✓）→ loop 执行（✓）→ tool_result 回灌。
  - 加**集成测试**：拦截 LLM fetch，断言请求 body 含 `tools` 字段（防 encode 丢 tools 类回归）。
  - 真机冒烟由用户在 dev 做（自动化 mock 无法验证真实 LLM 是否真调——见 memory v008）。
- 对齐：`tools/overall.md`、`anthropic_impl.md`。

### #5 Enter 越过中文输入法
- 现状：`section-chat-detail.tsx:61` `if (e.key==='Enter' && !e.shiftKey) send` —— 无 IME guard。
- 方案：加 `&& !e.nativeEvent.isComposing`（+ 兼容 `e.keyCode === 229`）。IME 组词中 Enter 确认组词不发送；组词结束（compositionend）后 Enter 才发送。
- 对齐：`_overview.md §4.11`（Enter 发送，Shift+Enter 换行）补 IME 约束。

## 3. 关键用户路径（每条 ≥1 case）
- 路径A：点 model-tag → 下拉**向下**展开 → 选模型 → tag 显示「provider label + model 名」。
- 路径B：选模型 → 切走再切回 session → model 配置**已恢复**（持久化）。
- 路径C：中文输入法组词中按 Enter → **确认组词不发送**；组词后 Enter → 发送。
- 路径D（真机）：发「创建 hello.txt」→ agent **真调工具** → tool_result → 汇报。
- 路径E：POST /session/:id/messages 不带 providerId → 用 session 持久 model 跑通。

## 4. scope out
- 不动 agent loop / context engine 核心逻辑（v0.0.8 已稳定）。
- 不做多 provider 并发 / 模型热切换（YAGNI）。

## 5. 验收
- UT/AT/ET 全过（见 test-plan）+ 真机工具冒烟（用户）+ 视觉保真度不回归。
