---
type: interface
title: Todo 工具（session 级双层待办）
priority: P1
status: active
updated: 2026-08-15
since: v0.0.223
related: [[P0]tool_policy.md, [P1]task_tools.md, ../../agent/context/[P0]system_reminder.md]
---

# Todo 工具（session 级双层待办）

> 定位：todo = **当前 session 手头**的双层待办清单（主 item + 步骤），**session 级**（不跨 session）、持久化、agent 自主维护、纯文本主体 + 结构化引用 id。
> **todo ≠ task**（权威区分）：task = squad **团队跨 session** 工作项（leader 创建/member 认领/DAG/CAS/状态机严格，`../../squad/[P1]squad_tools.md §3`）；todo = 当前 session 内 agent 手头待办（无角色/无 DAG/无 CAS/状态 free-form）。
> 参照：task-tool action-based dispatch 模式（`app/server/src/agent/tools/task-tool.ts:40-120`）；cron 独立 store 路线（`app/server/src/scheduling/persistence/cron-adapter.ts`）。
> 需求权威：`specs/prd/version_logs/v0.0.223.md §2.3`。

---

## 1. 能力边界

| 维度 | todo | task |
|---|---|---|
| 范围 | 当前 session（不跨 session） | squad 团队跨 session |
| 作者 | agent 自主维护 | leader 创建 / member 认领 |
| 权限 | 无角色（session 内唯一 agent） | leader/mate 按 action 校验 |
| 状态机 | 5 态 free-form（仅 enum，不校验跃迁） | WorkStatus 严格状态机（illegal_transition 拒） |
| DAG/CAS | 无 | DAG 写环检测 / claim CAS |
| 存储 | `<DATA_DIR>/sessions/<sid>/todos.json`（独立 store） | `<DATA_DIR>/squads/<squadId>/board/tasks/{id}.json` |
| reminder | `[todo]` session 进度（todo provider） | `[task]` 我的+待认领（task provider） |

---

## 2. 数据模型

### 2.1 主 item（layer 1）

```typescript
interface TodoItem {
  id: string;                          // ULID（session 内唯一）
  desc: string;                        // 一句话描述
  status: TodoStatus;                  // 5 态 enum
  source?: { type: 'task' | 'user_message' | 'agent'; refId?: string };
  output?: { type: 'file' | 'reply_session' | 'reply_agent'; refId?: string };
  memo?: string;                       // 自由文本备忘（非 desc，补充说明）
  steps: TodoStep[];                   // 步骤（layer 2）
  createdAt: string;                   // ISO
  updatedAt: string;                   // ISO
}
```

**source.type 语义**（任务从哪来）：
- `task`：来自 squad task（refId=taskId）
- `user_message`：来自当前 user message（refId=messageId?）
- `agent`：agent 自主产生（无 refId）

**output.type 语义**（要产出什么；PRD §6 开放点已定：不加 reply_user）：
- `file`：产出文件（refId=文件路径?）
- `reply_session`：回复某 session（refId=targetSessionId）
- `reply_agent`：回复某 agent（refId=targetMemberId）

### 2.2 步骤（layer 2）

```typescript
interface TodoStep {
  id: string;           // ULID（item 内唯一）
  desc: string;         // 一句话
  status: TodoStatus;   // 同 5 态
}
```

### 2.3 状态 enum（5 态 free-form）

```typescript
type TodoStatus = 'not_started' | 'in_progress' | 'done' | 'skipped' | 'error';
```

中文映射：未开始 / 进行中 / 已结束 / 跳过 / 出错。

**MUST NOT 校验跃迁路径**：任意状态间可跳转（agent 自决），工具层仅校验 enum 合法性（非法字符串 → `invalid_status` 错误，不报 `illegal_transition`）。对齐 PRD §2.3「free-form 跃迁」+ CLAUDE.md memory `user-prefers-simple-direct-refactor-no-defensive-checks`。

### 2.4 生命周期

- 主 item 标 `done` / `skipped` 后，**下次 todo 工具被调用时清理**（action=`cleanup_finished` 显式触发，或在 `list` / `add_item` 时隐式清理；架构期定：**显式 cleanup_finished action**，agent 责任，不强制立即删——给 agent 完成确认窗口）。
- 步骤不独立清理（随主 item 一起删）。

---

## 3. action schema

