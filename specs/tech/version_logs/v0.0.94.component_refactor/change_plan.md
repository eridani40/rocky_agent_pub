# v0.0.94.component_refactor 变更计划书 — 组件数据 hook 统一到 lifecycle 四方法契约

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 权威输入：`reqs/[done] v0.0.94.component_refactor/design-decisions.md`（法律）+ tech spec `[P0]component_architecture.md §3.10/§3.11` + `[P0]lifecycle_data_shapes.md` + `[P0]chat_area_hooks.md`。
> **纯前端重构，无后端契约变更，specs/api/ 不动**（BudgetMeter 核实无 SSE topic → 保 poll，不加后端 topic）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统（lifecycle-core / shapes / area-hooks / left-list / right-tab / poll-hooks / studio） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec 位置（路径+章节 / 项目原则编号） |
| 影响行 | +N / -M |

## 建议 task 切分（5 个，按区）

- **T1 契约+三形lib**：`use-lifecycle.ts` 四方法升级 + `lifecycle-shapes.ts`（三形 reducer）+ 两个 test。底层，其余 task 依赖它先落。
- **T2 对话区引擎拆解**：5 个 area-hook 新建 + 删 monolith + 三页 compose。最核心高风险。
- **T3 左侧列表**：usePageChatMount / useSubagentChildren re-fit + useStudioUnreadMeta + StudioSidebar。
- **T4 右侧tab + 已迁re-fit**：useMemoryCrud / MemberPanelMemory / SectionWorkspacePanel re-fit + SectionCronPanel onTick。
- **T5 poll→onTick + board**：BudgetMeter / PageConnector onTick 标准化 + SquadBoard。

> 依赖顺序：T1 先（其余全依赖新契约 + 三形）。T2-T5 可并行（各改各的文件；共享 store/reducer 只读不改）。

---

## 变更清单

