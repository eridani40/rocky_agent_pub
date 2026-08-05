# v0.0.33.3 API 变更日志 — 看板只读 HTTP + LLM 工具契约（goal/requirement/task/team.update_charter）

> 范围红线：本版 API surface **仅新增一组 board 只读 HTTP 端点**（`GET /squad/:id/board`，详细契约 `11b-squad-workitems.md`）；工作项**写操作不经 HTTP**，落 LLM 工具契约（leader/mate 在对话中调 `goal`/`requirement`/`task`/`team(update_charter)`，权威定义在 `specs/tech/squad/[P1]squad_tools.md` v0.6，本文件只摘要 + 链接）。
> 权威输入：PRD `specs/prd/version_logs/v0.0.33.3/change_log.md`（10 UC）+ tech `specs/tech/version_logs/v0.0.33.3/change_log.md`（9 块改动）+ 7 个 [P1] spec。
> 父版本：v0.0.33.2（4 scope 对话 + send_message squad 别名 + team v2 只读 + `<EOS>` 透明 + studio 403 已拆）。
> 命名：一律 **mate**。

---

## 1. 概述

本版 API 变更分两类：

| 类型 | 范围 | 影响 |
|---|---|---|
| **新增只读 HTTP**（A） | `GET /squad/:id/board`（聚合 goals+requirements+tasks，按 view 切） | UI 看板渲染 |
| **LLM 工具契约**（B） | `goal` / `requirement` / `task` / `team(update_charter)` 4 个 action-based 工具（权威：`[P1]squad_tools.md` v0.6） | LLM 工具调用契约（**非 HTTP**） |

**核心原则**：本版本**只读 HTTP + 工具写 store**——编辑走对话（LLM 调工具）或 v1 既有 UI（charter editor / member manage），看板不暴露 POST/PATCH/DELETE。

---

## 2. HTTP 端点新增（→ 11b-squad-workitems.md）

### 2.1 `GET /squad/:id/board` — 看板聚合读（NEW）

| 方法 | 路径 | query | 成功响应 | 失败 |
|------|------|-------|---------|------|
| `GET` | `/squad/:id/board` | `view?=all\|goals\|requirements\|tasks`（缺省 all） | `200 + Board`（三视图字段对齐 store 投影，剔除 `lastWriteMessageId`） | `404` squad 不存在 / `400` view 非法 |

**完整契约**（响应 schema / 排序 / 字段对齐表 / AT 映射）→ `specs/api/overall/11b-squad-workitems.md`。

**与现有端点关系**：
- 沿用 `11a-squad-endpoints.md` 路径前缀（`/squad/:id/...`）。
- 不替代 `GET /squad/:id`（后者是 squad 详情含 members/charter；board 端点是工作项视图）。
- charter 仍走 `GET /squad/:id/charter`（`11a §3.1`），不在 board 端点重复。

> **无写 HTTP**：board 端点只 GET；POST/PATCH/DELETE 工作项**不经 HTTP**（编辑走 LLM 工具或 v1 既有 UI；PRD §5 排除看板编辑 / drag-drop）。

---

## 3. LLM 工具契约（→ [P1]squad_tools.md，本文件只摘要）

> **关键定位**：本节工具是 **agent 在对话中调用的 LLM 工具**（leader/mate 经 chat-flow 触发），**不是 HTTP 端点**——UI 不直接发这些调用，UI 只读 board。权威定义在 `specs/tech/squad/[P1]squad_tools.md` v0.6，本节仅摘要 + 错误码 + UC 映射，不复述字段细节。

### 3.1 工具签名摘要（4 工具）

