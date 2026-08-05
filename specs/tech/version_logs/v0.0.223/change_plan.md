# v0.0.223 变更计划书 — todo 工具（session 双层待办）+ OKR/req 漏出移除 + 全景 task 视图优化

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 决策来源：`specs/prd/version_logs/v0.0.223.md` + `states/v0.0.223/okr-req-gate-plan.md` + `specs/research/v0.0.223-todo-okr-research.md`（已核对代码 file:line）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（worktree 根相对） |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT |
| 参考 | 依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 变更清单

### A. todo 工具 + store + handler（新概念，参照 cron 全套）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| todo_store | app/server/src/agent/todo/todo-store.ts | TodoStore (class) | 新增 | session 级双层 todo 持久化 store：路径 `{DATA_DIR}/sessions/{sid}/todos.json`（仿 CronPersistenceAdapter，read-modify-write + atomicWriteSync）；方法 listBySession / upsertItem / removeItem / removeAll。DATA_DIR 经 `resolveDataDir()` 展开（packaged cwd=`/` 护栏） | MUST 复用 `persistence/fs-io.ts:atomicWriteSync`；MUST NOT 拼 字面`~`；文件 ≤300 行 | cron-adapter.ts:72；CLAUDE.md 持续可打包护栏#4；PRD §2.3 | +220 |
| todo_store | app/server/src/agent/todo/todo-store.ts | TodoItem (interface) | 新增 | 主 item schema: {id, desc, status, source:{type:'task'\|'user_message'\|'agent', refId?}, output:{type:'file'\|'reply_session'\|'reply_agent', refId?}, memo?, steps:TodoStep[], createdAt, updatedAt}；status enum 5 态 free-form | MUST status 仅校验 enum 不校验跃迁路径（free-form） | PRD §2.3 状态机；todo_tools.md §2（新） | +18 |
| todo_store | app/server/src/agent/todo/todo-store.ts | TodoStep (interface) | 新增 | 步骤 schema: {id, desc, status}（status 同 5 态 enum） | — | PRD §2.3；todo_tools.md §2 | +6 |
| todo_tool | app/server/src/agent/tools/todo-tool.ts | todoTool (Tool 单例) | 新增 | action-based dispatch（参照 task-tool），TODO_ACTIONS=['add_item','update_item','add_step','update_step','delete_item','list','cleanup_finished']；run() 读 rtc.selfSessionId 索引 store，switch action 路由 | MUST 返 Promise<ToolRunResult>；MUST NOT 校验状态跃迁合法性（free-form 仅 enum）；MUST NOT 引入 leader/mate 权限（session 级无角色） | task-tool.ts:40-120；todo_tools.md §3-§4；PRD §2.3 | +180 |
| todo_tool | app/server/src/agent/tools/todo-tool.ts | TODO_ACTIONS (const) | 新增 | action enum 常量 + isTodoAction 类型守卫 | — | task-tool.ts:21 模式 | +6 |
| tools_registry | app/server/src/tools/registry.ts | defaultTools() | 修改 | 在 taskTool 后插入 todoTool（line 98 区） | MUST 进 defaultTools（profile.toolBound 解析走 registry） | tools/index.md §③；tool_policy.md | +2 |
| todo_handler | app/server/src/handlers/todo-handler.ts | registerTodoRoutes() | 新增 | HTTP 路由 `/session/:sessionId/todos`（GET list / POST add / PATCH item / DELETE item）+ `/session/:sessionId/todos/:itemId`（仿 cron-handler）；挂 session-deps 注入的 todoStore | MUST 路由形态对齐 cron（/session/:sid/todos[/:itemId]）；仅 session 级读写，不跨 session | cron-handler.ts:7；api/overall/20-todo（新） | +150 |
| todo_handler | app/server/src/handlers/session-deps.ts | SessionHandlerDeps.todoStore | 修改 | 加 `todoStore?: TodoStore` 字段（仿 cronAdapter 字段），bootstrap 装配 | — | session-deps.ts:136（cron 字段参照） | +3 |
| bootstrap | app/server/src/server.ts (或 bootstrap 装配点) | todoStore 装配 | 修改 | 启动期 new TodoStore({fsRoot: resolveDataDir()})，注入 session-deps + ReminderCtx extras | MUST fsRoot 经 resolveDataDir 展开绝对路径 | CLAUDE.md 护栏#4 | +5 |

