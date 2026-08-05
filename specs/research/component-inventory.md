# 动态页面组件清单 + 数据源 + 数据流（v0.0.94 Part 2 现状梳理）

- **调研范围**: playground/chat-page + studio/studio-page 两个动态页 + 列表，盘组件数 / 数据源 / 数据格式 / 页面↔组件↔数据关系
- **调研对象**: dev1 主仓库 `app/web/src/components/{chat-page,studio-page}` + `app/web/src/store/` + `app/web/src/lib/`
- **调研日期**: 2026-07-08
- **版本**: v0.0.94.part2_inventory（read-only，不改代码）
- **输入文档**: `specs/research/sse_lifecycle_audit.md`（§1 现状总表 + §1.3 API 数据）/ `specs/research/sse_research.md`（§3 订阅方 + §1 topic 数据形态）
- **下游消费**: v0.0.94 Part 3 迁移方案（组件 = 视觉；数据 hook = useLifecycle）

---

## §0 一句话结论

**两个动态页 = 35 个组件 + 5 个 hook + 2 个全局 store slice**。SSE 主驱动（agent_loop + session_panel + session_meta 三 topic，subId 路由）已经覆盖 chat 类页面（playground + member/squad chat 共享 useSessionRunState 引擎）；剩余的 polling（cron 60s / budget 30s）、GET-once（workspace tree / memory list / summary / squad detail / board）和命令式 API（subagent children per-call）才是 Part 3 迁移 useLifecycle 的真正目标。已迁 4 个（✓ in audit §7.3 表），剩余 8 个待迁候选。**数据流主轴：API/SSE → useSessionRunState 引擎 / 全局 chat-slice store / 组件 local state → 组件 props 喂下游**。

---

## §1 跨页基础（数据源层）

### 1.1 全局 store（zustand）2 个 slice

| slice | 文件 | 字段 | 谁读 | 谁写 | 跨页保留? |
|---|---|---|---|---|---|
| **chat-slice**（playground 专属，biz 守卫拒 studio） | `app/web/src/store/chat-slice.ts` | `sessions[]` / `activeSessionId` / `lastWorkspaceEvent` / `lastWorkspaceEventAt` / `childrenByParent` / `activeSubId` | page-chat, section-conv-panel, section-workspace-panel, component-subagent-tree | usePageChatMount(setSessions/applySessionMetaEvent) / useSessionRunState 回调(setLastWorkspaceEvent/setSessionUnread) / useSubagentChildren(setChildren) / page-chat(setActiveSession/setActiveSubId) | **保留**（跨页不释放，设计如此——切回不重拉） |
| **view-store**（视图态，跨页共享） | `app/web/src/store/view-store.ts` | `view` / 等 | app-shell NavRail | NavRail setView | 保留 |

**chat-slice reducer 守卫**：`chat-slice.ts:129` `if (incoming.biz === 'studio') return;`（playground 拒纳 studio meta，与 use-studio-unread-meta 反向守卫双向隔离）。

### 1.2 SSE 单例 + 三 topic

| topic | group 命名 | 数据形态 | 订阅方 |
|---|---|---|---|
| **`session_meta`** | `_all`（全局广播） | `SessionMetaUpdateEvent`：`{id, sessionId, type:'session_meta_update', createdAt, data: Session(全量最新态)}`；reducer 按 data.id 整条替换 | usePageChatMount（playground 列表，biz='playground' 守卫）/ **useStudioUnreadMeta（违规独立 SseClient，studio 红点）** |
| **`agent_loop`** | `session_id:<sid>_amt:current` | `AgentEvent` discriminated union：`message_start` / `text_delta` / `tool_call_delta` / `run_start` / `run_end` 等；reducer `applyAgentEventToMessages` 按 message+part key 累积 | useSessionSseSubscribe（playground shared 引擎）/ SquadChatPage（群聊直接订阅） |
| **`session_panel`** | `session_id:<sid>` | `SessionEvent` discriminated union：`session_status_update` / `session_usage_update` / `summary_task_update` / `messages_cleared` / `session_workspace_file_changed` / `session_workspace_dir_changed` / `session_read_update` | useSessionSseSubscribe（playground + member chat 共享）/ SquadChatPage（群聊直接订阅，仅 workspace event 透传 store） |

**SSE 单例位置**：`app/web/src/lib/sse-singleton.ts:23` `getSseClient()` lazy 模块级单例（非 React Context，避 StrictMode 双 mount）。
**违规破口**：`use-studio-unread-meta.ts:46` `new SseClient()` 独立实例 + `:95 sse.destroy()`（详 sse_research.md §6 G1）。

### 1.3 chat-api / squad-api 端点清单（数据源枚举）