### T1 — 契约核心 + 三形 lib（lifecycle-core / shapes）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `LifecycleContract<TCtx,TEvent>` | 修改 | 替换 `LifecycleOptions`：`onInit/onDestroy?/onTick?/onEvent?/deps`；onEvent 签名 `(ctx,event,from{topic,group})=>TCtx\|void` | MUST NOT 保留旧 init/destroy/refresh 命名（彻底改名，删旧接口不留兼容） | §3.10 接口签名 | +14/-16 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `LifecycleInitApi` | 新增 | onInit 收的 api：`{signal, startTimer({intervalMs,justification}), subscribe(topic,group)}` | MUST 声明式；subscribe 内部 `getSseClient().subscribe`，句柄 useLifecycle 持有 | §3.10 effect 声明式 | +8 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `useLifecycle` | 修改 | 主体升四方法：onInit 传 effect api；ctxRef 持最新 ctx；onEvent 帧 handler 内 `next=onEvent(ctxRef.current,event,from)` 后同步 `ctxRef.current=next`+排队 setCtx（不变量①）；startTimer→内部 setInterval 到点 `onTick(ctxRef.current)`；订阅/timer 句柄集中回收 | MUST 不变量① ctx ref-latest（收 ctxRef.current 非快照，同步写 ref）；MUST 多订阅按 subId 各注册 handler，onEvent 带 from{topic,group}；MUST timer/SSE 回收归本 hook（re-init/unmount 自动 unsubscribe+clearInterval）；MUST NOT onEvent 内 setState（返回新 ctx 由 hook 写） | §3.10 6 不变量①⑤⑥；design-decisions §5 | +80/-40 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | `reload` | 修改 | 沿用命令式 re-init（abort 旧 + 重跑 onInit）；命名不变 | MUST 唯一命令式口子；reload-on-resume 仍 poll-only | §3.10；design-decisions §8 #2 | +2/-2 |
| lifecycle-core | app/web/src/lib/use-lifecycle.ts | onVisibility (内部) | 修改 | 沿用 poll-only：hidden 停 timer / visible 仅当声明 timer 才 reload | MUST NOT 纯订阅 hook 在 tab 切换重载（abort in-flight 教训） | §3.10 reload-on-resume | +0/-0 |
| shapes | app/web/src/lib/lifecycle-shapes.ts | `Collection<T>` | 新增 | `{items:T[], keyOf:(item)=>string}` 类型 | MUST items 保序 | shapes §2.1 | +6 |
| shapes | app/web/src/lib/lifecycle-shapes.ts | `CrudOp<T>` | 新增 | union: upsert(item)/upsert(items)/delete(key)/replace(items) | — | shapes §2.1 | +6 |
| shapes | app/web/src/lib/lifecycle-shapes.ts | `applyCrud` | 新增 | 应用 CRUD 返回新 Collection：upsert 同 key 原地替换不移位、新 key append 尾；delete 不存在返原引用；replace 整表换 | MUST 幂等（无变化返原引用）+ immutable + 保序（upsert 已存在 key 不移位） | shapes §2.1；§3.10 数据三形 | +34 |
| shapes | app/web/src/lib/lifecycle-shapes.ts | `emptyCollection` | 新增 | 构造空 Collection(keyOf) | — | shapes §2.1 | +3 |
| shapes | app/web/src/lib/lifecycle-shapes.ts | `Snapshot<T>` | 新增 | `T \| null` 类型别名 | — | shapes §2.2 | +2 |
| shapes | app/web/src/lib/lifecycle-shapes.ts | `SnapshotOp<T>` | 新增 | union: replace(value)/patch(patch) | — | shapes §2.2 | +4 |
| shapes | app/web/src/lib/lifecycle-shapes.ts | `applySnapshot` | 新增 | replace 整体换；patch 仅 prev!=null 有效（{...prev,...patch}），prev==null 返 null | MUST patch prev==null 返 null（不凭空造对象）+ immutable | shapes §2.2 | +14 |
| shapes | app/web/src/lib/lifecycle-shapes.ts | `KeyedMap<K,V>` | 新增 | `Record<K,V>` 类型别名 | — | shapes §2.3 | +2 |
| shapes | app/web/src/lib/lifecycle-shapes.ts | `KeyedOp<K,V>` | 新增 | union: set(key,value)/delete(key)/clear | — | shapes §2.3 | +4 |
| shapes | app/web/src/lib/lifecycle-shapes.ts | `applyKeyed` | 新增 | set 同 key 同值返原引用/否则 {...prev,[k]:v}；delete 不存在返原引用；clear 非空返 {} | MUST 幂等（无变化返原引用）+ immutable | shapes §2.3 | +18 |
| lifecycle-core | app/web/src/lib/__tests__/use-lifecycle.test.ts | (test suite) | 修改 | 重写为四方法：验 ①ref-latest（高频 onEvent 累积不丢）/ effect.subscribe 多订阅 from.topic switch / startTimer→onTick / onDestroy 幂等 / reload 命令式 / poll-only resume | MUST 覆盖不变量① ref-latest（连续 onEvent 用 ctxRef.current 累积，断言无 stale 覆盖） | §3.10 6 不变量 | +120/-80 |
| shapes | app/web/src/lib/__tests__/lifecycle-shapes.test.ts | (test suite) | 新增 | 三 reducer 单测：applyCrud upsert 保序/delete 幂等原引用/replace；applySnapshot replace/patch null；applyKeyed set 幂等/delete/clear | MUST 验幂等返原引用（Object.is） | shapes §2/§3.3 | +90 |

