---
type: spec
title: Frontend Component Architecture（组件式架构总纲）
priority: P0
status: active
updated: 2026-07-20
since: v0.0.4
related: [[P0]tech_stack.md, [P0]design_system.md]
---

# Frontend Component Architecture（组件式架构总纲）

> 管什么：`app/web/` 渲染层的**组件式架构**——分层、命名、目录结构、单文件单组件原则、与 spec 的契约关系。
> 不管什么：技术选型（→ `[P0]tech_stack.md`）；设计 token（→ `[P0]design_system.md`）；组件粒度/命名细则与 spec 写法（→ `specs/ui/components/_conventions.md`）；具体组件契约（→ `specs/ui/components/{framework,common,一级页面}/`）。
> 关系：本文件是**架构总纲**（讲「项目怎么组织」），`specs/ui/components/` 是**组件契约**（讲「每个组件长什么样」）。

## 1. 核心原则：组件式架构

`app/web/` 是**组件式架构**，不是页面一体式。每个组件独立一个 `.tsx` 文件，按粒度分层、统一命名、单向组合。理由：

- **可复用**：primitive/component 跨页面复用，避免重复
- **可测试**：单组件可独立单测（vitest + testing-library）
- **可维护**：单文件 ≤300 行（见 CLAUDE.md），改一处不影响他处
- **spec 对齐**：每个组件有对应 spec（md + 关键实现），契约与实现一一映射

## 2. 分层与命名

详见 `specs/ui/components/_conventions.md` §2/§3。要点：

- 五层：`primitive` → `component` → `section` → `page` → `framework`
- 前缀 + kebab：`primitive-toggle-switch` / `component-key-card` / `section-config-layout` / `page-app-config` / `app-shell`（framework 用自然名）
- 单向组合：高层组合低层，**禁止逆向依赖**

## 3. `app/web/src/components/` 目录结构

第一层 = `framework/` + `common/`（跨页面复用）+ 各**一级页面**目录（扁平，与 `specs/ui/components/` 同名映射）。结构一致的页面合并（app/dev config → `app-dev-config-page/`）。

```
app/web/src/components/
├─ framework/                  # 框架级（对应 specs/ui/components/framework/）
│  ├─ app-shell/app-shell.tsx
│  ├─ nav-rail/nav-rail.tsx
│  └─ primitives/              # 原子组件聚合
│     ├─ toggle-switch.tsx
│     ├─ key-input.tsx
│     ├─ key-select.tsx
│     ├─ key-boolean.tsx
│     └─ drag-handle.tsx
├─ common/                     # 跨页面复用的 component/section（对应 specs/ui/components/common/）
│  ├─ section-group-list.tsx          # 通用 group 列表（app-dev config + plugin 扩展点共用）
│  ├─ component-group-list-item.tsx
│  └─ member-avatar.tsx               # [v0.0.39] member 头像（色块 + 首字母，单聊/群聊对端 member 用）
├─ app-dev-config-page/        # app + dev config 页（结构一致，共享 section/component）
│  ├─ page-app-config.tsx      # page：组合 section（app 实例）
│  ├─ page-dev-config.tsx      # page：组合 section（dev 实例）
│  ├─ section-config-layout.tsx# 三栏布局（app/dev 复用）
│  ├─ component-key-card.tsx
│  └─ component-group-save-bar.tsx
├─ plugin-config-page/         # plugin config 页（特殊：tab + 扩展点）
│  ├─ page-plugin-config.tsx
│  ├─ section-plugin-list.tsx
│  ├─ section-ext-point-area.tsx       # 内含 common/section-group-list
│  ├─ component-plugin-item.tsx
│  ├─ component-ext-impl-radio.tsx     # exclusive
│  ├─ component-ext-impl-checkbox.tsx  # list
│  ├─ component-ext-impl-ordered.tsx   # ordered（拖拽 + 开关）
│  └─ component-schema-config-modal.tsx
├─ studio-page/                # Studio 团队页（squad chat / member chat / 看板 / [v0.0.168] 首页单页中枢）
│  ├─ page-studio.tsx                    # [v0.0.168] 主区四态 seats/board/chat/member（无 panel）
│  ├─ section-studio-sidebar.tsx         # [v0.0.168] 单行列表，无手风琴树（component-squad-tree 已 mv soft_deleted/）
│  ├─ component-seats-panel.tsx          # [v0.0.165/v0.0.168] 首页单页中枢容器（3 tab 内联 + 宿主 context-menu state）
│  ├─ component-seats-body.tsx           # [v0.0.168/v0.0.170] SeatsPanel seats tab 主体（双列指挥台 seats-console：左列 seats-side + 右列 roster 行列表）
│  ├─ component-seat-card.tsx            # [v0.0.165/v0.0.170] 队长 mini 卡（C 指挥台左列；行内 amber LEADER badge；右键 context menu 上抛）
│  ├─ component-seat-row.tsx             # [v0.0.170] mate 坐席行（SeatRowView；ops hover/focus-within 揭示）
│  ├─ use-seat-menu.ts                   # [v0.0.170] 坐席卡/行共享菜单机械 hook（开关/rect 定位/flip-up/延迟关闭监听）
│  ├─ seat-present.ts                    # [v0.0.170] 坐席卡/行共享呈现（pulseStyle 静态脉冲点 / useSeatStatusText）
│  ├─ component-seat-stats.tsx           # [v0.0.165/v0.0.170] 坐席统计 2×2 无缝格（图标下线；null 显「—」不隐藏格）
│  ├─ component-team-entry-row.tsx       # [v0.0.165/v0.0.170] 团队入口 compact links（看板/群聊 link；群聊右键上抛复制 sessionId）
│  ├─ use-seats-data.ts                  # [v0.0.165] 坐席派生数据 hook（presence 三态/statusTextSource/统计）；[v0.0.170] 下线 listSessions()（只调 getBudgetUsage）
│  ├─ component-seat-card-menu.tsx       # [v0.0.168] SeatCard「更多」菜单弹层（编辑/bench/deploy 按 role+state 组合）
│  ├─ component-studio-context-menu.tsx  # [v0.0.168] 复制 Session ID 浮层 primitive（触发点=坐席卡/群聊入口卡右键）
│  ├─ component-manage-tab.tsx           # [v0.0.168] 由 SeatsPanel panel tab 内联渲染（原 SquadPanel admin-tab）
│  ├─ component-autowork-tab.tsx         # [v0.0.168] 由 SeatsPanel autowork tab 内联渲染（原 SquadPanel autowork-tab）
│  ├─ section-studio-chat.tsx     # [v0.0.216] studio chat 薄壳（单聊/群聊统一）：身份 header 两形态 + SectionChatSession 透传；取代 section-{member,squad}-chat.tsx + component-member-chat-input-bar.tsx + use-studio-chat-chrome.ts + squad-chat-helpers.tsx（谓词迁 chat-page/chat-actor-strategy.tsx）
│  ├─ section-member-panel.tsx         # [v0.0.113] skills overlay switch + 简化筛选器（删 model/记忆模块）；[v0.0.168] 唯一入口=坐席卡菜单编辑，返回恒回 seats
│  ├─ section-member-create.tsx        # [v0.0.169] 成员创建页（Fresh/Derive 双模式；复用 member-panel 视觉基线；前身 component-hire-modal 弹层已软删）
│  ├─ component-member-skill-filter.tsx # [v0.0.113] 成员 skills 简化筛选器（enable/disable + 搜索）
│  ├─ component-studio-board-route.tsx  # [v0.0.57] board 路由态包装；[v0.0.168] 头部加返回键（board-topbar-back-btn）
│  ├─ component-squad-board.tsx        # 看板 section（v0.0.57 起独立 board 路由态，非 goals tab）
│  ├─ component-board-goals-view.tsx   # Goals 视图（Objective+KR 进度+health）
│  ├─ component-board-requirements-view.tsx # Requirements 视图（status 分组）
│  ├─ component-board-tasks-view.tsx   # Tasks 视图（kanban 列=status+group=assignee）
│  ├─ chat-node.ts                     # [v0.0.168] ChatNode 类型独立（原在被删的 component-squad-tree.tsx）
│  └─ board-types.ts                   # Board 响应类型（对齐 11b schema）
│  # [v0.0.168 已删]：section-squad-panel.tsx / component-members-tab.tsx / component-member-card.tsx /
│  #                  component-squad-tree.tsx（全部 mv soft_deleted/v0.0.168/）
├─ chat-page/                  # chat 页（page-chat + BaseChatPage/BaseChatInputBar 骨架 + section-chat-session 统一装配层 + message-stream 内核 + area-hooks + abort-btn/enqueue-view 等）
│  ├─ page-chat.tsx                       # playground 宿主：conv-panel/三栏/workspace 接线 + <SectionChatSession>（会话区数据全内置）
│  ├─ use-chat-actions.ts                 # 列表/导航 handler（openSession/handleCreate/handleDelete/handleRenameTitle/handleSelectSub）；会话区 handler（send/compact/clear/model/effort/approval/enqueueCancel）已内置 SectionChatSession
│  ├─ section-chat-session.tsx            # [v0.0.216] 统一装配层（7 页唯一接入点，[P0]chat_session_assembly.md）
│  ├─ component-chat-session-input.tsx    # [v0.0.216] 统一输入区（capabilities 门控）
│  ├─ component-chat-session-topbar-left.tsx # [v0.0.216] 缺省身份 header（ChatSessionTopbarLeft，titleOverride 口子）
│  ├─ use-chat-chrome.ts                  # [v0.0.216] chrome hook（GET /session/:id/chrome，component_data_map §6）
│  ├─ chat-actor-strategy.tsx             # [v0.0.216] chrome 驱动渲染策略（谓词自 studio squad-chat-helpers 等价迁移 + deriveRenderStrategy）
│  ├─ base-chat-page.tsx                  # [v0.0.155] page 级骨架（三 chat 页共用 ~90%）；[v0.0.156] topbar 加 data-testid="chat-topbar"
│  ├─ base-chat-input-bar.tsx             # [v0.0.155] input 级骨架
│  ├─ component-message-stream.tsx        # 消息流内核（共享 ChatStream，§3.3）
│  ├─ component-message-stream-avatars.tsx # [v0.0.156 B-1] 抽 DefaultAgentAvatar/DefaultUserAvatar
│  ├─ types.ts                             # [v0.0.156 B] 6 行 barrel（`export * from './types/{message,session,hitl,usage,subagent,enqueue}'`；35 消费方零改）
│  └─ types/                               # [v0.0.156 B] 6 子域：message(12 符号) / session(2) / hitl(10 含类型守卫) / usage(6) / subagent(2) / enqueue(1)
├─ connector-page/             # connector 配置页（page-connector + section-browser-connector）
├─ skill-page/                 # skill 管理页（page-skill + section-skill-list + drop-zone 等）
├─ providers/                  # 跨页复用的 providers section/component（无 page-*；被 app-dev-config-page 与 app-shell 引用）
└─ chat/                       # chat 页旧目录（待迁入 chat-page/）
```