| 端点 | 用途 | 调用方 |
|---|---|---|
| GET /session | 顶层 session 列表（含 unread） | usePageChatMount |
| GET /session/:id | 单 session 详情（running/state） | useSessionSseSubscribe（run_end 校正） |
| GET /session/:id/messages?limit&beforeId | transcript 基线 + 分页 | useSessionSseSubscribe（初始）/ page-chat loadMore（分页）/ SquadChatPage fetchOnce |
| GET /session/:id/usage | token usage 快照 | useSessionSseSubscribe / SquadChatPage fetchOnce |
| GET /session/:id/children | subagent tree（running/terminated 分组） | useSubagentChildren |
| GET /session/:id/summary | transcript summary（角色长期记忆） | MemberPanelMemory |
| POST /session/:id/messages | 发消息 | page-chat / SquadChatPage / MemberChatPage |
| POST /session/:id/abort / compact / clear / read | run 控制 | page-chat / useSessionRunState.abort |
| POST /session（建）/ DELETE /session/:id / PUT /session（改名/改 model/workspaceDir） | 列表 CRUD | page-chat handlers |
| GET /memory/session?sessionId | session scope 长期记忆 list | useMemoryCrud（SectionMemoryPanel） |
| GET /memory/user | user scope 长期记忆 list | useMemoryCrud（section-user-memory，本次范围外） |
| POST/PATCH/DELETE /memory/:scope | memory CRUD | useMemoryCrud |
| GET /session/:sid/cron | cron 列表 | SectionCronPanel |
| POST/DELETE /session/:sid/cron(/enable\|disable) | cron CRUD | SectionCronPanel |
| GET /workspace/tree?sessionId[&parent] | workspace 目录树（lazy） | SectionWorkspacePanel |
| POST /workspace/open / pick | 打开/选目录 | SectionWorkspacePanel |
| GET /squad | squad 列表 | PageStudio |
| GET /squad/:id | squad 详情（成员+charter+预算+model default） | PageStudio / StudioSidebar（懒缓存） |
| POST/PATCH /squad / PUT /squad/:id/charter | squad CRUD | PageStudio |
| POST/bench/deploy /squad/:id/member | member CRUD | PageStudio |
| PATCH /squad/:id/member/:mid | member 字段（model/skills/prompt） | MemberChatPage / MemberPanel |
| GET /budget/usage?squadId | team daily token 用量 | BudgetMeter |
| GET /board?squadId&view=all&zone=active\|archive | 看板 goals/requirements/tasks | SquadBoard |
| POST/PATCH /board + archive/restore | 看板 entity CRUD | SquadBoard |

---

## §2 playground / chat-page

### 2.1 整体结构（`page-chat.tsx:270-322`）

```
PageChat
├── <SectionConvPanel>                // 220px 左栏
│   └── <ComponentConversationItem>*  // 顶层 session 行（含展开树）
│       └── <ComponentSubagentTree>   // running + terminated 分段
├── <SectionChatDetail>               // 中间主区
│   ├── topbar (title + usage + compact + clear)
│   ├── <ComponentEmptyState> (空会话欢迎 hero) | <ComponentMessageStream>
│   │   └── <ComponentToolBatch>* / <ComponentToolCallItem>* / on-message spinner
│   └── input-bar: <ComponentRunStateBar> + <ChatComposer> + <InputModelPicker> + send + <ComponentRunStateAbortSlot>
│       └── <ComponentMentionPopover> (Tiptap @ mention)
│   └── <ComponentClearConfirmModal>
└── <SectionWorkspacePanel>           // 右侧栏（activeSessionId && 时挂）
    ├── <ComponentWsResizeHandle>
    ├── <ComponentWsTabBar>           // 3 tab: workspace | memory | cron
    ├── tab='workspace': <ComponentWsPathBar> + <ComponentWsFileTree>（→ <ComponentWsTreeItem>*）
    ├── tab='memory': <SectionMemoryPanel>
    │   └── <ComponentMemoryEntryCard>* + <ComponentMemoryEditorModal>
    └── tab='cron': <SectionCronPanel>
        └── <ComponentCronJobCard>* + <ComponentCronNewForm> + 删除确认 dialog
```

引擎 hook（不在 JSX）：`usePageChatMount` / `useSessionRunState`(→ `useSessionSseSubscribe`) / `useSubagentChildren` / `useSubagentRunRefresh` / `useModelRestore`。

### 2.2 区域：会话列表（左 220px）

**组件清单**：

| 组件 | 数据源 | 数据格式（关键字段） | 拥数据? | 当前生命周期 | file:line |
|---|---|---|---|---|---|
| `SectionConvPanel` | props（父 page-chat 从 store 注入 sessions/childrenByParent/activeId/activeSubId） | `Session[]` + `ChildrenView` + activeId | ❌（纯展示 shell） | — | `chat-page/section-conv-panel.tsx:46-141` |
| `ComponentConversationItem` | props（父级透传单条 session + childrenView）+ local state（expanded/editMode/contextMenu） | `Session{id,title,titled,role,derivation,unread,biz,parentSessionId,...}` | ⚠️ local state only（行级展开/编辑态）；**sessions 数据在 store** | 行内 useEffect expand 时调 onRefreshChildren→useSubagentChildren per-call | `chat-page/component-conversation-item.tsx:1-200`（pollRef dead code :101-108） |
| `ComponentSubagentTree` | props（running/terminated SubagentNode[]） | `SubagentNode{id,title,state,updatedAt,...}`；`ChildrenView={running:[],terminated:[],parentId}` | ❌（纯展示） | — | `chat-page/component-subagent-tree.tsx:1-60+` |
| `usePageChatMount` ✓已迁候选 | **GET /session**（listSessions）+ **SSE session_meta `_all`** | Session[]（meta 广播 reducer 整条替换） | ✓（page-chat 列表的唯一数据源） | useEffect mount：GET 一次 + getSseClient().subscribe；cleanup unsubscribe 句柄（不 destroy 单例） | `chat-page/use-page-chat-mount.ts:56-108` |
| `useSubagentChildren` ✓已迁候选 | **GET /session/:id/children**（命令式 per-call） | `ChildrenView{parentId,running:SubagentNode[],terminated:SubagentNode[]}` | ⚠️ 写入 store.childrenByParent（全局，不随 unmount 释放） | useCallback refreshChildren(parentSid)→setChildren；fetchedRef Set 去重 | `chat-page/use-subagent-children.ts:21-39` |

