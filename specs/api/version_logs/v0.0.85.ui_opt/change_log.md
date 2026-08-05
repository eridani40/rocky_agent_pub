# v0.0.85.ui_opt API Change Log

> version: 1.0 · 2026-07-07
> **无 HTTP API 契约变更**（PRD D1 决策）。

## 影响的 API 文档

无。`specs/api/overall/04-agent-session.md` 既有契约（GET /messages 分页 §3.1 / POST /session/:id/read §2.3.1 / unread 字段 §2.1）全部就绪，本版纯前端 + prompt + watcher lifecycle 修复。

## 不新增 AT case（D1）

PRD 调研结论：5 需求无 HTTP API 变更（需求 1 后端已就绪、需求 3 纯 prompt、需求 4 后端已广播、需求 2/5 无 API）→ 不新增 AT case。

## 版本

version 1.0（2026-07-07）：声明版本——5 需求合并发版，API 零变更。