### 3.1 Studio page 组件（squad chat / member chat / member panel）

- **核心概念**：`studio-page/` 是 Studio 业务页目录，含 squad chat、member chat、member panel 等真跑组件。（**[v0.0.113]** member memory 组件 `component-member-panel-memory.tsx` 已删——记忆入口迁 chat 右侧 `section-right-tabs`。）
- **设计思路**：沿用一级页面目录，不新建 `studio/` 别名，避免 spec 与实现目录漂移；群聊/单聊共用 `squad-chat-*` testid 族，差异只在 sender prefix 与 role avatar。
- **代码路径**：`app/web/src/components/studio-page/page-studio.tsx → component-studio-chat-router.tsx`（useChatChrome 拉 chrome 定 workspaceSemantic）`→ section-studio-chat.tsx`（薄壳：身份 header + `<SectionChatSession chrome={chrome}/>` 透传）；`page-studio.tsx → section-member-panel.tsx`（成员编辑）。
- **接口签名**：`SectionStudioChatProps { chrome: SessionChromeView; prefill?: MentionAttrs[]; onBack?: () => void }` —— 薄壳只管身份要素（单聊=back+MemberAvatar+name+tag / 群聊=缺省 ChatSessionTopbarLeft）+ 透传，会话能力全在 SectionChatSession（`[P0]chat_session_assembly.md`）。

### 3.2 Studio page 看板（[v0.0.57] 起独立 board 路由态；[v0.0.168] 头部加返回键）

- **核心概念**：看板从 v0.0.57 起是 page-studio 主区独立路由态 `MainView {kind:'board'; squadId}`（不再是 squad-panel 的 goals tab；v0.0.168 SquadPanel 整体解体，goals tab 概念多版本前已不存在）；`component-squad-board` 是 section 容器（sub-tab 切换 + GET `/squad/:id/board?view=all`），内嵌 3 个视图组件（goals/requirements/tasks）。**[v0.0.168]** 外层 `component-studio-board-route.tsx` 头部新增返回键（`board-topbar-back-btn`）回首页 seats。
- **设计思路**：看板 v0.0.60 起支持编辑（弹层 + 直调 HTTP），v0.0.76 改统一弹层化；3 视图独立组件便于按 view 本地切换不重拉；返回键固定占位（`mb-2`），布局稳定不推挤下方 squad 名标题。
- **代码路径**：`app/web/src/components/studio-page/page-studio.tsx.mainView.kind==='board' → component-studio-board-route.tsx → component-squad-board.tsx → {component-board-goals-view,component-board-requirements-view,component-board-tasks-view}.tsx`。

### 3.3 共享渲染内核 ChatStream `[v0.0.39]`

- **核心概念**：`chat-page/component-message-stream.tsx` 参数化为**共享渲染内核 ChatStream**（playground / studio 单聊 / studio 群聊三视图复用同一内核）；`message-flatten.ts` 加 `flattenAndGroup` + 两级过滤选项（`messageFilter` 消息级白名单 + `blockFilter` 块级过滤）+ `DEFAULT_BLOCK_FILTER`（默认滤 `isSystemReminder=true` 的 text block）。
- **设计思路**：三视图差异不是「渲染逻辑不同」而是「策略不同」——同一内核 + 4 个策略 hook：
  - `resolveActor(msg)`：头像 + 名字（playground 默认 Rocky/U；studio 传 `MemberAvatar` + member.name）。
  - `messageFilter`：消息级白名单。**单聊/playground 不传**（全展示，仅滤 reminder）；**群聊传** `m => isUser(m) || isA2aInbox(m)`（mute assistant answer + tool + reminder）。
  - `blockFilter`：block 级过滤。两场景都用内核默认 `DEFAULT_BLOCK_FILTER`（全局滤 reminder，零侵入见 `specs/tech/agent/message/[P0]agent_message_interface.md §4.1`）。
  - `sideOfMessage(msg)`：左右侧判定。关键 — a2a inbox（`sender.source='agent'`）→ assistant 侧（左），即便 `role='user'`（后端 a2a 存 `role='user'`）；其余按 role。playground 无 a2a → 默认行为零回归。
  - 不传策略 hook 时全走默认（playground 零改动，视觉/行为零回归）。