| 工具 | action 集 | 谁可调（caller 角色） | 写对象 | 关键强约束 |
|---|---|---|---|---|
| `goal(action, ...)` | `create_objective` / `create_kr` / `update_progress` / `edit` / `set_status` / `query` | leader / user（`update_progress`：KR 责任 mate 仅自己 KR） | `goals/{id}.json` + 派生 health 联动 | KR `ownerMemberId` 判权；current ∈ 0..target |
| `requirement(action, ...)` | `create` / `triage` / `promote_to_goal` / `set_status` / `query` | `create`: leader/user/member（代提，raisedBy=self）；`triage`/`promote_to_goal`: leader only | `requirements/{id}.json` | 仅 pending 可 triage |
| `task(action, ...)` | `create` / `assign` / `claim` / `update_status` / `query` | `create`/`assign`: leader only；`claim`: member only；`update_status`: leader（任意）/ mate（仅自己 task） | `tasks/{id}.json` | **source 必填**（禁 orphan）/ **DAG 无环**（写入检测）/ **claim CAS 原子**（assignee=null→caller）/ 状态机非法跃迁拒写 |
| `team(update_charter, patch, reason, triggeredByMessageId?)` | 写 action（v0.0.33.2 v2 只读已落） | leader / user | `squad.charter` patch merge + append `charter_history` + 填 squad.lastWriteMessageId | history append-only；patch 是 partial；返 `{charterVersion, historyId}` |

> 字段细节 / input output schema → `[P1]squad_tools.md §2-§5.6`（不复述）。

### 3.2 工具错误码（统一）

| error code | 触发场景 | 来源工具/action |
|---|---|---|
| `forbidden` | caller 角色无权调此 action（如 member 调 `task(create)`、mate 调 `team(update_charter)`） | 全工具 |
| `already_claimed` | `task(claim)` CAS 失败（assignee 已被他人先写） | task.claim |
| `illegal_transition` | `task(update_status)` / `goal(set_status)` / `requirement(set_status)` 状态机非法跃迁（如 done→in_progress） | 三工具 set_status / update_status |
| `dag_cycle` | `task(create)` 写入 `dependsOn` 形成环 | task.create |
| `orphan_task` | `task(create)` 未填 `source`（禁孤儿任务） | task.create |
| `not_found` | 引用 id 不存在（如 `goal(create_kr)` goalId 不存在 / `task(update_status)` taskId 不存在） | 引用类 action |
| `invalid_input` | 字段非法（如 `goal(update_progress)` current 超出 0..target / `task(create)` source.kind 非 kr\|requirement） | 全工具 |

> 错误码风格沿用现有（`squad_*` / `task_*` / `goal_*` / `requirement_*` 前缀，具体前缀编码定）；HTTP 不直接返这些码（工具是 LLM 调用），LLM 收到错误文本后自决策（重试 / 改参数 / 报错给 user）。

### 3.3 工具 vs HTTP 边界（明确）

| 维度 | LLM 工具（本节） | HTTP 端点（§2 + 11a/11b） |
|---|---|---|
| 调用方 | leader/mate agent 在 chat-flow 中 LLM 决策调用 | UI / 外部脚本 curl |
| 入口 | tool_call（agent loop 内） | HTTP request |
| 写对象 | store json（每项一文件）+ 通过 agent 间接同步 OKF md | ——（本版本工作项无写 HTTP） |
| 读对象 | store（query action） | store（GET board） |
| 错误返回 | 文本错误进 LLM context，LLM 决策 | HTTP status + error code |

> UI 看板**只读 HTTP**；编辑意图 → user 在 chat 中告诉 leader → leader 调工具。

---

## 4. UC 映射（PRD 10 路径 → 工具写 + HTTP 读）

| UC | 用户路径 | 工具调用（写） | HTTP 读（验） |
|----|---|---|---|
| **UC-1** 建 Goal+KR | leader `goal(create_objective, create_kr)` | `GET /squad/:id/board?view=goals` |
| **UC-2** 群聊提需求→triage | `requirement(create)` + `requirement(triage, accept)` | `GET ?view=requirements` |
| **UC-3** 拆 task→mate reminder→update_status | leader `task(create, source=R)` + mate `task(update_status, in_progress)` | `GET ?view=tasks` |
| **UC-4** 并发 claim CAS | mate A/B 并发 `task(claim)` | `GET ?view=tasks`（验 assignee 落一人） |
| **UC-5** DAG 依赖解锁 | `task(create, dependsOn=[A])` + `task(update_status, done)` | `GET ?view=tasks` |
| **UC-6** KR 进度推动+health | mate（KR 责任）`goal(update_progress, krId, current)` | `GET ?view=goals`（验 kr.health + goal.health 落库） |
| **UC-7** promote_to_goal | leader `requirement(promote_to_goal, objective, krs)` | `GET board`（验 req.status=done+relatedGoalId + goals 含新 G） |
| **UC-8** charter 对话演化 | leader `team(update_charter, patch, reason, triggeredByMessageId)` | `GET /squad/:id/charter`（11a §3.1）+ `GET /charter/history` |
| **UC-9** mate 代提 requirement | mate `requirement(create, raisedBy={kind:member, id:self})` | `GET ?view=requirements`（验 raisedBy） |
| **UC-10** systemPrompt 移除后人设不丢 | （无工具调用，纯 prompt fragment 注入） | 33.2 GET /messages 真聊回归 |