**页面↔组件↔数据关系**：
1. `usePageChatMount` mount 时 GET /session → `store.setSessions(list)`；同时 SSE subscribe `session_meta _all` → `applySessionMetaEvent` 整条替换 sessions[]。
2. `page-chat` 从 store 选 `sessions` / `activeSessionId` / `childrenByParent` / `activeSubId` 透传给 `<SectionConvPanel>`。
3. `SectionConvPanel` 把每条 session + parent.childrenView 透传给 `<ComponentConversationItem>`，后者展开时渲染 `<ComponentSubagentTree>`（数据全来自 props，不自己拉）。
4. subagent meta 到达时 usePageChatMount 回调内调 `refreshChildren(parentSid)` → useSubagentChildren per-call GET → store.childrenByParent 更新 → 组件 store 订阅 rerender。

### 2.3 区域：会话详情（中间主区）

**组件清单**：

| 组件 | 数据源 | 数据格式（关键字段） | 拥数据? | 当前生命周期 | file:line |
|---|---|---|---|---|---|
| `SectionChatDetail` | props（messages/runActive/loadingPhase/usage/summaryTask/model 等 全由父 page-chat 注入） | `Message{id,role,parts[]}` / `SessionUsageView{input,total,...}` / `SummaryTaskStatus{state,...}` | ❌（纯展示 + shell） | — | `chat-page/section-chat-detail.tsx:103-300` |
| `ComponentMessageStream` | props messages + runActive + loadingPhase | `Message[]`（按 id 排序，含 role='tool'）；part 类型 union | ❌ | — | `chat-page/component-message-stream.tsx` |
| `ComponentRunStateBar` | props sessionRunning + enqueueItems | `EnqueueItem{enqueueId,...}[]` | ❌ | — | `chat-page/component-run-state-bar.tsx` |
| `ComponentRunStateAbortSlot` | props sessionRunning + sessionState | `'running'\|'interrupting'` | ❌ | — | 同上 |
| `ComponentUsagePanel` | props usage | SessionUsageView | ❌ | — | `chat-page/component-usage-panel.tsx` |
| `ComponentEmptyState` | 无（onNewConversation 触发父 handleCreate） | — | ❌ | — | `chat-page/component-empty-state.tsx` |
| `ComponentClearConfirmModal` | local open state | — | ⚠️ local | useState | `chat-page/component-clear-confirm-modal.tsx` |
| `ChatComposer` | local Tiptap editor state + props sessionId | string（mention 以 `<mention>` 标签嵌入） | ⚠️ local editor | useState + useRef | `chat-page/component-chat-composer.tsx` |
| `ComponentMentionPopover` | local query + debounce setTimeout | `MentionItem[]` | ⚠️ local | ⚠️ debounce setTimeout 未在 unmount clear | `chat-page/component-mention-popover.tsx:85,134,156` |
| `InputModelPicker` | props model + useProviders() | `ModelSelection{providerId,modelId}` | ❌（受控） | — | `chat-page/component-input-model-picker.tsx` |
| `useSessionRunState`（引擎壳） | 内部 useSessionSseSubscribe；外部 onWorkspaceEvent/onSessionRead 回调 | — | ✓ 引擎（messages/runActive/usage/summaryTask 唯一数据源） | — | `chat-page/use-session-run-state.ts:99-199` |
| `useSessionSseSubscribe`（SSE 主驱动） | **SSE agent_loop + session_panel** + **GET /messages + GET /session + GET /usage** | AgentEvent / SessionEvent / Message[] | ✓（订阅 + 初始 GET 三连） | useEffect [sessionId]：GET 三连 → subscribe 双 topic；cleanup 句柄 unsubscribe | `chat-page/use-session-sse-subscribe.ts:62-195` |
| `useModelRestore` | **GET /session**（隐式，setModel 后 PUT /session 持久化） | ModelSelection | ✓（model 选中态 + 渲染时机回填） | useLayoutEffect 同帧清 + useEffect 异步回填 + token 守卫 | `chat-page/use-model-restore.ts:50-99` |
| `useSubagentRunRefresh` | meta 事件回调 + setMessages | — | ❌（per-event） | useCallback | `chat-page/use-subagent-run-refresh.ts:1-95` |

**页面↔组件↔数据关系**：
1. `useSessionRunState(viewedSessionId, opts)` 是引擎；`viewedSessionId = activeSubId ?? activeSessionId`（兼顾 subagent 只读页）。
2. 引擎内 `useSessionSseSubscribe[sessionId]` effect：① `useLayoutEffect[sessionId]` reset 同步清 messages/runActive/usage（防 paint 错位）→ ② GET /messages + GET /session + GET /usage 顺序拉初值 → ③ getSseClient().subscribe(agent_loop + session_panel)。
3. SSE 帧到达：`agent_loop` → 纯 reducer `applyAgentEventToMessages(messages, evt, ctxRef, slice)` → setState 存快照；`session_panel` → 按 type 分流（status_update 改 sessionRunning、usage_update 改 usage、summary_task_update 改 summaryTask、workspace_* 转发 store、session_read_update 转父回调）。
4. 引擎返回 `messages/runActive/usage/...` → page-chat 解构 → 透传给 `<SectionChatDetail>` props → 子组件纯展示。
5. workspace SSE 事件经 `onWorkspaceEvent` 回调写入 `store.lastWorkspaceEvent` → `<SectionWorkspacePanel>` 订阅此字段 dispatch 到 wsReducer。
6. session_read_update 经 `onSessionRead` 回调写入 `store.setSessionUnread(sid, false)`（红点消失）。

### 2.4 区域：右侧 Workspace / Memory / Cron（`SectionWorkspacePanel`）

**组件清单**：

