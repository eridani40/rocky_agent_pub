# v0.0.52.context_engine_fix API 变更日志 — 无 HTTP 端点 / 契约变更

## 概述

**v0.0.52 无 API 变更**——本版本是 `anthropic_messages` protocol encode 的**内部 wire body 构造策略**修正，不暴露任何新/改 HTTP 端点、不改 request/response schema：

| 改动点 | 涉及层 | 为何无 API 变更 |
|---|---|---|
| `cache_control` breakpoint 落点（bp#2 反向扫非 reminder block） | LLM 出站 wire body（rocky → Anthropic/volcengine/minimax） | 这是 rocky **发往上游 LLM 厂商**的 wire body 内部字段，**不是 rocky 对客户端暴露的 HTTP 端点**；客户端（前端/AT）从不直接观察 `cache_control` 字段 |
| wire 层过滤历史 reminder | LLM 出站 wire body | 同上——reminder 块在 ingest 时仍持久化进 transcript（context 层不变），客户端经 `GET /session/:id/messages` 读到的 transcript 形态零变化 |
| reminder wire 过滤 + cache 命中 | rocky 出站 → 上游 LLM | 对 rocky 自身暴露的 `POST /session/:id/messages` / `GET /sse` / `GET /session/:id/messages` 等端点的 request/response schema 零影响 |

## 复用端点（全部既有，零变更）

- `POST /session/:id/messages`（[v0.0.12] 入列 enqueue）—— 发消息。
- `GET /session/:id/messages?limit=50&beforeId=`—— transcript 拉取（reminder 块仍持久化、仍按现有过滤语义返回，零变化）。
- `GET /sse` SSE 流（`agent_loop` / `session_panel` / `session_meta` topic）—— 帧格式 + AgentEvent 联合类型零变化。
- `POST /session/:id/abort`（[v0.0.12] / [v0.0.15]）—— stop。

## 唯一可观测差异（非契约变更）

LLM usage 事件中的 `input_cache_read` token 数会上升（cache 命中率改善）——这是既有 `Usage` 字段（[v0.0.13] 起就有 cache 拆分）的值变化，**不是新字段 / 新语义**。客户端若展示 token 统计会看到 cache 命中数变多，但这是性能改善，非契约变更。

## 权威 spec

技术细节见 `specs/tech/agent/providers_and_models/[P0]cache_control.md`（目标契约）+ `specs/tech/version_logs/v0.0.52.context_engine_fix/change_log.md`。

## 版本

> 本版本不改 `specs/api/overall/`（API 全貌无变化）。
