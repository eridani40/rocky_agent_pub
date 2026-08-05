---
type: spec
title: Task Tool（占位）
priority: P1
status: deprecated-pointer
updated: 2026-07-02
since: v0.0.8
---

# Task Tool（占位 — 实现已迁 squad）

Task / todo 管理工具：任务规划、状态追踪。原计划在 tools 子系统定义，**实际落地为 squad 工作项三层（goal/requirement/task）的 task 工具**——权威定义已迁至 `../../squad/[P1]squad_tools.md §3`。

## 1. 概述

task 工具让 agent 自主规划与追踪多步工作：创建任务、更新状态、查询进度。对应"todo 之类的"规划能力。

## 2. 当前实现（指向 squad）

**权威 spec**：`../../squad/[P1]squad_tools.md §3`（task 工具 action 表 + 权限 + 强约束）。
**权威代码**：`app/server/src/agent/tools/task-tool.ts`（5 action：create/assign/claim/update_status/query）。
**权限**：create/assign=leader only；claim=mate only（CAS 原子）；update_status=leader（任意）/mate（仅自己 task）；query=全员。
**强约束**（工具兜底）：source 必填（缺→orphan_task）/ DAG 写环检测 / claim CAS 原子 / WorkStatus 状态机非法跃迁拒写。
**注册**：`registry.ts:51 defaultTools()` 含 `taskTool`（与 goal/requirement/team 一起）。**可见性裁剪 `[v0.0.48 modified]`**：改由 `resolveTools()` 读 `TOOL_POLICY['studio-leader'|'studio-mate'].bound` 单方法 resolve（task 在 leader/mate bound 内 → 可见；playground-rocky/subagent bound 不含 → 不可见），替代旧 `filterToolDefinitionsBySessionType` schema 层裁剪。详见 `[P0]tool_policy.md §2.2/§3`。

## 3. 边界（初步）

| 零件 | 归属 |
|---|---|
| task 工具定义 + 任务模型 + 状态机 + action 表 + 强约束 | `../../squad/[P1]squad_tools.md §3` ✅ |
| 调度/执行 | `tool_execution_engine.md` |
| squad schema 裁剪（leader/mate 可见） | `[P0]tool_policy.md §2.2/§3`（v0.0.48 `resolveTools()` 单方法）+ `agent_tools.md §2` |

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
> 本文件保留为索引占位，不再细化；新需求直接改 squad_tools.md §3。