| 组件 | 数据源 | 数据格式（关键字段） | 拥数据? | 当前生命周期 | file:line |
|---|---|---|---|---|---|
| `SectionWorkspacePanel` ✓已迁候选 | **GET /workspace/tree**（mount/切 sid/手动刷新/dir_changed/stale）+ 订阅 `store.lastWorkspaceEvent` | `WsTreeResponse{workspaceDir, tree: WsTreeNode[]}`；`WorkspaceEvent{type:'session_workspace_file_changed'\|'dir_changed',sessionId,path,...}`；reducer state `{workspaceDir,tree,childrenCache,expanded,stalePaths,loading}` | ✓（workspace tree + 缓存 + stale 标记） | useReducer(wsReducer)；useEffect[sessionId]：dispatch('fresh')+GET+cancelled flag；useEffect[lastWorkspaceEvent,sessionId]：dispatch file-changed/dir-changed | `chat-page/section-workspace-panel.tsx:58-272` |
| `ComponentWsTabBar` | local activeTab state | `'workspace'\|'memory'\|'cron'` | ⚠️ local | useState | `chat-page/component-ws-tab-bar.tsx` |
| `ComponentWsFileTree` / `ComponentWsTreeItem` | props state | `WsTreeNode{path,name,type:'dir'\|'file',children?}` | ❌ | — | `chat-page/component-ws-file-tree.tsx` / `component-ws-tree-item.tsx` |
| `ComponentWsPathBar` / `ComponentWsResizeHandle` | props workspaceDir | string | ❌ | — | 同上 |
| `SectionMemoryPanel` | 委托 useMemoryCrud | — | ❌（薄壳） | — | `chat-page/section-memory-panel.tsx:34-96` |
| `useMemoryCrud` ✓已迁候选 | **GET /memory/:scope**（mount + 写后 refetch）+ POST/PATCH/DELETE | `MemoryEntry{name,content,scope,...}[]` | ✓（entries list + CRUD） | useEffect[refetch]：GET once；写后 refetch；无 SSE、无 cancelled flag | `chat-page/use-memory-crud.ts:43-93` |
| `ComponentMemoryEntryCard` / `ComponentMemoryEditorModal` | props entry / local form | MemoryEntry | ❌/⚠️ local | useState | `chat-page/component-memory-entry-card.tsx` / `component-memory-editor-modal.tsx` |
| `SectionCronPanel` | **GET /session/:sid/cron**（mount + 写后 refetch + **setInterval 60s 轮询**） | `CronJobSummary{id,name,cron,prompt,enabled,nextFireAt}[]` | ✓（jobs list + CRUD） | useEffect[refetch,sessionId]：GET + setInterval 60s；cleanup clearInterval ✅ | `chat-page/section-cron-panel.tsx:61-95` |
| `ComponentCronJobCard` / `ComponentCronNewForm` / `ComponentCronFreqPicker` | props job / local form | CronJobSummary | ❌/⚠️ local | useState | `chat-page/component-cron-job-card.tsx` 等 |

**页面↔组件↔数据关系**：
1. `SectionWorkspacePanel` 自给自足：useReducer 管 tree state，三个 effect 分别管 `[sessionId]` 初始拉、`[lastWorkspaceEvent,sessionId]` SSE fan-out、`[collapsed/width]` localStorage 持久化。
2. workspace event 不在本 panel 订阅，而在主区引擎 `useSessionSseSubscribe` 内订阅 session_panel → 转发 `store.lastWorkspaceEvent` → 本 panel store 订阅消费（store 是扇出枢纽）。
3. `SectionMemoryPanel` / `SectionCronPanel` 与 workspace 解耦：仅依赖 `sessionId` prop，自己拉自己的 API，不读 store。
4. tab 切换不触发 fs.watch 变化（设计如此——session 级 lazy watcher，sse_research.md §3 + audit §3.1）。

### 2.5 小结：playground 组件数 / hook 现状

**Section 区域 = 4 大区**（左列 conv / 中主区 chat / 右栏 workspace-or-tabs / 浮层 modal）。
**组件总数 ≈ 24**（shell 4 + 列表项 2 + 主区 11 + 右栏 8 + 浮层 2 + chat-composer 子 1）。
**Hook 总数 = 7**：

| Hook | 已迁 useLifecycle? | 备注 |
|---|---|---|
| `usePageChatMount` | ✓ 候选（audit §7.3 标「保持现状」——已符合 lifecycle 模式，迁无收益，但可统一） | SSE meta 订阅 + GET list |
| `useSessionRunState`（含 `useSessionSseSubscribe`） | ❌ **不迁**（已是引擎；audit §7.3 明示保持现状） | SSE agent_loop + session_panel + GET 三连 |
| `useModelRestore` | ❌ **不迁**（已有 useLayoutEffect + token 守卫；迁反而退化） | GET /session model 回填 |
| `useSubagentChildren` | ✓ 候选 | 命令式 per-call GET /session/:id/children |
| `useSubagentRunRefresh` | ❌ 不迁（per-event 命令式） | meta 事件回调 |
| `useMemoryCrud` | ✓ 候选（audit §7.3 已列） | GET /memory + CRUD refetch |
| `useMessageScrollPagination` | ❌ 不迁（纯 UI 滚动 hook，无数据） | DOM scroll |

**已迁 4 个**（per 用户指令）：`useMemoryCrud` / `MemberPanelMemory` / `SectionWorkspacePanel` / `useSubagentChildren`——audit §7.3 表也明示。

---

## §3 studio / studio-page

### 3.1 整体结构（`page-studio.tsx:46-293`）

