# v0.0.240 变更计划书 — squad task（panorama builtin entity + reminder + 首页改造）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 架构决策：方案 A+——task = panorama **builtin entity**（不造专用工具，agent 用通用 `panorama(action, entity=task)`）；状态走 reminder 注入（挂 SystemReminderPoint）；依赖全自动（waiting⇄todo 后置 hook，source=system）。前置增强：view.filter / 归档 / builtin schema 通道 / field 中文。
> 概念权威源：`specs/tech/squad/[P1]panorama_builtin.md`（新增）+ `[P1]panorama_dsl.md §5.0`（view.filter）+ `[P1]squad_reminder_providers.md §4`（squad_task provider）+ `specs/api/overall/14-panorama-endpoints.md` v1.3。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名/符号名（行 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

### 模块 A：panorama builtin schema 通道（server 新模块）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama_builtin | app/server/src/squad/panorama/builtin/task-schema.ts | TASK_ENTITY_DEF | 新增 | task EntityDef 常量：id/title/description/owner(ref member)/dependencies(string+pattern,max50)/status(enum 4 态)/archived(boolean)；label 配死中文（标题/描述/负责人/依赖/状态/已归档）| MUST owner ref → member（跨实体软解析，dsl 校验放宽 member 存在性）；dependencies 用 string 表达 id 列表（coder 可改 ref[] 若 DSL 扩容，见 builtin §2.1 决策点） | panorama_builtin §2.1 | +45 |
| panorama_builtin | app/server/src/squad/panorama/builtin/task-schema.ts | TASK_VIEW_DEF | 新增 | task_kanban KanbanViewDef：4 列（todo/waiting/in_progress/done）+ filter {archived:false} + card 模板（title + owner/status badges）+ display.status_labels 中文 + status_colors（waiting=amber） | MUST 4 列对应 4 状态、等待中单独列；filter 默认隐藏归档 | panorama_builtin §2.3 | +25 |
| panorama_builtin | app/server/src/squad/panorama/builtin/task-schema.ts | BUILTIN_ENTITY_DEFS | 新增 | `Record<string, EntityDef>` 常量 = `{ task: TASK_ENTITY_DEF }`（后续 builtin entity 加这里） | MUST builtin 优先于 DSL 同名 entity | panorama_builtin §3 | +3 |
| panorama_builtin | app/server/src/squad/panorama/builtin/task-schema.ts | BUILTIN_VIEWS | 新增 | `ViewDef[]` 常量 = `[TASK_VIEW_DEF]`（prepend 进 effective schema.views） | MUST builtin views 始终首项（task 是第一个 tab） | panorama_builtin §3 | +3 |
| panorama_builtin | app/server/src/squad/panorama/builtin/effective-schema.ts | readEffectiveSchema | 新增 | `(squadId, dataDir) => PanoramaSchema \| null`：new PanoramaEntityStore + readBoard()，合并 `{entities: {...raw.entities, ...BUILTIN_ENTITY_DEFS}, views: [...BUILTIN_VIEWS, ...raw.views]}`；raw=null 时返纯 builtin | MUST NOT 写盘（只读合并）；MUST builtin 优先（覆盖同名 DSL）；MUST 空板也返 builtin（task 恒在） | panorama_builtin §3；原则#1/#2 | +22 |
| panorama_builtin | app/server/src/squad/panorama/builtin/task-hooks.ts | parseDeps | 新增 | `(raw: unknown) => string[]`：dependencies 字段值（string）→ id 数组（逗号/空格分隔 + 过滤空） | MUST 容错非 string 输入返 [] | panorama_builtin §4 | +10 |
| panorama_builtin | app/server/src/squad/panorama/builtin/task-hooks.ts | afterTaskWrite | 新增 | `(squadId, store, triggerId) => void`：listInstances('task') 全量扫描，依赖未满足且 status=todo → waiting；依赖全 done 且 status=waiting → todo；同值跳过；store.transitionInstance source='system'；emit SSE panorama_entity_update（action=transitioned, source=system）受影响 task | MUST source='system' 区分 agent/drag；MUST 同值跳过（防事件洪水）；MUST NOT 走 runTransition/validateTransition（避免 self-loop hook）；MUST 幂等；状态机 design 保证 waiting⇄todo 合法 | panorama_builtin §4；原则#3 | +35 |
| panorama_builtin | app/server/src/squad/panorama/builtin/index.ts | (barrel) | 新增 | re-export TASK_ENTITY_DEF/TASK_VIEW_DEF/BUILTIN_*/readEffectiveSchema/afterTaskWrite/parseDeps | — | — | +8 |

