---
type: spec
title: 对话区引擎拆解（area-hooks：useMessages / useRunState / useUsage / useSummary）
priority: P0
status: active
updated: 2026-07-31
since: v0.0.94
related: [[P0]component_architecture.md, [P0]lifecycle_data_shapes.md, [P0]sse_client_singleton.md]
---

# 对话区引擎拆解（area-hooks）

## §1 概述

- **管什么**：把旧 `useSessionRunState` monolith（订双 topic + 揽 5 区域数据）**拆成 4 个 area-hook**——`useMessages` / `useRunState` / `useUsage` / `useSummary`，每个基于 useLifecycle 四方法契约、订自己那份数据、独立自治。统一装配层 `SectionChatSession`（`[P0]chat_session_assembly.md`）单点 compose 这些同源 area-hook，7 个消费页经它接入（不再各自起引擎/各自 compose）。
- **不管什么**：useLifecycle 四方法机制与 ref-latest 不变量（→ `[P0]component_architecture.md §3.10`）；三形 reducer（→ `[P0]lifecycle_data_shapes.md`）；SSE 单例订阅协议（→ `[P0]sse_client_singleton.md`）；纯展示内核 ComponentMessageStream / ComponentRunStateBar（→ `component_architecture.md §3.3/§3.5`，本次不动）。
- **范畴一句话**：把「一个 session 的运行态」从一个揽 5 件事的大 hook，拆成 4 个各管一件事的小 hook，让 usage 变了只动 useUsage、消息流帧不丢字靠 useMessages 独占。
- **与外界如何交互**：4 个 area-hook 在 `chat-page/` 目录，各自 `getSseClient().subscribe`（经 useLifecycle 的 `effect.subscribe` 声明）；由 `SectionChatSession` 统一 compose（§5）。

## §2 拆解总览（一 hook 一 topic 一形一块数据）

| area-hook | 订阅 | 读取 API | 数据形 | ctx 关键字段 | 消费方 |
|---|---|---|---|---|---|
| `useMessages` | `agent_loop`（流）+ `session_panel`（`messages_cleared` + `session_status_update` 终态） | GET /messages | **领域 reducer + buffer 第三参数**（v0.0.95：纯化后进契约，跨帧累积走 buffer 通道，详 §3） | messages / hasMore / runActive / loadingPhase / lastRunFinish / enqueueItems | SectionChatSession |
| `useRunState` | `session_panel`（`session_status_update`） | GET /session | Snapshot | sessionRunning / sessionState | SectionChatSession（`enabled=caps.runState`，群聊 false 零订阅） |
| `useUsage` | `session_panel`（`session_usage_update`） | GET /usage | Snapshot\<SessionUsageView\> | usage | SectionChatSession |
| `useSummary` | `session_panel`（`summary_task_update`） | 无（初值 null） | Snapshot\<SummaryTaskStatus\> | summaryTask | SectionChatSession（同款 enabled 门） |

**fan-out**：`session_panel` 被 3 个 area-hook（useRunState/useUsage/useSummary）+ useMessages（只取 messages_cleared）各订一份（各自 subId），后端定向投递多份——**已接受**（design-decisions §7 原子化 + debuggability > efficiency；v0.0.88 sse_channel_multipub 定向投递支持多 subId）。

**workspace / read / todo 扇出去哪了**（原引擎的 `onWorkspaceEvent`/`onSessionRead` 回调 + [v0.0.228] todo 第三类）：见 §4。

## §3 useMessages —— 流式 + buffer 第三参数样板（多订阅 + 领域 reducer）