### B. ReminderCtx 扩展 + todo provider 填壳

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| reminder_ctx | app/plugins/builtins/rocky_context/types.ts | ReminderCtx.todoStore | 修改 | 加可选 `todoStore?: TodoStorePort`（鸭子类型，{listBySession(sid): Promise<TodoItem[]>}） | MUST 可选（向后兼容；非 parent.main session 不注入 → provider no-op） | squad_reminder_providers.md §1（squadContext 同模式） | +6 |
| reminder_pipeline | app/server/src/agent/context-ingest-pipeline.ts | runReminderProviders() | 修改 | extras 加 `todoStore?: unknown`，构造 ctx 时透传（仿 squadContext line 88） | MUST 与 squadContext 同 key 模式 | context-ingest-pipeline.ts:75-90 | +4 |
| reminder_pipeline | app/server/src/agent/context-engine.ts (或 ingest caller) | todoStore 注入 | 修改 | ingest 期构造 extras 时传入 todoStore（与 squadContext 同来源） | — | system_reminder.md §3 | +3 |
| todo_provider | app/plugins/builtins/rocky_context/reminder/todo.ts | TodoReminderProvider.provide() | 修改 | 填壳：读 ctx.todoStore.listBySession(config.sessionId) → filter 未结束主 item → 格式化 `[todo]` 段（主 item desc + 步骤 N/M 进度）；空则返 []；parent.main only（subagent/forked 不产出，readSessionType 判） | MUST 标头 `[todo]`；MUST 仅 parent.main session 产出（避免 subagent 噪声）；MUST NOT 读 task_tools（语义已重定义为 session todo 进度） | system_reminder.md §3 row 5；PRD §2.5；todo_tools.md §5 | +45 |

### C. task reminder 改名收窄（squad_tasks → task，扩 assignee=null）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| task_reminder | app/plugins/builtins/rocky_context/prompt/squad_tasks.ts | formatTasksReminder() | 修改 | 标头 `[squad:tasks]` → `[task]`；filter 扩：readMyTasks 改读全量 tasks 后 filter `assignee===null \|\| assignee===memberId`（待认领池 ∪ 我认领） | MUST 无新字段/新 action（仅 filter 扩）；MUST 保留血缘 join + dependsOn 降级；MUST 保留 mate only filter | PRD §2.4；squad_reminder_providers.md §3 | +12/-4 |
| task_reminder | app/plugins/builtins/rocky_context/prompt/squad_tasks.ts | SQUAD_HEADER_PREFIX 用法 | 修改 | 标头改为独立 const `[task]`（不走 SQUAD_HEADER_PREFIX+'tasks]'） | — | squad_tasks.ts:213 | +2/-1 |
| task_reminder | app/plugins/builtins/rocky_context/prompt/squad_tasks.ts | readMyTasks() | 修改 | 改名 readMyAndUnassignedTasks，filter 收 `assignee===null \|\| assignee===memberId` | — | PRD §2.4 | +8/-3 |
| task_reminder | app/plugins/builtins/rocky_context/plugin.json | implId squad_tasks→task | 修改 | line 330 implId 改 `task`，description i18n key 同步（或保留文件名 squad_tasks.ts 仅改 implId） | MUST 标头/implId 一致；build-plugins copyResources 覆盖（保留文件名降风险） | plugin.json:330；CLAUDE.md 护栏#2 | +2/-2 |

### D. OKR/req 摘除（配置层 + squad_board 滤）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| profile_tools | app/plugins/session-types/studio-leader.parent.main.yaml | toolBound | 修改 | 删 `goal` + `requirement` 两行（agent 不再能调 OKR/req 工具） | MUST 工具 impl 代码保留（gate 长期保留决策）；MUST 全盘扫所有 *.parent.main（leader/mate/squad）含 goal/requirement 的都摘 | okr-req-gate-plan.md A1；PRD §2.1 | -2 |
| profile_tools | app/plugins/session-types/studio-mate.parent.main.yaml | toolBound | 修改 | 删 `requirement` 行（mate 持 requirement，无 goal） | 同上 | okr-req-gate-plan.md A1 | -1 |
| profile_tools | app/plugins/session-types/studio-squad.parent.main.yaml | toolBound | 修改 | 全盘扫，若含 goal/requirement 一并摘 | — | okr-req-gate-plan.md A1 | -? |
| prompt | app/plugins/builtins/rocky_context/prompt/{rules,identity,parent_task,squad_role}.ts | OKR/req 段 | 修改 | coder 全盘扫 prompt 段，凡引导 OKR/requirement 流程的文字段（rules.ts OKR triage 段 / identity.ts OKR 提及等）整段摘除或降级 | MUST 不删文件（仅摘段）；MUST 保留 task 相关引导；coder grep `requirement\|OKR\|KR\|goal` 定位 | okr-req-gate-plan.md A2；PRD §2.1 | ±20 |
| squad_board | app/plugins/builtins/rocky_context/prompt/squad_board.ts | SquadBoardReminderProvider.provide() | 修改 | 产出层只保留 tasks 段，滤掉 goals/requirements（即使生产侧将来注册生效，reminder 不含 OKR/req）；保留 task 血缘（source.requirementId → req title 仍 join 显示，req 数据在后端仍存在） | MUST 只滤 reminder 产出，不动 store；保留 task 血缘（PRD §2.4 明确血缘保留） | squad_reminder_providers.md §4；okr-req-gate-plan.md A3 | +8/-10 |

