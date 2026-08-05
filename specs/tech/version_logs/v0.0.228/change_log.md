# v0.0.228 变更日志 — todo 面板 SSE 实时化 + UI 优化

> 版本轴发布说明（跨 KB）。位置轴见各 KB `log.md`；method 级契约见同目录 `change_plan.md`。
> PRD：`specs/prd/version_logs/v0.0.228.md`；需求源：`reqs/[working] v0.0.228.todo_sse_ui/req.md`。

## 1. 主题

todo 面板（v0.0.223 只读双层树）5 项收敛：SSE 实时化（`session_todo_changed` 复用 session_panel topic，替换 60s 轮询）+ 打开弹层 refetch + 尺寸响应式（720px 档）+ hover 弹层收敛（主 item only + 正下方）+ done 徽章 success 绿。HTTP 7 端点契约零改动、零新 topic 注册、零 SSE 白名单变更、零 i18n 新 key。

## 2. 后端（agent/session + agent/todo + bootstrap）

- **新事件 `session_todo_changed`**（`session-event-types.ts`）：extends SessionEventBase，data=`Record<string, never>`（轻量信号不携带 todo 数据，消费方重拉 GET 全量）。topic=`session_panel`、group=`session_id:<sid>`。
- **TodoStore emit 注入**（`todo-store.ts`）：`TodoStoreDeps.statusBus?: ReplayableEventBus` optional 构造注入；私有 `emitChanged(sid)` 在 `upsertItem` 写成功 / `removeItem` 真删 / `cleanupFinished` 真清（removed>0）后调用。三不 emit 原则：bus 未注入 no-op / 无实际变更不 emit / emit 异常吞错 console.warn 不影响写路径。`removeAll`（session 销毁 hook）不 emit。
- **bootstrap 接线**（`bootstrap.ts:354`）：注入 **wrap 前 raw sessionStatusBus**（bus-phase 产出时序先于 store-phase `wrapStatusBusForUnread`）——天然不过 broadcaster/unreadRuntime；双保险 `session_todo_changed` 不进 `META_TRIGGERING_TYPES`，不触发 session_meta broadcast（todo 不在 SessionMetaView，对齐 session_workspace_file_changed 先例）。
- **覆盖两条写路径**：agent 工具（todo-tool）与 HTTP handler（todo-handler）共享 TodoStore 实例，store 层单点 emit 全覆盖。

## 3. 前端（store → fanout → hook → 视图）

- **store**（`session-slice-reducer.ts` + `chat-slice.ts`）：SessionEvent 联合加 `SessionTodoChangedEvent` 变体（shape 与后端严格一致）；`lastTodoEvent` state + `setLastTodoEvent` action（幂等键=event.id 非 createdAt——同毫秒连写 createdAt 可能撞键丢事件，ulid 必唯一）。
- **fanout 第三类扇出**（`use-session-panel-fanout.ts`）：`case 'session_todo_changed'` → `setLastTodoEvent`（chat_area_hooks §4.2 受控例外机制复用，hook 内不自订 SSE——订阅归 fanout 唯一枢纽）。
- **useTodoCrud SSE 驱动**（`use-todo-crud.ts`）：60s 轮询（POLL_INTERVAL_MS/startTimer/onTick）全删；新增 store effect（lastTodoEvent.sessionId 匹配才 refetch）；`refetch` 从 reload() 改**静默刷新**（listTodos GET + mutateCtx 口子）——reload 内部 setCtx(null)+setLoading(true)（use-lifecycle.ts:221-231），SSE 高频触发会致 badge 归 0/列表闪「加载中」，禁用。
- **component-todo-modal**：① 打开（挂载）弹层侧 `useEffect []` 调一次 refetch（skills 弹层先例；hook 本体恒挂 float-menu 不变，与 SSE 互补）；② 尺寸 `w-[520px]` → `w-[720px] max-w-[92vw] max-h-[88vh]`（对齐 md viewer/editor 档位）；③ hover 收敛——hover handlers + relative 定位上下文移到主 item 行容器，步骤层移出容器（步骤 hover 不触发），详情弹层 top-full 在主 item 正下方 absolute overlay（不推挤后续行，布局稳定）；④ STATUS_STYLE done 改 `text-[var(--success)] bg-[var(--success-bg)]`（既有 token 零硬编码；skipped 保 muted+opacity 与 done 靠色相拉开）。

## 4. 代码↔spec 偏离核实（doc-modifier 阶段 5）

逐项核对「代码实现 == spec 契约」，**结论：无静默偏离**——

| 契约点 | 代码核实 |
|---|---|
| TodoStore 单点 emit（两条写路径共享） | `todo-store.ts` upsertItem:135 / removeItem:150,154 / cleanupFinished:172,176；removeAll:184 无 emit ✓ |
| fanout 唯一枢纽（hook 不自订 SSE） | `use-session-panel-fanout.ts:48-52` todo case；`use-todo-crud.ts` 无 subscribe ✓ |
| 轮询退役 | `use-todo-crud.ts` 无 POLL_INTERVAL_MS / timer 残留 ✓ |
| 静默 refetch（禁 reload） | `use-todo-crud.ts:68-76` listTodos+mutateCtx，不走 reload ✓ |
| 幂等 event.id | `chat-slice.ts:162-165` `lastTodoEvent?.id === evt.id` skip ✓ |
| raw bus 注入 + 不触发 meta broadcast | `bootstrap.ts:354`（时序先于 wrap）；`session-meta-broadcaster.ts:54-63` META_TRIGGERING_TYPES 不含 todo ✓ |
| 事件 shape 前后端一致 | `session-event-types.ts:134-137` ↔ `session-slice-reducer.ts:51` ✓ |
| 尺寸/hover/颜色 | `component-todo-modal.tsx:137`（720px 档）/ :58-94（hover 主 item 容器 + 步骤层外移）/ :37（--success）✓ |

**顺手修正的 spec drift（v0.0.223 遗留，非本版引入）**：`[P1]todo_tools.md` §2.1/§3 + `20-todo.md` §2.2 写 source/output 必填，实际代码（todo-tool.ts / todo-handler.ts / TodoItem interface）自 v0.0.223 起即 optional——spec 已改 optional 对齐代码。

## 5. spec 同步清单

- tech OKF：`agent/session/[P0]session_event.md`（§2/§3/§3a.4，架构期预落地，doc-modifier 核实）+ `agent/tools/[P1]todo_tools.md`（§4/§7 + optional drift 修正）+ `app/frontend/[P0]chat_area_hooks.md §4.2` + `[P0]component_data_map.md`（架构期预落地，核实）+ 三 KB `log.md` 条目。
- api：`specs/api/overall/20-todo.md` §3（polling→SSE）+ §6 版本段。
- ui：`specs/ui/components/chat-page/component-todo-modal.md` + `component-chat-float-menu.md §7`（架构期预落地，核实）+ `specs/ui/overall/00-app-guide.md §3.1`（todo 面板操作路径更新）。
- prd：`specs/prd/overall/03-llm-chat.md` todo 条目补 v0.0.228 标注。

## 6. 验证

- UT：TodoStore emit 用例组 + bootstrap 注入断言 + fanout todo 用例 + use-todo-crud SSE 驱动用例 + modal 打开 refetch/hover/徽章用例（随 T1/T2 同 task 交付）。
- AT 回归：`todo-crud-flow` / `todo-reminder` 全绿（emit 注入不改写路径契约）。
- ET：`playground-todo-view` 扩展目标 7-10（SSE 实时 / 打开即最新 / hover 收敛 / 尺寸+徽章色）——无设计稿免 vision compare。