> **v0.0.95 演进**：本节原是 useLifecycle 契约的「流式特例」（v0.0.94 唯一不进契约纯函数通道的 hook，自管 `sliceRef + runCtxRef`，onEvent 返 void 不走 ctx 通道）。v0.0.95 通过给 useLifecycle 加 **buffer 第三参数** + 纯化 `applyAgentEventToMessages`（消除 ctxRef mutate 副作用）消灭特例——useMessages 现走标准契约的 **ctx 渲染通道 + buffer 工作内存通道**双写路径。本节是 buffer 第三参数的**落地样板**（其它需要跨帧累积的 hook 可参考）。
>
> **历史背景（v0.0.94 特例理由，v0.0.95 已解决）**：原 reducer `applyAgentEventToMessages(messages, evt, ctxRef, slice)` 对 `ctxRef.toolCallRawArgs`/`pendingError` 有 mutate 副作用 → 非纯函数 → 不进契约纯函数通道 → 自管 sliceRef+runCtxRef+setSlice。v0.0.95 把 `ctxRef` 参数化为显式 `runCtx` 入参（值传递）+ 返回新 runCtx（immutable），reducer 变纯 → 进契约；跨帧累积走 buffer 通道（不渲染）。

- **核心概念**：唯一订 `agent_loop`（流式消息）的 area-hook，**同时**订 `session_panel` 只为处理 `messages_cleared`（clear 端点 emit 清对话区）+ `session_status_update` 终态清 sticky 孤儿（D7）——**单 hook 多订阅**的契约样板（`[P0]component_architecture.md §3.10` 不变量⑥），onEvent 按 `from.topic` switch。
- **ctx + buffer 双通道（v0.0.95 标准）**：
  - **ctx** = `{ messages, hasMore, runActive, loadingPhase, lastRunFinish, enqueueItems }`（**渲染**态，走 commitCtx+setCtx）。
  - **buffer** = `{ runCtx: RunContext | null }`（**工作内存**，走 commitBuffer 不渲染；持跨帧累积的 `toolCallRawArgs`/`pendingError`/`currentAssistantMessageId`）。
  - **buffer 完全私有**：`UseMessagesResult` 对外只暴露 ctx 字段 + 命令式方法（setMessages，[v0.0.97] 删 removeEnqueueItem/addEnqueueItem），消费方（page-chat/member-chat/squad-chat）读不到 buffer，也不需要读。
- **为什么仍保留领域 reducer（不套三形）**：agent_loop 帧是 part 级流式累积（`text_block_delta` 累积到某 message 的某 block、`tool_call_delta` 累积 JSON 片段），不是「整条 message upsert」粒度。`applyCrud` 的 by-key upsert 粒度太粗（覆盖会丢正在累积的 part）。但 reducer **已纯化**（v0.0.95，无 ctxRef mutate），通过 buffer 参数承担跨帧累积，进契约纯函数通道。详见 `[P0]lifecycle_data_shapes.md §3.2`。
- **ref-latest 是硬前提（不变量①）**：agent_loop 一秒几十帧 `text_block_delta`，onEvent 必须收 useLifecycle 内部 `ctxRef.current`（永远最新，非 React 快照）+ `bufferRef.current`（最新累积态），否则帧2 读到帧1 未 commit 的 stale messages → 流式累积覆盖丢字。**这正是把 v0.0.94 手写 `sliceRef`/`runCtxRef` 升为契约默认（不变量①扩展到 buffer）的动机**——useMessages 白嫖，不再自己维护 ref。
- **onInit（subscribe-first + 双 GET seed，v0.0.97 修订）**：顺序必须是 ① `api.subscribe('agent_loop', 'session_id:${sid}_amt:current')` + `api.subscribe('session_panel', 'session_id:${sid}')` → ② `GET /messages?limit=50`（transcript 基线）→ ③ `GET /inbox`（**v0.0.97 新增**，inbox 只读快照 seed enqueueItems，失败降级空不阻塞）→ 返回 `{ ctx: {...initialCtx, messages, enqueueItems}, buffer: { runCtx: null } }`。
  - **为什么 subscribe 必须在 GET 之前（D8 权威）**：GET 返回到 subscribe 之间 fire 的 `message_enqueued` 既不在 GET 快照里又没订阅到 → 丢事件。subscribe-first 保证 GET 之后的所有 SSE 都被捕获；GET 与 SSE 重叠的条目靠 reducer `some(enqueueId)`（chat-slice-reducer.ts:336）幂等去重。代码现状（use-messages.ts:102-108）已 subscribe-first，本节对齐代码。
  - **GET /inbox seed**：`items.map(it => ({ enqueueId: it.enqueueId, content: contentBlocksToPreviewText(it.content) }))` → 写入 `enqueueItems`。content 形与 `message_enqueued` SSE 同形（ContentBlock[]），走同一 `contentBlocksToPreviewText` 入口（INV-2）。
