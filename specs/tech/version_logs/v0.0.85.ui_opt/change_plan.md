# v0.0.85.ui_opt 变更计划书 — UI 优化 5 需求（分页 / 文件 watch / 转发格式 / studio 红点 / squad UI 尺寸）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 权威输入：`specs/prd/version_logs/v0.0.85.ui_opt.md`（PRD）+ `specs/research/v0.0.85.ui_opt.md`（调研）。
> **无 HTTP API 契约变更**（D1）→ `specs/api/version_logs/v0.0.85.ui_opt/` 仅放「无变更」声明，不新增 AT case。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名（ui-chat-paging / session-workspace / squad-chat-prompt / studio-sidebar / squad-tree-ui） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（行 = 一个符号；新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

---

## F1 — Session 消息向上滚动分页（前端）

> Invariants：① 消息按 createdAt 升序；messageId=服务端 ULID（字典序=时间序）。
> ② loadMore 前插**不能**触发自动滚底 effect（`isLoadingMore` ref 标记跳过）。
> ③ prepend 后保持滚动位置（`prevHeight = scrollHeight - scrollTop` 技巧；effect 设 `scrollTop = scrollHeight - prevHeight`）。
> ④ loadMore 期间防重入（`loading` ref + `hasMore` ref）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat-paging | app/web/src/components/chat-page/use-session-run-state.ts | UseSessionRunStateOptions | 修改 | 新增 `loadMoreTokenRef`（防重入 token，每次起 ++token；await 后校验是最新才 setMessages prepend） | MUST：prepend 路径仍走 `mergeMessagesById` 去重；不改 `hasMore` 语义 | specs/ui/components/chat-page/_overview.md §4.5（需补「分页前插」）；调研 §1 | +6 |
| ui-chat-paging | app/web/src/components/chat-page/use-session-run-state.ts | isLoadingMoreRef（内部 ref） | 新增 | ref 标记「正在 loadMore」，供 SectionChatDetail 透传给 ComponentMessageStream 跳过自动滚底 effect | MUST：仅在 setMessages prepend 时设 true；下一帧 effect 后清 false；MUST NOT 触发 rerender（保持 ref） | _overview.md §4.5（需补「跳过滚底 effect」规则） | +12 |
| ui-chat-paging | app/web/src/components/chat-page/use-session-run-state.ts | SessionRunState.isLoadingMore | 新增 | 引擎暴露 `isLoadingMore: boolean` state（驱动 SectionChatDetail / message-stream 跳过滚底 effect）；ref → state mirror | MUST：与 isLoadingMoreRef 同步；不改 messages 触发逻辑 | 调研 §1 | +8 |
| ui-chat-paging | app/web/src/components/chat-page/page-chat.tsx | loadMore（既有 fn） | 修改 | 增加 `isLoadingMoreRef` 防重入守卫；调用前 set isLoadingMore=true；finally 清 false；仍然用 `messages[0].id` 作 beforeId | MUST：loadMore 进行中二次调用直接 return；MUST NOT 改 beforeId 取法 | 调研 §1；PRD §2.1 | +8/-2 |
| ui-chat-paging | app/web/src/components/chat-page/page-chat.tsx | sr-only chat-load-more button | 删除 | 删除 sr-only `<button data-testid="chat-load-more">`（testid 迁到 ComponentMessageStream 滚动容器顶部 hidden sentinel，保留 ET 锚点） | MUST：testid `chat-load-more` 保留（不破历史 ET）；MUST NOT 让按钮可见 | PRD §2.1；testid 表 _overview.md §7 | -8/+4 |
| ui-chat-paging | app/web/src/components/chat-page/section-chat-detail.tsx | ChatDetailProps | 修改 | 新增 `hasMore: boolean` / `onLoadMore: () => void` / `isLoadingMore: boolean` 三 prop；透传给 `<ComponentMessageStream>` | MUST：prop 类型与 useSessionRunState 暴露对齐；MUST NOT 在 SectionChatDetail 内部 trigger loadMore（单一职责：透传） | _overview.md §4.5（需补） | +6 |
| ui-chat-paging | app/web/src/components/chat-page/component-message-stream.tsx | MessageStreamProps | 修改 | 新增 `hasMore?: boolean` / `onLoadMore?: () => void` / `isLoadingMore?: boolean` 三 prop | MUST：可选 prop（向后兼容 studio 群聊不传场景） | _overview.md §4.5（需补） | +6 |
| ui-chat-paging | app/web/src/components/chat-page/component-message-stream.tsx | ComponentMessageStream（滚动逻辑） | 修改 | ① 顶部插入 hidden sentinel `<div data-testid="chat-load-more">`（hasMore=true 时渲染）；② scrollRef 加 `onScroll` handler：`scrollTop < threshold(120px) && hasMore && !isLoadingMore → onLoadMore()`；③ 自动滚底 effect 加守卫 `if (isLoadingMore) return`；④ 新增 prepend-保持位置 effect：在 isLoadingMore 从 true→false 时记录 prevHeight → set scrollTop | MUST：threshold=120px（coder 可微调，记入 spec）；MUST NOT 在新消息（非 prepend）触发时跳过滚底；MUST 在 prepend 完成后视觉保持原顶部条目位置（不跳到新加载的旧消息顶） | _overview.md §4.5（需补 prepend+保持位置+跳过滚底）；PRD §2.1 验收标准；原则 #10 | +35/-3 |
| ui-chat-paging | app/web/src/components/studio-page/section-member-chat.tsx | MemberChatPage（分页透传） | 修改 | useSessionRunState 已暴露 messages/hasMore/setMessages；新增 loadMore 复刻 page-chat 同款（用 `messages[0].id` beforeId + prepend）；透传 hasMore/onLoadMore/isLoadingMore 给 ComponentMessageStream | MUST：与 playground 行为一致（同一套分页语义）；MUST NOT 复刻独立分页 API | 调研 §1（subagent/member 单聊同款缺口） | +18 |

