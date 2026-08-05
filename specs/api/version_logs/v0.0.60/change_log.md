# v0.0.60.squad_ui_2 API Change Log — Squad Workitems HTTP API v1.0 → v2.0（可编辑 + 联合检查归档）

> version: 1.0 · 2026-07-04
> 范围：`specs/api/overall/11b-squad-workitems.md` 从 v1.0（只读 board 端点）升级到 v2.0（全实体全字段可编辑 + 联合检查归档 + 派生字段 + zone/filter/sort query）。
> 权威输入：`specs/prd/version_logs/v0.0.60/change_log.md` §5.2（API 缺口 4 项）+ `states/v0.0.60/task.json` decisions（双轨保留 + zone 默认 active + 派生不落库）。
> 父版本：v1.0 `[v0.0.33.3]`（board 只读 HTTP 端点）。

---

## 1. 改动总览

| # | 类别 | 改动 |
|---|---|---|
| **A** | 写端点（v0.0.60 新增） | §3 POST/PATCH `/squad/:id/board/{goals,krs,requirements,tasks}` + `POST /tasks/:tid/duplicate` + `PATCH /{entity}/:id/archive|restore` |
| **B** | 响应字段扩展 | §2.1 BoardItem 加 `body?` / `priority`(Task) / `deadline`(KR+Task) / `archived` / `archivedAt?` / `archivedBy?` |
| **C** | 派生字段（响应层算，不落库） | `readable: bool` / `effectiveArchived: bool` / `completionPct`(Goal+KR) / `health`（持久化但读时复核） |
| **D** | zone/filter/sort query | §4 `?zone=active|archive` + `?filter=reqId|krId|all` + `?sort=priority,updatedAt` |
| **E** | 字段废弃 | §6 `RequirementBoardItem.relatedGoalId` → `relatedKRId`；`TaskBoardItem.source.kind` 去枚举（统一 `{requirementId}`） |
| **F** | AT 映射扩到 14 UC | §7 从 v1.0 的 7 验证点扩到 14 UC（编辑/归档/恢复/筛选/复制/联合检查 fail/编辑感知） |

---

## 2. 新增端点详情（§3）

### 2.1 Goal 端点

- `POST /squad/:id/board/goals` — 建 Goal（含嵌 KR 数组）
- `PATCH /squad/:id/board/goals/:gid` — 改 Goal（title/description/body/ownerMemberId）
- `PATCH /squad/:id/board/goals/:gid/archive` — 归档 Goal（self-only，**不级联**改子）
- `PATCH /squad/:id/board/goals/:gid/restore` — 恢复 Goal

### 2.2 KR 端点（嵌在 Goal 下）

- `POST /squad/:id/board/goals/:gid/krs` — 建 KR
- `PATCH /squad/:id/board/goals/:gid/krs/:kid` — 改 KR（含 update_progress：current/target/deadline 变 → 重算 health + 联动父 goal health）
- `PATCH /squad/:id/board/goals/:gid/krs/:kid/archive` — 归档 KR
- `PATCH /squad/:id/board/goals/:gid/krs/:kid/restore` — 恢复 KR

### 2.3 Requirement 端点

- `POST /squad/:id/board/requirements` — 建 Requirement
- `PATCH /squad/:id/board/requirements/:rid` — 改 Requirement（含 relatedKRId 切换）
- `PATCH /squad/:id/board/requirements/:rid/archive` — 归档 Requirement
- `PATCH /squad/:id/board/requirements/:rid/restore` — 恢复 Requirement

### 2.4 Task 端点（含 duplicate）

- `POST /squad/:id/board/tasks` — 建 Task（source.requirementId 必填）
- `PATCH /squad/:id/board/tasks/:tid` — 改 Task（mate 仅自己 task 字段子集）
- `POST /squad/:id/board/tasks/:tid/duplicate` — 复制 Task（复制 source/assignee/deadline；status=pending；priority=none；**不复制 dependsOn**；新 id）
- `PATCH /squad/:id/board/tasks/:tid/archive` — 归档 Task
- `PATCH /squad/:id/board/tasks/:tid/restore` — 恢复 Task

### 2.5 通用约定