- **onEvent**：返 `{ctx?, buffer?}` 双写。
  - `from.topic === 'agent_loop'` → 调纯化 reducer `applyAgentEventToMessages(ctx.messages, buffer.runCtx, evt, ctx)` → 拿 `{messages, runCtx, ...派生态}` → **同帧 return `{ctx: {...ctx, messages, runActive, loadingPhase, lastRunFinish, enqueueItems}, buffer: {runCtx: 新runCtx}}`**（双写：ctx 渲染、buffer 累积）。
  - `from.topic === 'session_panel' && evt.type === 'messages_cleared'` → return `{ctx: {...ctx, messages: [], lastRunFinish: null, enqueueItems: []}}`（buffer 不变）。
  - `from.topic === 'session_panel' && evt.type === 'session_status_update'` 终态（idle/error/interrupted）→ 强制 `runActive=false, loadingPhase=null`（D7 治 sticky 孤儿），幂等跳渲染。
  - `from.topic === 'session_panel' && evt.type === 'session_status_update' && state ∈ {running, interrupting}`（v0.0.176）→ 清 `ctx.pendingToolCall`（治 HITL 悬挂卡片不消失）。`RUNNING_STATES` 对齐 sessionRunning 口径，**排除 suspended**（INV-2：HITL 合法等待态）。触发源是 session_running 权威事件，**非** session 自己发的消息——子 agent / 另一个 tab / 后台激活让 session 进 running 时，原 HITL 已失效须清。覆盖 ask question 卡（need_feedback）+ 权限卡（need_approval），因两卡都 gate 在 pendingToolCall（base-chat-input-bar §4）。幂等：无 pendingToolCall 时跳过。
  - 其余 session_panel type 忽略（归 useRunState/useUsage/useSummary 等 area-hook）。
- **命令式方法（走 mutateCtx，不碰 buffer）**：
  - `setMessages(items, {hasMore, prepend})`（loadMore 分页，组件自管 — design-decisions §7 分页不进契约）→ `mutateCtx(ctx => ({...ctx, messages: mergeMessagesById(ctx.messages, items, prepend), hasMore: opts?.hasMore ?? ctx.hasMore}))`。走 `mergeMessagesById` 防 transcript fetch 重置 SSE 累积态（v0.0.81 契约不变）。
  - **[v0.0.97] 删除 `removeEnqueueItem` / `addEnqueueItem` 命令式方法**（dead code）：队列加项只由 SSE `message_enqueued` 驱动（onInit GET /inbox seed + reducer），移项只由 SSE `enqueued_message_canceled`/`processed` 驱动。POST /messages 响应、cancel POST 响应都不进 reducer（多端一致性 INV-1/INV-5，PRD `specs/prd/version_logs/v0.0.97.enqueue_sse/change_log.md` §2.3）。caller（page-chat / section-member-chat）已同步删调用。
- **buffer 清理（D2 落地）**：reducer 在 `tool_call_end` case 攒够 args 写进 ctx.messages 时，**同帧从返回的新 buffer.runCtx.toolCallRawArgs 中删该 key**（return 删 key 的新 Map）；onDestroy/reload/deps 变 re-init 整个 buffer 重置（bufferRef 重赋 onInit 返回值）。UT 验：跑一轮 tool_call（start→delta→end）后 buffer.runCtx.toolCallRawArgs 中对应 key 已删。
- **run_end GET 校正 / sticky 孤儿清理**（原 use-session-sse-subscribe 状态自愈，治 D6/D7）：run_end 校正（GET /session 兜底 sessionRunning）**归 useRunState**（§4.1，它持 sessionRunning）；sticky run_start 孤儿清理（session_status_update 终态强制 runActive=false）已在 useMessages onEvent 的 session_panel 分支处理——**方案见 §4.2**。

## §4 跨区域协调（fan-out + 状态自愈的重新理清）

