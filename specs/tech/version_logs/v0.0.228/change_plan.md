# v0.0.228 变更计划书 — todo 面板 SSE 实时化 + UI 优化

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 概念契约已先行落地：`specs/tech/agent/session/[P0]session_event.md`（session_todo_changed §2/§3/§3a.4）+ `[P1]todo_tools.md` §4/§7 + `[P0]chat_area_hooks.md` §4.2 + `[P0]component_data_map.md`（useTodoCrud 行）+ `specs/api/overall/20-todo.md` §3 + `specs/ui/components/chat-page/component-todo-modal.md` + `component-chat-float-menu.md` §7。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | 对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

### 后端（agent/todo + session event + bootstrap 接线）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent/session | app/server/src/agent/session-event-types.ts | `SessionEventType` | 修改 | 联合加 `'session_todo_changed'` 成员 | MUST 与 session_event.md §2 命名一致 | specs/tech/agent/session/[P0]session_event.md §2 | +1 |
| agent/session | app/server/src/agent/session-event-types.ts | `SessionTodoChangedEvent` | 新增 | interface extends SessionEventBase：type='session_todo_changed'，data=`Record<string, never>`（轻量信号不携带 todo 数据） | data 必为空对象；MUST NOT 携带 items | session_event.md §2；PRD 块1 轻量信号+重拉 | +8 |
| agent/session | app/server/src/agent/session-event-types.ts | `SessionEvent` | 修改 | 联合加 SessionTodoChangedEvent | — | session_event.md §2 | +1 |
| agent/todo | app/server/src/agent/todo/todo-store.ts | `TodoStoreDeps.statusBus` | 新增 | optional 字段 `statusBus?: ReplayableEventBus`（构造注入） | optional——UT/无 bus 场景 no-op 不炸 | [P1]todo_tools.md §4 emit 注入 | +4 |
| agent/todo | app/server/src/agent/todo/todo-store.ts | `emitChanged()`（private） | 新增 | 构造 `{id:ulid(), type:'session_todo_changed', sessionId, createdAt, data:{}}` → `statusBus.emit(\`session_id:${sid}\`, {data:e, timestamp})`；try/catch 吞错 console.warn | 三不 emit：bus 未注入 no-op / 无实际变更不调本方法 / emit 异常不影响写路径 | session-workspace-store.ts:59-71 范式；session_event.md §3 | +14 |
| agent/todo | app/server/src/agent/todo/todo-store.ts | `upsertItem()` | 修改 | atomicWriteSync 成功后调 emitChanged(sessionId) | MUST NOT 改方法签名/返回值/异常契约（todo-tool 鸭子类型校验不动） | session_event.md §3 触发表 | +1 |
| agent/todo | app/server/src/agent/todo/todo-store.ts | `removeItem()` | 修改 | 仅真删（即将 return true 的两条路径）调 emitChanged；无变化 return false 不 emit | 无实际变更不 emit（三不原则） | 同上 | +2 |
| agent/todo | app/server/src/agent/todo/todo-store.ts | `cleanupFinished()` | 修改 | 仅 removed>0 调 emitChanged；removed=0 不 emit | 同上；`removeAll` 不 emit（session 销毁无订阅方） | 同上 | +2 |
| bootstrap | app/server/src/bootstrap.ts | todoStore 实例化（:351） | 修改 | deps 加 `statusBus: sessionStatusBus`（bus-phase :337 已产出，时序先于本行） | MUST 传 wrap 前 raw sessionStatusBus——MUST NOT 经 wrapStatusBusForUnread（防 session_meta broadcast/unread 误捕获；双保险=不进 META_TRIGGERING_TYPES） | session_event.md §3a.4；bootstrap-bus-phase.ts | +1 |

