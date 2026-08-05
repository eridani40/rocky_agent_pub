---
version: v0.0.111
slug: workitem_visibility
title: 工作项三态可见性 + team 硬删除 API 契约
status: working
updated: 2026-07-10
---

# v0.0.111 API 增量记录

> 本版本 API 契约变更（黑盒断言依据）。`specs/api/overall/` 已由 doc-modifier 阶段 5 同步。
> Method 级改动合同见 `specs/tech/version_logs/v0.0.111/change_plan.md`。

## 1. 新增端点

- **`DELETE /squad/:id`**（`11a-squad-endpoints.md §1.5`）：team 硬删除（解散）。校验 squad 存在（不存在 `404 squad not found`）→ `dissolveSquad`（disposeSquad teardown → 删各会话 → deleteSquad → rmSync 办公室目录，顺序不可颠倒）→ `200 { deleted: true }`。**不可逆硬删**：member session + 历史消息 + 调度全物理清，不留回收站/软归档。AT 用临时 squad 验证。删除旧「无 DELETE / squad 不可删」表述。

## 2. 契约变更

- **`11b §4.1` GET /board cancelled 不返**：`handleBoardRead` 三段先 `!effectiveCancelled` 前置过滤（cancelled 项 self 或祖先取消 → 两 zone 都不返），再走 zone。响应 schema 不含 `effectiveCancelled` 字段（cancelled 不返则恒 false 无意义）。
- **`11b §4.1` 工具 query 口径**：`goal/requirement/task(query)` 默认滤 `effectiveArchived ∨ effectiveCancelled`（只返 active）；`filter.includeArchived===true` 保留 archive 仍滤 cancel（cancel 终态永不返）。权威 `[P1]squad_tools.md §3`。

## 3. 契约补齐（AT designer 发现，实现从首版即支持）

- **`11b §3.5` PATCH body 显式补 `status`**：`PatchGoalBody`/`PatchKRBody`/`PatchRequirementBody`/`PatchTaskBody` 均加 `status?: WorkStatus`（Task 额外 `reason?`）。走 `isLegalWorkTransition` 校验，非法跃迁 → `400 illegal_transition`（§3.6）。旧 spec 用 `Partial<CreateXBody>` 漏列 status——本次补齐对齐代码（`board-write-{goal,req,task}.ts` `isStatus(b.status)`）。