原 monolith 内部方法触发（run_end→刷 usage、workspace 转发 store、sticky 孤儿清理）现在跨 hook。**原则：各区域自治，靠事件流解耦，不靠一个 hook 触发另一个**（design-decisions §7 + component_refactor_plan §「耦合靠事件流解开」）。

### 4.1 usage 不再靠 messages 触发（事件流解耦）

原 `run_end → 刷 usage` 的人为触发**删除**。usage 变了后端直接推 `session_usage_update` 给 `useUsage`（它独立订 session_panel）——各区域自治，useMessages 不碰 usage。

### 4.2 workspace / read / todo 扇出 —— 归属重新理清（关键设计）

原 `session_panel` 的 `session_workspace_*` → `onWorkspaceEvent` → `store.setLastWorkspaceEvent`（供 `SectionWorkspacePanel` 消费）；`session_read_update` → `onSessionRead` → `store.setSessionUnread`。这些**不属于 run 态四区域**，是「把 session_panel 的边角事件转发给别的消费方」。

- **方案（采纳）**：新增独立 area-hook `useSessionPanelFanout(sessionId)`——**唯一**负责把 session_panel 的 `session_workspace_file_changed/dir_changed` → `store.setLastWorkspaceEvent`、`session_read_update` → `store.setSessionUnread`。**[v0.0.228] 加第三类**：`session_todo_changed` → `store.setLastTodoEvent`（供 `useTodoCrud` 消费——它读 store 值经 effect 触发静默 refetch；todo 事件契约见 `specs/tech/agent/session/[P0]session_event.md` §2）。它订 session_panel，onEvent 只处理这三类，写 store（副作用写 store 是 fan-out 枢纽的职责，非纯 ctx）。
- **为什么独立 hook 而非塞进某 area-hook**：workspace 扇出与 messages/runState/usage/summary 是**正交关注点**（谁看 workspace 面板与 run 态无关）。塞进 useMessages 会让「消息流 hook」偷偷管 workspace（违背原子化）。独立 hook = 一个关注点一个 hook。
- **ctx 形**：`useSessionPanelFanout` 无自己的渲染数据（它只转发给 store），ctx 可为 `null`（借 useLifecycle 管订阅生命周期，类似 `useSubagentChildren` 的用法）。**store 写入不经 ctx**（onEvent 内直接 `useChatStore.getState().setLastWorkspaceEvent(...)`，返回 null/void）。这是「onEvent 有 store 副作用」的**受控例外**——扇出枢纽本质是副作用，spec 显式标明。
- **sticky run_start 孤儿清理（D7）**：`session_status_update` 进终态（idle/error/interrupted）时需强制 `runActive=false, loadingPhase=null`。`runActive` 在 useMessages 的 ctx（agent_loop 派生），但 `session_status_update` 在 session_panel（useRunState 订）。**方案**：useMessages **也订 session_panel 的 session_status_update**（多订阅它已订 session_panel 拿 messages_cleared，加一个 type 分支即可），终态时清自己 ctx 的 runActive/loadingPhase。即：useMessages onEvent 的 session_panel 分支处理 `messages_cleared` + `session_status_update`（仅取终态清孤儿），**不碰 sessionRunning**（那是 useRunState 的）。run_end GET 校正归 useRunState（它持 sessionRunning，收 agent_loop? 否——见下）。
  - **run_end GET 校正归谁**：run_end 是 agent_loop 帧（useMessages 收）。但校正的是 sessionRunning（useRunState 持）。**采纳**：校正逻辑归 useRunState——useRunState **也订 agent_loop** 只为收 run_end 做 GET /session 校正（sessionRunning 仍 true 且非 interrupting → GET 兜底）。useRunState 因此多订阅（session_panel 拿 status_update + agent_loop 拿 run_end），onEvent 按 topic switch。**这是「状态自愈跨 topic」的合理多订阅**，比让 useMessages 反向回调 useRunState 干净。

> **多订阅小结**（都符合契约不变量⑥）：`useMessages` = agent_loop（流）+ session_panel（messages_cleared + status_update 终态清孤儿）；`useRunState` = session_panel（status_update）+ agent_loop（run_end 校正）。`useUsage`/`useSummary` 各单 topic。`useSessionPanelFanout` = session_panel（workspace/read/todo 三类扇出 [v0.0.228]）。