> Subagent 只读页（`use-subagent-run-refresh.ts`）同款分页：本版**不实现**（PRD §2.1 仅提 playground+squad 单聊；subagent 只读页 transcript 一般 <50 条，分页收益低）。后续如需可复用同链路。

---

## F2 — 文件 tab 目录监听稳定（后端 + 前端）

> Invariants：① chokidar 'ready' 后 startWatch 才 resolve（5s 超时兜底防 hang）。
> ② `watcher.on('addDir', abs => watcher.add(abs))`（chokidar4 `add()` 同步非 Promise，禁 `.catch()`）。
> ③ subscribe hook 改 async + await（消除 fire-and-forget 竞争）。
> ④ 三时机：session 打开 → subscribe；切目录 → unsubscribe+resubscribe；关闭 → unsubscribe。

### F2 后端修复（对齐 squad_filewatch BUG-005/006 模式）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| session-workspace | app/server/src/agent/session-workspace-manager.ts | SessionWorkspaceManager.startWatch | 修改 | ① 加 `await waitForChokidarReady(watcher, 5000)`（5s 超时兜底，超时也不 reject——继续运行让 watcher 自愈）；② 注册 `watcher.on('addDir', abs => { watcher.add(abs); })`（chokidar4 add 同步禁 .catch） | MUST：超时后仍 resolve（不阻塞 lazy hook 主路径）；MUST NOT 用 await watcher.add(...)（chokidar4 同步返 FSWatcher，await undefined 不会错但语义错）；MUST 在 stopWatch 时清掉 addDir listener（watcher.close 已含） | specs/tech/squad/[P1]squad_filewatch.md §2（BUG-005/006）；specs/tech/agent/session/[P0]session_workspace_manager.md §3/§4（需补 await ready+addDir） | +22/-1 |
| session-workspace | app/server/src/agent/session-workspace-manager.ts | waitForChokidarReady（私有 helper） | 新增 | `function waitForChokidarReady(watcher: FSWatcher, timeoutMs: number): Promise<void>` —— once('ready') + setTimeout race，超时 resolve（不 reject） | MUST：超时 resolve（不抛）；MUST NOT 改 watcher 配置 | squad_filewatch.md §2 BUG-005 | +18 |
| session-workspace | app/server/src/agent/session-workspace-manager.ts | mapKind（既存） | 修改 | 新增 `addDir` 触发 watcher.add（在 handleFsEvent 内分流：addDir kind → 调 watcher.add(absPath)）— **二次防御**（startWatch 的 addDir listener 已挂，本行兜底） | MUST：watcher.add 同步调用，禁 .catch | session-workspace-manager.md §6 | +3 |
| sse-channel | app/server/src/sse/sse-channel.ts | SubscribeHooks（interface） | 修改 | onSubscribe/onUnsubscribe 返回类型改 `void \| Promise<void>`（保留 sync 兼容；caller 可抛 Promise） | MUST：向后兼容（旧 sync 实现仍可）；subscribe/unsubscribe 内 `await hooks.onSubscribe?.(...)` | specs/tech/app/frontend/[P0]sse_channel.md（需补 setSubscribeHooks async） | +2/-2 |
| sse-channel | app/server/src/sse/sse-channel.ts | SseChannel.subscribe（既存） | 修改 | 调 `await this.subscribeHooks.onSubscribe?.(topic, group)` 包裹 try/catch；subscribe 函数签名改 async | MUST：hook 异常不影响订阅本身（已有 try/catch 保留）；MUST NOT 改去重逻辑（subs.has 还在） | sse_channel.md §5 | +5/-2 |
| sse-channel | app/server/src/sse/sse-channel.ts | SseChannel.unsubscribe（既存） | 修改 | 同上，`await hooks.onUnsubscribe?.(...)` | MUST：与 subscribe 对称 | sse_channel.md §5 | +5/-2 |
| bootstrap | app/server/src/bootstrap.ts | setSubscribeHooks 调用 | 修改 | onSubscribe/onUnsubscribe 改 async 函数 + 内部 `await workspaceManager.startWatch(...)` / `await workspaceManager.stopWatch(...)`（消除 `void startWatch` fire-and-forget） | MUST：保留 topic 守卫 `if (topic !== SESSION_PANEL_TOPIC) return`；MUST 保留 extractSessionIdFromGroup；MUST NOT 在 hook 内抛错（catch 内吞） | 调研 §2 根因 4；session_workspace_manager.md §7 | +6/-4 |