```
PageStudio（顶层：useState 持 squads / selectedSquadId / detail / mainView / tab / modal / toast / dataVersion）
├── useStudioUnreadMeta()  // 独立 SseClient 订阅 session_meta _all（biz='studio' 反向守卫）
├── useMemberPanelHandlers()  // member 保存 handler 簇
├── useBoardAtMention()  // 看板 @ 切 leader chat + prefill
├── <StudioSidebar>                  // 左 224px
│   └── <SquadTree>*  // 每个 squad 展开 → 懒加载 getSquad detail
│       ├── 节点：board 入口
│       ├── 节点：leader / mate chat 入口（unread 红点）
│       └── 节点：squad 群聊 chat 入口（unread 红点）
├── mainArea（四态）：
│   ├── 'panel' → <SquadPanel>  // 3 tab：管理 / 成员 / 自动工作
│   │   ├── ManageTab (元信息 form + charter editor)
│   │   ├── MembersTab → <ComponentMemberCard>*
│   │   └── AutoworkTab (toggle + <BudgetMeter> + <AutoWorkHistory>)
│   ├── 'board' → <BoardRoute> → <SquadBoard>  // 3 sub-tab goals/requirements/tasks + zone active/archive
│   │   └── <BoardEntityModal> edit/create
│   ├── 'chat' → <StudioChatRouter>  // node.type === 'squad' ? squad-chat : member-chat
│   │   ├── node=squad → <SquadChatPage>（自起 SSE agent_loop + session_panel 双 topic）
│   │   └── node=member → <MemberChatPage>（复用 useSessionRunState 引擎）
│   │   两者都挂 <SectionRightTabs>（薄 wrapper → SectionWorkspacePanel）
│   └── 'member' → <MemberPanel>  // 5 section：profile + tasks + memory + skills+model + heartbeat
│       ├── <MemberPanelMemory>（GET summary + POST compact）
│       └── <HeartbeatConfigSection>
├── 弹层：<NewSquadModal> / <HireModal> / <BenchModal>
└── toast 反馈
```

`mainView` 四态 = `panel | board | chat | member`，单例切换（每次只渲染一个）。

### 3.2 区域：左侧栏 squad 列表

**组件清单**：

| 组件 | 数据源 | 数据格式（关键字段） | 拥数据? | 当前生命周期 | file:line |
|---|---|---|---|---|---|
| `StudioSidebar` | props squads / selectedSquadId / unreadMap + local expanded + **懒缓存 detailCache**（GET /squad/:id） | `SquadSummary{id,name,...}[]` + `SquadDetail` | ⚠️ local detailCache（squad 级懒加载） | useState(expanded) + useState(detailCache)；useEffect[dataVersion]：清缓存；useEffect[expanded,detailCache]：展开缺缓存时 GET | `studio-page/section-studio-sidebar.tsx:38-124` |
| `SquadTree` | props squad + detail + unreadMap | `SquadSummary` + `SquadDetail{members,modelDefault,...}` + `unreadMap` | ❌（纯展示树） | — | `studio-page/component-squad-tree.tsx` |
| `useStudioUnreadMeta` ⚠️**违规独立 SseClient** | **SSE session_meta `_all`**（biz='studio' 反向守卫） | `SessionMetaUpdateEvent`；局部维护 `unreadMap: Record<sid,boolean>` | ✓ studio 红点 unread 唯一数据源 | useEffect mount：`new SseClient()` + connect + subscribe；cleanup unsubscribe + **destroy**（违反单例 spec S1） | `studio-page/use-studio-unread-meta.ts:39-113` |

**页面↔组件↔数据关系**：
1. `PageStudio` 顶层 `useStudioUnreadMeta()` 拿 `unreadMap` + `markReadAndClear`；mount 时独立 SseClient subscribe session_meta `_all`（biz='studio' 守卫）。
2. `PageStudio` useState 持 `squads` / `selectedSquadId` / `detail`：mount 时 GET /squad 列表 + 自动选中第一个 + GET /squad/:id 详情。
3. `<StudioSidebar>` 接收 squads（顶层 list）+ selectedSquadId + dataVersion（mutation 后 bump）+ unreadMap；自身懒缓存每个展开 squad 的 detail（避免父级反复重拉），dataVersion 变化时清缓存。
4. 点 chat 节点 → `markReadAndClear(sessionId)` 乐观清红点 + POST /session/:id/read fire-and-forget + setMainView 'chat'。
5. mutation（建队/hire/bench/charter）后 `refresh()` → reloadDetail + reloadSquads + bump → sidebar 缓存清空重拉。

### 3.3 区域：squad 面板（3 tab）

**组件清单**：

| 组件 | 数据源 | 数据格式 | 拥数据? | 当前生命周期 | file:line |
|---|---|---|---|---|---|
| `SquadPanel` | props detail + tab | `SquadDetail` | ❌（纯 tab 路由 shell） | — | `studio-page/section-squad-panel.tsx:47-93` |
| `ManageTab` | props detail + onSaveMeta/onSaveCharter | SquadDetail（含 charter） | ❌（受控表单） | local form state | `studio-page/component-manage-tab.tsx` |
| `MembersTab` | props detail.members + handlers | `Member[]` | ❌ | — | `studio-page/component-members-tab.tsx` |
| `ComponentMemberCard` | props member + onBench/onDeploy/onEdit | `Member{id,name,role,state,sessionId,model,skills,...}` | ❌ | — | `studio-page/component-member-card.tsx` |
| `AutoworkTab` | props detail + <BudgetMeter> + AutoWorkHistory | — | ❌（容器） | — | `studio-page/component-autowork-tab.tsx` |

### 3.4 区域：squad-chat 群聊（`SquadChatPage`）

**组件清单**：

