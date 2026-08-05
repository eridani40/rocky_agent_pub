# v0.0.97 — Tech Change Log（enqueue 队列重构：纯 API(GET /inbox)+SSE 驱动 + cancel 转圈 UX + mention pill）

> 跨版本发布说明（版本轴）。本目录级变更见各 KB `log.md`（位置轴）：`specs/tech/app/frontend/log.md` + `specs/tech/agent/agent_interface_and_loop/log.md`。
> 权威输入：`specs/prd/version_logs/v0.0.97.enqueue_sse/change_log.md` + `specs/tech/version_logs/v0.0.97/change_plan.md` + `states/v0.0.97/task.json` decisions（D8 subscribe-first 权威）。

## 概览

v0.0.97 是 enqueue 队列重构——把「POST 乐观加项 + cancel 乐观删项」补足 SSE 时序窗口的旧模型，改为「**纯 API(GET /inbox) + SSE 驱动**」新模型，解决多客户端不一致 + 切 session 队列丢失两个根因问题。同时改版 cancel UX（x→转圈）+ 排队项渲染 mention pill。

三件套：
1. **后端新增 `GET /session/:id/inbox`**：只读快照（过滤 kind:'message'，浅拷贝防 drain 并发），供前端 onInit seed enqueueItems。
2. **前端 useMessages onInit 追加 GET /inbox**（subscribe-first D8）+ **删 addEnqueueItem/removeEnqueueItem 命令式方法**（队列加/移项只由 SSE 驱动，INV-1/INV-5）。
3. **component-enqueue-view cancel 转圈**（本地 canceling Set，1s 恢复，禁点）+ **MentionRender 渲染**（解析 `<mention/>` tag → pill）。

**破坏性变更**：无对外契约破坏——POST /messages 响应不变（INV-6）、SSE 三事件不变、EnqueueItem 形不变；新增 GET /inbox 纯 additive；删除的 addEnqueueItem/removeEnqueueItem/onRemove 是内部命令式 API（无外部 caller 后删）。

## §1 后端：GET /session/:id/inbox（agent KB + api KB）

### 1.1 InboxStore.peek 快照语义（O1 裁决）

`InboxStore.peek(sid)` 返**直接引用**（`this.buckets.get(sid) ?? []`）；`drain` 用 `bucket.splice(0)` **改同一数组**。若 GET handler 返直接引用 + drain 并发 → 已返数组被清空。

**裁决**：GET handler 浅拷贝 `[...peek]` 在调用时刻快照，**不改 `peek` 本身**（peek 既有 normal-mode 外层循环 live-ref 调用方依赖实时视图）。见 `[P0]agent_inbox_enqueue.md §10.3`。

### 1.2 AgentManagerImpl.peekInbox 透传

inbox 字段 private，外部不能直访。新增 public `peekInbox(sessionId): InboxEntry[]` 纯透传（不改语义、不在透传层过滤 kind——过滤在 handler，peek 返全量维持 inbox 既有契约）。

## §2 前端：useMessages onInit 双 GET seed（frontend KB）

### 2.1 subscribe-first 顺序（D8 权威）

onInit 顺序必须是：① subscribe(agent_loop + session_panel) → ② GET /messages → ③ GET /inbox → 返回 ctx。

**为什么 subscribe 必须在 GET 之前（D8）**：GET 返回到 subscribe 之间 fire 的 `message_enqueued` 既不在 GET 快照里又没订阅到 → 丢事件。subscribe-first 保证 GET 之后的所有 SSE 都被捕获；GET 与 SSE 重叠的条目靠 reducer `some(enqueueId)`（chat-slice-reducer.ts:336）幂等去重。

> **D8 修正 PRD §2.2**：PRD 原写 GET-first/subscribe-last，会丢 SSE 事件。代码实际已 subscribe-first（use-messages.ts:106-108 subscribe 在 GET 前），spec 对齐代码。

### 2.2 GET /inbox seed enqueueItems

```typescript
// onInit 内，GET /messages 成功块之后
try {
  const { items: inboxItems } = await getInbox(sessionId);
  if (signal.aborted) return { ctx: emptyCtx(), buffer: emptyBuffer() };
  initial = {
    ...initial,
    enqueueItems: (inboxItems ?? []).map((it) => ({
      enqueueId: it.enqueueId,
      content: contentBlocksToPreviewText(it.content),  // ContentBlock[] → string（EnqueueItem.content 为 string）
    })),
  };
} catch {
  // inbox 拉取失败：enqueueItems 降级空（不阻塞，SSE 仍可推增量）
}
```