### F2 前端修复（订阅覆盖 squad 群聊 + member-chat 接 workspace fan-out）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| studio-member-chat | app/web/src/components/studio-page/section-member-chat.tsx | MemberChatPage（useSessionRunState 接线） | 修改 | useSessionRunState 调用补 `onWorkspaceEvent: (evt) => useChatStore.getState().setLastWorkspaceEvent(evt)`；与 playground 同款 fan-out 链路（chat-slice store 是全局 store，studio 可消费） | MUST：useChatStore 从 `../../store/chat-slice` 导入；MUST NOT 在组件本地维护 second 份 workspace state（store 已全局唯一）；事件归属 sid 守卫已在 ws-panel 内（lastWorkspaceEvent.sessionId === sessionId） | specs/ui/components/chat-page/_overview.md §4.5 既有 fan-out 路径；调研 §2 根因 1 | +3 |
| studio-squad-chat | app/web/src/components/studio-page/section-squad-chat.tsx | SquadChatPage（新增 session_panel 订阅 effect） | 新增（effect） | 新增 useEffect：mount 时 `const sse = new SseClient(); void sse.connect().then(() => sse.subscribe('session_panel', \`session_id:${sessionId}\`, handler))`；handler 仅处理 `session_workspace_file_changed` / `session_workspace_dir_changed` → 调 `useChatStore.getState().setLastWorkspaceEvent(evt)`，其他 type 忽略；cleanup：unsubscribe + sse.destroy | MUST：用独立 SseClient 实例（squad-chat 不跑 useSessionRunState——保留 GET 轮询拉 a2a inbox 不变）；MUST：handler 严格 type 守卫（不污染其他 reducer）；MUST：cleanup 显式 unsubscribe + destroy 防泄露；MUST NOT 在 handler 内更新 messages（仍由 GET 轮询管） | 调研 §2 根因 1（squad 群聊完全不订阅 session_panel）；sse_channel.md §9/§10（订阅生命周期） | +28 |
| studio-squad-chat | app/web/src/components/studio-page/section-squad-chat.tsx | SseClient import + WorkspaceEvent type import | 新增 | import { SseClient } from '../../lib/sse-client'; import type { WorkspaceEvent } from '../chat-page/workspace-types' | MUST：路径与 playground 一致 | sse-client.ts; workspace-types.ts | +2 |

> **F2 订阅方案选型结论**：见下方「架构决策记录 §1」。

---

## F3 — SquadChat 转发 3 段格式（prompt + 删硬编码）