```typescript
todo(action, ...args)
```

TODO_ACTIONS = `['add_item', 'update_item', 'add_step', 'update_step', 'delete_item', 'list', 'cleanup_finished']`

| action | 入参 | 说明 | output |
|---|---|---|---|
| `add_item` | `desc, status?, source?, output?, memo?` | 建主 item（steps=[]）；status 缺省 not_started；source/output 均可空 | `{itemId}` |
| `update_item` | `itemId, patch:{desc?,status?,source?,output?,memo?}` | 改主 item 字段（partial） | `{itemId}` |
| `add_step` | `itemId, desc, status?` | 给主 item 加步骤（status 缺省 not_started） | `{itemId, stepId}` |
| `update_step` | `itemId, stepId, patch:{desc?,status?}` | 改步骤字段 | `{itemId, stepId}` |
| `delete_item` | `itemId` | 删主 item（含步骤） | `{itemId}` |
| `list` | — | 列当前 session 全部 todo（含已结束未清理） | `TodoItem[]` |
| `cleanup_finished` | — | 删所有 status ∈ {done, skipped} 的主 item | `{removed: number}` |

**错误码**：`invalid_action` / `invalid_status`（非 enum）/ `item_not_found` / `step_not_found` / `desc_required`。MUST NOT 有 `forbidden` / `illegal_transition`（session 级无角色 + free-form）。

---

## 4. 存储路线（独立 store，仿 cron-adapter）

**路线 B（独立 store，已确认）**：`<DATA_DIR>/sessions/<sid>/todos.json` 单文件 per session，schema `{version:1, sessionId, items:TodoItem[]}`，read-modify-write + atomicWriteSync 原子写。

**理由**（research §4.1）：
- todo 高频更新（agent 每 turn 可能改），独立 store 避免 Session 主记录频繁整写 + 减少并发写冲突。
- 对齐 cron/memory「session 级结构化数据走独立 store」既有模式。
- DATA_DIR 经 `app/server/src/config.ts:resolveDataDir()` 单源展开（packaged cwd=`/` 护栏，CLAUDE.md #4）。

**实现**：`app/server/src/agent/todo/todo-store.ts:TodoStore`（仿 `CronPersistenceAdapter`，方法 listBySession / upsertItem / removeItem / removeAll / cleanupFinished）。复用 `persistence/fs-io.ts:atomicWriteSync / readJsonFileSync / removeFileSync / ensureDirSync`。
**emit 注入（v0.0.228）**：`TodoStoreDeps.statusBus?: ReplayableEventBus`（optional，构造注入；bootstrap 传 session_panel topic 的 raw sessionStatusBus——构造时序在 store-phase wrap 之前，不经 wrap fan-out，天然不触发 session_meta broadcast / unread 处理）。写成功后经私有 `emitChanged(sid)` 发 `session_todo_changed`；三不 emit 原则见 `[P0]session_event.md` §3。

---

## 5. profile.toolBound 绑定

**进所有 `*.parent.main` profile**（leader / mate / standalone parent.main；PRD §2.3）：
- `app/plugins/session-types/studio-leader.parent.main.yaml`
- `app/plugins/session-types/studio-mate.parent.main.yaml`
- `app/plugins/session-types/studio-squad.parent.main.yaml`
- `app/plugins/session-types/playground-rocky.parent.main.yaml`
- `app/plugins/session-types/academy-*.parent.main.yaml`（academy-coach / head_teacher / student）

**MUST NOT 绑**：
- `*.subagent.*.yaml`（短生命周期，todo 主在 parent session）
- `*.consolidate.yaml` / `*.summary.yaml`（runKind 粒度，零工具 / 仅 skill_manage+memory_manage）
- `forked` session（不绑；research §4.5）

**实现**：todoTool 进 `defaultTools()`（registry.ts:98），profile.toolBound 写 `todo`；resolveToolSet(kind) 三层一致解析（`[P0]tool_policy.md`）。

---

## 6. todo reminder（填壳）

