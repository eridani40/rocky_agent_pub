---
type: spec
title: 组件-数据源拆解映射表（全组件 useLifecycle 四方法映射）
priority: P0
status: active
updated: 2026-07-31
since: v0.0.94
related: [[P0]component_architecture.md, [P0]lifecycle_data_shapes.md, [P0]chat_area_hooks.md]
---

# 组件-数据源拆解映射表（全组件 useLifecycle 四方法映射）

> **本表是「组件-数据源拆解标准」的永久落地**——后续版本增删组件须同步更新本表。
> 涉 UI/数据的需求进编码前必须先出组件-数据源拆解表（CLAUDE.md pre-coding 硬门禁，memory `ui-req-needs-component-datasource-decomposition`）；本表既是历史拆解记录，也是新需求拆解的对齐基线（按本表结构填新组件）。

## §1 概述

- **管什么**：列出 `app/web/` 全部数据生命周期 hook（含已迁 + 不迁）→ useLifecycle 四方法契约的映射：**数据形**（Collection/Snapshot/KeyedMap/流式特例/compose/null）+ **订阅 topic** + **读 API** + **触发**（SSE / GET-once / onTick poll / 命令式）+ **契约草案**（onInit/onEvent/onTick/onDestroy 的职责简述）+ **备注**（核实结论/历史/G1 等）。
- **不管什么**：useLifecycle 四方法机制与 ref-latest 不变量（→ `[P0]component_architecture.md §3.10`）；三形 reducer 实现细节（→ `[P0]lifecycle_data_shapes.md`）；area-hook 内部结构（→ `[P0]chat_area_hooks.md`）；组件视觉/testid/props（→ `specs/ui/components/`）。
- **范畴一句话**：每个数据 hook 该持什么数据形、订什么 topic、读什么 API、走什么触发——一表看全，是迁移/新建组件的拆解对齐基线。
- **与外界如何交互**：本表是「现状映射表」——记录代码现状（不是文档规范，规范在 §3.10/三形/area-hooks）。增删组件时改代码同时改本表（双向对齐：代码静默偏离本表 = 死代码 + 表失去权威性）。

## §2 全组件迁移映射表