> Invariants：① 转发仍是 send_message 的 content text blocks（**不扩** a2a §5 消息体）。
> ② sender 永远是 SquadChat（reply 走 to=sender.agent.ref 必回群聊；不能改成 sender=原 user）。
> ③ needReply 是顶层字段不进 content；默认 true（v0.0.68 R5 已实现）。
> ④ squad_chat 红线：不改写 user 原文、不创作 answer。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad-chat-prompt | app/server/src/prompts/content/squad/squad_chat.md | 全文重写 | 修改 | 重写「转发」段为 **3 段模板**：`### 说明`（来自群聊 `{squad.name}` + 由 SquadChat router 转发 + 按 needReply 决定是否回复 + 回来源 session）/ `### 原文`（来自 `{sender}`——user 显「user」，否则显 `{name} ({sid})`，原文一字不差）/ `### 相关上下文`（群聊相关上下文，可概括改写）；保留「永不创作 / 永不改写原文」红线；needReply 默认 true（对齐 a2a §4.2 缺省） | MUST：3 段标题字面保留（vision_check 段标题断言用）；MUST：原文段「一字不差」红线；MUST NOT 改 send_message 工具签名；MUST NOT 创作新内容字段 | PRD §2.3；a2a_protocol.md §4.2；调研 §3 | +28/-7 |
| squad-chat-prompt | app/server/src/prompts/content/squad/leader.md | 接收转发处理段（追加） | 修改 | 末尾追加段落：收到 SquadChat 转发按「### 说明」段决定是否回复；回复走 `send_message(to=SquadChat)`（即 sender.agent.ref）即回群聊；不接受原文外二次转述 | MUST：与 squad_chat.md 3 段模板呼应；MUST NOT 引入新工具 | PRD §2.3；a2a_protocol.md §4.1/§4.4 | +6 |
| squad-chat-prompt | app/server/src/prompts/content/squad/mate.md | 接收转发处理段（追加） | 修改 | 同 leader.md（mate 收到转发同款规则） | MUST：与 leader.md 同步 | PRD §2.3 | +6 |
| squad-handler-config | app/server/src/handlers/session-config.ts | STUDIO_SQUAD_ROUTER_SYSTEM_PROMPT（const） | 删除 | 删除整段常量（55-56 行）+ systemPrompt 三分支中 squad 分支（237-240 行）改由 squad_role mapper / builder 出 system prompt（leader/mate 走 '' 由 builder 覆盖，squad router 同款 → '' 由 builder 注入 squad_chat.md） | MUST：grep `STUDIO_SQUAD_ROUTER_SYSTEM_PROMPT` 0 残留；MUST：squad router 的 systemPrompt 由 system-prompt-builder 经 squad_role mapper 注入 squad_chat.md（与 leader/mate 同链路，对齐架构原则「单一 system prompt 构建链」）；MUST NOT 保留任何硬编码 squad system prompt | 调研 §3（A 路 vs B 路矛盾）；specs/tech/squad/[P1]agent_squad_chat.md §2（system prompt 构建链）；specs/tech/squad/[P1]prompt_sections.md §3.1（squad_role mapper） | -15/+3 |
| squad-handler-config | app/server/src/handlers/session-config.ts | buildSessionConfigFromDeps（systemPrompt 分支） | 修改 | systemPrompt 三分支表里删除 `kind.role === 'squad'` 单独分支——squad 与 leader/mate 一并走 `systemPrompt = ''`，由 builder 经 squad_role mapper 注入对应 .md（leader.md/mate.md/squad_chat.md） | MUST：mapper 必须支持 role='squad'（已支持，squad_role mapper §3.1 表含 squad）；MUST：单元测试更新（session-config-studio.test.ts:112 那条 systemPrompt='' 占位的注释保留 + 补 squad 同款） | prompt_sections.md §3.1；agent_squad_chat.md §2 | +3/-3 |

> needReply 默认 true：v0.0.68 R5 已实现（send-message-tool.ts schema + normalize `?? true` 兜底）——本版**纯 spec 同步**（`specs/tech/multi_agent/[P1]a2a_protocol.md §4.2` 已是 default:true，无代码改动；doc-modifier 阶段 5 同步 subagent_derivation §5）。

---

## F4 — Studio 红点（前端，后端已广播）

> Invariants：① 后端 unread CAS 路径不动（产生=session 层 markUnreadTrue；消除=POST /read CAS false）。
> ② studio 与 playground reducer 互不串扰（biz 守卫双向）。
> ③ 红点显示/消失完全由 unread prop 驱动（GET /session + session_meta SSE 实时刷）。