| 组件 | 数据源 | 数据格式 | 拥数据? | 当前生命周期 | file:line |
|---|---|---|---|---|---|
| `SquadChatPage` | **GET /messages + GET /usage**（fetchOnce Promise.all）+ **SSE agent_loop + session_panel**（直接订阅，不经 useSessionRunState） | Message[] / SessionUsageView / AgentEvent / SessionEvent | ✓ 群聊 messages + usage + model override 唯一数据源 | useEffect[sessionId,fetchOnce]：cancelled flag + reset slice + fetchOnce + getSseClient().subscribe 双 topic + subRef[]；cleanup 置 cancelled + 句柄 unsubscribe | `studio-page/section-squad-chat.tsx:85-194` |
| `ComponentMessageStream` | props messages + 群聊白名单策略（groupMessageFilter + resolveGroupActor） | Message[] | ❌（共享内核） | — | 同 playground |
| `ComponentUsagePanel` + `CompactBtn` + `ClearBtn` | props usage / summaryTask | SessionUsageView | ❌ | — | 同 playground |
| `ChatComposer` + `InputModelPicker` + send | local editor + per-call model override | string / ModelSelection | ⚠️ local | useState | 同 playground |
| `ComponentClearConfirmModal` | local open | — | ⚠️ local | useState | 同 playground |
| `SectionRightTabs`（薄 wrapper） | sessionId prop | — | ❌ | — | `studio-page/section-right-tabs.tsx:40-50` |

**页面↔组件↔数据关系**：
1. 群聊自管 messages state（`sliceRef.current` ref 持权威态，useState 存快照）——**不走 store，不走 useSessionRunState**。
2. SSE 帧到达：agent_loop → `applyAgentEventToMessages` 纯 reducer → setMessages；session_panel → 仅 workspace_file/dir_changed 透传 `useChatStore.getState().setLastWorkspaceEvent(data)`（让 SectionWorkspacePanel 消费），其余 type 忽略（群聊不展示 usage/runActive）。
3. 发送：`postMessage` → `fetchOnce` 单次刷新（不再 30s 轮询，v0.0.88 已删）。
4. 与 playground 共享 SSE 单例（`getSseClient()`），subId 路由保证不串话。

### 3.5 区域：member-chat 单聊（`MemberChatPage`）

**组件清单**：

| 组件 | 数据源 | 数据格式 | 拥数据? | 当前生命周期 | file:line |
|---|---|---|---|---|---|
| `MemberChatPage` | **复用 useSessionRunState(sessionId)**（与 playground 同引擎）+ workspace event 转发 store | SessionRunState 全套 | ❌（壳） | — | `studio-page/section-member-chat.tsx:82-326` |
| `MemberAvatar` | props member | Member | ❌ | — | `common/member-avatar.tsx` |
| `<SectionRightTabs>` | sessionId | — | ❌ | — | 同 §3.4 |
| 其他共享内核（MessageStream / RunStateBar / Composer / UsagePanel / ClearModal） | 同 playground | — | ❌ | — | 同 playground |
| **per-call PATCH member model** | 直接调 patchMember（不持久化本组件 state） | `PatchMemberBody{model}` | ❌ | useCallback | `section-member-chat.tsx:147-163` |

**页面↔组件↔数据关系**：
1. 与 playground 引擎完全同源（`useSessionRunState(sessionId, {onWorkspaceEvent})`）——member session 也是一个 session，agent_loop 走 member 自己的 agent loop。
2. member.model 修改：用户选 picker → `handlePickerChange` → sel.modelId==='default' 时清空 member.model（inherit squad default），否则写 `${providerId}/${modelId}` → PATCH /squad/:id/member/:mid。
3. `member.sessionId` 来自父级 `PageStudio.detail.members`，是后端给的 member 专属 session id。

### 3.6 区域：member 面板（`MemberPanel`）

**组件清单**：

| 组件 | 数据源 | 数据格式 | 拥数据? | 当前生命周期 | file:line |
|---|---|---|---|---|---|
| `MemberPanel` | props member + onSave/onSaveHeartbeat + local form (name/systemPrompt/skills/model) | Member / PatchMemberBody / PatchHeartbeatBody | ⚠️ local edit state（base + dirty 比较） | useState；save → onSave → reset base | `studio-page/section-member-panel.tsx:73-221` |
| `MemberPanelMemory` ✓已迁候选 | **GET /session/:sid/summary**（mount + compact 后 setTimeout 1500ms 重拉） | `SummaryResponse{summary?: {content}}` | ✓ member summary 唯一数据源 | useEffect[reload]：GET once；onCompact → POST /compact + setTimeout(reload, 1500) + setTimeout(setFeedback, 2600)（⚠️ 一次性未 clear） | `studio-page/component-member-panel-memory.tsx:25-94` |
| `HeartbeatConfigSection` | props + onSave | PatchHeartbeatBody | ⚠️ local form | useState | `studio-page/section-heartbeat-config.tsx` |
| `MultiCheck` / `ModelPicker` | props value / onChange | string[] / ModelSelection | ❌（受控） | — | — |

### 3.7 区域：board 看板（`SquadBoard`）

**组件清单**：

