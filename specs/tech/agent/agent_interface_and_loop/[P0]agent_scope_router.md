---
type: spec
title: Agent Scope Router（v0.0.204 废止：scopeId = canonicalId 纯拼接）
priority: P0
status: superseded
updated: 2026-07-24
since: v0.0.40
---

# Agent Scope Router — v0.0.204 废止

> **v0.0.204 起本文废止**。`AgentScopeRouter`（`app/server/src/agent/agent-scope-router.ts`）整文件删除。
> 替代：**scopeId = `SessionKind.canonicalId()` 纯字符串拼接**（零路由表、零决策逻辑），单行函数 `scopeIdOf(kind)`（`app/server/src/agent/scope-id.ts`）。所有用到的 scope 组合在 `app/plugins/scopes/` 全量配 yaml 文件（空文件 = 沿 extends 链继承）。
> 概念权威：`../session/[P0]session_kind.md §2`（canonicalId）+ `../session/[P0]session_type_profile.md §2/§5`（scopeId 拼接 + scope 文件矩阵 + extends 链式回退）。

## 废止要点（历史对照）

| 旧（v0.0.40-v0.0.183） | 新（v0.0.204 终版） |
|---|---|
| `AgentScopeRouter.resolve(modeKey, kind?)` 硬编码路由表 | `scopeIdOf(kind) = kind.canonicalId()` 纯拼接 |
| Min 方案：current 恒 default；forked 恒 forked | 每类型每 runKind（main/summary/consolidate）各一 scope 文件 |
| Granular：academy-coach/student 两 scope + subagent 一律 forked（academy 已于 v0.0.208 删除，仅留历史对照） | 全组合显式文件；subagent 各类型独立 scope（偏差#5 修正，见 session_type_profile.md §9） |
| modeKey 自由 string（current/summary/memory_extract） | modeKey 字段退役；runKind 扁平闭合枚举（main/summary/consolidate）并入身份键 |
| forked / ForkedContextPort / ForkedLifecyclePort / MUTED_BUS | forked 命名彻底退役；旁路 run 装配统一进 `buildRunDeps`，差异由 profile 字段承载 |

> 变更历史见 `log.md`；机制演进见 `../../version_logs/v0.0.204/change_plan.md`。