### 前端（ui-chat：store → fanout → hook → 视图）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | app/web/src/store/session-slice-reducer.ts | `SessionEvent` 联合 | 修改 | 加变体 `{type:'session_todo_changed'; sessionId; createdAt; data: Record<string,never>}` | shape 与后端 session-event-types.ts 严格一致 | session_event.md §2 | +7 |
| ui-chat | app/web/src/store/chat-slice.ts | `lastTodoEvent` state 字段 | 新增 | `lastTodoEvent: SessionTodoChangedEvent \| null` + 初始 null（类型从 session-slice-reducer import） | 存整事件（含 id 作幂等键） | chat-slice.ts:57 lastWorkspaceEvent 先例 | +3 |
| ui-chat | app/web/src/store/chat-slice.ts | `setLastTodoEvent()` | 新增 | action：幂等键=event.id（`get().lastTodoEvent?.id === evt.id` 则 skip），否则 set | MUST 用 id 不用 createdAt 幂等（同毫秒连写 createdAt 可能撞键丢事件；ulid 必唯一） | chat-slice.ts:142 setLastWorkspaceEvent 先例 | +7 |
| ui-chat | app/web/src/components/chat-page/use-session-panel-fanout.ts | `onEvent` switch | 修改 | 加 `case 'session_todo_changed'` → `useChatStore.getState().setLastTodoEvent(event)` | MUST NOT 处理 status/usage/summary/messages_cleared（归各 area-hook）；ctx=null + 返 void 受控例外边界不变 | [P0]chat_area_hooks.md §4.2 | +4 |
| ui-chat | app/web/src/components/chat-page/use-todo-crud.ts | `POLL_INTERVAL_MS` + `startTimer` + `onTick` | 删除 | 移除 60s 轮询全部代码（SSE 接管实时性） | 删干净不留死代码/死 import；onInit 不再声明 timer | PRD 块1；20-todo.md §3 | -14 |
| ui-chat | app/web/src/components/chat-page/use-todo-crud.ts | `refetch()` | 修改 | 实现从 `reload()` 改为**静默刷新**：`listTodos(sessionId)` GET → `mutateCtx(() => ({items, keyOf}))`；失败置 mutError 不 throw | MUST 无 ctx-null/loading 闪烁——reload 内部 setCtx(null)+setLoading(true)（use-lifecycle.ts:221-231），高频 SSE 触发会致 badge 归 0/列表闪「加载中」，禁用；MUST 走 mutateCtx 口子不裸 setState | [P0]component_architecture.md §3.10 命令式口子 | +10/-3 |
| ui-chat | app/web/src/components/chat-page/use-todo-crud.ts | SSE store effect | 新增 | `const lastTodoEvent = useChatStore(s => s.lastTodoEvent)` + useEffect：`lastTodoEvent.sessionId === sessionId` 才 `void refetch()`，不匹配 skip | hook 恒挂 float-menu 模型不变；MUST NOT 在 hook 内自订 SSE（订阅归 fanout 唯一枢纽） | chat_area_hooks.md §4.2；component_data_map.md useTodoCrud 行 | +10 |
| ui-chat | app/web/src/components/chat-page/component-todo-modal.tsx | 打开 refetch effect | 新增 | `useEffect(() => { void crud.refetch(); }, [])`——弹层每次打开（挂载）调一次（skills 弹层先例） | hook 本体恒挂 float-menu 不动；刷新只发生在打开这一刻 | component-chat-float-menu.md §7；component-skills-modal.tsx:81-84 先例 | +5 |
| ui-chat | app/web/src/components/chat-page/component-todo-modal.tsx | 面板宽度 className（:123） | 修改 | `w-[520px]` → `w-[720px]`（保留 `max-w-[92vw] max-h-[88vh]`） | 不窄于 520px、不超 92vw；布局稳定铁律（无元素位移） | PRD 块3；component-modal-md-editor.tsx 档位 | +1/-1 |
| ui-chat | app/web/src/components/chat-page/component-todo-modal.tsx | `STATUS_STYLE`（:31） | 修改 | done：`'text-muted-2 bg-bg-warm opacity-60'` → `'text-[var(--success)] bg-[var(--success-bg)]'` | 只用既有 token 零硬编码 hex；其余 4 态不动（skipped 保 muted+opacity 与 done 靠色相拉开） | PRD 块5；tokens.css:122-123 | +1/-1 |
| ui-chat | app/web/src/components/chat-page/component-todo-modal.tsx | `TodoItemRow` hover 结构（:52） | 修改 | hover handlers 从外层包裹块移到**主 item 行容器**（relative 定位上下文随之内移）；步骤层移出 hover 容器；详情弹层 `absolute top-full` 相对主 item 行容器 = 主 item 正下方 overlay | 触发=主 item 行 only（步骤 hover 不触发）；保持区域=主 item 行∪弹层；absolute overlay MUST NOT 推挤后续行（布局稳定铁律）；`hasDetail` 才弹逻辑不动 | PRD 块4；component-todo-modal.md 悬停详情 | +8/-6 |