| 组件 | 数据源 | 数据格式 | 拥数据? | 当前生命周期 | file:line |
|---|---|---|---|---|---|
| `SquadBoard` | **GET /board?squadId&view=all&zone=active\|archive**（mount + zone 切 + reload）+ 乐观 patch + reload 真值 | `Board{squadId, goals:{items,total}, requirements:{...}, tasks:{...}}`；entity 含 `archived` / `effectiveArchived` | ✓ board 全 entity 唯一数据源 | useEffect[reload]：GET；handleSave/Archive/Restore → setBoard 乐观 + 写端点 + flash toast + reload 取真值 | `studio-page/component-squad-board.tsx:58-295` |
| `BoardGoalsView` / `BoardRequirementsView` / `BoardTasksView` | props board.{goals\|requirements\|tasks}.items + members | `Goal/KR/Requirement/Task` entity | ❌ | — | `component-board-{kind}-view.tsx` |
| `BoardEntityModal` | props target + board + members | `EditTarget{kind,id,parentGoalId?}` / `BoardPatch` | ⚠️ local form | useState | `component-board-entity-modal.tsx` |
| `BoardToolbar` / `ArchiveNotice` | props + local taskFilter | TaskFilterState | ⚠️ local | useState | `component-board-toolbar.tsx` / `component-board-zone-bar.tsx` |
| `useBoardEditForm` | props target + board | BoardPatch | ❌（form hook） | — | `use-board-edit-form.ts` |
| `useBoardCreate` / `useBoardDuplicate` | props + flash | — | ❌（mutation hook） | — | 同名 ts |

### 3.8 区域：budget meter

**组件清单**：

| 组件 | 数据源 | 数据格式 | 拥数据? | 当前生命周期 | file:line |
|---|---|---|---|---|---|
| `BudgetMeter` | **GET /budget/usage?squadId**（mount + **setInterval 30s 轮询** + refreshKey 变化触发） | `BudgetUsage{consumed,limit,remaining,windowEnd,timezone}` | ✓ squad 预算用量唯一数据源 | useEffect[reload]：GET + setInterval 30s；useEffect[refreshKey,reload]：变化即 reload；cleanup clearInterval ✅ | `studio-page/component-budget-meter.tsx:27-60` |

**注释**：注释自承「SSE 推送为主，polling 兜底」，但 SSE 推送并未接线（audit §1.2 + sse_research §3）。

### 3.9 小结：studio 组件数 / hook 现状

**Section 区域 = 5 大区**（左 sidebar / 主区四态 panel-board-chat-member / 浮层 modal / toast）。
**组件总数 ≈ 30+**（含 board 子组件族 10+）。
**Hook 总数 = 5**（顶层）+ 子组件 hooks：

| Hook | 已迁 useLifecycle? | 备注 |
|---|---|---|
| `useStudioUnreadMeta` ⚠️**违规独立 SseClient** | ✓ 候选（同时修违规） | SSE session_meta 独立 SseClient（应改单例） |
| `useMemberPanelHandlers` | ❌ 不迁（mutation handler 簇，非数据 hook） | save member PATCH |
| `useBoardAtMention` | ❌ 不迁（UI 交互 hook） | 切 chat + prefill |
| `MemberPanelMemory` ✓候选（audit §7.3 已列） | ✓ 候选 | GET summary + POST compact |
| `useBoardEditForm` / `useBoardCreate` / `useBoardDuplicate` | ❌ 不迁（form / mutation） | — |

**剩余待迁候选**（per audit §7.3 表）：
- `BudgetMeter`（poll 改 SSE 或保 30s poll，justification 已记录）
- `SectionCronPanel`（保 60s poll）
- `PageConnector`（不在本次范围，标「后续补」）
- `useStudioUnreadMeta`（修违规 + 迁 useLifecycle）

---

## §4 数据流总览（page↔组件↔store↔sse 映射）

### 4.1 三层数据所有权

| 层 | 持有者 | 跨页保留? | 释放方式 | 示例 |
|---|---|---|---|---|
| **L1 全局 store**（zustand） | chat-slice | ✓（设计如此） | 显式 `deleteSession` handler（audit G3 未实现） | `sessions[]` / `childrenByParent` / `lastWorkspaceEvent` |
| **L2 引擎/hook local state**（useState/useRef/useReducer） | useSessionRunState / SquadChatPage / SectionWorkspacePanel / BudgetMeter / SectionCronPanel | ❌（unmount 释放） | unmount cleanup | messages / runActive / wsReducer tree / budget usage / cron jobs |
| **L3 组件纯展示**（props 驱动） | SectionChatDetail / ComponentMessageStream / SquadPanel 等 | — | — | 无数据所有权 |

### 4.2 SSE 帧到组件的完整路径

```
后端 emit → SseChannel.writeFrame（broadcast 所有 sinks）
  → 前端 getSseClient() 单例 reader.read() 收帧
    → handlers.get(subId)?.(frame.data)  // subId 路由
      ├─ subId=usePageChatMount.meta → applySessionMetaEvent → store.sessions[]
      │   └→ page-chat 订阅 store → rerender → SectionConvPanel props 更新
      ├─ subId=useSessionSseSubscribe.agent_loop（playground + member chat 共享）
      │   → applyAgentEventToMessages reducer → sliceRef.current → setSlice
      │   └→ page-chat / MemberChatPage 透传 messages → ComponentMessageStream
      ├─ subId=useSessionSseSubscribe.session_panel（同上引擎）
      │   → 按 type 分流：status_update→setSessionRunning / usage_update→setUsage /
      │     summary_task_update→setSummaryTask / messages_cleared→清 messages /
      │     workspace_*→onWorkspaceEvent ref→store.setLastWorkspaceEvent
      │     session_read_update→onSessionRead ref→store.setSessionUnread
      ├─ subId=SquadChatPage.agent_loop → sliceRef + setMessages（群聊自管）
      ├─ subId=SquadChatPage.session_panel → 仅 workspace_* 透传 store
      └─ subId=useStudioUnreadMeta.meta（独立 SseClient）→ setUnreadMap → sidebar 红点
```

### 4.3 API→组件→store 直拉路径

