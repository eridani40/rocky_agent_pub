# v0.0.55 Tech Change Log — memory UI + skill governance + 统一 session 锁 + squad workspace

> version: 1.0 · 2026-07-03
> PRD 权威：`specs/prd/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`
> 5 个互相独立需求共享「用户对自我演化的可见可控」主题。

---

## 0. 核心设计决策（必读）

1. **统一 per-session × per-task 内存锁 subsumes summaryTask CAS**——v0.0.55 新建 `SessionTaskLock`（`specs/tech/agent/session/[P0]session_task_lock.md`）取代 v0.0.13 的 `Session.summaryTask` 持久化字段。内存 only 不落盘（客户端产品决策：磁盘锁=幽灵锁，重启自然清空）。compact + tier1 + 后续同类任务共用一套 acquire/release CAS 语义；不同 session × 不同 taskType 互不阻塞。

2. **exclusive EP 字段统一（enabled + order）**——废弃 `exclusive?: boolean` 字段，三种 cardinality（exclusive/list/ordered）共用同一数据模型。`setExclusive` 改 enabled 互斥（目标 `enabled=true`，同 point 其他 `enabled=false`）；`exclusivePick` 改读 enabled + effective order 最小者；inventory 加 `selected` 派生字段（前端不再自算）。旧 `exclusive` record 启动 lazy migrate 清理（参照 `ext_impl_scope §4.3` 范式）。

3. **memory UI 端点与 agent memory_manage 工具正交**——用户路径（HTTP `/memory/*`）与 agent 路径（`memory_manage` 工具）完全分离，共享底层 managed-store（per-file 锁串行化仍生效）。UI 端点支持 GET/POST/PATCH/DELETE，scope=session/user。

4. **evolvable 字段（mutable 改名 + 删 mutableLocked）**——`mutable → evolvable`（更直观「是否开启自进化」）；删 `mutableLocked` 维度（UI 一定能改 evolvable，agent 不碰治理元字段）。零历史包袱（v0.0.51 引入、尚未被消费）。

---

## 1. 子系统变更总览

| KB | 变更 | 新文件 |
|---|---|---|
| `agent/session/` | 新建 SessionTaskLock；删 Session.summaryTask 字段 | `[P0]session_task_lock.md` |
| `agent/skills/` | 删 mutableLocked；mutable→evolvable；governance 简化 | — |
| `agent/memory/` | memory UI 端点（与 agent 工具正交） | — |
| `agent/context/` | compact 触发接入 SessionTaskLock（subsumes summaryTask） | — |
| `config/` | 废弃 exclusive 字段；inventory 加 selected；setExclusive 改 enabled 互斥 | — |

---

## 2. agent/session/ — 统一锁

### 2.1 新文件：`[P0]session_task_lock.md`

- 接口：`acquire(sid, taskType)→bool` / `markDone` / `markFailed` / `release` / `getState` / `reconcileOnStartup`
- 内存 `Map<sessionId, Map<taskType, SessionTaskState>>`；CAS 语义（state ∈ {idle,done,failed} → running）
- 不落盘（§3.2 客户端产品决策）；reconcileOnStartup 实际 no-op（内存已空=全部释放）
- subsumes summaryTask：删 `Session.summaryTask` 字段 + `markSummaryRunning/Done/Failed`；调用方改 `lock.acquire/markDone/markFailed('compact')`
- 与五态机正交（不动 session.state/Run/currentRunId）

### 2.2 代码-spec 差异（要改的代码）

| 文件 | 现 spec 描述 | 现代码状态 | v0.0.55 改 |
|---|---|---|---|
| `app/server/src/agent/session-task-lock.ts` | — | 不存在 | **新建** SessionTaskLock class |
| `app/server/src/agent/session-store.ts` | `Session.summaryTask` 字段 + `markSummary*` 方法 | L590 注释引用 summaryTask | 删字段 + 删方法 |
| `app/server/src/agent/session-state-machine.ts` | §3a summaryTask CAS 段 | L244-310 实现 markSummary* | 删整段 + reconcileSummaryTaskOnStartup 改 SessionTaskLock.reconcileOnStartup |
| `app/server/src/handlers/session-compact.ts` | 409 compact_in_progress 读 summaryTask.status | 实现 409 判定 | 改读 `lock.getState(sid,'compact').status==='running'` |
| `app/server/src/agent/schema_defs/session.ts` | summaryTask field | 声明 field | 删 field |
| `app/server/src/agent/context-compact-runner.ts`（或 summary_do_compact impl） | markSummary* CAS 包夹 | 调 markSummary* | 改 SessionTaskLock.acquire/markDone/markFailed |
| `app/server/src/index.ts`（bootstrap） | reconcileSummaryTaskOnStartup | 调用 | 改 SessionTaskLock.reconcileOnStartup（no-op） |

---

## 3. agent/skills/ — evolvable 改名 + 删 mutableLocked

### 3.1 spec 修正