### 模块 B：panorama 工具/HTTP 接入 effective schema + task hook（server 修改）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-actions.ts | effectiveSchema | 新增 | helper `(rtc, dataDir) => PanoramaSchema \| null`：包 readEffectiveSchema(rtc.selfSquadId, dataDir)；替代各 action 直读 store.readBoard() 的 schema 获取（store 实例仍用 store() helper 取） | MUST 所有 schema 读取经此（单一 chokepoint）；MUST NOT 直读 readBoard 拿 schema（task entity 会丢） | panorama_builtin §3 原则#2 | +6 |
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-data-actions.ts | resolveEntity | 修改 | schema 来源改 `effectiveSchema(rtc, dataDir)`（原 `store(rtc,dataDir).readBoard()`）→ resolveEntity 自动看到 task entity | MUST schema 经 effectiveSchema；task entity 名解析命中 builtin | panorama_builtin §3 | +2/-2 |
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-data-actions.ts | runCreate | 修改 | entity==='task' 时 createInstance 后调 `afterTaskWrite(rtc.selfSquadId, s, id)`（自动依赖 transition） | MUST 仅 task entity 触发 hook（其他 entity 不动）；hook 在 emit entity.created SSE 之前/之后均可（coder 定）但必须在 return 之前 | panorama_builtin §4 | +4 |
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-data-actions.ts | runUpdate | 修改 | entity==='task' 且 patch 触碰 dependencies 或 status → updateInstance 后调 afterTaskWrite | MUST 仅 task + patch 含 deps/status 时触发（避免无关 patch 重扫） | panorama_builtin §4 | +5 |
| panorama_tool | app/server/src/squad/panorama/tool/panorama-tool-data-actions.ts | runTransition | 修改 | entity==='task' → transitionInstance 后调 afterTaskWrite（todo→done 触发依赖该 task 的 waiting 解除） | MUST 仅 task 触发 | panorama_builtin §4 | +3 |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | handleGetSchema | 修改 | **不改实现**：继续返纯 DSL（前端镜像 builtin 注入）；仅注释标明 builtin 由前端合成 | MUST 返纯 leader DSL 文本（不含 builtin）；MUST NOT 后端把 builtin 序列化进 dsl | api/overall/14 §1.1 v1.3 | +2 (注释) |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | handleListEntities | 修改 | schema 来源改 readEffectiveSchema；entity 是 builtin（task）时跳过 409 schema_not_defined（直接返实例列表，空板也 200） | MUST builtin entity 不返 409 | api/overall/14 §2.1；panorama_builtin §3 | +4/-3 |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | handleCreateEntity | 修改 | schema 来源改 readEffectiveSchema（拿 builtin task entityDef 校验）；entity==='task' 调 afterTaskWrite | MUST 校验走 effective schema 的 entityDef | panorama_builtin §3/§4 | +4/-2 |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | handlePatchEntity | 修改 | schema 来源改 readEffectiveSchema；task + patch 触 dependencies/status → afterTaskWrite | MUST 归档（patch archived）走原 PATCH 路径无特化 | api/overall/14 §2.4；panorama_builtin §4 | +4/-2 |
| panorama_http | app/server/src/squad/panorama/http/panorama-routes-impl.ts | handleTransition | 修改 | schema 来源改 readEffectiveSchema；entity==='task' 调 afterTaskWrite | — | panorama_builtin §4 | +3/-2 |
| panorama_validation | app/server/src/squad/panorama/validation/validate_semantic.ts | checkViewFilter | 新增 | 在 checkViews forEach 内调：view.filter 存在时校验 key 是 entity 已声明字段（否则 `panorama_unknown_filter_field`）；enum 字段值不在 values 内 → warning `panorama_warn_unknown_filter_value` | MUST 不短路（收集式）；MUST filter key 不存在 = error（防止 leader 写错字段名静默无效） | panorama_dsl §5.0；panorama_validation §4 | +18 |
| panorama_validation | app/server/src/squad/panorama/validation/validate_semantic.ts | checkViews | 修改 | forEach 内加 `checkViewFilter(view, entity, p, errors, warnings)` 调用（component 分支前） | — | panorama_dsl §5.0 | +1 |

