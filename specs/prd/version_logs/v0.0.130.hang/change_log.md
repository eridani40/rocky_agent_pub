# v0.0.130.hang PRD 变更 — 工具执行阶段外显（P6 用户可见行为）

> 本版本主体是 agent hang 后端修复（技术权威 `specs/tech/version_logs/v0.0.130.hang/change_log.md`）；PRD 侧只有一处用户可见变化：chat loading 的工具执行阶段外显。

## 03-llm-chat.md §3.1（loading 条 [v0.0.130.hang modified]）

**问题**：以往 chat 的 on-message spinner 只有在 `tool_result_start`（工具**结果**开始返回）到达时才切到 `tool_executing` 阶段。工具卡死/hang 时结果永不返回 → UI 永停在「思考中」，用户看不出卡在哪、也不知道 agent 是否还活着。

**改动（用户可见）**：
- 工具执行**一开始**（SSE `tool_execution_start`，早于结果返回）即切 `tool_executing` 阶段，显示「运行工具: `<tool 名>`」（如「运行工具: bash」，i18n `loading.toolExecutingNamed`，中英双语）。用户能区分「LLM 思考中」vs「正在执行某个具体工具」。
- 停止原因（stopReason）继续走现有 run-finish 外显（`max_iterations`/`doom_loop`/`error`/中断/`tool_pending` 已覆盖）。
- 工具超时以 `[timeout] <tool> exceeded <ms>ms` tool_result（isError）在 tool batch 内呈现，loop 续跑（非 stopReason）——LLM 读到统一超时标记可自行处理。

## 关键用户路径（补充）

- **路径 HANG：工具执行阶段可见** — 发 query → LLM 返回工具调用 → SSE `tool_execution_start` → spinner 显「运行工具: bash」（不再假「思考中」）→ 结果返回 / 超时 → tool_result 呈现 → loop 续跑或 run-finish。

> 无新 HTTP 端点、无新页面（复用现有 chat SSE + loading-status 组件）。无设计稿 → 视觉保真度门禁跳过。