- **代码路径**：`app/web/src/components/chat-page/component-message-stream.tsx.ComponentMessageStream()`（共享内核）← `chat-page/section-chat-session.tsx`（唯一装配消费方；策略由 `chat-actor-strategy.tsx.deriveRenderStrategy(chrome)` 按 chrome.groupRender/memberId 派生——群聊=白名单+a2a actor、单聊=对端 actor+a2a→右、playground=零策略默认）；拍平 + 过滤在 `message-flatten.ts.flattenAndGroup()`。
- **接口签名**：`MessageStreamProps { messages, resolveActor?, messageFilter?, blockFilter?, containerTestid?, rowTestid?, senderPrefixTestid?, runActive?, sessionRunning?, lastRunFinish? }` —— 除 `messages` 外全可选（保 playground 零回归）。
- **版本演进**：`[v0.0.39]` squad 对话 UI 重写引入策略化内核 + `common/member-avatar.tsx`（色块 + 首字母，对端 member 头像）。`[v0.0.216]` 策略接线收敛进 SectionChatSession（谓词 isUser/isA2aInbox 等迁 `chat-page/chat-actor-strategy.tsx`，逐行等价）。组件 spec 见 `specs/ui/components/chat-page/section-chat-session.md` + `studio-page/section-studio-chat.md` + `common/member-avatar.md`。

### 3.4 共享 run 态引擎 useSessionRunState `[v0.0.39 P2]`

- **核心概念**：`chat-page/use-session-run-state.ts` 的 `useSessionRunState(sessionId, opts?)` 是 **playground + studio 单聊共用的 run 态引擎**——把"一个 session 的运行态"（messages / runActive / loadingPhase / lastRunFinish / sessionRunning / enqueueItems / usage / summaryTask）从 `chat-slice` store 抽成 hook 自持状态，**playground 自己也消费**（不再埋在 page-chat 内联 + store 里）。
- **设计思路**：run 态本质是"当前查看的 session"的派生态（SSE 驱动 + 初始 GET），不属于全局列表/拓扑。hook 内部**复用已有纯 reducer**（`chat-slice-reducer.applyAgentEventToMessages` 喂 agent_loop 帧 + `session-slice-reducer.applySessionStatusUpdate` 喂 session_panel 的 session_status_update 帧）——**不写第三套 reducer**。sessionId 变化时 hook 自动重订阅 + 重拉初值。
- **接口签名**：
  ```ts
  useSessionRunState(sessionId, opts?: {
    sseClient?: SseClient;            // 注入（playground 共享 sharedSse）；省略 → hook 自建+destroy（studio 单聊隔离）
    onWorkspaceEvent?: (evt) => void; // session_panel 的 workspace 事件转发给 store（section-workspace-panel 消费）
    onSessionRead?: (sid) => void;    // session_read_update 转发（store 更新 sessions[] unread）
  }): {
    messages, hasMore, setMessages,           // transcript + 分页（prepend 旧消息）
    runActive, loadingPhase, lastRunFinish,   // agent_loop 派生（loading 胶囊 + run-finish）
    sessionRunning,                           // session_panel 权威源（停止按钮 + run-finish 门控）
    enqueueItems, removeEnqueueItem,          // 排队区（running 时 enqueue + cancel 乐观移除）
    usage, summaryTask,                       // usage 圆环 + CompactBtn 状态
    abort, reset,                             // POST /abort（fire-and-forget）/ 切 session 重置
  }
  ```
- **SSE 订阅契约**（与原 page-chat openSession 一致，零回归）：
  - `agent_loop`（group=`session_id:${sid}_amt:current`）→ 喂 `applyAgentEventToMessages`（messages/runActive/loadingPhase/lastRunFinish/enqueueItems）。
  - `session_panel`（group=`session_id:${sid}`）→ 按 type 分流：`session_status_update`→sessionRunning；`session_usage_update`→usage；`summary_task_update`→summaryTask；`messages_cleared`→清 messages/lastRunFinish/enqueueItems；`session_workspace_*`→`onWorkspaceEvent`；`session_read_update`→`onSessionRead`。
  - 切 session cleanup：unsubscribe 两 topic（hook 自建实例额外 destroy）。