### 模块 C：squad reminder provider + deps 接入（server + plugin）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| squad_reminder | app/server/src/agent/squad-reminder-deps.ts | SquadReminderDeps | 修改 | 加 `panoramaDataDir: string`（boot.ts 注入 config.dataDir） | MUST 由 boot.ts 注入；MUST NOT 在 provider 内自行取 env | squad_reminder_providers §4 | +3 |
| squad_reminder | app/server/src/agent/squad-reminder-deps.ts | SquadContextService | 修改 | 加 `listActiveTasks(squadId: string, viewerMemberId: string \| null): Promise<TaskLike[]>`（leader=null 全队；mate=self 过滤 owner∪依赖） | MUST 不返 archived=true；TaskLike = {id,title,owner,dependencies,status,archived} 子集 | squad_reminder_providers §4 | +5 |
| squad_reminder | app/server/src/agent/squad-reminder-deps.ts | makeSquadContextService | 修改 | 实现 listActiveTasks：new PanoramaEntityStore({root:deps.panoramaDataDir, squadId}).listInstances('task') filter archived=false + 角色 filter（leader 全队 / mate owner∪依赖 owner==self） | MUST 经 PanoramaEntityStore 直读（不经 effective schema，task 是 builtin 永远在）；MUST mate 过滤含「我 block 别人」（dependencies 含 owner==self 的 task） | squad_reminder_providers §4；panorama_builtin §5 | +25 |
| squad_reminder | app/server/src/agent/squad-reminder-deps.ts | TaskLike | 新增 | type export（provider 产出格式用） | — | — | +8 |
| squad_reminder | app/server/src/agent/squad-reminder-deps.ts | boot.ts wiring（注入点） | 修改 | bootstrap 构造 SquadReminderDeps 时填 panoramaDataDir = config.dataDir | MUST boot.ts 注入（provider 不读 env） | — | +2 |
| plugin_rocky_context | app/plugins/builtins/rocky_context/reminder/squad_task.ts | SquadTaskReminderProvider | 新增 | default export class extends ContextImplBase implements SystemReminderProvider；provide(ctx)：role filter（leader 全队 / mate owner∪依赖）→ squadContext.listActiveTasks → 格式化 `[squad:tasks]` 提示（owner_name join memberStore、status_label 中文、waiting 显依赖提示） | MUST 复用 readSessionType helper；MUST tier='info'；MUST 不走 shouldProduce（瞬时值每轮产出）；MUST SquadChat/subagent/standalone 返 [] | squad_reminder_providers §4；panorama_builtin §5 | +75 |
| plugin_rocky_context | app/plugins/builtins/rocky_context/plugin.json | system_reminder impls | 修改 | 加 `{implId:'squad_task', point:'system_reminder', impl:'./reminder/squad_task.ts', description: __MSG...}`（order 在 squad_workspace/squad_team_status 之后） | MUST implId=squad_task（与 spec 对齐） | squad_reminder_providers §4 | +5 |
| plugin_rocky_context | app/plugins/builtins/rocky_context/_locales/*/messages.json | squad_task.description i18n key | 新增 | 中英两 locale 加 squad_task 描述 | MUST 中英同步（i18n key-add-checklist memory） | i18n-key-add-checklist | +2 |

### 模块 D：panorama 前端类型 + view.filter 透传 + builtin 镜像（web 修改）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| panorama_web_types | app/web/src/components/studio-page/panorama-types.ts | BaseViewDef | 修改 | 加 `filter?: Record<string, unknown>`（三种 view 共享） | MUST 镜像 server DSL 类型 | panorama_dsl §5.0 | +2 |
| panorama_web_types | app/web/src/components/studio-page/panorama-types.ts | BUILTIN_TASK_ENTITY_DEF / BUILTIN_TASK_VIEW_DEF | 新增 | 前端常量镜像 server task-schema（同字段/view 配置） | MUST 与 server 常量逐字段一致（防 render 漂移） | panorama_builtin §2 | +35 |
| panorama_web_types | app/web/src/components/studio-page/panorama-types.ts | mergeBuiltinSchema | 新增 | `(schema: PanoramaSchema \| null) => PanoramaSchema`：null → `{entities:{task},views:[TASK_VIEW]}`；非 null → merge builtin 优先 + prepend view | MUST 与 server readEffectiveSchema 同语义 | panorama_builtin §3 | +12 |
| panorama_web_utils | app/web/src/components/studio-page/panorama-utils.ts | parsePanoramaDsl | 修改 | parse 后跑 mergeBuiltinSchema（DSL + builtin 合并） → 前端 schema 永远含 task | MUST 调用点（PanoramaRoute）拿到的 schema 已合并 | panorama_builtin §3 | +3 |
| panorama_web_view | app/web/src/components/studio-page/component-panorama-view.tsx | (entity fetch) | 修改 | fetch `GET entities/:entity` 时若 activeView 声明 filter → 序列化 `?filter=k:v,k2:v2` 透传（与 handleListEntities 现有解析对齐） | MUST 仅 view.filter 存在时透传；MUST archive 开关 override 时省略 filter | panorama_dsl §5.0；api/overall/14 §2.1 | +12 |
| panorama_web_view | app/web/src/components/studio-page/component-panorama-view.tsx | archiveSwitchState | 新增 | 任务 tab toolbar 右侧「活跃/含归档」segmented 开关 state（默认「活跃」=传 filter；切「含归档」=不传 filter 重 fetch） | MUST 仅 task view 显示（其他 view 无归档概念除非 leader DSL 配 archived 字段 + filter；coder 决定通用化口径） | PRD §3.6 | +18 |
| panorama_web_route | app/web/src/components/studio-page/component-panorama-route.tsx | PanoramaRoute | 修改 | 删 `onBack` prop + 头部返回键/标题块（变内嵌组件，无独立路由头部）；tab 条 + view 内容保留 | MUST 删 onBack（首页内嵌无返回）；MUST 不再渲 ChatTopbarBackBtn | PRD §3.3.4；orchestrator 裁决#2 | -20/+3 |

### 模块 E：首页 IA 改造（web 修改 + 新增 + 删除）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| studio_page | app/web/src/components/studio-page/page-studio.tsx | MainView | 修改 | 删 `{ kind: 'panorama'; squadId: string }` variant（独立路由态废） | MUST kind=panorama 分支同步删；MUST NOT 保留死变体 | orchestrator 裁决#2；PRD §3.3.4 | -1 |
| studio_page | app/web/src/components/studio-page/page-studio.tsx | mainArea dispatch（kind==='panorama' 分支） | 删除 | 删整段 PanoramaRoute 独立路由渲染 + onAtLeader 切群聊逻辑（搬进 SeatsPanel 内嵌） | MUST 删干净不留注释残骸 | PRD §3.3.4 | -12 |
| studio_page | app/web/src/components/studio-page/page-studio.tsx | onOpenPanorama prop（传 SeatsPanel） | 删除 | 不再传（ SeatsPanel 内嵌渲染，不走 setMainView 切路由） | — | — | -1 |
| studio_seats | app/web/src/components/studio-page/component-seats-panel.tsx | SeatsPanel props | 修改 | 删 `onOpenPanorama`；roster 头计数 N 减队长；第二栏新增内嵌 PanoramaRoute（squadId + onAtLeader 透传） | MUST 第二栏内嵌 PanoramaRoute（无 onBack）；MUST roster N=members.length-1（leader 不计） | PRD §3.3.2/§3.3.4 | +8/-3 |
| studio_seats | app/web/src/components/studio-page/component-seats-body.tsx | SeatsBody 左列 | 修改 | 删 `<SeatStats>` 2×2 格 + 删 `<TeamEntryRow>`；加 `<TokenWidget>`（图文组件，点击触发 onOpenTokenStats）；左列三卡堆叠保队长 mini 卡 | MUST 删 SeatStats/TeamEntryRow 引用 + import；MUST token-widget 整卡点击切 token-stats 路由态 | PRD §3.3.2/§3.3.3；orchestrator 裁决#1 | -25/+15 |
| studio_seats | app/web/src/components/studio-page/component-seats-body.tsx | roster 头计数文案 | 修改 | i18n key `studio:tabs.seats` 文案「坐席」→「首页」；roster 头「坐席·N」→「成员·N」（N 减队长） | MUST 中英 i18n 同步；MUST N=total-1（leader 不计） | PRD §3.3.1/§3.3.2；i18n-key-add-checklist | +3/-2 |
| studio_token_widget | app/web/src/components/studio-page/component-token-widget.tsx | TokenWidget | 新增 | 图文组件：今日三色比例条（input/output/cache）+ 7 日迷你柱 + 累计/预算进度条 + 整卡点击 → onOpenTokenStats；数据源复用 getBudgetUsage + token-stats 派生口吻 | MUST 复用 token-stats 配色（input=hue-blue/output=hue-violet/cache=hue-green/累计=hue-amber）；MUST 整卡 hover box-shadow（无位移）；MUST budget=null 显「不限量」 | PRD §3.3.3；component-token-stats.md | +120 |
| studio_team_entry_row | app/web/src/components/studio-page/component-team-entry-row.tsx | (整文件) | 删除 | 整组件废（mv 到 soft_deleted/v0.0.240/）——业务全景 link 由第二栏全景 tab 取代；token 统计 link 由 TokenWidget 取代 | MUST grep 残留引用清零（panorama-route.md spec 过时 doc-modifier 修）；MUST 删 i18n key `teamEntry.*` | orchestrator 裁决#1；PRD §7 | -85 |
| studio_i18n | app/web/src/locales/{zh,en}/studio.json | tabs.seats / roster.count / tokenWidget.* / task.* labels | 修改 | tabs.seats 「坐席」→「首页」；roster.count 文案；新增 tokenWidget.* + task.status_labels + squad_task.description | MUST 中英同步；MUST task enum labels 配死中文（未开始/等待中/进行中/已结束） | i18n-key-add-checklist | +25 |

### 模块 F：测试（UT，product 代码配套）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test_builtin | app/server/src/squad/panorama/builtin/__tests__/task-hooks.test.ts | afterTaskWrite UT | 新增 | case：依赖未满足+todo→waiting / 依赖全 done+waiting→todo / 同值跳过 / 环依赖保护 / 多依赖部分 done / status=in_progress 不被 hook 改 | MUST 覆盖全自动核心逻辑（PRD P2 最低覆盖） | bottom-up-layer-verify memory；PRD §4 P2 | +80 |
| test_builtin | app/server/src/squad/panorama/builtin/__tests__/effective-schema.test.ts | readEffectiveSchema UT | 新增 | case：空板返纯 builtin / DSL+builtin 合并 / builtin 覆盖同名 DSL entity / views prepend 顺序 | — | panorama_builtin §3 | +35 |
| test_reminder | app/plugins/builtins/rocky_context/reminder/__tests__/squad_task.test.ts | SquadTaskReminderProvider UT | 新增 | case：leader 全队 / mate owner∪依赖 / SquadChat 返空 / archived 不入 / waiting 显依赖提示 / 无 task 显空态 | MUST mock squadContext.listActiveTasks（不真读盘） | squad_reminder_providers §4 | +70 |
| test_web | app/web/src/components/studio-page/__tests__/panorama-utils.test.ts | mergeBuiltinSchema UT | 新增 | case：null schema → 含 task / 非 null → merge + prepend | — | panorama_builtin §3 | +20 |

## 影响面评估

**跨模块**：6 模块（panorama_builtin 新 / panorama_tool / panorama_http / panorama_validation / squad_reminder + plugin / studio_ui）。后端 4 模块（A-D 除 web）+ 前端 2 模块（D-web + E）。

**破坏性变更**：
- `MainView kind='panorama'` 删除 → 类型 union 收紧，调用方需同步（page-studio 内部，封闭）。
- `PanoramaRoute` props 删 `onBack` → 调用方同步（SeatsPanel 内嵌）。
- `TeamEntryRow` 整删 → grep 残留引用清零。
- `BaseViewDef` 加 `filter?` → optional 向后兼容，无破坏。
- `SquadReminderDeps` 加 `panoramaDataDir` → boot.ts 必须注入（否则启动期 typecheck 红，强制迁移）。
- `SquadContextService` 加 `listActiveTasks` → 接口扩展，所有实现同步。

**依赖顺序**（底层先）：
1. 模块 A（builtin schema 常量 + effective schema + hooks）— 自含，无外部依赖。
2. 模块 B（tool/http 接入 effective schema + hook）— 依赖 A 的 export。
3. 模块 C（reminder provider + deps 扩展）— 依赖 A 的 PanoramaEntityStore（已有）+ listInstances。
4. 模块 D-web（前端类型 + view.filter + builtin 镜像）— 依赖 spec 契约（不依赖 server 实现）。
5. 模块 E（首页 IA）— 依赖 D-web 的 PanoramaRoute 改造。

**并行度**：T1（server: A+B+C+validation）∥ T2（web: D-web+E）可并行（契约 = api/overall/14 v1.3 + panorama_builtin spec）。

**风险点**：
1. **dependencies 字段类型**：架构期建议 `string + pattern` + hook 解析（DSL v1 无 `ref[]`）；coder 可改走 `ref[]`（需扩 DSL 字段类型集 + parser + 校验）。若改走 ref[]，须同步 panorama_dsl §4.2 + panorama_builtin §2.1。
2. **owner ref → member 跨实体**：member 不在 panorama DSL（SchemaDef 管理），dsl 校验层须放宽 owner ref 的存在性闭合（semantic 层跳过 member 存在校验）；reminder 层做软解析（join memberStore 取 name）。coder 须确认 validateSemantic 不会因 owner 指向 member（不在 entities map）报 `panorama_unknown_ref_target`——可能需把 owner 字段类型用 `string` + 自定义格式而非 `ref`，或扩 semantic 放行 member ref。
3. **task 自动 transition SSE 风暴**：afterTaskWrite 改一个 task 状态可能级联（A done → B 解除 waiting → B 不影响其他）；单层依赖无级联（hook 不递归传递闭包）。若未来扩传递依赖须加 visited set。
4. **UI archive 开关通用化口径**：架构期默认仅 task view 显示开关（其他 view 无归档）；coder 可决定 leader DSL entity 声明 archived 字段 + view filter 时也显示开关（通用化），本表标「coder 定位」。

**spec 过时待修**（doc-modifier 阶段 5）：① `component-panorama-route.md`（FIXED_TABS 残留 + 内嵌改造）；② `component-team-entry-row.md`（整组件废）；③ `component-panorama-view.md`（toolbar 加 archive 开关槽位）；④ `06-studio.md`（首页 IA + tab 改名 + roster 计数）。PRD §7 已记。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 实现细节合理偏离（如 dependencies 改 ref[]、archive 开关通用化）须向 orchestrator 汇报偏离 + 理由 + 影响范围，由 orchestrator 裁决后续（core 约束不可擅偏离：builtin 只在 read 层合并 / 自动 transition 不走用户路径 / 不造专用工具 / reminder 复用 SystemReminderPoint）