- `[P0]skill_definition.md §6/§8`：删 mutableLocked 维度（§6.2/§6.3 表/§6.4/§8 全段重写）；`mutable → evolvable`（§2 frontmatter + §6.1 + §6.3 默认值表 + §6.4 创建规则 + §8 UI 改 evolvable）；默认值表更新（系统内置 evolvable=false 但不再「locked」）
- `[P0]skill_manage_tool.md`：patch payload 不含 evolvable（原「不含 mutable」改名）；create 注入 `evolvable:true`（不再注入 mutableLocked）；mutable 强制文案 → evolvable 强制
- `index.md`：④ 删第 11 条（双维度治理）→ 改为单维度 evolvable；导航表同步

### 3.2 代码-spec 差异

| 文件 | 现代码状态 | v0.0.55 改 |
|---|---|---|
| `app/server/src/skills/governance.ts`（197 行） | body.mutable + step3 检查 mutableLocked + setMutableLine + 函数名 governSkillMutable | body.evolvable；删 step3（mutableLocked 检查）；setEvolvableLine；函数名 `governSkillEvolvable`；返回 entry 删 mutableLocked 字段 |
| `app/server/src/tools/skill-manage.ts`（300 行边界） | create 注入 `{mutable:true, mutableLocked:false}`；patch payload 文档化不含 mutable/mutableLocked | create 注入 `{evolvable:true}`（删 mutableLocked）；patch payload 文档化不含 evolvable；mutable 强制文案 → evolvable |
| `app/server/src/skills/types.ts` | SkillEntry 含 mutable + mutableLocked 字段 | 字段改名 evolvable；删 mutableLocked |
| `app/server/src/skills/resolver.ts`（parseSkillDir） | 读 frontmatter mutable/mutableLocked | 改读 evolvable |
| `app/plugins/builtins/rocky_context/prompt/skills.ts` | L0 catalog `[mutable=true|false]` 标记 | `[evolvable=true|false]` |
| `app/web/src/components/skill-page/*` | 显示 mutable 状态 | 显示 evolvable 状态（如适用） |

---

## 4. agent/memory/ — memory UI 端点

### 4.1 spec 修正

- `memory_manage_tool.md`：保持 agent 工具契约不变；新增 §9「与 UI 端点的边界」（明确 agent 路径 vs 用户路径正交）
- `memory_definition.md`：保持结构化格式不变；§4 封装原则补「UI 走 HTTP 端点」（与 agent 走工具并列）
- `index.md`：④ 新增第 7 条原则「UI 端点与 agent 工具正交」

### 4.2 代码-spec 差异