### F4 — unread CAS 路径核对结论（架构师核对，见「架构决策记录 §3」）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| studio-sidebar | app/web/src/components/studio-page/page-studio.tsx | PageStudio（session_meta 订阅 effect） | 修改（新增 effect + state） | ① 新增 state `unreadMap: Record<string, boolean>`（key=sessionId）；② mount effect：new SseClient → connect → `subscribe('session_meta', '_all', handler)`；handler 反向守卫 `if (incoming.biz !== 'studio') return`（仅收 studio session meta），按 `data.id` 更新 unreadMap；③ cleanup unsubscribe + destroy；④ 初始化：GET `/session?biz=studio`（如 API 支持）或复用 detail.members 各 session unread 字段构建初始 unreadMap | MUST：biz 守卫方向（playground reducer 是 `if(incoming.biz==='studio') return`，studio 是反向 `if(incoming.biz!=='studio') return`，**双向隔离**）；MUST：SseClient 独立实例（与 playground sharedSse 隔离，避免 handler 互覆盖）；MUST：cleanup 防泄露；MUST NOT 调任何持久化 API 改 unread（只读） | specs/tech/app/frontend/[P0]sse_channel.md §10（session_meta 广播）；specs/tech/agent/session/[P0]session_state.md §6（unread 模型）；调研 §4；chat-slice.ts:120-137（参照 playground reducer 守卫） | +38 |
| studio-sidebar | app/web/src/components/studio-page/page-studio.tsx | PageStudio.onOpenChat（既存 arrow fn） | 修改 | onOpenChat 回调内追加 `markSessionRead(node.sessionId)`（POST /session/:id/read，fire-and-forget catch console.warn）；同时本地 setState unreadMap 清零（乐观更新，SSE markRead 的 session_meta_update 会兜底） | MUST：markSessionRead 从 `../../lib/chat-api` 导入（已存在）；MUST：fire-and-forget（不阻塞切 chat）；MUST NOT 在看板节点（kind='board'）调 markRead（看板无 sessionId） | api/overall/04-agent-session.md §2.3.1（POST /read 契约）；session_state.md §6.3 不变量 2（markRead 唯一消除入口） | +6 |
| studio-sidebar | app/web/src/components/studio-page/section-studio-sidebar.tsx | StudioSidebarProps | 修改 | 新增 prop `unreadMap: Record<string, boolean>`（key=sessionId）+ `activeChatSessionId?: string`（当前打开的 chat 节点 sessionId，active 时不显红点）；透传给 SquadTree | MUST：prop 透传链路 page-studio → StudioSidebar → SquadTree → TreeChild；MUST NOT 在 StudioSidebar 内部维护 unreadMap（单一数据源 page-studio） | specs/ui/components/studio-page/studio-sidebar.md（需补 unread prop） | +6 |
| studio-sidebar | app/web/src/components/studio-page/component-squad-tree.tsx | SquadTreeProps | 修改 | 新增 `unreadMap: Record<string, boolean>` + `activeChatSessionId?: string` prop；透传给内部 TreeChild（按 sessionId 查 unreadMap）；BoardNode 不接（看板无 sessionId，本版不加红点） | MUST：BoardNode 不加红点（PRD 非目标）；MUST NOT 在 SquadTree 内派生 unread（直接 prop） | studio-sidebar.md；PRD §2.4 非目标（看板节点不加红点） | +5 |
| studio-sidebar | app/web/src/components/studio-page/component-squad-tree.tsx | TreeChild（component） | 修改 | ① 接受新 prop `unread?: boolean` + `active?: boolean`；② 渲染红点 DOM：条件 `unread && !active` → `<span data-testid={`squad-tree-session-${sessionId}-unread-dot`} className="absolute top-2 right-2 w-[7px] h-[7px] rounded-full bg-[#DC2626]" />`；③ 行 position 改 relative（红点 absolute 锚定） | MUST：testid 字面 `squad-tree-session-{sessionId}-unread-dot`（与 studio-sidebar.md testid 族对齐）；MUST：红点颜色 `#DC2626`（与 playground conv-item-unread-dot 同色）；MUST：仅 unread && !active 渲染（已在看的会话不显）；MUST NOT 给 BoardNode 渲染红点 | conv-item 红点（chat-page/_overview.md §4.2 + §8 #DC2626）；session_state.md §6；studio-sidebar.md testid 族 | +14 |

> **F4 unread CAS 路径核对结论**：见「架构决策记录 §3」。

---

## F5 — Squad UI 尺寸对齐（纯 CSS）

