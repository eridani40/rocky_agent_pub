# v0.0.97 变更计划书 — enqueue 队列重构：纯 API(GET /inbox)+SSE 驱动 + cancel 转圈 UX + mention pill

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 权威基线：PRD `specs/prd/version_logs/v0.0.97.enqueue_sse/change_log.md`；task.json decisions（D8 subscribe-first 权威 + 实现细节①②③）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 / 项目原则 |
| 预计影响行 | +N / -M |

## 符号核对结论（arch 落表前 grep 核实）

| 符号 | 真实状态 | 备注 |
|---|---|---|
| `InboxStore.peek` | ✓ 存在（inbox.ts:139），**返直接引用** `this.buckets.get(sid) ?? []` | drain `splice(0)` 改同数组 → handler 须浅拷贝快照（O1） |
| `InboxEntry.kind` | ✓ `'message' \| 'cancel'`（inbox.ts:41-54） | 闭合，过滤 `kind:'message'` 可行 |
| `contentBlocksToPreviewText` | ✓ 存在（chat-slice-reducer.ts:75），只 join TextBlock.text | mention tag 是 TextBlock.text 子串 → 自然保留（**O2 零改动**） |
| `MentionRender({text})` | ✓ 存在（component-mention-render.tsx:47） | 解析 `<mention/>`，降级纯文本 |
| `cancelEnqueue` / `getMessages` | ✓ chat-api.ts:171 / 126 | 无 `getInbox`（新增） |
| `useMessages.onInit` | ✓ 已 subscribe-first（subscribe 102-103 → GET 108） | **D8 已与代码一致**，只需插 GET /inbox |
| `UseMessagesResult` | ✓ 含 `removeEnqueueItem`(57)+`addEnqueueItem`(59) | 均删 |
| `handleSend`/`handleEnqueueCancel`(page-chat) | ✓ 209/210/222；addEnqueueItem@215、removeEnqueueItem@223 | |
| `section-member-chat.handleEnqueueCancel` | ✓ 151（removeEnqueueItem@153）；**handleSend(160) 不调 addEnqueueItem** | 仅删 removeEnqueueItem 调用 |
| `EnqueueViewProps.onRemove?` | ✓ 存在（enqueue-view.tsx:55），**run-state-bar 从不传 onRemove**（只传 onCancel） | 死代码，删 |
| `toTextPreview` / `{preview}` 渲染 | ✓ enqueue-view.tsx:34 / 132 | |
| `matchSessionPath` regex alternation | ✓ router.ts:172（`messages\|summary\|...`） | 加 `inbox` |
| `AgentManagerImpl.inbox` | ✓ private（agent-manager.ts:94） | 需 public `peekInbox` 透传 |
| `deps.agentManager` | ✓ SessionHandlerDeps 暴露（session-messages 用 `deps.agentManager.enqueue`） | handler 可直调 peekInbox |
| `icons.tsx` SpinnerIcon | ✗ **不存在**；码内 spinner 约定 = inline `<span border+animate-spin>`（abort-btn/loading-status/ws-tree） | **偏离任务描述**：不加 SpinnerIcon，用 inline span |
| `EnqueueItem` | ✓ `{enqueueId, content: string}`（types.ts:158） | 不扩 enqueuedAt（O3 YAGNI） |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| backend_api | app/server/src/handlers/session-inbox.ts | handleSessionInbox() | 新增 | GET /session/:id/inbox handler：校验 method=GET → `deps.agentManager.peekInbox(id)` → 过滤 `kind:'message'` → 映射成 `InboxItemView[]`（按 enqueuedAt 升序，ULID 字典序天然升序）→ 200 `{items}`；session 不存在 404。**浅拷贝快照** `[...peek]` 防 drain splice 改已返引用 | MUST 浅拷贝（O1：peek 返直接引用，drain splice 同数组）；MUST 只读无副作用（不 emit/不 drain/不锁）；MUST NOT 暴露 kind:'cancel' 条目；单文件 ≤300 行 | PRD §2.1；[P0]agent_inbox_enqueue.md §2/§3；arch O1 | +45 |
| backend_api | app/server/src/handlers/session-inbox.ts | InboxItemView | 新增 | `interface InboxItemView { enqueueId: string; content: ContentBlock[]; enqueuedAt: string }`（content 字段与 message_enqueued SSE 同形） | MUST content 为 ContentBlock[]（INV-2：与 SSE 同形） | PRD §2.1；api 04 §3.5 | +6 |
| backend_api | app/server/src/router.ts | matchSessionPath() regex | 修改 | 在 alternation 加 `inbox`：`(?:\/(messages\|inbox\|summary\|...))?` | MUST 保持 cancel/workspace/debug 更具体匹配在前 | router.ts:172 | +1/-1 |
| backend_api | app/server/src/router.ts | sub dispatch | 修改 | 加分支 `if (sessionMatch.sub === 'inbox') return handleSessionInbox(req, method, sessionMatch.id, deps);` | MUST 非法 method 由 handler 返 405 | router.ts:~340 | +3 |
| backend_api | app/server/src/router.ts | import handleSessionInbox | 修改 | 从 `./handlers/session-inbox` import | | | +1 |
| backend_api | app/server/src/agent/agent-manager.ts | AgentManagerImpl.peekInbox() | 新增 | `peekInbox(sessionId: string): InboxEntry[] { return this.inbox.peek(sessionId); }`——public 透传（inbox 字段 private，外部不能直访） | MUST 纯透传不改语义；MUST NOT 在此过滤 kind（过滤在 handler，peek 返全量维持 inbox 既有契约） | [P0]agent_inbox_enqueue.md §2；inbox.ts:139 | +4 |
| fe_api | app/web/src/lib/chat-api.ts | getInbox() | 新增 | `getInbox(sessionId, base?): Promise<{ items: InboxItemView[] }>` → `GET /session/:id/inbox`，走既有 `req<>()` 封装 | MUST 与 getMessages 同款封装风格；MUST NOT 在前端做 kind 过滤（后端已过滤） | PRD §2.2；chat-api.ts:126 getMessages | +14 |
| fe_hook | app/web/src/components/chat-page/use-messages.ts | onInit() | 修改 | 在 GET /messages 成功块**之后**追加 GET /inbox：`try { const { items } = await getInbox(sessionId); initial = {...initial, enqueueItems: items.map(it => ({ enqueueId: it.enqueueId, content: contentBlocksToPreviewText(it.content) }))}; } catch { /* 失败不阻塞，enqueueItems 降级空 */ }`。**subscribe-first 顺序不变**（subscribe 在 GET /messages 前，本表不动该顺序） | MUST subscribe 仍在 GET /messages + GET /inbox 之前（D8：GET 返回到 subscribe 间 fire 的 message_enqueued 会丢）；MUST 用 contentBlocksToPreviewText 转 string（EnqueueItem.content 为 string）；MUST 幂等靠 reducer `some(enqueueId)`（chat-slice-reducer.ts:336 既有） | PRD §2.2 + D8；[P0]chat_area_hooks.md §3 | +12 |
| fe_hook | app/web/src/components/chat-page/use-messages.ts | import getInbox | 新增 | `import { getMessages, getInbox } from '../../lib/chat-api';` | | | +1/-1 |
| fe_hook | app/web/src/components/chat-page/use-messages.ts | UseMessagesResult (interface) | 修改 | 从接口删 `removeEnqueueItem` + `addEnqueueItem` 两字段 | MUST 同步删实现（见下两行）；MUST NOT 留废弃注释 | PRD §2.3 D4；[P0]chat_area_hooks.md §3 | -2 |
| fe_hook | app/web/src/components/chat-page/use-messages.ts | removeEnqueueItem() | 删除 | useCallback 闭包整体删（167-178 区间）+ return 对象删该键 | MUST 确认无 caller（page-chat/section-member 同步删调用） | PRD §2.3；memory delete-dead-code-no-deprecate-mark | -14 |
| fe_hook | app/web/src/components/chat-page/use-messages.ts | addEnqueueItem() | 删除 | useCallback 闭包整体删（180-192 区间）+ return 对象删该键 | MUST 确认无 caller（page-chat 同步删） | PRD §2.3 | -13 |
| fe_page | app/web/src/components/chat-page/page-chat.tsx | handleSend() | 修改 | 删 `if (enqueueId) addEnqueueItem({enqueueId, content});`（line 215 区间）；POST 响应 enqueueId 不再用于 UI state | MUST 队列加项只由 SSE message_enqueued 驱动（INV-1/INV-5） | PRD §2.3 D4；[P0]agent_inbox_enqueue.md §3 | -2 |
| fe_page | app/web/src/components/chat-page/page-chat.tsx | addEnqueueItem (local destructure) | 删除 | 删 `const addEnqueueItem = messages.addEnqueueItem;`（209） | MUST 删后无悬空引用 | | -1 |
| fe_page | app/web/src/components/chat-page/page-chat.tsx | handleEnqueueCancel() | 修改 | 删 `messages.removeEnqueueItem(enqueueId);`（223）；只保留 `cancelEnqueue(activeSessionId, enqueueId).catch(...)` | MUST 队列移项只由 SSE enqueued_message_canceled/processed 驱动（INV-1/INV-5）；cancel POST fire-and-forget | PRD §2.3 D4 | -1 |
| fe_page | app/web/src/components/studio-page/section-member-chat.tsx | handleEnqueueCancel() | 修改 | 删 `removeEnqueueItem(enqueueId);`（153）；只保留 cancelEnqueue POST | 同上 | PRD §2.3；section-member-chat.tsx:151 | -1 |
| fe_page | app/web/src/components/studio-page/section-member-chat.tsx | removeEnqueueItem (destructure) | 删除 | 从 `messagesHook` 解构删 `removeEnqueueItem`（115） | | | -1 |
| fe_comp | app/web/src/components/chat-page/component-enqueue-view.tsx | EnqueueViewProps.onRemove | 删除 | 删 `onRemove?: (enqueueId: string) => void;`（55） | MUST run-state-bar 从未传 onRemove（已核实，死代码） | PRD §2.3 + §7.2 | -1 |
| fe_comp | app/web/src/components/chat-page/component-enqueue-view.tsx | canceling (state) | 新增 | `const [canceling, setCanceling] = useState<Set<string>>(new Set());` + `const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());`（track setTimeout 防切 session unmount 后 setCanceling 触发 React warn） | MUST 纯本地瞬态，不进 store/ctx（INV-3）；MUST unmount 清理 timers（实现细节①） | PRD §2.4 D5 + 实现细节① | +3 |
| fe_comp | app/web/src/components/chat-page/component-enqueue-view.tsx | useEffect (timer cleanup) | 新增 | 组件级 useEffect cleanup：unmount 时 `timersRef.current.forEach(clearTimeout); timersRef.current.clear();` | MUST 切 session 时 EnqueueView unmount（showEnqueue 门控）→ fire 已清 timer 不 setCanceling | PRD 实现细节①；PRD §2.4 | +6 |
| fe_comp | app/web/src/components/chat-page/component-enqueue-view.tsx | handleCancel() | 修改 | 改写：①若 `canceling.has(enqueueId)` return（禁点防重复 POST）；②`setCanceling(prev => new Set(prev).add(enqueueId))`；③`onCancel?.(enqueueId)`；④`const t = setTimeout(() => setCanceling(prev => { const n = new Set(prev); n.delete(enqueueId); return n; }), 1000); timersRef.current.set(enqueueId, t);`。**删 onRemove 调用** | MUST 转圈期禁点（INV：防重复 POST）；MUST 1s 后回 x（cancel POST 幂等，重试无副作用 INV-7）；MUST NOT 监听 POST 成败（fire-and-forget，PRD §2.4 约束） | PRD §2.4 D5；[P0]agent_inbox_enqueue.md §6.3；04-agent-session.md §3.4 | +9/-3 |
| fe_comp | app/web/src/components/chat-page/component-enqueue-view.tsx | cancel button render | 修改 | 取消按钮（150-160）：加 `data-canceling={canceling.has(it.enqueueId) ? 'true' : 'false'}` + `disabled={canceling.has(it.enqueueId)}`；children 从 `<CloseIcon size={12} />` 改为 `{canceling.has(it.enqueueId) ? <span className="inline-block w-3 h-3 border-[1.5px] border-[var(--color-border-strong)] border-t-[var(--color-accent)] rounded-full animate-spin" /> : <CloseIcon size={12} />}` | MUST spinner 用 inline span border+animate-spin（码内既有约定，abort-btn/loading-status/ws-tree 同款，**非 SVG SpinnerIcon**——偏离任务描述）；MUST x 与 spinner 占同 22×22 槽位（INV-4）；MUST data-canceling 供 ET DOM 断言（实现细节②，不加新 testid） | PRD §2.4 + INV-4 + 实现细节②；icons.tsx 无 spinner | +6/-1 |
| fe_comp | app/web/src/components/chat-page/component-enqueue-view.tsx | content 渲染 | 修改 | `{preview}`（132）→ `<MentionRender text={preview} />`；preview 仍由 `toTextPreview(it.content)` 产（保留兜底防 ContentBlock[] 流入） | MUST 复用 MentionRender（PRD §2.5）；MUST 无 mention 时降级纯文本（既有行为，零回归） | PRD §2.5 D6；mention-pill.md | +1/-1 |
| fe_comp | app/web/src/components/chat-page/component-enqueue-view.tsx | import MentionRender | 新增 | `import { MentionRender } from './component-mention-render';` | | | +1 |
| fe_comp | app/web/src/components/chat-page/component-enqueue-view.tsx | 文件头注释（cancel 行为段） | 修改 | line 19 注释「onRemove 立即乐观移除 + 重排」改为「x→转圈（本地 canceling Set，1s 恢复，禁点）+ 移项靠 SSE enqueued_message_canceled」 | MUST 注释与新行为一致 | PRD §7.2 | +1/-1 |
| fe_comp | app/web/src/components/chat-page/component-run-state-bar.tsx | onEnqueueCancel 注释 | 修改 | line 33-36 注释「caller 负责乐观移除（removeEnqueueItem）... 不接 onRemove」改为「cancel 仅 POST，移项靠 SSE enqueued_message_canceled（不进 store）」 | MUST 删 stale「乐观移除」描述 | PRD §7.2 | +1/-2 |
| spec_api | specs/api/overall/04-agent-session.md | §3.5 GET /session/:id/inbox | 新增 | 端点文档：路径/响应 `{items: InboxItemView[]}`/`InboxItemView={enqueueId, content:ContentBlock[], enqueuedAt}`/过滤 kind:'message'/按 enqueuedAt 升序/只读无副作用/404 | arch 阶段落 delta，doc-modifier 阶段 5 定稿 | PRD §5.1 §7.1 | +25 |
| spec_tech | specs/tech/app/frontend/[P0]chat_area_hooks.md | §3 useMessages | 修改 | onInit 段补「GET /messages 后追加 GET /inbox seed enqueueItems（contentBlocksToPreviewText 入口）；subscribe-first 不变（D8）」；命令式方法段删 `removeEnqueueItem`/`addEnqueueItem` | arch 阶段落 delta，doc-modifier 阶段 5 定稿 | PRD §7.1 §7.2；D8 | +5/-3 |
| spec_tech | specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md | §10 前端只读 GET /inbox | 新增 | 引用 GET /session/:id/inbox（GET seed + SSE 增量 = 队列真相源，对齐 INV-1）；§6.3 端到端链路「UI 立即乐观移除」描述同步改「x→转圈 + SSE 移项」 | arch 阶段落 delta，doc-modifier 阶段 5 定稿 | PRD §7.1；INV-1 | +12 |
| spec_ui | specs/ui/components/chat-page/_overview.md §4.11a | cancel 行为/Props/toTextPreview | 修改 | cancel 行为改 x→转圈；Props 删 onRemove；toTextPreview 改 MentionRender | **coder 编码前置产出/更新**（arch 只标契约点） | PRD §5.4 §7.1 §7.2 | coder 定 |
| spec_ui | specs/ui/components/chat-page/_components.md | component-enqueue-view 视觉基线 | 修改 | cancel icon→spinner（inline span border+animate-spin，22×22 同槽位）；queue-text mention 部分 pill | coder 编码前置产出/更新 | PRD §5.4 §7.1 | coder 定 |
| spec_ui | specs/ui/components/studio-page/member-chat-page.md | enqueue 行为 | 修改 | handleEnqueueCancel 不再 removeEnqueueItem，仅 POST cancel | coder 编码前置产出/更新 | PRD §7.1 | coder 定 |

