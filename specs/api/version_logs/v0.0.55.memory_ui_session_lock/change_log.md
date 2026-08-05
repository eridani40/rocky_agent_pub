# v0.0.55 API Change Log — memory UI + skill governance + exclusive EP 统一

> version: 1.0 · 2026-07-03
> PRD 权威：`specs/prd/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`
> Tech 权威：`specs/tech/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`

---

## 1. 新增端点

### 1.1 `/memory/*`（UI 专用 memory CRUD，全新增）— `15-memory-ui.md`

- `GET /memory/:scope?sessionId=&includeArchived=` — 列 entry（scope=session|user）
- `POST /memory/:scope` — 新建 entry（body 含 sessionId + entry 对象）
- `PATCH /memory/:scope/:name` — 更新 entry
- `DELETE /memory/:scope/:name?sessionId=` — 归档 entry（不真删，archived=true）

> 与 agent `memory_manage` 工具正交；共享底层 ManagedStore per-file 锁串行化。

## 2. 修改端点

### 2.1 `PATCH /skill/:name/governance`（v0.0.51 mutable → v0.0.55 evolvable）— `06a-skill-governance.md`

- body 字段：`mutable → evolvable`（更直观「是否开启自进化」）
- 删 `mutableLocked` 维度：响应不再含 `mutableLocked`；删 403 路径（所有 skill UI 都能改 evolvable）
- v1.0 → v2.0

### 2.2 `PUT /config/plugin`（exclusive EP 字段统一）— `03-config-center.md`

- `setExclusive` op 改 enabled 互斥语义（不写 `exclusive` 字段）：目标 enabled=true + 同 point 其他 enabled=false
- GET `/config/plugin` 响应 ext impl 节点新增 `selected?: boolean` 派生字段
- 旧 `{exclusive:true}` record 启动 lazy migrate 清理

### 2.3 `POST /session/:id/compact`（任务锁替换）— `04-agent-session.md`

- 409 判定改读 `SessionTaskLock.getState(sid, 'compact').status === 'running'`（原 `summaryTask.status`）
- 行为完全不变（响应体、状态码、错误码 `compact_in_progress` 一致）

## 3. AT 落点（配合 PRD §3 六路径）

| 路径 | AT case | 文件 |
|---|---|---|
| 路径 1 · session memory 查看/编辑 | `tests/api/memory/session_memory_crud_tc1/` | 新建 |
| 路径 2 · user memory 查看/编辑 | `tests/api/memory/user_memory_crud_tc1/` | 新建 |
| 路径 3 · skill evolvable 切换 | `tests/api/skill/governance_evolvable_tc1/` | 改名（原 mutable_tc1） |
| 路径 4 · studio leader 右侧区域 | `tests/api/squad/leader_memory_workspace_tc1/` | 新建 |
| 路径 5 · exclusive EP 切换生效 | `tests/api/plugin/exclusive_unified_tc1/` | 新建 |
| 路径 6 · session 并发任务锁互斥 | `tests/api/session/compact_lock_tc1/` | 新建 |

详细 case 设计由 api-test-designer 按 test-plan 设计（断言基于本 change_log + 各端点契约，不看代码）。