### T2 — 对话区引擎拆解（area-hooks）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| area-hooks | app/web/src/components/chat-page/use-messages.ts | `useMessages` | 新增 | area-hook：onInit GET /messages(limit 50)+subscribe(agent_loop group `session_id:${sid}_amt:current`)+subscribe(session_panel group `session_id:${sid}`)；onEvent 按 from.topic switch：agent_loop→`applyAgentEventToMessages(ctx.result.messages,evt,runCtxRef,ctx.result)`；session_panel→`messages_cleared` 清对话区 + `session_status_update` 终态(idle/error/interrupted)清 runActive/loadingPhase(治 D7)。暴露 messages/runActive/loadingPhase/lastRunFinish/enqueueItems/hasMore + setMessages(mergeMessagesById)/removeEnqueueItem 命令式 | MUST 保留领域 reducer 不套 applyCrud（流式特例）；MUST ref-latest（收 ctxRef.current）；MUST NOT 碰 sessionRunning/usage（归其它 area-hook）；MUST 多订阅按 from.topic switch | chat_area_hooks §3；shapes §3.2；原则#10 | +140 |
| area-hooks | app/web/src/components/chat-page/use-run-state.ts | `useRunState` | 新增 | area-hook：onInit GET /session(sessionRunning/state)+subscribe(session_panel)+subscribe(agent_loop 仅收 run_end 校正)；onEvent：session_panel `session_status_update`→`applySessionStatusUpdate`→sessionRunning/sessionState(Snapshot)；agent_loop `run_end` 且 sessionRunning 仍 true 且非 interrupting→GET /session 校正(治 D6)。暴露 sessionRunning/sessionState + abort() | MUST run_end GET 校正归此(持 sessionRunning)；MUST 多订阅 from.topic switch；MUST NOT 反向回调 useMessages | chat_area_hooks §4.2；§3.11 | +90 |
| area-hooks | app/web/src/components/chat-page/use-usage.ts | `useUsage` | 新增 | area-hook：onInit GET /usage+subscribe(session_panel)；onEvent `session_usage_update`→`applySnapshot(replace)`。暴露 usage(Snapshot\<SessionUsageView\>) | MUST 一形一 topic；MUST NOT 靠 useMessages 触发刷新(事件流解耦) | chat_area_hooks §4.1；shapes §2.2 | +55 |
| area-hooks | app/web/src/components/chat-page/use-summary.ts | `useSummary` | 新增 | area-hook：onInit subscribe(session_panel)(无初始 GET，初值 null)；onEvent `summary_task_update`→`applySnapshot(replace)`。暴露 summaryTask(Snapshot\<SummaryTaskStatus\>) | MUST 单 topic | chat_area_hooks §2；shapes §2.2 | +45 |
| area-hooks | app/web/src/components/chat-page/use-session-panel-fanout.ts | `useSessionPanelFanout` | 新增 | area-hook(扇出枢纽)：onInit subscribe(session_panel)；onEvent `session_workspace_file/dir_changed`→`useChatStore.getState().setLastWorkspaceEvent(evt)`；`session_read_update`→`setSessionUnread(evt.sessionId,false)`；返回 void(无渲染 ctx) | MUST onEvent 副作用写 store 是受控例外(扇出本质副作用)；MUST NOT 处理 status/usage/summary/messages_cleared(归各 area-hook) | chat_area_hooks §4.2 | +55 |
| area-hooks | app/web/src/components/chat-page/use-session-run-state.ts | (整文件) | 删除 | 职责全转 area-hooks；删 `useSessionRunState`/`UseSessionRunStateOptions`/`SessionRunState`/`emptySlice` | MUST 删干净不留死代码(memory delete-dead-code) | chat_area_hooks §5；§3.11 删除 | -199 |
| area-hooks | app/web/src/components/chat-page/use-session-sse-subscribe.ts | (整文件) | 删除 | 订阅副作用转 area-hooks 各自 onInit | MUST 删干净 | chat_area_hooks §5 | -195 |
| area-hooks | app/web/src/components/chat-page/page-chat.tsx | PageChat (compose 段) | 修改 | 删 `useSessionRunState(viewedSessionId,{onWorkspaceEvent,onSessionRead})`；改 compose useMessages+useRunState+useUsage+useSummary+useSessionPanelFanout(viewedSessionId)；下游 props 从各 area-hook 取(messages/runActive/.../usage/summaryTask/sessionRunning)；loadMore 调 useMessages.setMessages | MUST 保 viewedSessionId=activeSubId??activeSessionId；MUST NOT 破坏 PRD 关键路径(消息流/run 态/loadMore)；workspace/read 扇出改由 useSessionPanelFanout 不再内联回调 | chat_area_hooks §5；§3.11 | +40/-30 |
| area-hooks | app/web/src/components/studio-page/section-member-chat.tsx | MemberChatPage (compose 段) | 修改 | 删 `useSessionRunState(sessionId,{onWorkspaceEvent})`；改 compose 全套 area-hooks；workspace 扇出改 useSessionPanelFanout(删内联 onWorkspaceEvent 回调) | MUST 三页同源；MUST NOT 破坏单聊 a2a 侧别/enqueue | chat_area_hooks §5 | +35/-25 |
| area-hooks | app/web/src/components/studio-page/section-squad-chat.tsx | SquadChatPage (SSE 段) | 修改 | 删自管 sliceRef/ctxRef/subRef+自订双 topic(useEffect:128-194)+fetchOnce 的 SSE 部分；改 compose useMessages+useUsage+useSessionPanelFanout；messages 从 useMessages 取；usage 从 useUsage 取(升级为 SSE 推送+初值，替代 GET-once)；workspace 扇出走 useSessionPanelFanout(替代内联只透传 workspace) | MUST 群聊不订 run 态(无 stop/enqueue)；MUST 群聊 usage 展示不回归(行为增强需验)；MUST NOT 破坏群聊白名单/testid | chat_area_hooks §5 SquadChatPage 行 | +30/-70 |
| area-hooks | app/web/src/components/chat-page/use-subagent-run-refresh.ts | `useSubagentRunRefresh` | 修改 | 接 useMessages.setMessages(签名不变，run 结束重拉行为不变)；适配 area-hook 传参 | MUST 保 BUG-002 fix(subagent 只读页 transcript 补全)不回归 | §3.4 subagent 补全 | +4/-4 |