### E. feature gate `__FEATURE_OKR__`（build-time，前端编译期）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| feature_gate | app/web/vite.config.ts | defineConfig | 修改 | 加 `define: { __FEATURE_OKR__: JSON.stringify(process.env.FEATURE_OKR === 'true') }` | MUST 编译期常量（非运行时）；默认关（FEATURE_OKR 未设 → false） | okr-req-gate-plan.md B0；research §1.3 | +3 |
| feature_gate | app/web/src/vite-env.d.ts | declare const __FEATURE_OKR__ | 新增 | 文件不存在，新建（含现有 `/// <reference types="vite/client" />` + `declare const __FEATURE_OKR__: boolean`） | MUST tsc 能识别（否则 typecheck fail） | research §1.4 | +6 |
| feature_gate | scripts/build-dmg.sh | FEATURE_OKR export | 修改 | 默认不 export FEATURE_OKR（注释说明：未来开 OKR `export FEATURE_OKR=true`） | MUST NOT 默认 export（packaged 默认关）；MUST 在 VITE_API_BASE export 旁加注释 | build-dmg.sh:94；okr-req-gate-plan.md B0 | +3 |

### F. OKR/req UI 漏出点 gate 包（前端条件渲染）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama_route | app/web/src/components/studio-page/component-panorama-route.tsx | FIXED_TABS | 修改 | gate 关时 filter 留 `tasks`：`const visibleTabs = __FEATURE_OKR__ ? FIXED_TABS : FIXED_TABS.filter(t=>t.id==='tasks')`；activeTab 默认值同步改 'tasks' | MUST gate 开时行为不变（代码/spec/测试全留） | panorama-route.tsx:52-56；okr-req-gate-plan.md B1 | +5/-1 |
| task_card | app/web/src/components/studio-page/component-board-task-card.tsx | requirement 呈现 span | 修改 | line 132 `<span>src · req:{...}</span>` 包 `{__FEATURE_OKR__ && <span>...}` | MUST gate 关时不渲染（不留空 span 占位） | task-card:132；okr-req-gate-plan.md B2 | +2/-1 |
| task_form | app/web/src/components/studio-page/component-board-entity-modal.tsx | requirement 选择器 + D1-b 强制 | 修改 | gate 关时隐藏 requirement 选择器（line 80 board.requirements.items.map 区）+ 放宽 D1-b 强制校验（line 101 `target.kind==='task'` create 模式 source 可空） | MUST gate 关时 task 可无 requirement（PRD：agent 不再走 OKR 链路）；MUST gate 开时行为不变 | entity-modal:80/101；okr-req-gate-plan.md B3 | +8/-2 |

### G. 全景 task 视图优化（响应式 + 甬道色块多通道）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama_kanban | app/web/src/components/studio-page/component-panorama-kanban.tsx | column className | 修改 | line 39 `w-[240px] shrink-0` → `min-w-[200px] flex-1`（列随视口自适应，窄屏缩/宽屏平铺） | MUST 保留 overflow-x-auto 兜底；视觉待 demo（designer spec 标「待 demo」） | PRD §2.2；research §2.2 | +1/-1 |
| panorama_kanban | app/web/src/components/studio-page/component-panorama-kanban.tsx | header 色带 | 修改 | line 66-70 header 区：8×8 圆点 → 列顶全宽色带（`h-1 w-full` bg statusColor）+ header 底色（statusColor+'20' alpha）+ 状态文字带色（style={{color: statusColor}}）多通道编码 | MUST 多通道（色带+文字+底色）防色弱；statusColor 映射不动 | PRD §2.2；research §2.3 | +6/-1 |
| panorama_kanban | app/web/src/components/studio-page/component-panorama-kanban.tsx | PanoramaCard 左缘竖条 | 修改 | 卡片左缘加 `border-l-4` + style borderColor statusColor（加强列色归属） | MUST 不动 statusColor() 函数 | panorama-kanban.tsx:115；PRD §2.2 | +2 |