### 测试（UT 随实现同 task）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test-server | app/server/src/agent/todo/__tests__/todo-store.test.ts | emit 用例组 | 修改 | 加：mock statusBus 下 upsert/remove/cleanup 各 emit 一次且 shape 正确；removeItem 无变化 / cleanup removed=0 不 emit；未注入 bus 不炸 | 真实 tmpdir 写路径不 mock fs | session_event.md §3 三不原则 | +40 |
| test-server | app/server/src/__tests__/bootstrap-todostore-injection.test.ts | 注入断言 | 修改 | 断言装配后 todoStore 持有 statusBus（emit 通路连通） | — | bootstrap.ts:351 | +5 |
| test-web | app/web/src/components/chat-page/__tests__/use-session-panel-fanout.test.tsx | todo 扇出用例 | 修改 | 加：收 session_todo_changed → store.setLastTodoEvent 被调且值正确；幂等（同 id 重发不重复 set） | — | chat_area_hooks.md §4.2 | +15 |
| test-web | app/web/src/components/chat-page/__tests__/use-todo-crud.test.ts | 轮询删 + SSE 驱动用例 | 修改 | 删 startTimer/onTick 断言；加：store.lastTodoEvent 写入（匹配 sid）→ 静默 refetch（items 更新且 loading 不翻转）；不匹配 sid 不 refetch | — | component_data_map.md useTodoCrud 行 | +25/-15 |
| test-web | app/web/src/components/chat-page/__tests__/component-todo-modal.test.tsx | 打开 refetch + hover + 徽章用例 | 修改 | 加：挂载调 crud.refetch；步骤行 hover 无详情弹层；done 徽章 class 含 --success | — | component-todo-modal.md | +20/-5 |

## 影响面评估

- **跨模块**：agent/session（事件类型）→ agent/todo（emit）→ bootstrap（接线）→ web store/fanout/hook/视图。无破坏性变更：HTTP 7 端点契约零改动；SSE 复用 session_panel topic，零新 topic 注册零白名单变更（04-agent-session.md §4.2 白名单已含）。
- **依赖顺序**：事件契约（session_event.md §2，已落地）= 前后端共同冻结点；后端 T1 与前端 T2 可按契约**并行**开发（前端 mock 事件即可 UT）。
- **风险点**：① refetch 闪烁——已钉「MUST 静默刷新禁用 reload」约束（use-lifecycle.ts:221-231 setCtx(null) 是闪烁根因）；② 幂等撞键——已钉「id 非 createdAt」约束；③ 事件风暴——todo 写低频（每 turn 数次），GET 为本地文件读，成本可忽略，不做 debounce（简单直接）；④ i18n 零新增 key（仅改色不改文案，todoModal.status.* 既有）。
- **回归不变量**：既有 AT `todo-crud-flow` / `todo-reminder` 全绿（emit 注入不改写路径契约）；`removeAll` 不 emit 保持 session 销毁路径安静。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