### T3 — 左侧列表（left-list / studio）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| left-list | app/web/src/components/chat-page/use-page-chat-mount.ts | `usePageChatMount` | 修改 | 从手写 useEffect 改 useLifecycle 四方法：onInit GET /session→setSessions(通过 ctx=Collection\<Session\>)+subscribe(session_meta,`_all`)；onEvent `session_meta`→`applyCrud(upsert)` 得新 ctx 写 store.setSessions + 副作用(subagent parent children 刷新 refreshChildren + handleSubRunMeta)；保 childrenFetchedRef 去重 | MUST 保 session_meta 广播 reducer 语义(按 data.id upsert)；MUST NOT 破坏 subagent children 刷新链；onEvent 副作用(refreshChildren/setSessions)受控例外(列表 hook 需写 store) | §3.11 usePageChatMount 行；shapes §2.1 | +50/-40 |
| left-list | app/web/src/components/chat-page/use-subagent-children.ts | `useSubagentChildren` | 修改 | re-fit 新四方法命名：`init`→`onInit`(返 null)、`destroy`→`onDestroy`(abort in-flight controllersRef)；refreshChildren 命令式不变(per-call GET /children→store.setChildren) | MUST 借 useLifecycle 只为 unmount cleanup(非 poll)；MUST 保 reload-on-resume poll-only 不 abort in-flight(v0.0.92 契约) | §3.11 useSubagentChildren 行 | +6/-6 |
| studio | app/web/src/components/studio-page/use-studio-unread-meta.ts | `useStudioUnreadMeta` | 修改 | 从手写 useEffect 改 useLifecycle 四方法：onInit subscribe(session_meta,`_all`)；onEvent biz 反向守卫(`incoming.biz!=='studio'` 跳过)+`applyKeyed(set,sid,unread)`(KeyedMap\<sid,bool\>)；markReadAndClear 命令式(乐观 applyKeyed set false + POST /read fire-and-forget) | MUST 用 getSseClient() 单例(不 new SseClient——G1)；MUST 保 biz 反向守卫；MUST 幂等(同值不触发渲染) | §3.11 useStudioUnreadMeta 行；shapes §2.3；§3.8 S1 | +30/-40 |
| studio | app/web/src/components/studio-page/section-studio-sidebar.tsx | `StudioSidebar` | 修改 | detailCache 懒缓存改 useLifecycle：onInit 返空 KeyedMap\<squadId,SquadDetail\>；loadDetail 命令式(GET /squad/:id→applyKeyed set 写 ctx)；dataVersion 变→reload(清缓存重来)。展开缺缓存触发 loadDetail 仍由 effect 配合(懒触发) | MUST 保懒加载语义(展开才拉)；MUST dataVersion 变清缓存；MUST NOT 破坏 unreadMap 透传 | §3.11 StudioSidebar 行；shapes §2.3 | +35/-25 |