### H. todo 视图（float-menu 第 4 项 + hook + modal）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| todo_api | app/web/src/lib/todo-api.ts | listTodos / createTodo / updateTodo / deleteTodo | 新增 | fetch wrapper（GET/POST/PATCH/DELETE `/session/:sid/todos`），仿 cron-api.ts | — | cron-api.ts 模式；api/overall/20-todo | +60 |
| todo_hook | app/web/src/components/chat-page/use-todo-crud.ts | useTodoCrud() | 新增 | session 级 CRUD hook，仿 useCronCrud（list/create/update/delete + refetch），Collection 形 | MUST 走 useLifecycle 标准契约；MUST badge=未完成主 item 数（assignee/owner 维度 N/A，仅未完成） | use-cron-crud.ts:75；component_data_map.md；lifecycle_data_shapes.md §2.1 | +120 |
| todo_modal | app/web/src/components/chat-page/component-todo-modal.tsx | ComponentTodoModal | 新增 | 双层树视图（主 item + steps）+ 悬停主 item 弹结构化详情（source/output/memo）；本版只读 | MUST 本版只读（PRD §2.6）；视觉待 demo | PRD §2.6；component-chat-float-menu.md | +150 |
| float_menu | app/web/src/components/chat-page/component-chat-float-menu.tsx | open union | 修改 | 加 `'todo'`（line 46）+ 第 4 button（skills 下，line 98 后）+ 第 4 modal（line 109 后）+ 恒挂 useTodoCrud | MUST 顺序 skills 下方；MUST badge=未完成主 item 数 | float-menu.tsx:46/89-98/107-109；PRD §2.6 | +18 |

### I. 测试（UT，AT/ET 按测试计划）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| todo_ut | app/server/src/agent/todo/__tests__/todo-store.test.ts | TodoStore UT | 新增 | list/upsert/remove + 5 态 free-form + cleanup_finished 行为 | — | todo_tools.md §2/§4 | +120 |
| todo_ut | app/server/src/agent/tools/__tests__/todo-tool.test.ts | todoTool UT | 新增 | 7 action 链路 + free-form 状态机 + selfSessionId 索引 | MUST 覆盖 cleanup_finished（主 item 已结束下次清理） | todo_tools.md §3 | +150 |
| reminder_ut | app/plugins/builtins/rocky_context/prompt/__tests__/squad-reminder-providers.test.ts | task reminder 改名断言 | 修改 | 标头 `[squad:tasks]` → `[task]`；加 assignee=null case（待认领池 mate 可见） | — | squad_tasks.ts UT 现状 | +20/-8 |
| feature_gate_ut | app/web/src/components/studio-page/__tests__/component-panorama-route.test.tsx | FIXED_TABS gate 断言 | 修改 | 添加 gate=false 只见 tasks tab 断言（mock __FEATURE_OKR__） | MUST 保留 gate=true 旧行为断言 | research §1.4 | +15 |

## 影响面评估

- **新概念**：todo（双层 session 待办，独立 store 仿 cron）；feature gate（build-time vite define，前端编译期）。
- **跨模块**：todo 全链路横跨 server(agent/tools + agent/todo + handlers) + plugin(reminder) + web(hook+modal+float-menu)；OKR 摘除横跨 plugin(profile yaml + prompt) + web(gate + 条件渲染)；全景改造局部 kanban 单文件。
- **依赖顺序**：底层 store/handler → tool → ReminderCtx 扩展 → provider 填壳；前端 todo-api → hook → modal → float-menu 集成。gate/全景独立无依赖。
- **破坏性变更**：无 schema 破坏（todo 新独立 store；squad_tasks 改名仅 implId + 标头）；profile toolBound 摘 goal/requirement 是运行时配置变更（gate 长期保留可逆）。
- **风险点**：(1) todo store packaged 验证（DATA_DIR 展开过 resolveDataDir）；(2) prompt 段 OKR 摘除需 coder 全盘扫定位（change_plan 已标 grep 关键词）；(3) feature gate UT 适配（mock __FEATURE_OKR__ 双值）。
- **持续可打包护栏**：feature gate = vite define（前端编译期，后端零涉及）；todo store 独立走 packaged 验证；todo/squad_tasks provider 不改 plugin.json 资源结构（仅改 implId + i18n key，build-plugins copyResources 已覆盖）。

## 反馈回路

后续实现/codereview 发现严重违反本表（改了不在表里的文件、动到未声明符号、约束列被破、影响行严重偏离）→ 退 coder；同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