| page | 组件(en,中) | 数据形 | 订阅 topic | 读 API | 触发 | 契约草案 | 备注 |
|---|---|---|---|---|---|---|---|
| chat | `useMessages` 会话消息流 | 流式特例 | agent_loop + session_panel(messages_cleared,status终态) | GET /messages | SSE | onInit: GET+subscribe×2; onEvent: topic switch(agent_loop→reducer / panel→清空+清孤儿); onDestroy: 空 | 多订阅样板；ref-latest 硬前提 |
| chat | `useRunState` 运行状态 | Snapshot | session_panel(status_update) + agent_loop(run_end 校正) | GET /session | SSE | onInit: GET+subscribe×2; onEvent: status→sessionRunning/state, run_end→GET 校正; onTick: 无 | run_end GET 校正归此（持 sessionRunning）；`opts.enabled=false`（capabilities.runState=false，群聊）→ onInit 不 subscribe 不 GET，零 SSE 零网络 |
| chat | `useUsage` token 用量 | Snapshot\<SessionUsageView\> | session_panel(usage_update) | GET /usage | SSE | onInit: GET+subscribe; onEvent: replace usage; onTick: 无 | 独立 hook 不再从引擎接 prop |
| chat | `useSummary` compact 状态 | Snapshot\<SummaryTaskStatus\> | session_panel(summary_task_update) | 无(初值 null) | SSE | onInit: subscribe; onEvent: replace summaryTask | 无初始 GET；同款 `opts.enabled` 门（false → 不 subscribe，ctx 恒 null） |
| chat | `useSessionPanelFanout` 面板扇出 | null(副作用写 store) | session_panel(workspace_*/read/todo_changed) | 无 | SSE | onInit: subscribe; onEvent: workspace→setLastWorkspaceEvent, read→setSessionUnread, **[v0.0.228]** todo→setLastTodoEvent(返 void) | 扇出枢纽，onEvent 有 store 副作用（受控例外，`[P0]chat_area_hooks.md §4.2`） |
| chat | `usePageChatMount` 会话列表 | Collection\<Session\> | session_meta(_all) | GET /session | SSE | onInit: GET+subscribe; onEvent: applyCrud upsert(+subagent children 刷新副作用) | 已符合模式，套四方法契约 |
| chat | `useSubagentChildren` 子代理树 | null(命令式写 store) | 无 | GET /children(per-call) | 命令式 | onInit: null; onDestroy: abort in-flight; refreshChildren 命令式 | v0.0.92 已迁，re-fit(borrow cleanup) |
| chat | `useMemoryCrud` 记忆 CRUD | Collection\<MemoryEntry\> | 无 | GET /memory/:scope | GET-once | onInit: listMemory; onDestroy: 空; reload 写后刷 | v0.0.92 已迁，re-fit(ctx 改 Collection)；**[v0.0.131]** `component-chat-float-menu` 恒挂载驱动 badge（`entries.length`）+ `component-memory-modal` 弹层（同一实例，弹层开关不重 GET）；editor state 复用 hook 既有 `editor` 字段 |
| chat | `SectionWorkspacePanel` 工作区面板 | 特例(wsReducer)+null | 无(消费 store.lastWorkspaceEvent) | GET /workspace/tree | GET+store | onInit: getWorkspaceTree; onDestroy: 空; wsReducer 内核不动 | v0.0.92 已迁，re-fit(onInit 命名) |
| chat | `useCronCrud` 定时任务 | Collection\<CronJobSummary\> | 无 | GET /cron | **onTick 60s**（`enabled` 时） | onInit: `enabled?` list+startTimer(60s,"nextFireAt 漂移") `:` 返空不 fetch/不 startTimer; onTick: 重读; onDestroy: 空 | **[v0.0.131]** 从已删的 `section-cron-panel` 抽出为 hook（`useCronCrud(sessionId,{enabled})`；`NewFormState`/`INITIAL_NEW` 迁入）；`enabled:false`（squad 群聊 float-menu `hideCron`）→ 零网络（module 级 `EMPTY_COLLECTION` 常量）。`component-chat-float-menu` 恒挂载驱动 badge（`jobs.filter(enabled).length`）+ `component-cron-modal` 弹层。无 SSE topic→poll 兜底 |
| chat | `useTodoCrud` todo 待办 | Collection\<TodoItem\> | 无（消费 store.lastTodoEvent，fanout 扇出） | GET /session/:sid/todos | **SSE(经 store)+命令式** [v0.0.228] | onInit: listTodos; onDestroy: 空; refetch 命令式静默刷（GET+mutateCtx，无 ctx-null/loading 闪烁）; store effect: lastTodoEvent.sessionId 匹配→refetch | **[v0.0.223]** 新建（仿 useCronCrud）；`component-chat-float-menu` 恒挂载驱动 badge（`pendingCount`=未完成主 item 数）+ `component-todo-modal` 弹层同一实例。**[v0.0.228]** 60s polling 退役改 SSE 驱动（`session_todo_changed` 经 useSessionPanelFanout→store→effect refetch）+ 弹层打开 refetch（skills 先例） |
| chat | `PageConnector` 连接器页 | Snapshot\<ConnectorState\> | 无 | listConnectors | **onTick 5s** | onInit: refresh+startTimer(5s,"connecting→终态感知"); onTick: refresh | 无 topic 且本版不加→poll 兜底 |
| studio | `useStudioUnreadMeta` studio 红点 | KeyedMap\<sid,bool\>×3 + metaMap\<sid,updatedAt\> | session_meta(_all) | **GET /session?biz=studio**（[v0.0.348] hydrate 基线 + onResumed 校正；POST /read） | SSE + GET 补水 | onInit: 同步 subscribe + fire-and-forget hydrate + onResumed 注册（句柄 onDestroy 回收）; onEvent: biz 守卫+applyKeyed set（三 map 同步写 metaMap）; hydrate: mergeFromSessions 纯函数（重建语义 + updatedAt 竞态仲裁，GET 后到不回退新帧）经 mutate 写回; markReadAndClear 命令式 | **修 G1 违规**：new SseClient→getSseClient() 单例；**[v0.0.348] 四层 hydration**（v0.0.165 删初始拉取+无重连校正 → 丢帧永久错态回归修复） |
| studio | `StudioSidebar` squad 懒缓存 | KeyedMap\<squadId,SquadDetail\> | 无 | GET /squad/:id(懒) | 命令式 | onInit: 空 map; onEvent: 无; loadDetail 命令式 set; dataVersion 变→reload 清 | 懒缓存抽 useLifecycle |
| chat | `SectionChatSession` 统一装配层 | compose | (compose area-hooks) | (同 area-hooks) + GET /session/:id/chrome | SSE + GET-once chrome | compose useChatChrome+useMessages+useRunState({enabled})+useUsage+useSummary({enabled})+useSessionPanelFanout+useLoadMore | 7 页唯一装配点（playground/studio 单聊群聊/academy×4）；能力按 chrome.capabilities 门控（`[P0]chat_session_assembly.md`）；取代旧 SquadChatPage/MemberChatPage/academy chat col 各自 compose |
| chat | `useChatChrome` chat 自给 chrome | Snapshot\<SessionChromeView\> | 无 | GET /session/:id/chrome | GET-once | onInit: getSessionChrome（genRef+signal.aborted 守卫；`opts.injected` 注入时跳自拉）；onEvent/onTick: 无；setEffort/setApprovalMode/setModel: mutate 乐观 + fire-and-forget PUT /session/:id | 非 area-hook 不订 SSE；取代 useStudioChatChrome（两跳收敛一跳）+ useModelRestore。详 §6 |
| studio | `MemberPanelMemory` 成员记忆 | Snapshot\<SummaryResponse\> | 无 | GET /summary | GET-once | onInit: getSummary; reload 写后刷 | v0.0.92 已迁，re-fit |
| studio | `SquadBoard` 看板 | Collection\<entity\> | 无 | GET /board | GET+乐观 | onInit: getBoard; reload 取真值; 乐观 patch 在 reload 内 | 候选迁；乐观 patch + reload |
| studio | `BudgetMeter` 预算表 | Snapshot\<BudgetUsage\> | 无(见备注) | GET /squad/:id/budget/usage | **onTick 30s** | onInit: GET+startTimer(30s,"squad 聚合无 SSE"); onTick: 重读; refreshKey→reload | **核实结论：session_usage_update 携 per-session SessionUsageView，非 squad budget；无 topic→保 poll 兜底**（design-decisions §6 premise 与代码漂移，见 `version_logs/v0.0.94/change_log.md`） |