### T4 — 右侧 tab + 已迁 re-fit（right-tab）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| right-tab | app/web/src/components/chat-page/use-memory-crud.ts | `useMemoryCrud` | 修改 | re-fit 四方法命名(`init`→`onInit`,`destroy`→`onDestroy`)；ctx 从 `MemoryEntry[]` 改 `Collection<MemoryEntry>`(entries=ctx.items)；写操作(save/archive)后 reload 命令式(不变)；mutError 叠加保留 | MUST GET-once 无 poll(PRD §2.2)；MUST 保 archive 失败 mutError 可见语义；ctx 改 Collection 但对外仍暴露 entries 数组 | §3.11 useMemoryCrud 行；shapes §2.1 | +12/-10 |
| right-tab | app/web/src/components/studio-page/component-member-panel-memory.tsx | `MemberPanelMemory` | 修改 | re-fit 四方法命名；ctx=Snapshot\<SummaryResponse\>；onCompact→POST /compact + reload 命令式(v0.0.92 已删 setTimeout)不变 | MUST 保 compact 后 reload 命令式(不用 setTimeout)；GET-once 无 poll | §3.11 MemberPanelMemory 行；shapes §2.2 | +8/-8 |
| right-tab | app/web/src/components/chat-page/section-workspace-panel.tsx | `SectionWorkspacePanel` | 修改 | re-fit 四方法命名(`init`→`onInit`,`destroy`→`onDestroy`)；顶层 tree GET 仍走 useLifecycle(ctx=WorkspaceTreeResponse)；wsReducer 内核 + 'fresh'/lastWorkspaceEvent effect 不动 | MUST wsReducer 内核不动；MUST 'fresh' 同步重置仍由 useEffect 配合(onInit 内禁 dispatch，不变量2) | §3.11 SectionWorkspacePanel 行 | +6/-6 |
| right-tab | app/web/src/components/chat-page/section-cron-panel.tsx | `SectionCronPanel` | 修改 | 从手写 useEffect+裸 setInterval(60s) 改 useLifecycle：onInit list(ctx=Collection\<CronJobSummary\>)+`startTimer({intervalMs:60000,justification:"cron nextFireAt 分钟级漂移，无 SSE topic"})`；onTick 重读 list 返新 ctx；写操作(toggle/delete/new)后 reload 命令式 | MUST 删裸 setInterval 改 effect.startTimer(禁裸 setInterval)；MUST justification；MUST NOT 加后端 topic(design-decisions §6) | §3.11 SectionCronPanel 行；design-decisions §6 | +20/-18 |