> Invariants：① 视觉基线对齐 playground conv-item（padding/字号/首字母头像）。
> ② member-card 不改（卡片非列表行）。
> ③ subagent 本版不派生（沿用 studio-sidebar.md 既有声明）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad-tree-ui | app/web/src/components/studio-page/component-squad-tree.tsx | TreeChild（视觉对齐） | 修改 | ① 行 padding `py-1.5 pl-7 pr-2.5` → `px-3 py-2.5`（对齐 conv-item `px-3 py-2.5 rounded-lg mb-0.5`）；② dot 14×14 `<span>` 替换为 `<MemberAvatar size="sm" />`（leader/mate/squad 三种 role 通过 MemberAvatar 渲染）；③ name `text-[12.5px] text-fg-2` → `text-[13px] font-medium text-fg-2`（对齐 conv-item title） | MUST：与 MemberAvatar role 三档对齐（leader=accent / mate=gold / squad=渐变）；MUST：行高度变化允许（视觉对齐优先于像素一致）；MUST NOT 改 member-card（卡片不在范围） | PRD §2.5 视觉基线对齐表；chat-page/_overview.md §4.2（conv-item 视觉基线 px-3 py-2.5 / text-[13px] font-medium）；common/member-avatar.md | +6/-5 |
| squad-tree-ui | app/web/src/components/studio-page/component-squad-tree.tsx | BoardNode（同步 padding/字号） | 修改 | padding `py-1.5 pl-7 pr-2.5` → `px-3 py-2.5`；name `text-[12.5px]` → `text-[13px] font-medium`；dot 沿用现有渐变方框（target 图标）——**不改 dot 形态**（看板节点无 member 角色，不用 MemberAvatar） | MUST：与 TreeChild padding/字号同步；MUST NOT 用 MemberAvatar（看板无 member 身份） | PRD §2.5；studio-sidebar.md（BoardNode 视觉基线） | +2/-2 |
| squad-tree-ui | app/web/src/components/studio-page/component-squad-tree.tsx | dotStyle（既存 helper） | 删除 | dotStyle 函数删除（TreeChild 改用 MemberAvatar，不再需要 inline style 背景） | MUST：grep 0 残留；MUST NOT 删除 BoardNode 的 inline style（看板渐变方框仍需） | PRD §2.5 | -7 |
| squad-tree-ui | app/web/src/components/common/member-avatar.tsx | MemberAvatarRole（type） | 修改 | role 联合类型加 'squad'：`'leader' \| 'mate' \| 'user' \| 'squad'` | MUST：联合类型扩展（向后兼容）；MUST NOT 改其他 role 已有底色 | PRD §2.5；common/member-avatar.md（需补 role='squad' 渐变底 sm 档） | +1/-1 |
| squad-tree-ui | app/web/src/components/common/member-avatar.tsx | bgColor（既存 helper） | 修改 | 加 role='squad' 分支：返回 CSS `linear-gradient(135deg, var(--color-accent), var(--color-gold))` | MUST：渐变 135° accent→gold（对齐 squad_chat dotStyle 既有渐变方向）；MUST NOT 改 leader/mate/user 已有底色 | component-squad-tree.tsx:43-48 dotStyle（squad 渐变）；PRD §2.5 | +2 |
| squad-tree-ui | app/web/src/components/common/member-avatar.tsx | initialOf（既存 helper） | 修改 | role='squad' 兜底字符：群聊无首字母 → 渲染固定 '#' 或 SquadChat 头字母 'S'（coder 定，spec 注明）。建议 squad → 取 squad.name 首字母（caller 传 name='squad.name'） | MUST：兜底字符与 leader/mate 一致逻辑（取 name 首字母，空名兜底）；MUST：sm 档字距合理 | common/member-avatar.md | +1/-1 |

---

## 影响面评估

### 跨模块影响