- **与 store 的关系**（B 的核心——store 瘦身）：
  - **store 砍掉**：messages/hasMore/runActive/loadingPhase/lastRunFinish/sessionRunning/enqueueItems/usage/summaryTask 及 actions（applyAgentEvent/applySessionEvent/setMessages/setSessionRunning/setUsage/removeEnqueueItem/resetRunState）。
  - **store 保留**：sessions[] 列表（setSessions/setSessionUnread/**applySessionMetaEvent 含 P1 bizType 守卫**）+ activeSessionId/setActiveSession + subagent tree（childrenByParent/activeSubId/setChildren/setActiveSubId）+ lastWorkspaceEvent/setLastWorkspaceEvent（workspace 扇出，section-workspace-panel 读）。
- **SSE 隔离**（对 playground 零回归）：playground 注入 page-chat 的 sharedSse（模块级单例，hook 只 sub/unsub 不 destroy）；studio 单聊省略 sseClient → hook 内部 new + connect + cleanup 时 destroy（不碰 playground sharedSse）。
- **代码路径（历史，v0.0.94 已拆 area-hooks / v0.0.216 收敛 SectionChatSession）**：纯 reducer 仍在 `store/{chat-slice-reducer,session-slice-reducer}.ts`（由 area-hooks 调用）。
- **subagent 只读页 transcript**：实时性由 useMessages 的 agent_loop 订阅承担（`use-subagent-run-refresh.ts` 已删——run 结束丢帧的根因在 reducer 层根治：tool_call_* 按 evt.messageId 锚定 + 缺 message 兜底建 assistant message）。
- **[v0.0.81.compaction_bug] setMessages by-id merge（防 transcript fetch 重置 SSE 累积态）**：`setMessages` 内部调 `chat-page/merge-messages-by-id.ts.mergeMessagesById(prev, incoming, prepend)` 按 id 合并：
  - 同 id 时**取 prev**（保留 SSE 累积的 tool_call rawArgs / pendingError 等，不覆盖）；incoming 自身去重保序。
  - `prepend=true`（loadMore 续载）：incoming 在前 + prev 独有 id 按原序补回（保 SSE 增量的近期消息不丢）。
  - `prepend=false`（transcript fetch 整体替换）：不补 prev 独有 id（transcript 是权威最新 list）。
  - SSE reducer（`chat-slice-reducer`）已按 id dedup，本 helper 只管 transcript fetch / loadMore 路径——修复「transcript fetch 整体替换重置已渲染同 id 消息 → tool_call 增量被覆盖丢失」bug（与 compact_notice 删除独立，但同一 query 触发的真实 UI dedup bug）。代码路径：`use-session-run-state.ts:setMessages() → merge-messages-by-id.ts:mergeMessagesById()`。

### 3.5 共享 run 态 UI 组装层 ComponentRunStateBar `[v0.0.39 P2 R3]`

- **核心概念**：`chat-page/component-run-state-bar.tsx` 是继渲染内核 ChatStream（§3.3）、run 态引擎 `useSessionRunState`（§3.4）之后的**第三个共享件**——把"引擎数据 → UI 组件"这层**组装**收拢成共享组件，**避免引擎字段被某个消费方漏接**（R2 引擎已算 `enqueueItems/removeEnqueueItem`，但单聊 `section-member-chat` 只手写接了 loading+abort，漏了 enqueue 排队区，正是组装层未抽象的后果）。
- **设计思路**：run 态 UI 三块差异**仅在数据源**（playground vs studio 单聊），UI 结构同构 → 收拢：
  - `ComponentRunStateBar`（Fragment）= **loading 胶囊**（`ComponentLoadingStatus`，悬浮，`phase=runActive?loadingPhase:null`）+ **enqueue 排队区**（`ComponentEnqueueView`，占排版流，`running && items.length>0` 门控）。两块不依赖 caller 的 textarea/send 布局，可完整封装；`showEnqueue=false` 仅留 loading 胶囊（playground readOnly mode）。
  - `ComponentRunStateAbortSlot` = **停止按钮判断收拢**（`sessionRunning && sessionId` 才渲 `ComponentAbortBtn`）。位置仍由 caller 内联（在自己 input-row 的 textarea 与 send 之间，两边 send 样式不同不抽），但「是否渲染」的判断统一吃进 slot，**两消费方不再各写一遍同款条件+JSX**。
- **零回归**：渲为 Fragment（不引入新定位上下文）；caller 放它进输入区 wrapper 首位——wrapper 满宽贴底，左下角 = 页根左下角，故 loading 胶囊 `absolute left-10 bottom-[72px]` 物理位置与原先（直接挂页根）一致；enqueue 区仍是 wrapper 首个 in-flow 子节点。testid 由叶子组件自带（`chat-loading-status`/`enqueue-view`/`chat-abort`），包装不改 DOM。
- **代码路径**：`chat-page/component-run-state-bar.tsx.{ComponentRunStateBar,ComponentRunStateAbortSlot}` ← `chat-page/base-chat-input-bar.tsx`（enqueue 排队区骨架位）+ `component-chat-session-input.tsx`（AbortSlot，caps.runState 门控）；复用 `component-{loading-status,enqueue-view,abort-btn}.tsx`。

**单文件单组件**：一个 `.tsx` 只导出一个组件（+ 其私有子组件）。文件名 = 组件名。例外：紧密相关的一组件可同文件多导出（如 `component-usage-panel.tsx` 导出 `ComponentUsagePanel/CompactBtn/ClearBtn`；`component-run-state-bar.tsx` 导出 `ComponentRunStateBar/ComponentRunStateAbortSlot`）。

### 3.6 [v0.0.42] sideResolver prop（消息来源左右对齐）

- **核心概念**：`component-message-stream` 加可选 `sideResolver?: (msg: Message) => 'user' | 'assistant'`——caller 可覆盖内核默认 `sideOfMessage`（左右侧判定）。**单一职责**：sideResolver 只控「左右侧」，头像/名字仍由 `resolveActor` 控制（不受 sideResolver 影响）。
- **设计思路**（actor `side` 字段方案 vs 独立 sideResolver prop 的对比，**采纳独立 prop**）：
  - **独立 prop（采纳）**：单一职责——`resolveActor` 管头像/名字，`sideResolver` 管左右。两者解耦、可独立覆盖；不传 resolver 时全走默认（playground 零回归）。
  - **actor.side 字段（否决）**：把「左右侧」语义塞进 actor 解析结果，与头像/名字混在一起；单聊 a2a→右需要绕开默认头像解析（仍是 member 头像）只改 side，actor.side 字段方案耦合不清。
- **接口签名**：`MessageStreamProps` 加 `sideResolver?: (msg: Message) => 'user' | 'assistant'`；内核渲染 `side = sideResolver?.(msg) ?? sideOfMessage(msg)`（默认逻辑不动）。**不影响 actor 解析**——actor 仍由 `resolveActor(msg)` 决定，与 side 独立。
- **三视图策略**（接线单点 = `chat-actor-strategy.tsx.deriveRenderStrategy(chrome)`，SectionChatSession 消费）：
  - **studio 单聊**（chrome.memberId 非空）：`sideResolver = msg => isA2aInbox(msg) ? 'user' : sideOfMessage(msg)`（a2a 收件→右与 user 同侧；assistant 自答+tool 仍左）。`sideOfMessage` 从内核导出复用（保持默认逻辑单一来源）。
  - **studio 群聊**（chrome.capabilities.groupRender=true）：不传 sideResolver（沿用默认 a2a→左）。
  - **playground / academy**：不传（默认零回归）。
- **代码路径**：`app/web/src/components/chat-page/component-message-stream.tsx` 加 prop + 内核 `sideOfMessage` 改为可被覆盖（导出供 caller 复用）← `chat-page/chat-actor-strategy.tsx.memberSideResolver`（a2a→右 resolver，单聊策略）。详见组件 spec `specs/ui/components/chat-page/component-message-stream.md`。

### 3.7 [v0.0.42] 两层状态 UI（stop 圆环 + on-message spinner）

- **核心概念**：本版本起 run 态 UI 严格两层分离（PRD §1 + `sse_channel.md §9.1`）——**stop 按钮**（session 层，圆环动画+实心方框，interrupting 减速）+ **on-message spinner**（run 层，贴流式尾部，spinner+phase 同控件状态各自决定）。移除原浮动 loading 胶囊（`absolute left-10 bottom-[72px]`，§4.10），其职责被两层 UI 替代。
- **stop 按钮圆环视觉**（`component-abort-btn` 改写）：
  - Props：`{ sessionId, sessionState: 'running' | 'interrupting', onAbort }`（替代原 `{ sessionId, onAbort }`，加 `sessionState` 让组件感知 interrupting 态做减速）。
  - 视觉：外圈**旋转环**（accent border + animate-spin，running 时 duration 1s，interrupting 时 duration 2.5s 减速）+ 中心**实心方框**（stop icon，14px）。
  - 可见条件：父 `ComponentRunStateAbortSlot` 门控 `sessionRunning && sessionId`（沿用）。
  - **interrupting 减速实现**：CSS `animation-duration` 按 `sessionState` 切换（running=1s / interrupting=2.5s）；不 disable 按钮（视觉反馈即可，POST /abort 已 fire-and-forget + 防连点 disabled 本地态保留）。
- **on-message spinner 组件**（新建 `component-on-message-spinner` 或改造 `component-loading-status`）：
  - Props：`{ visible: boolean; phase: LoadingPhase | null }`。
  - 可见性：`visible === runActive`（只要 run 活着就转）。
  - 视觉：spinner 圆环（小，9px，沿用 `component-loading-status` 的 spinner 样式）+ phase 文案（4 阶段表，沿用 §4.10）；spinner 与 phase 文案**同一控件、状态各自决定**（4 阶段：thinking/answering/tool_calling/tool_executing）。
  - **位置**：贴 run 流式尾部（最新内容下方）——由 caller 放在 `ComponentMessageStream` 的 messages 列表末尾（在 run-finish 之前），随 auto-scroll 始终可见。**不再是浮动胶囊**。
- **`ComponentRunStateBar` 组装变化**：
  - **移除**：`<ComponentLoadingStatus phase={runActive ? loadingPhase : null} />`（浮动胶囊）。
  - **保留**：`<ComponentEnqueueView />`（enqueue 排队区，session 层，与 loading 无关）。
  - **on-message spinner 移到 `ComponentMessageStream` 内**（或父 section 显式组合）——因为位置在流式尾部，属于 message 渲染区。`ComponentRunStateBar` 只剩 enqueue 区 + abort slot，命名沿用（历史命名，避免改 testid 破坏 ET）。
- **引擎恢复路径**（`useSessionRunState` 切走切回）：
  - 切走：unsubscribe agent_loop + session_panel，hook ref 状态保留（或 reset，依赖实现；当前实现是切 sessionId 时 reset）。
  - 切回：useEffect 重订阅 → GET /session 兜底 sessionRunning + subscribe agent_loop 触发 replay（含 sticky run_start → runActive 恢复）。**hook 自身逻辑不变**——`applyAgentEventToMessages` 喂入 replay 事件，run_start 自动翻 runActive=true。
  - **关键**：replay 粘住（块 1）是后端 event-bus 改动，前端 hook 零改动受益。
- **代码路径**：`app/web/src/components/chat-page/component-abort-btn.tsx`（圆环改造）+ `component-loading-status.tsx`（改造为 on-message spinner，移除 absolute 定位）或新建 `component-on-message-spinner.tsx` + `component-message-stream.tsx`（末尾加 spinner 节点）+ `component-run-state-bar.tsx`（移除 loading 胶囊引用）+ `section-chat-session.tsx`（统一装配 on-message spinner）。详见组件 spec `_overview.md §4.10/§4.11b`。

### 3.8 [v0.0.88] SSE Client 单例 + 组件级订阅

- **核心概念**：`app/web/src/lib/sse-singleton.ts` 导出**唯一** SseClient 单例（`getSseClient()` 模块级 lazy）；app 根 mount 不需要 explicit connect（首次 `getSseClient()` 调用 lazy 自连），app 卸载时 `destroy()`。中间全程不动连接——切会话/切页面/StrictMode 双 mount 都不重连。详见 `specs/tech/app/frontend/[P0]sse_client_singleton.md`。
- **设计思路**：后端 `EventHub`/`SseChannel` 本就是「1 消费者 per (topic,group)」模型，多 SseClient 共存触发未设计缺陷（hub 无 refcount / channel subs 去重丢 replay / `_all` 多订阅者互相踩）。**单例不是选项，是后端模型的硬约束**。playground 稳定正是因为只 1 个 SseClient，后端只见 1 个消费者。
- **subscriberId 路由**：每个 `subscribe()` 调用生成唯一 `subscriberId`（前端 ULID），上行 `POST /sse/subscribe` 携带，后端帧携带 `subscriberId` 下行，前端按 `subscriberId` 路由到 handler（**零过滤**）。稳定句柄（不依赖 handler 引用相等）解决 React inline arrow handler 变化问题。详见 `[P0]sse_client_singleton.md §3`。
- **代码路径**：`app/web/src/lib/sse-singleton.ts`（新建 `getSseClient()` + 测试 `_resetSseSingletonForTest()`）+ `app/web/src/lib/sse-client.ts`（`SseClient.handlers` 改 `Map<subscriberId, handler>`，`subscribe/unsubscribe` 加 subscriberId 生成与路由）。
- **迁移映射**（详 `[P0]sse_client_singleton.md §5`）：
  - **R1 playground sharedSse**（`page-chat.tsx:38,110` 模块级 `let sharedSse` + `new SseClient()`）：删模块级 `let`，改 `import { getSseClient }`；session_meta `_all` 订阅挂单例。
  - **R2 studio ownSse**（`use-session-run-state.ts:231` `ownSse=true → new+destroy`）：删 `ownSse` 分支，`useSessionRunState` 强制从单例取；cleanup `unsubscribe` 两 topic 但**不 destroy**。
  - **R3 squad 轮询**（`section-squad-chat.tsx:67` `setInterval(fetchOnce, 2000)`）：删 `setInterval`，改单例 subscribe `agent_loop` + `session_panel`，与 member 单聊同机制。
- **状态自愈**（治 D6/D7，归属 `useSessionRunState` 引擎层）：收到 `run_end` 但 `sessionState` 仍 running → `GET /session/:id` 校正；收到 `session_status_update{state:idle|error}` → 强制 `runActive=false`（清 sticky run_start 孤儿）。详见 `[P0]sse_client_singleton.md §7`。
- **与 §3.4 共享 run 态引擎的关系**：`useSessionRunState` 的 `sseClient?` 注入参数在 v0.0.88 后废弃（保留兼容签名但忽略）；hook 内部强制 `getSseClient()` 取单例。playground / studio 单聊 / squad 群聊统一从单例订阅，零隔离分支。

### 3.9 [v0.0.88] 后端多订阅 + 定向投递

- **核心概念**：`SseChannel.subscribe(topic, group, subscriberId, sink)` 持 `SubscriberProxy` 对象；`unsubscribe(subscriberId)` 按 id 移除 + refcount 归零才拆 hub 订阅。bus emit → channel listener 按 (topic,group) 取 `groupSubs` Set，对每个 `subscriberId` 写一帧携带 `subscriberId` 到其 `proxy.sink`——**定向投递**替代原 §5 `writeFrame` 广播。详见 `specs/tech/app/frontend/[P0]sse_channel_multipub.md`。
- **hub refcount**（防御性）：`EventHub.activeSubs` 真数组 + refcount +1/-1/归零 delete，单例后不触发但补齐多消费者安全层。详见 `specs/tech/agent/event/[P0]event_hub.md §3.1`。
- **帧格式变更**：`{topic, group, data, timestamp, subscriberId}`（加 subscriberId 字段，向后兼容旧客户端）。
- **代码路径**：`app/server/src/sse/sse-channel.ts`（`subscribers`/`groupSubs`/`subs` 三 Map + `subscribe/unsubscribe` 改造）+ `app/server/src/agent/event-hub.ts`（`activeSubs` 真数组 + push/cancel refcount）+ `app/server/src/handlers/sse.ts`（`SubscribeBody` 加 `subscriberId?`）。

### 3.10 [v0.0.94] useLifecycle 四方法契约（标准化组件数据生命周期）

> **v0.0.94 演进**：从 v0.0.92 三方法（`init/destroy/refresh`+`poll` config）→ 四方法（`onInit/onDestroy/onTick/onEvent` + `effect` 声明式）+ **ctx ref-latest 不变量①** + **数据三形标准化**（→ `[P0]lifecycle_data_shapes.md`）+ **对话区引擎拆解**（→ `[P0]chat_area_hooks.md`）。规范权威 = 本节 + 三形文件 + area-hooks 文件 + 全组件迁移映射表（§3.11）。
>
> **v0.0.95 演进**：四方法契约加 **buffer 第三参数**（消灭 useMessages 流式特例）。`useLifecycle<TCtx, TBuffer, TEvent>`：onInit 返 `{ctx, buffer}`（buffer 可选，大多数 hook 不传）；onEvent/onTick 收 `(ctx, buffer, event, from)` 返 `{ctx?, buffer?}`（ctx 变才渲染，buffer 变不渲染）；onDestroy 收 `(ctx, buffer|null)`。**双写路径**：ctx→commitCtx+setCtx（渲染）/ buffer→commitBuffer（只写 ref 不渲染）。新增**不变量⑦ buffer 变不渲染** + **不变量⑧ onEvent 串行调度**。命令式口子 `mutate` 分裂为 `mutateCtx`（改渲染态）+ `mutateBuffer`（改工作内存不渲染）。详 `reqs/[done] v0.0.95.lifecycle_buffer/req.md`（法律）。

- **核心概念**：`app/web/src/lib/use-lifecycle.ts` 提供**唯一**的生命周期抽象 hook `useLifecycle<TCtx, TBuffer, TEvent>(opts)`，收敛组件级「订阅 / 数据 / 定时器」三类资源的 mount/unmount 管理。形态 = **hook**（非 OOP base class，React 函数组件原生契合）。
- **控制模型（design-decisions §5 + v0.0.95 buffer 扩展）**：useLifecycle 是**数据唯一持有者**，攥 `ctxRef`（渲染态）+ `bufferRef`（工作内存）+ `setCtx`（渲染）三个句柄**不外发**；在合适时机主动调**纯函数回调**（帧到→onEvent、tick→onTick、mount/deps→onInit、unmount→onDestroy）；回调只回答「旧数据+事件=新数据」`return` 新值，不碰 setState/订阅回收。**两个命令式口子**（v0.0.95 分立）：
  - **`reload()`** = 主动 re-init（重订阅/起 timer，POST 写后调；re-init 同时重置 ctx+buffer）。
  - **`mutateCtx(updater)`** = 主动局部改 ctx（触发渲染）。`updater(ctxRef.current)` 走同一 ① ref-latest 写回路径（`commitCtx`）。`updater` 纯函数 `(ctx)=>newCtx|void`，void 跳渲染。
  - **`mutateBuffer(updater)`**（v0.0.95 新增） = 主动局部改 buffer（**不渲染**）。`updater(bufferRef.current)` 走 `commitBuffer`（只写 bufferRef，不 setCtx）。供需要外部清理累积缓存的场景（如手动 reset）。
  - **消灭 overlay useState/ref+reload workaround**（数据分裂 ctx+overlay 违背原子化）。乐观更新（markRead/loadDetail/async 校正）用 mutateCtx 不重 init。
  - 其余全被动（onEvent/onTick/onInit/onDestroy 由 useLifecycle 主动调）。
- **接口签名（v0.0.95 加 buffer 第三参数）**：
  ```ts
  interface LifecycleContract<TCtx, TBuffer, TEvent> {
    /** mount / deps 变 / reload 时：读原始数据(API) + effect.startTimer + effect.subscribe(可多次)；返回 {ctx, buffer}（buffer 可为 null/undefined）。接 signal，await 后 signal.aborted 校验才生效（不变量2） */
    onInit: (api: LifecycleInitApi) => Promise<{ ctx: TCtx; buffer: TBuffer | null } | TCtx> | ({ ctx: TCtx; buffer: TBuffer | null } | TCtx);
    /** unmount / re-init 前：清 onInit 里自己 new 的业务资源。幂等（不变量3）。timer/SSE 由 useLifecycle 自动回收，此处不重复退；收最终 ctx+buffer（buffer 可能为 null） */
    onDestroy?: (ctx: TCtx | null, buffer: TBuffer | null) => void;
    /** timer 到点（= 定时轮询本意，仅 onInit 里 startTimer 声明才调）。可 async 重读 API 返 {ctx?,buffer?}（双写） */
    onTick?: (ctx: TCtx | null, buffer: TBuffer | null) => Promise<{ ctx?: TCtx; buffer?: TBuffer } | void> | { ctx?: TCtx; buffer?: TBuffer } | void;
    /** SSE 帧到达（仅 subscribe 声明才调）。收 ctxRef.current + bufferRef.current（最新，非快照）+ 事件 + from{topic,group}；多订阅按 from.topic switch；返 {ctx?,buffer?}（ctx 变才渲染、buffer 变不渲染，不变量⑦）；返回 void=不改数据 */
    onEvent?: (ctx: TCtx | null, buffer: TBuffer | null, event: TEvent, from: { topic: string; group: string }) => { ctx?: TCtx; buffer?: TBuffer } | void;
    /** deps：变化时 onDestroy(旧) + onInit(新) */
    deps: ReadonlyArray<unknown>;
  }
  /** onInit 收到的 api：声明式启动 timer / 订阅，useLifecycle 跟踪并自动回收 */
  interface LifecycleInitApi {
    signal: AbortSignal;                                                       // abort 后禁写数据（不变量2）
    startTimer: (opts: { intervalMs: number; justification: string }) => void; // 到点 onTick；须 justification（不变量4）
    subscribe: (topic: string, group: string) => void;                        // 帧到达 onEvent；可多次（多订阅），回收自动（不变量6）
  }
  function useLifecycle<TCtx, TBuffer = null, TEvent = unknown>(opts: LifecycleContract<TCtx, TBuffer, TEvent>): {
    ctx: TCtx | null; loading: boolean; error: Error | null;
    /** 命令式 re-init：abort 旧 generation + 重跑 onInit（重订阅/起 timer；re-init 同时重置 ctx+buffer，不依赖 deps） */
    reload: () => Promise<void>;
    /** 命令式局部改 ctx（触发渲染）：updater(ctxRef.current) 走同一 ① ref-latest 写回路径（commitCtx）；不重订阅/不重 init/不碰 timer/SSE；updater 返 void 跳渲染 */
    mutateCtx: (updater: (ctx: TCtx | null) => TCtx | void) => void;
    /** 命令式局部改 buffer（不渲染）：updater(bufferRef.current) 走 commitBuffer（只写 bufferRef 不 setCtx）；供外部清理累积缓存（如手动 reset）；updater 返 void 跳写 */
    mutateBuffer: (updater: (buffer: TBuffer | null) => TBuffer | void) => void;
  };
  ```
- **6+2 不变量（MUST NOT 违反）**：
  1. **① ctx ref-latest（v0.0.94 新增，正确性核心）**：`onEvent`/`onTick` 收到的是 useLifecycle 内部 `ctxRef.current`（**永远最新**），非可能滞后的 React 快照；返回值 useLifecycle **同步写回 `ctxRef` + 排队 `setCtx` 渲染**。**为什么必须**：agent_loop 一秒几十帧 `text_block_delta`，拿 React 快照则帧2 读到帧1 未 commit 的 stale 值 → 流式累积覆盖丢字。ref-latest 保证一环扣一环不丢帧。**现状**：引擎靠手写 `sliceRef.current` 扛，①把它升为契约默认，每个 area-hook 白嫖。
  2. **onInit 接 signal**：所有 await 后必须 `signal.aborted` 校验才能写数据（杜绝 unmount 后 setState）。
  3. **onDestroy 幂等**：多次调用不抛异常（re-init 前 + unmount 都会调）。
  4. **timer 需 justification**：`effect.startTimer` 必须写理由（轮询谨慎，dev 缺则 `console.warn('[lifecycle] polling ...')`）。
  5. **timer/SSE 回收归 useLifecycle**：onInit 用 effect 声明的，useLifecycle 自动停/退订；onDestroy 只清 onInit 手动 new 的业务资源（防漏收/双重收）。
  6. **订阅数无硬限（可多订阅）**：单 hook 可 `effect.subscribe` 多次，onEvent 按 `from.topic` switch。设计上优先「每区域一个 hook」；天然多 topic 的区域（如 `useMessages` = agent_loop 流 + session_panel messages_cleared）单 hook 多订阅 + switch 比硬拆干净。
  7. **⑦ buffer 变不渲染（v0.0.95 新增）**：onEvent/onTick 返回 `{ctx?,buffer?}` 中只有 `ctx` 字段触发渲染（commitCtx 写 ref + setCtx）；`buffer` 字段只走 commitBuffer（写 bufferRef，**不 setCtx**）。**为什么必须**：buffer 持「跨帧累积的中间态」（如 `runCtx.toolCallRawArgs` 半截 JSON 片段、`pendingError`），半截态给用户看无意义且闪烁；只有最终落到 ctx（messages + runFinish）才渲染。buffer 是 hook 私有工作内存，**对外不暴露**（消费方只读 ctx 字段）。
  8. **⑧ onEvent 串行调度（v0.0.95 新增）**：useLifecycle 保证 onEvent **一帧同步处理完才接下一帧**——handleFrame 内同步链路（调 onEventRef.current → commitCtx/commitBuffer）无重入、无并发；SseClient 单线程顺序投递是基础。**为什么必须**：单 buffer 实例不能并发写（race 致累积错乱）。现状 SSE 帧/React 事件循环本就顺序到达，本不变量是把"天然倾向串行"升为**显式契约保证**——禁止引入并发 onEvent 调度（如 Promise.all 批量喂帧）。
- **buffer 清理三层时机（v0.0.95 D2 落地）**：
  1. **reducer 内清理**：reducer 纯函数在 `tool_call_end` 等"攒够写 ctx"的 case，**同帧从返回的新 buffer 中删该 key**（return 删 key 的新 Map / 新对象）。不清理两后果：(a) 内存泄漏（每次 tool_call 留半截，buffer 无限增长）；(b) 旧数据污染（下次同 id 接着旧半截拼→参数错乱）。
  2. **onDestroy 整个 buffer 重置**：unmount 时 bufferRef 随 hook 销毁（onDestroy 收 buffer 终值做业务清理，buffer 本身由 hook GC）。
  3. **reload/deps 变 re-init 重置**：re-init 时 bufferRef.current 重置为 onInit 返回的初值（null 或新对象）。
  - **UT 必验**：跑一轮 tool_call（start→delta→end）后 `buffer.runCtx.toolCallRawArgs` 中对应 key 已删（D2 落地验证）。
- **6 禁忌（落地为代码注释 + dev 警告）**：❌ render 期间订阅；❌ 裸 `setInterval`（必须 `effect.startTimer`→onTick）；❌ 裸 `setTimeout` 不清；❌ `new SseClient()`（必须 `getSseClient()`，§3.8 S1；v0.0.92 use-studio-unread-meta 曾违规作 G1 反例，本版彻底改单例）；❌ onInit await 后不校验 signal 就写；❌ 把「全局 store 不释放」当「组件已清理」。
- **effect 声明式订阅/timer（v0.0.94 新增）**：onInit 内 `effect.subscribe(topic,group)` 声明订阅（内部 `getSseClient().subscribe`，句柄 useLifecycle 持有）；`effect.startTimer({intervalMs,justification})` 声明轮询。**回收全归 useLifecycle**（re-init/unmount 时自动 unsubscribe + clearInterval），onDestroy 不重复退。SseClient 连接生命周期仍归 app 级（§3.8 S3），本 hook 只 sub/unsub 不碰连接。SSE 重连（`[P0]sse_client_singleton.md §7.2`）在 SseClient 内部实现，不暴露给 useLifecycle。
- **onEvent/onTick 返回新 ctx（design-decisions §8 #1）**：回调返回新 ctx（immutable）→ useLifecycle 同步写 ref + 排队 setCtx。返回 `void`/`undefined` = 不改数据（幂等，跳渲染）。**副作用受控例外**：扇出枢纽 hook（`useSessionPanelFanout`）onEvent 内直接写 store（`setLastWorkspaceEvent`）返回 void——扇出本质是副作用，spec 显式标（`[P0]chat_area_hooks.md §4.2`）。
- **reload-on-resume = poll-only（v0.0.92 契约沿用，design-decisions §8 #2）**：`document.hidden` 时暂停 timer；切回 visible **仅当声明了 timer 才 reload 一次**（重起 timer）。纯订阅 hook 不在 tab 切换/重连重载，靠 SSE bridge（`onResumed`）续流。**为什么**：无条件 reload 会 abort in-flight（如 `useSubagentChildren` 借 hook 只为 unmount cleanup），故限 poll-only。`onResumed` 作未来扩展点**不做**。
- **数据三形（v0.0.94 新增）**：onEvent 按数据形调标准 reducer——list 型 `Collection<T>`+`applyCrud` / 单个型 `Snapshot<T>`+`applySnapshot` / kv 型 `KeyedMap<K,V>`+`applyKeyed`。每 hook 恰好持一形一块数据（原子化）。流式特例 `useMessages`（v0.0.94 不套三形、自管 sliceRef+runCtxRef）在 **v0.0.95 通过 buffer 第三参数消灭**：reducer 纯化（无 ctxRef mutate）后，跨帧累积态（rawArgs/pendingError）走 buffer 通道，进契约纯函数通道。详见 `[P0]lifecycle_data_shapes.md §3.2` + `[P0]chat_area_hooks.md §3`。
- **buffer 第三参数（v0.0.95 新增）**：reducer 有跨帧累积需求（如 useMessages 的 tool_call JSON 片段累积、error 暂存）时，用 `TBuffer` 类型作第三泛型参数。onEvent 收 `(ctx, buffer, event, from)` 返 `{ctx?,buffer?}`——ctx 走渲染通道、buffer 走工作内存通道（不变量⑦）。**buffer 完全私有**（hook 内部 bufferRef 持，消费方读不到也不需要读）；**大多数 hook 不用 buffer**（TBuffer 默认 null，签名退化到 v0.0.94 两参形式）。详见 `[P0]chat_area_hooks.md §3`（useMessages 落地样板）。
- **代码路径**：`app/web/src/lib/use-lifecycle.ts`（v0.0.94 升级四方法+effect+ref-latest；v0.0.95 加 TBuffer 第三参数 + 双写路径 + mutateCtx/mutateBuffer 分立）+ `app/web/src/lib/lifecycle-shapes.ts`（三形 reducer）+ `app/web/src/lib/__tests__/{use-lifecycle,lifecycle-shapes}.test.ts`。

### 3.11 [v0.0.94] 组件数据 hook 迁移映射表 → 见 `[P0]component_data_map.md`

本版核心 = 把所有数据 hook 统一到四方法契约（design-decisions §1 全部迁移含对话区引擎）。**全组件 → 契约映射表**（18 个数据 hook/组件，数据形/topic/API/触发/契约草案/备注）已下沉到独立文件 `[P0]component_data_map.md`（pre-coding 硬门禁标准：涉 UI/数据需求进编码前必须先出组件-数据源拆解表，按该表结构填新组件）。该表是「组件-数据源拆解标准」的永久落地，后续版本增删组件须同步更新。SSE 优先核实结论（BudgetMeter budget 前提修正）也在该表 §4。

### 3.12 BaseChatPage 骨架消费 + page-chat action hook

- **核心概念**：`base-chat-page.tsx`（page 级骨架）+ `base-chat-input-bar.tsx`（input 级骨架）的**唯一装配消费方 = `section-chat-session.tsx`**（v0.0.216 统一装配层，slot 注入：topbarLeft / topbarRight / messagesSlot / rightOverlaySlot / inputSlot）；7 个页面经 SectionChatSession 同源接入，差异只在身份要素注入（消费方必备能力清单见 `specs/ui/components/chat-page/base-chat-page.md`）。契约见 `base-chat-page.md` + `base-chat-input-bar.md`。
- **`use-chat-actions.ts` hook**：现只持**列表/导航** handler（openSession / handleCreate / handleDelete / handleRenameTitle / handleSelectSub）；会话区 handler（send / enqueueCancel / compact / clear / model / effort / approval）已内置 SectionChatSession（页面侧无接线）。每个 useCallback deps 数组防 stale closure：`openSession` 含 `sessions`（内部 `sessions.find(...)?.derivation==='subagent'` 判定 subagent）。
- **代码路径**：`chat-page/section-chat-session.tsx`（BaseChatPage 唯一装配消费方）+ `use-chat-actions.ts`（列表/导航 handler）+ `page-chat.tsx`（`const actions = useChatActions({...})` + render 内 `actions.handleX` 引用）。
- **接口签名**：
  ```ts
  interface UseChatActionsDeps {
    activeSessionId: string | null; sessions: Session[];
    setSessions: (u: Session[] | ((p: Session[]) => Session[])) => void;
    setActiveSession: (id: string | null) => void; setSessionUnread: (id: string, unread: boolean) => void;
    setActiveSubId: (id: string | null) => void;
    messages: ReturnType<typeof useMessages>; model: ModelSelection | null;
    setModel: (sel: ModelSelection | null) => void; resetSubRunBaseline: (subSessionId: string) => void;
    setError: (e: string | null) => void; setSendError: (e: string | null) => void;
  }
  function useChatActions(deps: UseChatActionsDeps): { openSession, handleModelChange, ..., handleSelectSub };
  ```
- **chat 域 barrel re-export 拆分（B）**：`types.ts` / `store/chat-slice-reducer.ts` / `lib/chat-api.ts` 三个大文件拆成 barrel + 子文件（各消费方零改），见 log.md v0.0.156 节 + change_log.md 段 B。前端 store/lib 目录变动：
  - `app/web/src/store/reducer/`：`agent-event-types.ts` / `message-preview.ts` / `reducer-state.ts` / `apply-agent-event.ts`（325 行主 reducer）
  - `app/web/src/lib/chat-api/`：`session-api.ts` / `message-api.ts` / `usage-summary-api.ts` / `workspace-api.ts`
- **版本演进**：`[v0.0.155]` 抽 base-chat-page + base-chat-input-bar + component-chat-topbar-right（studio 双聊消费）。`[v0.0.156]` playground 补接入（A1）+ page-chat handler 抽 hook（A3）+ chat 域 barrel 拆分（B）+ base-chat-page 补 `data-testid="chat-topbar"`（v0.0.155 遗漏补落）。

### 3.13 [v0.0.182] 三栏响应式布局引擎（layout-width-engine + useThreeColLayout）

- **核心概念**：chat 页（conv-panel + chat-detail + ws-panel）与 studio chat 页（chat 主区 + section-right-tabs）的三栏宽度由**纯函数引擎**统一换算——`app/web/src/lib/layout-width-engine.ts` 零 React 依赖，输入（available = 页容器 clientWidth、左右槽位设定宽/收起态、上一帧 L/R/C 渲染宽、dragging 标志）→ 输出（L/R/C 渲染宽 + minRowWidth + scrollX + cDefend）。宽度常量（232/560/272/36、180/400/220、480/932）唯一权威源在引擎。
- **统一宽度模型**：侧栏渲染宽 = `clamp(静态min, min(设定宽, 动态上限), 静态max)`，解析顺序**先 R 后 L**（= 降级 右⇒左）；中部不变式 `C = available − L − R ≥ 480`，破 480 → 内行 `min-width = L+480+R` + 页根容器 `overflow-x-auto` 横滚兜底（app-shell `overflow-hidden` 不变）。双场景语义分离：**场景 A 拖拽**（防守基准 480，对侧栏 hold 上一帧渲染宽不动）；**场景 B 窗口缩窄**（防守基准 `C_defend = clamp(480, middleCurrent, 932)`，侧栏先紧凑化最大化保中部）。相位表 P0~P4（右栏→232 ⇒ 左栏→180 ⇒ 中部→480 ⇒ 横滚）零硬编码、由公式涌现。932 = 820 内容列 + 32 左 pad + 80 右 overlay reserve（`_overview.md §4.5` 派生）。
- **拖拽无死区**：手柄 delta 算法（mousedown 捕获 startWidth+startX，raw = start ± Δ，clamp 到场景 A 动态上限 `available − 对侧Current − 480`），到边界反向立即响应；持久化写「拖拽实际到达的渲染宽」。通用 `ComponentColResizeHandle`（side=left/right 贴栏缘），`ComponentWsResizeHandle` 为其薄 wrapper（保 testid `ws-resize`）。
- **React 接线**：`useThreeColLayout` hook（chat-page/，page-chat 与 StudioChatRouter 共用）管 available（useLayoutEffect 首测 + ResizeObserver + window resize fallback，jsdom 守卫）+ convWidth（localStorage 全局 key `conv-panel-width`）+ rightReport（ws-panel 上报设定宽/收起态）+ dragging + 三 ref 帧回填。页根结构 = 外层 scroll 容器 + 内行 `flex h-full w-full` + style minWidth。**ws-panel 宽度 state 仍自管**（per-session `ws-width-<sid>` 持久化不变），父引擎经 `renderWidth` prop clamp 渲染宽、`onLayoutChange` 回收设定宽——「状态在下、算术在上」。
- **槽位映射**：chat 页 = 左 conv-panel（可拖 180~400 默认 220）+ 中 + 右 ws-panel（232~560 默认 272 / 收起 36）；studio = 左 null（sidebar 224 在 router 容器**外**、固定不参与）+ 中 + 右 SectionRightTabs→SectionWorkspacePanel（同 chat 右栏）。base-chat-page 骨架不动。
- **代码路径**：`app/web/src/lib/layout-width-engine.ts`（引擎 + UT `lib/__tests__/layout-width-engine.test.ts`）+ `app/web/src/components/chat-page/use-three-col-layout.ts`（hook）+ `component-col-resize-handle.tsx`（通用手柄）。PRD `specs/prd/version_logs/v0.0.182/change_log.md`；变更契约 `specs/tech/version_logs/v0.0.182/change_plan.md`。

## 4. 迁移记录（已完成）

历史上 `app/web/src/components/` 是扁平的 `settings/` + `chat/`；已按 `framework/` + `common/` + 一级页面目录重组。原文件去向：

| 旧位置 | 新位置 |
|------|------|
| `AppShell.tsx` | `framework/app-shell/app-shell.tsx` |
| `settings/AppSettingsPage.tsx` | `app-dev-config-page/page-app-config.tsx` |
| `settings/DevSettingsPage.tsx` | `app-dev-config-page/page-dev-config.tsx` |
| `settings/PluginSettingsPage.tsx` | `plugin-config-page/page-plugin-config.tsx` |
| `settings/ExtImplRow.tsx` | 拆为 `plugin-config-page/component-ext-impl-{radio,checkbox,ordered}.tsx` |

> 渐进迁移原则：新功能直接按 §3 目标结构；旧组件在涉及改动时顺手迁入，不强制一次性大重构。`chat/` 是仍未迁入 `chat-page/` 的旧目录。

## 5. 与 `tech_stack.md` §4.2 旧骨架的关系

`tech_stack.md` §4.2 的目录骨架（`app-shell/ chat/ settings/ primitives/`）是早期设想。**以本文件 §3 为准**；`tech_stack.md` 的骨架待后续对齐。

## 6. 复用规则

- **primitive**：放 `framework/primitives/`，任意层可引用
- **component/section**：优先放所属一级页面目录；若被 ≥2 页复用，提升到 `common/`
- **section/page**：只属于一个一级页面目录
- **framework**：`app-shell`/`nav-rail` 放 `framework/`，全局唯一

## 7. 单测

每个 component / primitive 配 `__tests__/{name}.test.tsx`（vitest + @testing-library/react），测渲染 + 交互，独立于页面。