- **权限**：leader/user 写全；mate 仅自己 task 字段子集（title/body/priority/deadline，**不允许改 source/assignee**）；越权 → `403 forbidden`。
- **`lastWriteMessageId` 自动写入**：caller 不直传，端点从 session context 取当前 message id 写入 store（与 LLM 工具一致，驱动 reminder 变化检测）。
- **OKF md 同步**：写 store 后 agent 同步 OKF md（非端点责任，prompt 引导；`squad_archive.md §6` 编辑感知）。
- **archive/restore 只改 self.archived**（联合检查模型，`squad_archive.md §1`）；可达性交给读取层（响应层派生 readable）。

---

## 3. 响应字段扩展（§2.1）

| 字段 | 类型 | 实体 | 说明 |
|---|---|---|---|
| `body?` | string | 全实体 | 长正文 markdown（区别 title/摘要） |
| `priority` | enum | Task | urgent/high/medium/low/none |
| `deadline?` | string | KR + Task | ISO date |
| `archived` | boolean | 全实体 | self-only（联合检查） |
| `archivedAt?` | string | 全实体 | 归档时间 |
| `archivedBy?` | string | 全实体 | 归档操作者 |
| `readable` | boolean（派生） | 全实体 | `self.archived==false ∧ 所有祖先.archived==false` |
| `effectiveArchived` | boolean（派生） | 全实体 | `self.archived==true ∨ 任一祖先.archived==true` |
| `completionPct` | number（派生） | Goal + KR | KR = current/target；Goal = KR 算术平均 |

**派生字段策略**（响应层算，不落库）：避免冗余存储与数据漂移；store 只持久化必要冗余（health 因免重算性能考虑持久化；其余实时算）。

---

## 4. Query 参数（§4）

### 4.1 `?zone=active|archive`（默认 active）

- `active`：返 `archived==false` 的项（含被祖先拽入归档区的活项，靠 effectiveArchived=true 暴露给 UI 做发现性提示条）
- `archive`：返 `effectiveArchived==true` 的项

### 4.2 `?filter=reqId|krId|all`（task 视图专用）

- `all`（默认）：全部
- `reqId=R-0001`：仅该 requirement 的 task
- `krId=KR-0001`：该 KR **含其下所有 requirement** 的 task（join requirement.relatedKRId==krId）

### 4.3 `?sort=priority,updatedAt`（task 列内）

- 默认 `status,priority,updatedAt`：status 序 → priority desc → updatedAt desc
- `priority,updatedAt`：仅 priority + updatedAt

---

## 5. 字段废弃（§6）

| 字段 | 替代 | migrate 策略 |
|---|---|---|
| `RequirementBoardItem.relatedGoalId` | `relatedKRId` | 旧 record 清空或经 promote 链路重挂；新写入拒收；响应不返 |
| `TaskBoardItem.source.kind` + `source.id` | `source.requirementId` | 旧 schema 废弃；migrate 时 kind=kr 转「观测 KR-X」Requirement 中转再回填；新写入拒收 |

---

## 6. 错误码（写端点通用）

| HTTP | 场景 | code |
|------|------|------|
| `403` | 越权（mate 改非自己 task / 改禁字段） | `forbidden` |
| `404` | 父实体不存在 | 标准 404 |
| `400` | body 非法 / source 缺失 | `orphan_task` |
| `400` | dependsOn 构成环 | `dag_cycle` |
| `400` | 状态机非法跃迁 | `illegal_transition` |
| (warn) | relatedKRId/source.requirementId 坏链 | 容忍 warn（不返 400） |

---

## 7. 与 PRD §5.2 缺口对齐

| PRD §5.2 项 | 本 change_log 章节 |
|---|---|
| 写端点 | §2 |
| 响应字段扩展 + 派生字段 | §3 |
| zone/filter/sort query | §4 |
| 字段废弃 | §5 |

---

## 8. AT 影响范围

- **新增 case**：编辑/归档/恢复/筛选/复制 × 4-6；联合检查 fail × 2-3；编辑感知 reminder × 1。
- **回归更新**：v0.0.33.3 board 读端点 UC-1~10（schema 字段扩展需更新 checkpoint 断言）。
- 详见 orchestrator 后续 `states/v0.0.60/verify/test-plan.md`。