## §3 不迁与删除

- **不迁（无数据生命周期）**：
  - `useMemberPanelHandlers`/`useBoardAtMention`/`useBoardEditForm`/`useBoardCreate`/`useBoardDuplicate`（mutation/form/UI hook）
  - `useMessageScrollPagination`（纯 UI 滚动）
  - `ComponentMentionPopover`（debounce，cleanup 已有）
  - 所有纯展示组件
- **删除**：`use-session-run-state.ts` + `use-session-sse-subscribe.ts`（职责全转 area-hooks，详 `[P0]chat_area_hooks.md §5`）；`use-model-restore.ts` + `use-studio-chat-chrome.ts`（model 回填/chrome 两跳拼装收敛进 `useChatChrome`）+ `use-subagent-run-refresh.ts`（subagent transcript 实时性由 useMessages agent_loop 订阅承担，丢帧根因已在 reducer 层根治——tool_call_* 按 evt.messageId 锚定 + 缺 message 兜底建 assistant message）。

## §4 SSE 优先核实结论（design-decisions §6）

- `BudgetMeter`/`SectionCronPanel`/`PageConnector` 三个 poll 组件**核实后均无现成 topic 携带其数据**，本版不加后端 topic → **保 onTick 轮询兜底**（走 `effect.startTimer` 标准化 + justification，禁裸 setInterval）。
- **`BudgetMeter` budget 前提修正（design-decisions §6）**：原草案以为 `session_usage_update`「已存在只是没接线」——**不成立**。该事件是 per-session `SessionUsageView`，而 Budget 需要 squad 聚合 `BudgetUsage`，无现成 topic 携带 squad 预算 → **保 onTick 30s 兜底**（本版不加后端 topic，符合「不碰 SSE 基建」精神）。详见 `version_logs/v0.0.94/change_log.md` 与 architect 汇报。