> **AT 策略**（PRD §3 注）：UC-2/UC-8 涉及 SquadChat 路由（非确定性，req13 I5）→ AT 用**直调工具 + GET 验落库**绕开路由不确定性；ET 容忍路由判断。

---

## 5. 文件变更清单（planner/coder 依据）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/router.ts` | 修改 | 新增路由 `GET /squad/:id/board`（dispatch 到 `BoardHandler.getBoard`）；query `view` 校验 |
| `app/server/src/handlers/board.ts` | 新增 | `BoardHandler.getBoard(req)`：load squad → 按 view 调 board-service → 组装 `Board` 响应（剔除 `lastWriteMessageId`） |
| `app/server/src/services/board-service.ts` | 新增（或合入 `squad-service.ts`） | `getBoard(squadId, view)`：并行读 `{goals,requirements,tasks}/*.json`（按 squadId 分片）+ 排序 + 字段裁剪 |
| `app/server/src/stores/{goal,requirement,task}-store.ts` | 新增（同 tech change_log §2.1） | 每项一文件 CRUD；board-service 复用其 `list(filter)` 接口读 |
| `app/server/src/agent/tools/{goal,requirement,task}-tool.ts` | 新增（同 tech change_log §2.3） | 3 工具 action-based，**LLM 工具非 HTTP**；写 store 记 lastWriteMessageId + 强约束（CAS/DAG/source 必填/状态机） |
| `app/server/src/agent/tools/team-tool.ts` | 修改（同 tech change_log §2.3） | 加 `update_charter` action（v0.0.33.2 v2 只读已落，本版加写 action） |
| `app/server/src/handlers/sse.ts` | 不改 | v0.0.33.1 已 refetch 策略（11-squad §5.2）；本版本 board 变化**仍走 refetch**（user 操作后 UI 主动 refetch `GET /board`），不引入 SSE（与 11-squad §5.2 v4 留线一致） |

> **router/handler/service 是新增 board 端点的全部 HTTP 改动**；工具实现归 tech change_log §2.3（agent tools 目录），与本文件 §3 摘要对齐。

---

## 6. 待定（非阻断）

- **`GET /board` 分页**：本版不分页（单 squad 项数预期 <100）；后续可加 `cursor/limit`。
- **错误码前缀统一**（§3.2）：`squad_*` / `task_*` / `goal_*` / `requirement_*` 具体前缀编码阶段定。
- **终态 record 写错误码**：对 done/cancelled record 调写 action（如对 done task `update_status`）—— 已归 `illegal_transition`（终态不跃迁，`squad_workitems §2.1`），不另设 `already_done`。
- **board SSE**：本版 refetch 够用；多 member 频繁改动时 SSE 推送留 v4（11-squad §5.2）。
- **aggregate 端点 vs 分端点**：本版采单端点 `?view=` 切换；项数大时可拆 `?view=goals` 独立端点（编码后评估）。

---

## 7. 版本

version: 1.0 `[v0.0.33.3]`（看板只读 HTTP + LLM 工具契约首版：①§2 新增 `GET /squad/:id/board?view=all|goals|requirements|tasks`（详细契约 11b）；②§3 4 工具签名摘要（goal/requirement/task + team.update_charter）+ 7 错误码（forbidden/already_claimed/illegal_transition/dag_cycle/orphan_task/not_found/invalid_input）+ 工具 vs HTTP 边界；③§4 PRD 10 UC → 工具写 + HTTP 读映射（AT 直调工具绕路由不确定性）；④§5 文件清单（router+handler+service+store+tools，sse 不改）；⑤§6 待定（分页/错误前缀/board SSE/aggregate 拆分）。基于 PRD v1.0 + tech change_log v1.0 + 7 个 [P1] spec + 33.2 已就绪基础。命名一律 mate。）