### T5 — poll→onTick 标准化 + 看板（poll-hooks / studio）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| poll-hooks | app/web/src/components/studio-page/component-budget-meter.tsx | `BudgetMeter` | 修改 | 从手写 useEffect+裸 setInterval(30s)+visibility 改 useLifecycle：onInit GET /squad/:id/budget/usage(ctx=Snapshot\<BudgetUsage\>)+`startTimer({intervalMs:30000,justification:"squad 聚合预算无 SSE topic(session_usage_update 是 per-session SessionUsageView 非 squad budget)"})`；onTick 重读；refreshKey 变→reload 命令式 | **MUST 保 onTick 30s poll 兜底**(核实无 SSE topic，design-decisions §6 premise 与代码漂移)；MUST 删裸 setInterval+visibility 手写(useLifecycle 接管)；MUST justification；MUST NOT 加后端 squad_budget_update topic(本版不碰后端) | §3.11 BudgetMeter 行；design-decisions §6；SSE 核实结论 | +25/-35 |
| poll-hooks | app/web/src/components/connector-page/page-connector.tsx | `PageConnector` | 修改 | 从手写 useEffect+裸 setInterval(5s)+visibility 改 useLifecycle：onInit refresh(ctx=Snapshot\<ConnectorState\>)+`startTimer({intervalMs:5000,justification:"connector connecting→终态由后端 lazy connect 推动，无 SSE topic 感知"})`；onTick refresh；handleToggle 后 reload | MUST 保 onTick 5s poll(无 topic 且本版不加)；MUST 删裸 setInterval+visibility 手写；MUST justification | §3.11 PageConnector 行；design-decisions §6 | +22/-30 |
| studio | app/web/src/components/studio-page/component-squad-board.tsx | `SquadBoard` | 修改 | 从手写 useEffect 改 useLifecycle：onInit getBoard(squadId,'all',zone)(ctx=Snapshot\<Board\>，Board 是单聚合对象非 entity 列表)；zone 变→deps 触发 re-init；写操作(save/archive/restore)乐观 patch(applyBoardPatch 领域 reducer 保留)+reload 取真值命令式 | MUST Board 用 Snapshot(单对象，非 Collection——getBoard 返聚合 Board)；MUST 乐观 patch 走既有 applyBoardPatch 不套三形；MUST reload 取真值 | §3.11 SquadBoard 行；shapes §2.2 | +15/-15 |

---

## 影响面评估

- **跨模块**：全在 `app/web/src/`（lib + components/chat-page + components/studio-page + components/connector-page）。**零后端改动**，`app/server/` 不动，`specs/api/` 不动。
- **破坏性变更**：`useLifecycle` 接口名彻底改（init→onInit 等），旧 4 个已迁 hook(useMemoryCrud/MemberPanelMemory/SectionWorkspacePanel/useSubagentChildren)必须同步 re-fit（T3/T4 含）——否则 typecheck 挂。删 `use-session-run-state.ts`+`use-session-sse-subscribe.ts` 两文件，所有 consumer(page-chat/member-chat/squad-chat + 4 个测试文件)必须改。
- **依赖顺序**：T1(契约+三形) 必须先落（其余全依赖新 `useLifecycle` 签名 + 三形 reducer）。T2-T5 各改各文件，共享 `store/{chat-slice,chat-slice-reducer,session-slice-reducer}.ts` + `merge-messages-by-id.ts` **只读不改**（reducer 逻辑不动，改由 area-hook 调用）。
- **测试影响**：`__tests__/use-session-run-state.test.tsx`/`enqueue-abort.test.tsx`/`page-chat-sse-singleton-mount.test.tsx`/`section-member-chat.test.tsx`/`use-subagent-run-refresh.test.tsx` 引用被删/改的 hook，需 coder 同步改（拆成 area-hook 测试或适配 compose）。新增 `use-messages`/`use-run-state`/`use-usage`/`use-summary` 各自单测。
- **风险点**：
  1. **ref-latest 不变量①**是正确性核心——useMessages 流式累积若 onEvent 拿快照会丢字（PRD 关键路径回归）。T1 useLifecycle 实现 + UT 必须钉死。
  2. **SquadChatPage usage 行为增强**（GET-once→SSE 推送）需回归群聊 usage 展示不空/不错。
  3. **多订阅状态自愈跨 topic**（run_end 校正归 useRunState、sticky 孤儿归 useMessages）——拆错会导致 D6 卡 running / D7 sticky 孤儿回归。
  4. **workspace 扇出**从三处内联回调收敛到 useSessionPanelFanout——三页都要改，漏一处 workspace 面板不更新。
- **验证**：主体纯前端 → UT 为主(每 area-hook + 三 reducer + useLifecycle)；PRD 关键路径(chat 流式不回归 / 列表 CRUD / run 态切换)保 ET；无后端契约变更免 AT(design-decisions §9)。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列如绕过 applyCrud 手写 upsert、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- **spec↔code 漂移已知项**（coder 遇到照实调整 + 汇报）：BudgetMeter 的 design-decisions §6「session_usage_update 已存在只是没接线」premise 与代码不符（该事件是 per-session SessionUsageView 非 squad budget）；已在本表 + spec 修正为「保 poll 兜底」。
