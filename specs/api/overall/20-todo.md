# 20. Todo API（session 级双层待办）

> 定位：todo 工具数据的 HTTP CRUD 端点（前端 todo 视图用），仿 `/session/:sid/cron`（`16-cron.md`）模式。session 级、不跨 session。
> 需求权威：`specs/prd/version_logs/v0.0.223.md §2.3/§2.6`；工具契约：`specs/tech/agent/tools/[P1]todo_tools.md`。
> 数据源：独立 store `<DATA_DIR>/sessions/<sid>/todos.json`（仿 cron-adapter）。

---

## 1. 资源模型

```
TodoItem (主 item, layer 1)
├─ id, desc, status, source, output, memo?, createdAt, updatedAt
└─ steps[]: TodoStep (layer 2)
   └─ id, desc, status
```

status enum 5 态：`not_started` / `in_progress` / `done` / `skipped` / `error`（free-form 跃迁，仅校验 enum）。

source: `{type:'task'|'user_message'|'agent', refId?}`；output: `{type:'file'|'reply_session'|'reply_agent', refId?}`。

---

## 2. 端点

> 响应契约：写操作返**小对象**（`{itemId}` / `{itemId, stepId}` / `{id, deleted}` / `{removed}`），完整 item 走 GET §2.1——省 payload（todo 高频更新，全量数据按需拉取）。

### 2.1 GET `/session/:sessionId/todos`

列当前 session 全部 todo（含已结束未清理的）。

**200** `{items: TodoItem[]}`

### 2.2 POST `/session/:sessionId/todos`

建主 item（agent / 用户视图调）。

**Body**: `{desc: string, source?, output?, memo?: string, status?: TodoStatus}`（source/output 均可空）
**201** `{itemId: string}`
**400** `desc_required` / `invalid_status`

### 2.3 PATCH `/session/:sessionId/todos/:itemId`

改主 item 字段（partial）。

**Body**: `{desc?, status?, source?, output?, memo?}`
**200** `{itemId: string}`
**404** `item_not_found`

### 2.4 DELETE `/session/:sessionId/todos/:itemId`

删主 item（含步骤）。

**200** `{id: string, deleted: true}`
**404** `item_not_found`

### 2.5 POST `/session/:sessionId/todos/:itemId/steps`

给主 item 加步骤。

**Body**: `{desc: string, status?: TodoStatus}`
**201** `{itemId: string, stepId: string}`

### 2.6 PATCH `/session/:sessionId/todos/:itemId/steps/:stepId`

改步骤字段。

**Body**: `{desc?, status?}`
**200** `{itemId, stepId}`

### 2.7 POST `/session/:sessionId/todos/cleanup`

删所有 status ∈ {done, skipped} 的主 item。

**200** `{removed: number}`

---

## 3. SSE / 轮询

**[v0.0.228] SSE 实时推送已落地，60s 轮询退役**：

- **事件**：`session_todo_changed`（topic=`session_panel`，group=`session_id:<sid>`——复用既有 topic，零新 topic 注册、零 SSE 白名单变更）。`data` = 空对象（轻量信号，不携带 todo 数据；契约见 `specs/tech/agent/session/[P0]session_event.md` §2/§3）。
- **触发**：`TodoStore.upsertItem` 写成功 / `removeItem` 真删 / `cleanupFinished` 真清——agent 工具与 HTTP 写路径共享 TodoStore，store 层单点 emit，两条路径都覆盖。
- **前端消费**：chat 页 `useSessionPanelFanout` 扇出（`session_todo_changed` → store.lastTodoEvent）→ `useTodoCrud` effect 匹配 sessionId 后**静默 refetch**（重拉本端点 GET 全量；todo 规模小，对齐 §2「写操作返小对象、完整数据走 GET」省 payload 原则）。badge 与已打开弹层同一 hook 数据源，同步刷新。
- **兜底**：初始态 = 挂载 GET（本端点）；打开 todo 弹层瞬间再 refetch 一次（skills 弹层先例）；切走/切回 session 自动退订/重订阅 + 重挂载 GET。SSE 断链期间的数据空洞由这两条兜底，不再保留定时轮询。
- **不触发 `session_meta` 广播**：todo 不在 SessionMetaView，会话列表无感知（对齐 `session_workspace_file_changed` 先例）。

---

## 4. 错误码

| code | 触发 | HTTP |
|---|---|---|
| `desc_required` | add_item / add_step desc 空 | 400 |
| `invalid_status` | status 非 enum | 400 |
| `item_not_found` | itemId 不存在 | 404 |
| `step_not_found` | stepId 不存在 | 404 |

MUST NOT 有 `forbidden` / `illegal_transition`（session 级无角色 + free-form 状态机）。

---

## 5. 鉴权 / 边界

- 仅 session 级读写：所有端点按 `:sessionId` 索引 todo store，**不跨 session**。
- todo 工具（`todoTool`）走同一 store（agent 写 / 用户视图读），无独立 agent 写端点——工具内部直接调 TodoStore。
- 与 task（squad 团队跨 session 工作项，`11b-squad-workitems.md`）完全独立：todo session 级，task squad 级。

---

## 6. 版本

**v0.0.223** — 新建 todo HTTP API（GET/POST/PATCH/DELETE `/session/:sid/todos[/:itemId/steps[/:stepId]]` + cleanup），仿 cron 模式。详见 `specs/tech/version_logs/v0.0.223/change_plan.md` A/H 节。

**v0.0.228** — SSE 实时推送落地（`session_todo_changed` 复用 session_panel topic，TodoStore 写方法单点 emit），§3 从「polling 兜底」改为 SSE 驱动（60s 轮询退役）；HTTP 端点契约零改动。另修正 §2.2 Body source/output 为 optional（对齐代码实际）。详见 `specs/tech/version_logs/v0.0.228/change_plan.md`。