## 开放点裁决（arch 拍板，PRD §8）

| ID | 裁决 | 理由 |
|---|---|---|
| **O1** peek 实现细节 | **handler 浅拷贝快照**（`[...peek]` 后 filter/map），**不改 InboxStore.peek** | peek 返直接引用（inbox.ts:140），drain `splice(0)` 改同数组（inbox.ts:134）。若 handler 返直接引用 + drain 并发 → 已返数组被清空。handler 浅拷贝在调用时刻快照，且不打扰 peek 既有 normal-mode live-ref 调用方 |
| **O2** contentBlocksToPreviewText 是否处理 mention tag | **零改动** | 已读代码核实（chat-slice-reducer.ts:75-83）：只 join TextBlock.text。mention tag 是 TextBlock.text 的子串（`<mention type="file" .../>` 嵌在文本里），join 结果自然含 tag 字符串。MentionRender 再解析 tag → pill。链路已通 |
| **O3** EnqueueItem 扩 enqueuedAt | **不扩**（YAGNI） | UI 暂不展示入队时刻；EnqueueItem.content 保持 string（types.ts:158 不动）；排序由 GET 响应升序 + SSE 到达顺序天然保证 |
| **O4** canceling Set 1s 超时可调 | **固定 1s**，不暴露配置 | 初值合理；用户反馈再调；spec 不预设最终值 |
| **O5** POST→SSE ms 窗口 loading state | **不做** | D1 多端一致性优先；窗口极短；session idle 时 enqueue→activate→drain 极快排队项根本不显示。超 query 范围 |
| **O6** cancel POST 失败回滚 canceling | **不回滚** | fire-and-forget 简单；1s 后自动回 x 可重试（cancel POST 幂等 INV-7）。监听成败增复杂度无收益 |
| **O7** InboxItemView 暴露 source/role | **不暴露** | user 场景单一；未来 a2a message 入队展示再扩 |