## §5 边界

| 零件 | 归属 |
|---|---|
| 全组件映射表（hook → 数据形/topic/API/触发） | 本文件 |
| 四方法机制 / ctx ref-latest / effect 声明式 | `[P0]component_architecture.md §3.10` |
| 三形 reducer（Collection/Snapshot/KeyedMap + applyCrud/applySnapshot/applyKeyed） | `[P0]lifecycle_data_shapes.md` |
| 对话区 area-hooks 内部结构（useMessages 流式 reducer 等） | `[P0]chat_area_hooks.md` |
| 组件 testid/props/视觉 | `specs/ui/components/` |

## §6 useChatChrome —— 统一 chat 自给 chrome hook

> **不是 area-hook**（不订 SSE、不消费运行态事件流），但走 useLifecycle 四方法契约做生命周期管理（genRef 守卫 + signal.aborted + deps 重拉），与 area-hook 同族。取代已删的 `useStudioChatChrome`（studio 专用，GET /session + GET /squad 两跳前端拼装）与 `useModelRestore`（playground model 回填）——chrome 拼装下沉后端 `GET /session/:id/chrome` 一跳（接口权威 `specs/api/overall/04a-session-chrome.md`；装配层权威 `[P0]chat_session_assembly.md`）。

### 6.1 设计意图

- **第一性原则**：chat 只认 `sessionId`，装饰数据（kind/title/tag/readOnly/两 picker 值/model/members/capabilities）由后端一跳拉齐，行为与进入路径解耦。kind 差异（defaultModel 来源、能力开关）是**后端静态表**，前端零 kind 分支。
- **如果不这样**：每个消费方各拼一遍 chrome（旧态：studio 两跳、academy 前端透传 classroom.defaultModel、playground useModelRestore 回填），新 kind / 新能力要改 N 处，且已实证产出「长得一样功能不一样」的降级。

### 6.2 契约（`use-chat-chrome.ts.useChatChrome(sessionId, opts?)`）

```ts
interface UseChatChromeOpts {
  /** 宿主注入的已装配 chrome（防双拉）；null/undefined = 内部自拉 */
  injected?: SessionChromeView | null;
}
interface UseChatChromeResult {
  chrome: SessionChromeView | null;   // onInit 完成后填
  loading: boolean;
  error: Error | null;
  setEffort: (level: EffortLevel) => void;      // mutate 乐观 + fire-and-forget PUT /session/:id
  setApprovalMode: (mode: ApprovalMode) => void; // 同上
  setModel: (sel: ModelSelection) => void;       // 'default' 哨兵→body {modelId:'default'}；具体 model→{providerId,modelId}
}
```

- **onInit**：`injected` 非空 → 直接返回注入值（零网络）；`sessionId` 空 → throw 走 error 通道；否则 `getSessionChrome(sessionId)`，await 后校验 `signal.aborted || gen !== genRef.current`（切 session 旧响应不覆盖）。
- **onEvent / onTick**：无（GET-once；chrome 期间不变，刷新靠切 sessionId remount）。
- **deps**：`[sessionId, injected]` —— **宿主传 injected 必须稳定引用**（不稳定 = 每 render re-init 反复 GET）。
- **setter**：`mutate` 乐观本地写（`c===null` 返回 `undefined` 跳写）+ fire-and-forget `updateSession`（失败仅 console.warn 不回滚），不 reload 不重新 GET。injected 模式下 setter 仍写本 hook 内部 ctx（宿主副本不回写——身份要素期间不变，可接受）。

### 6.3 边界

- **不替代 area-hooks**：useMessages/useRunState/useUsage/useSummary/useSessionPanelFanout 仍独立订 SSE 管 run 态；useChatChrome 只管 chrome（静态装饰数据）。
- **消费方**：`SectionChatSession`（缺省自拉）+ `component-studio-chat-router.tsx`（自拉一次派生 workspaceSemantic 后经 `chrome` prop 注入下传，防双拉）。
- **GET 失败**：`{ chrome: null, loading: false, error }`，SectionChatSession 渲空态 + console.warn（装饰数据失败不阻塞页面骨架）。
