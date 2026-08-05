# v0.0.97 — API Change Log（enqueue 队列重构：纯 API+SSE 驱动）

> 增量变更。全量权威：`specs/api/overall/04-agent-session.md`。
> 权威输入：`specs/prd/version_logs/v0.0.97.enqueue_sse/change_log.md` + `specs/tech/version_logs/v0.0.97/change_plan.md`。

## §1 新增端点

### 1.1 `GET /session/:id/inbox` — inbox 只读快照（§3.5）

**动机**：切到 running session 时，inbox 非 sticky（无 SSE replay，drain 一次性清空），新订阅者从空开始 → 看不到该 session 既有排队项。GET /inbox 提供只读快照，让前端 `useMessages` onInit 在 GET /messages 之后 seed `enqueueItems`——与「GET /messages 拉 transcript 基线」一致性原则对齐。

**契约**：

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/session/:id/inbox` | 返 inbox 中当前所有 `kind:'message'` 条目的只读快照 | `200` + `{ items: InboxItemView[] }` |

```typescript
interface InboxItemView {
  enqueueId: string;
  content: ContentBlock[];   // 与 message_enqueued SSE payload 的 content 字段完全同形（INV-2）
  enqueuedAt: string;        // ISO date（InboxEntry.enqueuedAt，append 时注入）
}
```

**约束**：
- **过滤**：仅返 `kind:'message'`（`kind:'cancel'` 是 drain 内部信号，不暴露）。
- **排序**：按 `enqueuedAt` 升序（ULID 字典序 = 入队时间序，与 SSE 到达顺序一致）。
- **只读无副作用**：不 emit 事件、不改 inbox 状态、不触发 drain。
- **浅拷贝快照（O1）**：handler `[...peek]` 浅拷贝防 drain `splice(0)` 改已返引用（`InboxStore.peek` 返直接引用，drain 并发会清空同数组）。
- **content 形对齐 SSE（INV-2）**：`content: ContentBlock[]` 与 `message_enqueued` 同形——前端走同一 reducer 入口 `contentBlocksToPreviewText`，不出现 GET vs SSE 两套处理路径。

**错误**：`404` session 不存在；`405` 非 GET。

**用途**：切 session 时前端 onInit 在 GET /messages 之后追加 GET /inbox seed enqueueItems（失败降级空不阻塞主对话流）。后续 SSE `message_enqueued` 到达时 reducer `some(enqueueId)` 幂等去重，GET seed 与 SSE 增量不双计。

## §2 不变契约（本版显式确认）

| 端点/事件 | 状态 | 说明 |
|-----------|------|------|
| `GET /session/:id/messages` | 不变 | transcript 分页 |
| `POST /session/:id/messages` | 不变 | 响应仍 `{ runId, enqueueId }`（INV-6 向后兼容）；前端只是不再读 enqueueId 用于 UI 状态 |
| `POST /session/:id/messages/:enqueueId/cancel` | 不变 | 202 fire-and-forget；幂等（INV-7） |
| SSE `message_enqueued` / `enqueued_message_processed` / `enqueued_message_canceled` | 不变 | 三事件 schema 不变（`[P0]agent_event.md §4.3`） |

## §3 §3.4 cancel 前端 UX 修订注（v0.0.97）

§3.4 加 `[v0.0.97] 前端 UX 修订` 注：用户点 enqueue-item 取消按钮 → **x 立即转圈**（component-enqueue-view 本地 `canceling: Set<enqueueId>`，1s 恢复，转圈期禁点）+ POST cancel；移项**只**靠 SSE `enqueued_message_canceled`（多端一致性，不乐观移除、不进 store）。1s 内 SSE 未到回 x 可重试点（cancel POST 幂等）。HTTP 契约（请求体/响应体/状态码）不变。

## §4 文件变更

| 文件 | 操作 | 变更 |
|------|------|------|
| `app/server/src/handlers/session-inbox.ts` | 新增 | `handleSessionInbox()` + `InboxItemView` interface（GET /inbox handler，浅拷贝快照 + 过滤 kind:'message' + 映射 InboxItemView） |
| `app/server/src/router.ts` | 修改 | `matchSessionPath` regex alternation 加 `inbox`；sub dispatch 加 `inbox` 分支 → `handleSessionInbox`；import |
| `app/server/src/agent/agent-manager.ts` | 修改 | 新增 public `peekInbox(sessionId): InboxEntry[]` 透传（inbox 字段 private，外部不能直访） |