| 文件 | 现代码状态 | v0.0.55 改 |
|---|---|---|
| `app/server/src/handlers/memory.ts` | 不存在 | **新建**：GET/POST/PATCH/DELETE 端点 handler，委托 ManagedStore（复用 `app/server/src/memory/managed-store.ts`） |
| `app/server/src/index.ts` | 无 /memory/* 路由 | 加 4 条路由 |
| `app/server/src/memory/managed-store.ts` | 已有 write/archive/list/read + per-file 锁 + atomicWrite | **零改动**（UI 端点复用，per-file 锁串行化跨 agent/UI 并发写仍生效） |

---

## 5. agent/context/ — compact 接入统一锁

### 5.1 spec 修正

- `[P0]context_compact_detail.md §2c`：compact 触发链路（tryCompact + summary_do_compact impl）的 summaryTask CAS 改为 `SessionTaskLock.acquire('compact')` + markDone/markFailed
- `§2b` HTTP 端点：409 判定改读 `lock.getState(sid,'compact').status === 'running'`
- 顶部注记更新：summaryTask CAS 引用改为 SessionTaskLock 引用

### 5.2 代码-spec 差异

已在 §2.2 列出（context-compact-runner 改 acquire/markDone）。

---

## 6. config/ — exclusive EP 字段统一

### 6.1 spec 修正

- `[P0]plugin_config_service.md §2/§4.2`：
  - `setExclusive(implId, scopeId)` 改 enabled 互斥：目标 `enabled=true`，同 point 其他 `enabled=false`（不再写 `exclusive:true`）
  - inventory 加 `selected: boolean` 派生字段（`selected = enabled && point 内 order 最小的 enabled 者`）
  - §4.2 重写：删 `exclusive` 字段引用；exclusive 语义统一用 enabled + order
- `[P0]ext_impl_scope.md §5.3`：exclusive cardinality 解析改读 enabled（删 `implPolicy.exclusive===true` 那套）
- `index.md`：④ 新增原则「exclusive 统一 enabled+order」

### 6.2 代码-spec 差异（关键 bug 修复）

| 文件 | 现代码状态 | v0.0.55 改 |
|---|---|---|
| `app/server/src/plugin/plugin-policy-store.ts`（283 行） | `ExtImplPolicyData` 含 `exclusive?: boolean` | 删字段；新增 `migrateLegacyExclusiveRecords()`（启动 lazy 清 `{exclusive:true}` record） |
| `app/server/src/plugin/plugin-config-service.ts`（**336 行已超 300**） | L165-169 `setExclusive` 只写 `exclusive:true` 不动 enabled 不清同 point 其他 | setExclusive 改 enabled 互斥（目标 enabled=true + 同 point 其他 enabled=false）；**同时拆出 scoped-write.ts** 减行 |
| `app/server/src/plugin/plugin-manager.ts`（243 行） | L222-243 `exclusivePick` 读 `implPolicy.exclusive===true` | 重写：active = enabled 者；多个取 effective order 最小者（与 ordered 同源，删 `getImplPolicy.exclusive` 那套） |
| `app/server/src/plugin/inventory-builder.ts`（220 行） | `buildExtImplNode` 无 selected 字段 | 加 `selected: boolean` 派生计算（exclusive point：enabled && point 内 order 最小的 enabled 者；list/ordered：未定义或 false） |
| `app/server/src/plugin/schema_defs/plugin_policy.ts` | schema 含 exclusive field | 删 field |
| `app/server/src/plugin/index.ts`（bootstrap） | — | 调 `migrateLegacyExclusiveRecords()` |
| `app/web/src/components/plugin-config-page/page-plugin-config.tsx` | radio 用 enabled 瞎猜 selected（两红框一 dot 根因） | radio 改用 inventory `selected` |

---

## 7. AT 落点建议（配合 PRD §3 六路径）

| 路径 | AT case 建议 | 断言重点 |
|---|---|---|
| 路径 1 · session memory | `tests/api/memory/session_memory_crud_tc1/` | GET 列表 → POST 新建 → PATCH 更新 → 查真落盘 `session_memory.md` + 新 session system prompt `memory_session` 含新内容 |
| 路径 2 · user memory | `tests/api/memory/user_memory_crud_tc1/` | POST user_memory entry（type=feedback）→ 查真落盘 `user_memory.md` + 新 session system prompt `memory_user` 含新 entry |
| 路径 3 · skill evolvable | `tests/api/skill/governance_evolvable_tc1/` | PATCH governance evolvable=false → frontmatter 真改 → agent 调 skill_manage.patch 返 isError + 稳定 code + 磁盘不变 |
| 路径 4 · studio leader 右侧区域 | `tests/api/squad/leader_memory_workspace_tc1/` | leader session GET session_memory（leader sessionId）+ GET workspace tree（squad workspaceDir） |
| 路径 5 · exclusive EP 切换 | `tests/api/plugin/exclusive_unified_tc1/` | PUT setExclusive（切 should_compact）→ GET inventory 验 `selected` + 磁盘 enabled 互斥 + 调用 exclusivePick 验返回新 impl |
| 路径 6 · session 并发任务锁 | `tests/api/session/compact_lock_tc1/` | 并发触发（compact + compact）→ 第二个 acquire 返 false / 409；查无并发执行 |

---

## 8. 任务拆分建议（供 planner 细化，3-8 个 task）

| # | task 雏形 | 主要文件 | 依赖 |
|---|---|---|---|
| 1 | **SessionTaskLock 新建 + summaryTask 迁移** | session-task-lock.ts 新建 + session-store/state-machine/compact-runner/schema 改 + index.ts bootstrap | 无（基础设施） |
| 2 | **skill evolvable 改名 + 删 mutableLocked** | governance.ts / skill-manage.ts / types.ts / resolver.ts / skills.ts prompt | 无 |
| 3 | **exclusive EP 统一（enabled + selected）** | plugin-policy-store / plugin-config-service（拆 scoped-write.ts）/ plugin-manager / inventory-builder / schema / page-plugin-config.tsx | 无 |
| 4 | **memory UI HTTP 端点** | handlers/memory.ts 新建 + index.ts 路由 + memory/manage-store 复用 | 无 |
| 5 | **memory UI 组件（chat 右侧 + 应用设置全局 + studio 右侧）** | component-workspace-panel 改 + page-app-settings-merged 改 + studio _overview/section 改 + component-memory-entry-card 新建 + section-memory-panel 新建 | task 4（API） |
| 6 | **skill-item 双开关 UI** | component-skill-item.tsx 改 + skill-page 联动 | task 2（governance API） |

> 6 个 task 可并行起跑 1/2/3/4；5 等 4；6 等 2。

---

## 9. 文件级变更清单（汇总）

### 新增（A）
- `specs/tech/agent/session/[P0]session_task_lock.md`（本文档对应 spec）
- `specs/api/overall/15-memory-ui.md`（memory UI HTTP 端点契约）
- `specs/api/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`
- `specs/tech/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`（本文件）
- `specs/ui/components/chat-page/section-memory-panel.md` + `.tsx`
- `specs/ui/components/chat-page/component-memory-entry-card.md` + `.tsx`
- `specs/ui/components/app-dev-config-page/section-user-memory.md` + `.tsx`
- `specs/ui/components/studio-page/section-right-tabs.md` + `.tsx`（leader/mate 右侧 tab 区域）
- `app/server/src/agent/session-task-lock.ts`
- `app/server/src/handlers/memory.ts`
- `app/server/src/plugin/scoped-write.ts`（plugin-config-service 拆分）

### 修改（M）
- 见各子章节「代码-spec 差异」表