todo 工具产出的数据，经 `reminder/todo.ts` provider（`[P0]system_reminder.md §3`，登记序 2）每轮注入 reminder：
- **数据源**：`ctx.todoStore.listBySession(config.sessionId)`（ReminderCtx 扩展 todoStore，仿 squadContext 模式）。
- **产出格式**：`[todo] 进行中：{desc} ({done}/{total} 步骤) · {desc2} (未开始)`（未结束主 item 摘要 + 步骤进度）。
- **角色 filter**：仅 parent.main session 产出（subagent/forked 不产出，避免噪声）。
- **MUST NOT 读 task_tools**（语义已重定义：旧 no-op 空壳 → 新 session todo 进度）。
- **prompt 差别说明**：prompt 段必须讲清 todo reminder（session 手头双层待办）vs task reminder（squad 团队认领/待认领任务）差别，避免 agent 混淆。

**reminder queue 接线（v0.0.361）**：todo 工具各写 action（add/update item、add/update step、delete、cleanup）成功后向 per-session reminder queue 写一行**已渲染增量行**——`new ReminderQueueStore({ fsRoot: dataDir }).write(sid, 'todo:{itemId}', value)`（如 `[todo] item「desc」→ done` / step 变化 / `[todo] item「desc」已删除`）；key=`todo:{itemId}`（同 key 重写删旧追加尾）；**写失败 catch 吞**（reminder 是 best-effort 通知，绝不阻断工具返回）；fsRoot=DATA_DIR（缺省 no-op）；queue 实例 per-call new（write 临界区纯同步 JS，多实例不交错）。消费侧由 incremental 轮 injector `queueDrain` 拼进当轮 reminder（`../../context/[P0]system_reminder.md §4`）。

---

## 7. HTTP API

仿 cron HTTP 路由（`specs/api/overall/20-todo.md` 新）：
- `GET /session/:sessionId/todos` — 列全部
- `POST /session/:sessionId/todos` — add_item（body: {desc, source, output, memo?, status?}）
- `PATCH /session/:sessionId/todos/:itemId` — update_item（body: patch）
- `DELETE /session/:sessionId/todos/:itemId` — delete_item
- `POST /session/:sessionId/todos/:itemId/steps` — add_step
- `PATCH /session/:sessionId/todos/:itemId/steps/:stepId` — update_step
- `POST /session/:sessionId/todos/cleanup` — cleanup_finished

仅 session 级读写，不跨 session。**SSE 实时推送（v0.0.228 落地）**：TodoStore 三个写方法（upsertItem / removeItem / cleanupFinished）写成功后 emit `session_todo_changed`（topic=`session_panel`、group=`session_id:<sid>`、data=空对象轻量信号；契约见 `[P0]session_event.md` §2/§3）——agent 工具与 HTTP handler 两条写路径共享 TodoStore，store 层单点 emit 全覆盖。前端 60s 轮询已退役，改 SSE 驱动 refetch + 打开弹层 refetch（见 `20-todo.md` §3）。

---

## 8. 边界

| 零件 | 归属 |
|---|---|
| todo 工具 action schema + 数据模型 + 5 态状态机 + profile 绑定 | 本文 ✅ |
| todo store 实现细节（原子写 / read-modify-write） | 代码 `todo-store.ts`（仿 cron-adapter） |
| todo reminder provider 产出格式 + ReminderCtx 扩展 | `../agent/context/[P0]system_reminder.md §3` |
| HTTP 路由契约 | `specs/api/overall/20-todo.md` |
| todo 视图组件（双层树 + 悬停详情 + float-menu 集成） | `specs/ui/components/chat-page/component-todo-modal.md`（coder 编码前置产出） |
| 与 task 的区分（task 跨 session / DAG / CAS） | `../../squad/[P1]squad_tools.md §3` |

---

## 9. 版本

**v0.0.223** — 新建 todo 工具（session 级双层待办，参照 task-tool action 模式，去权限/DAG/CAS，状态 free-form）+ 独立 store（仿 cron-adapter）+ ReminderCtx 扩展 todoStore + todo provider 填壳 + HTTP API + profile.toolBound 绑所有 parent.main。详见 `specs/tech/version_logs/v0.0.223/change_plan.md` A/B/H 节。

**v0.0.228** — TodoStore 写方法（upsertItem / removeItem / cleanupFinished）写成功后 emit `session_todo_changed`（§4 emit 注入 + §7 SSE 段落）；前端 60s 轮询退役改 SSE 驱动。另修正 §2.1/§3 source/output 为 optional（对齐代码实际——工具层/HTTP 层均接受省略）。详见 `specs/tech/version_logs/v0.0.228/change_plan.md`。