- **F1（前端）**：useSessionRunState（playground + studio member-chat 共享引擎）+ page-chat + section-chat-detail + component-message-stream + section-member-chat。**风险**：component-message-stream 是共享渲染内核，onScroll 新增需保证 studio 群聊（不传 hasMore）和 subagent 只读页（不传 hasMore）零回归。
- **F2（后端 + 前端）**：SessionWorkspaceManager（核心修复）+ bootstrap hook + sse-channel 接口 + studio squad/member chat 接线。**风险**：sse-channel 接口变更（sync → async）影响所有 hook 调用方（仅 bootstrap 一处，可控）；chokidar ready 超时兜底逻辑需 UT 覆盖。
- **F3（prompt + 配置）**：squad_chat.md + leader.md + mate.md + session-config.ts。**风险**：删 STUDIO_SQUAD_ROUTER_SYSTEM_PROMPT 后 squad router 的 system prompt 完全依赖 builder/mapper —— 必须确认 builder 对 role='squad' 走 squad_role mapper 注入 squad_chat.md（mapper 已含 squad 分支，spec prompt_sections.md §3.1 已声明）。
- **F4（前端）**：page-studio + section-studio-sidebar + component-squad-tree。**风险**：SseClient 独立实例（page-studio 一条）资源管理需谨慎（cleanup 防泄露）；biz 守卫方向错位会导致 studio 收 playground meta 反向污染（双向守卫必须对齐）。
- **F5（CSS）**：component-squad-tree + common/member-avatar。**风险**：MemberAvatar 接 role='squad' 需保证 sm 档视觉合理（14×14 内文字适配）。

### 破坏性变更

- **sse-channel SubscribeHooks 接口**：返回类型 `void → void | Promise<void>`（向后兼容；caller 需 await）。
- **删除 STUDIO_SQUAD_ROUTER_SYSTEM_PROMPT 常量**：grep 0 残留 + 测试更新（session-config-studio.test.ts 相关 systemPrompt 占位注释需补 squad 同款）。

### 依赖顺序

- F2 后端（session-workspace-manager + bootstrap + sse-channel）独立，可先做。
- F2 前端依赖后端修复（chokidar ready）才能真正稳定。
- F1/F4/F5 前端独立，可并行。
- F3 prompt + handler 独立。

---

## 架构决策记录

### §1 F2 订阅上提方案选型（采纳 = 最小改动方案）

**3 个候选**：

| 方案 | 描述 | 优 | 劣 |
|---|---|---|---|
| **a. ws-panel 自身持有 session_panel 订阅** | SectionWorkspacePanel mount 时 subscribe + handler 处理 workspace event 本地化，playground/studio/squad 群聊全覆盖 | 与 chat 类型解耦最彻底 | 与 useSessionRunState 现有 session_panel 订阅冲突（SseClient 单 handler per (topic,group)）→ 必须改 useSessionRunState 接口（subscribe 改为接收父级注入事件），改动面大、回归风险高 |
| **b. **(采纳)** squad-chat 独立 SseClient + member-chat 补 onWorkspaceEvent** | squad-chat mount 时 new SseClient → connect → subscribe session_panel（独立实例避免 handler 冲突）；member-chat 补一行 onWorkspaceEvent 接 store.setLastWorkspaceEvent | 最小改动（不动 useSessionRunState 接口、不动 ws-panel）；三种 chat 都覆盖；squad-chat 独立实例与 playground/member 的 SSE 实例隔离互不干扰 | squad-chat 多一条 SSE 连接（资源浪费可接受——squad-chat 是长生命周期页面）；后端 SseChannel subs Map 单订阅去重 + onSubscribe hook 仅 0→1 触发一次（幂等，不会重复 startWatch） |
| c. squad-chat 改用 useSessionRunState（替代 GET 轮询） | squad-chat 接 SSE 主驱动 | 统一订阅路径 | a2a inbox 收到的消息**不走 agent_loop**（走 deliverTo 写 inbox），SSE 看不到 → 必须保留 GET 轮询；切到 SSE 后 messages 双源（SSE + GET）易冲突 |

**结论采纳 b**：最小改动、风险最低、不动既有接口。**关键事实**：SseChannel 后端 subs Map 单订阅 per key 去重（`if (this.subs.has(key)) return`）→ 多 SseClient 实例 subscribe 同一 (topic, group) 后端不会重复登记 listener，但多 listener 各自 fan-out（hub.sub 注册多个）→ 前端多 handler 都会收到同一帧。squad-chat handler 严格 type 守卫（仅 workspace event）即可。

### §2 F3 硬编码 STUDIO_SQUAD_ROUTER_SYSTEM_PROMPT 删除安全性