## §5 compose 单点（SectionChatSession 统一装配层）

area-hooks 的唯一 compose 点 = `chat-page/section-chat-session.tsx`（`[P0]chat_session_assembly.md`）。7 个消费页（playground / studio 单聊群聊薄壳 / academy×4）经 SectionChatSession 接入，不再各自 compose：

| compose 点 | compose 的 area-hooks | 备注 |
|---|---|---|
| `SectionChatSession` | useChatChrome + useMessages + useRunState(`{enabled: caps.runState}`) + useUsage + useSummary(`{enabled: caps.runState}`) + useSessionPanelFanout + useLoadMore | hooks 恒挂（React 规则），能力关闭走 **enabled 门**：`useRunState`/`useSummary` 的 `opts.enabled=false`（群聊 capabilities.runState=false）→ onInit 不 subscribe 不 GET，零 SSE 零网络——取代旧「群聊不挂 hook」写法，INV-E3 语义不回归 |
| `page-chat`（playground 宿主） | usePageChatMount（会话列表）+ useSubagentChildren | 会话区数据全在 SectionChatSession 内；宿主只管 conv-panel/三栏/workspace 接线 |

- **enabled 门签名**：`useRunState(sessionId, opts?: {enabled?: boolean})` / `useSummary(sessionId, opts?: {enabled?: boolean})`，缺省 `true`（既有消费行为零变化）；`enabled=false` 或 sessionId 空 → onInit 返 inert ctx，deps 含 enabled（能力翻转 re-init）。
- **删除**：`use-session-run-state.ts`、`use-session-sse-subscribe.ts`（职责全转 area-hooks）；`use-studio-chat-chrome.ts`（→ useChatChrome，`[P0]component_data_map.md §6`）；旧三页各自 compose 的装配代码随 `section-chat-detail` / `section-member-chat` / `section-squad-chat` 删除。

## §6 设计决策

### 6.1 为什么拆而非留 monolith

- **结论**：4 个 area-hook + 1 个扇出 hook，删 monolith。
- **理由**：monolith 订双 topic 揽 5 件事，违反「一个组件一份订阅 / 每区域自治」（用户原话「usage 为什么不是独立组件？为什么要混为一谈？」）。拆后每 hook 依赖最小数据、数据变了自己变、别人不管——正是 design-decisions §7 原子化法律。
- **反例**：monolith 里 usage 更新要经「run_end→人为触发刷 usage」，是伪耦合；拆后 usage 后端直推 useUsage，耦合消失。

### 6.2 为什么状态自愈用多订阅而非跨 hook 回调

- **结论**：run_end 校正让 useRunState 多订 agent_loop；sticky 孤儿清理让 useMessages 多订 session_panel status。不引入「hook A 回调 hook B」。
- **理由**：跨 hook 回调（A 拿到事件调 B 的 setter）重建了 monolith 的隐式耦合，且回调链难排查。多订阅让「谁需要这个 topic 的这类事件谁自己订」，自治、可独立测。契约明确允许多订阅（不变量⑥）。

## §7 边界

| 零件 | 归属 |
|---|---|
| useMessages / useRunState / useUsage / useSummary / useSessionPanelFanout | 本文件（`chat-page/use-*.ts`） |
| `applyAgentEventToMessages` / `applySessionStatusUpdate` 纯 reducer | `store/{chat-slice-reducer,session-slice-reducer}.ts`（逻辑不动，改由 area-hook 调） |
| `mergeMessagesById`（transcript merge） | `chat-page/merge-messages-by-id.ts`（不动，useMessages.setMessages 内调） |
| 四方法机制 / ref-latest | `component_architecture.md §3.10` |
| 三形 reducer | `[P0]lifecycle_data_shapes.md` |
| ComponentMessageStream / ComponentRunStateBar 渲染 | `component_architecture.md §3.3/§3.5`（本次不动） |
| loadMore / subagent 补全 | 组件自管（design-decisions §7；调 useMessages.setMessages） |