```
GET /session ─── usePageChatMount ─── store.sessions[]
GET /session/:id/messages ─── useSessionSseSubscribe（初始 + run_end 校正）/ page-chat loadMore / SquadChatPage fetchOnce
  └→ engine local state → props → ComponentMessageStream
GET /session/:id/children ─── useSubagentChildren（per-call）→ store.childrenByParent → ComponentSubagentTree
GET /session/:id/summary ─── MemberPanelMemory ─→ local state → DOM
GET /session/:sid/cron ─── SectionCronPanel ─→ local state → DOM
GET /workspace/tree ─── SectionWorkspacePanel ─→ wsReducer → ComponentWsFileTree
GET /memory/:scope ─── useMemoryCrud ─→ local state → SectionMemoryPanel
GET /squad ─── PageStudio ─→ local state → StudioSidebar
GET /squad/:id ─── PageStudio / StudioSidebar（懒缓存）─→ local state
GET /budget/usage ─── BudgetMeter ─→ local state
GET /board ─── SquadBoard ─→ local state
```

---

## §5 已迁 useLifecycle 4 hook 与待迁候选汇总

### 5.1 已迁 4 个（用户指令确认）

| Hook | 现状 | 迁移收益（per audit §7.3） |
|---|---|---|
| `useMemoryCrud` ✓ | useEffect[refetch] GET；无 SSE / 无 cancelled flag | 直接迁；entries 改 hook 内部 state |
| `MemberPanelMemory` ✓ | useEffect[reload] GET + setTimeout(reload, 1500) + setTimeout(setFeedback, 2600)（未 clear） | 删 setTimeout 改 reload 命令式；迁 useLifecycle |
| `SectionWorkspacePanel` ✓ | useReducer + 多 effect；lastWorkspaceEvent 经 store 扇入 | 当前 useEffect 改造；store subscription 是新增点 |
| `useSubagentChildren` ✓ | useCallback per-call GET → store.setChildren | 直接迁；store 保留是设计 |

### 5.2 待迁候选（Part 3 评估）

| Hook/组件 | 类型 | 迁移建议 |
|---|---|---|
| `BudgetMeter` | polling 30s + refreshKey | 建议改 SSE 推送（session_usage_update 已存在）；次选保 poll + justification |
| `SectionCronPanel` | polling 60s + GET-once | 保 poll + justification（cron nextFireAt 漂移显示） |
| `useStudioUnreadMeta` | 独立 SseClient（违规）+ biz 守卫 | **必做**：改 getSseClient() 单例 + subId 区分；同时迁 useLifecycle（修违规） |
| `usePageChatMount` | 已符合 lifecycle 模式 | audit §7.3 标「保持现状」——可统一可不动 |
| `SquadChatPage`（群聊自管 SSE） | 自起 SSE 双 topic + sliceRef | 可考虑迁 useLifecycle（与 useSessionRunState 形态相似，但需保留 session_panel fan-out 转发 store 的副作用） |
| `MemberPanel`（form） | local edit state | 不迁（form hook，非数据 hook） |
| `StudioSidebar`（懒缓存） | useState detailCache + effect | 候选（懒缓存可抽 useLifecycle） |
| `SquadBoard` | GET board + 乐观 patch + reload | 候选（迁 useLifecycle + 乐观 patch 在 reload 内做） |

### 5.3 不迁的明确清单

- `useSessionRunState` / `useSessionSseSubscribe`（已是引擎；audit §7.3 明示）
- `useModelRestore`（已有 useLayoutEffect + token 守卫；迁反而退化）
- `useSubagentRunRefresh`（per-event 命令式）
- `useMemberPanelHandlers` / `useBoardAtMention` / `useBoardEditForm` / `useBoardCreate` / `useBoardDuplicate`（mutation / form / UI hook，非数据生命周期）
- `useMessageScrollPagination`（纯 UI 滚动）

---

## §6 后续补（config 页面，本次范围外）

用户指令明确本次略：
- **connector-page**（PageConnector）：`setInterval(refresh, 2000)` 高频轮询连接状态（audit §1.2 标「建议改 SSE 或延长至 5s」）
- **app-dev-config-page**（配置中心）
- **skill / plugin 管理页**

后续如纳入 v0.0.94 Part 3 迁移范围，按本表同样口径补充。

---

## 附录 A：参考文档

- `specs/research/sse_lifecycle_audit.md` §1（现状总表）/ §1.3（API 数据）/ §7.3（迁移映射表）—— **本文基础**
- `specs/research/sse_research.md` §1（topic 数据形态）/ §3（订阅方清单）—— **本文基础**
- `specs/tech/app/frontend/[P0]sse_client_singleton.md`（SSE 单例 spec）
- `specs/tech/app/frontend/[P0]sse_channel.md` §9-§10（session_panel / session_meta）
- `specs/tech/app/frontend/[P0]component_architecture.md` §3.4（共享 run 态引擎）
- `specs/ui/components/chat-page/_overview.md`（playground 组件契约）
- `specs/ui/components/studio-page/{squad-chat-page,member-chat-page,studio-sidebar}.md`

## 附录 B：未深读组件（不影响结论）

下列组件本次仅读首部，不影响组件清单 / 数据流 / hook 现状结论（多为纯展示 / 共享内核）：
- `component-message-stream.tsx` / `component-tool-batch.tsx` / `component-tool-call-item.tsx`（共享渲染内核）
- `component-board-{goals,requirements,tasks}-view.tsx`（board 子组件族，纯展示）
- `component-cron-{job-card,new-form,freq-picker}.tsx`（cron 子组件，纯展示）
- `component-ws-{file-tree,tree-item,path-bar,resize-handle,tab-bar}.tsx`（workspace 子组件，纯展示 / local UI state）
- `use-board-{edit-form,create,duplicate}.ts`（mutation hook，非数据生命周期）
- `chat-composer-extension.tsx`（Tiptap 编辑器扩展，纯 UI）