**安全性核对**：
1. squad_role mapper（`specs/tech/squad/[P1]prompt_sections.md §3.1`）已声明对 role='squad' 注入 squad_chat.md（mapper 表含 squad 分支）。
2. system-prompt-builder 在 assemble pipeline 覆盖空字符串 systemPrompt（v0.0.64 P1 已落地，DEFAULT_SYSTEM_PROMPT 删除）。
3. 删除后 squad router 的 systemPrompt 由 builder → squad_role mapper → squad_chat.md 注入，**与 leader.md/mate.md 同链路**（架构原则「单一 system prompt 构建链」）。
4. 测试影响：`handlers/__tests__/session-config-studio.test.ts:112`（systemPrompt='' 占位注释）保留 + 补 squad 同款注释。

**安全性结论**：删除安全。spec 同步：`specs/tech/squad/handler/session-config.ts`（或对应 spec）补「squad router systemPrompt 由 squad_role mapper 统一注入，不再硬编码」。

### §3 F4 unread CAS 路径核对结论

**核对源**：`specs/tech/agent/session/[P0]session_state.md §4.4 / §6` + `specs/tech/app/frontend/[P0]sse_channel.md §10` + chat-slice.ts:120-137 + session-meta-broadcaster.ts。

**结论**：
1. **后端 unread CAS 路径已通用**：`SessionUnreadRuntime` 订阅 statusBus `session_status_update(state→idle|error)` completion 信号 + 查 `isSessionActive(sid)` → CAS `unread: false→true` —— **session 层不区分 biz**（playground/studio session 同走此路径）。
2. **SessionMetaBroadcaster 已广播 studio session 的 unread meta**：`session-meta-broadcaster.ts:87-99` 序列化 `biz` 字段（按 session record 镜像）—— studio session 的 biz='studio' 已在广播 payload 中。**只是 studio 前端无人订阅**。
3. **markRead（POST /session/:id/read）后端通用**：handler 不区分 biz —— studio session 同样可调，CAS `unread: true→false` + emit `session_read_update` → broadcaster.broadcast。
4. **playground 列表隔离守卫已对**：chat-slice.ts:129 `if (incoming.biz === 'studio') return` —— studio session meta 不污染 playground 列表。**studio 侧新建订阅需反向守卫** `if (incoming.biz !== 'studio') return` —— 双向隔离。

**F4 实现路径**：纯前端（page-studio 新增 session_meta 订阅 + reducer + 渲染 + onOpenChat markRead）；后端零改（已就绪）。

---

## spec↔code 偏离 / coder 注意点（架构师核对发现）

1. **`useSessionRunState.isLoadingMore` 是新增 state**（不是 ref）—— 因驱动 SectionChatDetail / message-stream rerender 跳过滚底 effect，必须 state；ref 仅内部防重入。两者同步。
2. **chat-slice.lastWorkspaceEvent 是全局 store**（不是 per-session）—— studio member-chat / squad-chat 直接 `useChatStore.getState().setLastWorkspaceEvent(evt)` 即可（不需要在 studio 自建 store）。ws-panel 内已有 `lastWorkspaceEvent.sessionId !== sessionId` 守卫，不会跨 session 误触发。
3. **SseChannel.subs.has 去重 + 多 listener fan-out**：后端 `subscribe` 内 `if (this.subs.has(key)) return` 不重复登记 listener，但 `hub.sub` 已注册的 listener 仍会向所有 SseSink 推送 —— 前端多 SseClient 实例都能收到同一 SSE 帧（这是 F2 方案 b 成立的基础）。
4. **squad-chat.md 当前提到的 needReply=true 是 LLM prompt 内的指引**（不是 schema 层）—— schema 层 needReply 默认 true 在 send-message-tool.ts 已实现（v0.0.68 R5），spec `a2a_protocol.md §4.2` 已对齐。F3 prompt 重写时 needReply 描述仍写「默认 true」即可。
5. **session-config.ts systemPrompt 分支**：删除 squad 硬编码分支后，squad 与 leader/mate 一并走 `systemPrompt = ''` —— 必须 verify builder 对 kind.role='squad' 注入 squad_chat.md（mapper §3.1 已声明含 squad 分支）。**coder 实现时 grep 确认 builder 在 role='squad' 时调 squad_role mapper 注入对应 .md**；如未注入，需补 mapper 分支（偏离记入 change_log）。
6. **component-message-stream onScroll threshold**：120px 是建议值，coder 可视实测微调（记入 spec），但**必须**有 threshold（不能裸 `scrollTop === 0`，否则边界跳变 flaky）。

---

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- spec↔code 偏离（spec 概念表达与代码实际不符）：coder 按代码实际调整 + 汇报 → orchestrator 记 doc-sync 待办 → doc-modifier 阶段 5 统一改 spec
