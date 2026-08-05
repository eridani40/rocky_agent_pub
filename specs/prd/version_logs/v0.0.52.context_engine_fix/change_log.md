# v0.0.52.context_engine_fix PRD 变更日志 — 内部 protocol encode 优化，零产品契约变更

## 概述

**v0.0.52 无 PRD / 产品功能变更**——本版本是 `anthropic_messages` protocol encode 的**内部 cache 策略修正**：

- prompt cache 显式 breakpoint 落点修正（bp#2 从「最后 block」改为「跨 messages 反向扫第一个非 reminder block」）。
- wire 层过滤历史 reminder（非最末 user message 的 reminder 不进 wire，最末 user message 只保留最末一个 reminder）。

**用户可见行为零变更**：
- reminder 仍由 `system_reminder_injector` 在 ingest 时注入并持久化进 transcript（context 层不变，transcript 完整性不变）。
- reminder 仍按现有产品逻辑对用户可见/隐藏（前端 `DEFAULT_BLOCK_FILTER` 块级过滤语义不变）。
- prompt cache 命中是后端 token/成本优化，对用户不可见（仅 `Usage.input_cache_read` 计费字段体现，不影响消息展示/工具调用/会话生命周期）。

## 不涉及的产品路径

v0.0.49 / v0.0.50 已确立的所有用户路径（发消息 / 工具调用 / 多轮对话 / 压缩 / squad / mention 等）行为零变更——本版本不改任何 PRD 章节的需求描述。

## 权威 spec

技术细节见 `specs/tech/agent/providers_and_models/[P0]cache_control.md`（目标契约 + §6 代码对齐核对表）+ `specs/tech/version_logs/v0.0.52.context_engine_fix/change_log.md`。

## 版本

> 本版本不改 `specs/prd/overall/`（产品功能全貌无变化）。