**幂等**：GET seed 后，SSE `message_enqueued`（同 enqueueId）到达时 reducer `some(enqueueId)` 去重，不双计。

### 2.3 删命令式方法（dead code）

`UseMessagesResult` 删 `addEnqueueItem` + `removeEnqueueItem` 两字段 + 实现。队列加项只由 SSE `message_enqueued` 驱动（onInit GET seed + reducer），移项只由 SSE `enqueued_message_canceled`/`processed` 驱动。caller（page-chat / section-member-chat）已同步删调用。

## §3 前端：component-enqueue-view cancel 转圈 + mention pill（frontend KB + ui KB）

### 3.1 canceling Set（本地瞬态，INV-3）

`useState<Set<string>>` 纯本地瞬态，**不进 store / 不进 ctx**。点 cancel → `setCanceling(add)` + `onCancel(enqueueId)` POST + `setTimeout(1000)` 回 x。转圈期 `canceling.has(enqueueId)` → 禁点（防重复 POST）。unmount 时 useEffect 清 pending timer（切 session EnqueueView unmount 后 fire setCanceling 会 React warn）。

### 3.2 spinner = inline span（码内约定，非 SVG）

码内 spinner 约定 = inline `<span border+animate-spin>`（abort-btn/loading-status/ws-tree 同款），`icons.tsx` 无 SpinnerIcon。x 与 spinner 占同 22×22 槽位（INV-4）。

### 3.3 MentionRender 复用

`content` 经 `toTextPreview` 产预览 string 后，经 `<MentionRender text={preview}/>` 渲染——解析 `<mention/>` tag → pill。`contentBlocksToPreviewText`（chat-slice-reducer.ts:75）只 join TextBlock.text，mention tag 是 TextBlock.text 子串 → 自然保留（O2 零改动）。

## §4 spec↔code 偏离修正（doc-modifier 阶段 5 统一修）

| 偏离点 | 现 spec（本版前） | 代码实际 / 新设计 | 处置 |
|---|---|---|---|
| useMessages onInit 顺序 | §3 写「GET /messages → subscribe」 | 代码 subscribe-first（subscribe 106-107 → GET 112） | spec 改 subscribe-first（D8） |
| useMessages 命令式方法 | §3 列 removeEnqueueItem | 本版删（dead code） | spec 删 |
| _overview §4.11a cancel | 「UI 立即乐观移除」 | x→转圈 + SSE 移项 | spec 改 |
| _components enqueue Props | 列 onRemove? | run-state-bar 从不传，删 | spec 删 |
| enqueue-view spinner icon | 任务描述暗示加 SpinnerIcon | 码内无 spinner SVG，约定 inline span | 用 inline span（偏离任务描述，对齐码内约定） |
| _overview §4.11a toTextPreview | 纯文本 | MentionRender | spec 改 |

## §5 受影响 KB 文件

| KB | 文件 | 变更 |
|----|------|------|
| frontend | `[P0]chat_area_hooks.md §3` | onInit 补 GET /inbox seed（subscribe-first D8）；删 add/removeEnqueueItem 命令式方法 |
| agent | `[P0]agent_inbox_enqueue.md §10` | 新增「前端只读 GET /inbox」节（§10.1-§10.5：为什么需要 / 端点契约 / peek 快照语义 O1 / 前端消费链 subscribe-first / 队列真相源总结表）；§6.3 cancel 链路改 x→转圈 + SSE 移项 |

## §6 验证

- **code==spec 核对**：session-inbox.ts handler（浅拷贝 `[...peek]` + filter kind:'message' + map InboxItemView + 404/405）== api §3.5 ✓；use-messages.ts onInit（subscribe 106-107 → GET /messages 112 → GET /inbox 123 + 降级 catch）== chat_area_hooks §3 ✓；component-enqueue-view.tsx（canceling Set + timersRef + useEffect cleanup + handleCancel 转圈 + data-canceling + inline span spinner + MentionRender + 无 onRemove）== _overview §4.11a + _components ✓；agent-manager.ts peekInbox 透传（:201）✓；router.ts matchSessionPath regex + inbox dispatch ✓。
- **无代码偏离 spec**：所有实现与 spec 契约一致，未发现代码静默绕过 spec 链路。