## spec↔code 偏离（arch 标注，doc-modifier 阶段 5 统一修）

| 偏离点 | 现 spec | 代码实际 | 处置 |
|---|---|---|---|
| useMessages onInit 顺序 | [P0]chat_area_hooks.md §3 onInit 段写「GET /messages → subscribe」 | 代码 subscribe-first（subscribe 102-103 → GET 108） | D8 权威：代码对，spec 错。doc-modifier 阶段 5 改 spec 为 subscribe-first |
| useMessages 命令式方法 | §3 列 removeEnqueueItem | 本版删（dead code） | doc-modifier 阶段 5 删 |
| _overview §4.11a cancel | 「UI 立即乐观移除」 | 改 x→转圈 + SSE 移项 | coder 编码前置改 spec |
| _components enqueue Props | 列 onRemove? | run-state-bar 从不传，删 | coder 编码前置删 |
| enqueue-view spinner icon | 任务描述暗示加 SpinnerIcon | 码内无 spinner SVG，约定 inline span border+animate-spin | 用 inline span（偏离任务描述，对齐码内约定） |
| _overview §4.11a toTextPreview | 纯文本 | MentionRender | coder 编码前置改 |

## 影响面评估

- **跨模块**：backend（router+新 handler+agent-manager public 方法）/ fe-api（chat-api）/ fe-hook（use-messages）/ fe-page（page-chat + section-member-chat）/ fe-comp（enqueue-view + run-state-bar）/ specs 4 层
- **破坏性变更**：无对外契约破坏——POST /messages 响应不变（INV-6）、SSE 三事件不变、EnqueueItem 形不变；新增 GET /inbox 纯 additive；删除的 addEnqueueItem/removeEnqueueItem/onRemove 是内部命令式 API（无外部 caller 后删）
- **依赖顺序**（底层先）：①backend（handler+router+agent-manager.peekInbox）→ ②fe-api getInbox → ③fe-hook use-messages onInit+删方法 → ④fe-page 删调用 → ⑤fe-comp enqueue-view 改造。③删方法前须先④删 caller（否则 typecheck 挂）；planner 切 task 注意此顺序
- **风险点**：①onInit GET /inbox 失败须降级空不阻塞（PRD §2.2 约束）；②canceling timer unmount 清理（实现细节①，否则 React warn）；③spinner inline span 视觉须与 abort-btn ring 风格接近（PRD §2.4 约束）

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现表内符号/路径与代码不符（spec 落后）→ 按代码实际实现 + 汇报偏离 → orchestrator 记 doc-sync 待办 → doc-modifier 阶段 5 修 spec
