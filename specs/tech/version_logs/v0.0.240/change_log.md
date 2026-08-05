# v0.0.240 tech change_log — squad task（panorama builtin entity + reminder 注入 + 首页改造）

> 类型：panorama 概念层扩展（builtin schema 通道 / view.filter / 归档）+ squad reminder provider 新增 + plugin i18n + 前端类型镜像 + 首页 IA。
> 权威变更契约见同目录 `change_plan.md`（method 级 A-F 组）。PRD：`specs/prd/version_logs/v0.0.240/prd.md`。
> 概念权威源：`specs/tech/squad/[P1]panorama_builtin.md`（新增）+ `[P1]panorama_dsl.md §5.0`（view.filter）+ `[P1]squad_reminder_providers.md §4`（squad_task provider）。

## 影响子系统 KB

| KB | 改什么 |
|----|--------|
| `specs/tech/squad/` | 新增 `[P1]panorama_builtin.md`（builtin schema 通道权威）；`[P1]panorama_dsl.md §5/§5.0` view.filter；`[P1]panorama_overview.md` 概念表 + 设计原则；`[P1]squad_reminder_providers.md §4` squad_task provider；`index.md` 概念表 + 导航；`log.md` v0.0.240 条目（含 doc-sync 偏离核实） |

## 摘要

### ① panorama builtin schema 通道（change_plan A + B 组）
- 新模块 `app/server/src/squad/panorama/builtin/`：`task-schema.ts`（TASK_ENTITY_DEF + TASK_VIEW_DEF + BUILTIN_ENTITY_DEFS/VIEWS 常量）+ `effective-schema.ts`（`readEffectiveSchema` 单一 chokepoint，DSL + builtin 合并）+ `task-hooks.ts`（`parseDeps` + `afterTaskWrite` 自动依赖 transition）+ `index.ts`（barrel）。
- **不变量**：① builtin 只在 read 层合并（不写盘 board.yaml）② 单一 chokepoint（所有 schema 读取经 readEffectiveSchema）③ 自动 transition 不走用户路径（source=system 直调 transitionInstance，禁 runTransition/validateTransition 防 self-loop）④ reminder 复用 SystemReminderPoint ⑤ 不造专用工具（agent 用通用 panorama(action, entity=task)）。
- 工具/HTTP 接入：`panorama-tool-actions.ts:effectiveSchema` helper + `panorama-tool-data-actions.ts:resolveEntity/runCreate/runUpdate/runTransition`（task 触发 afterTaskWrite）+ `panorama-routes-impl.ts:handleGetSchema`（**返纯 DSL 不含 builtin**，前端镜像合成）+ `handleListEntities`（builtin task 例外 409）/`handleCreateEntity`/`handlePatchEntity`/`handleTransition`（schema 来源改 readEffectiveSchema + task 调 afterTaskWrite）。
- 校验：`validate_semantic.ts:checkViewFilter` + `checkViews` 加 view.filter 字段名校验（`panorama_unknown_filter_field`）。

### ② squad_task reminder provider（change_plan C 组）
- `app/server/src/agent/squad-reminder-deps.ts`：`SquadReminderDeps` 加 `panoramaDataDir`（boot.ts 注入）；`SquadContextService.listActiveTasks(squadId, viewerMemberId)`（leader=null 全队 / mate=self 过滤 owner∪依赖 owner==self）+ `TaskLike` type。
- `app/plugins/builtins/rocky_context/reminder/squad_task.ts`：`SquadTaskReminderProvider` default export——角色 filter（leader 全队 / mate owner∪依赖）+ listActiveTasks 数据源 + `[squad:tasks]` 产出格式（owner_name join memberStore 软解析 / status_label 中文 / waiting 显「等 N 项」依赖提示）+ tier=info + 瞬时值每轮产出（不走 shouldProduce）。
- plugin.json system_reminder EP 注册 implId=squad_task（order 在 squad_workspace/squad_team_status 之后）；i18n key `squad_task.description` 落 `app/web/src/i18n/locales/{zh-CN,en}/plugin-config.json`（中英同步）。

### ③ 前端类型镜像 + view.filter 透传 + builtin 合成（change_plan D 组）
- `panorama-types.ts`：BaseViewDef 加 `filter?: Record<string, unknown>`；新增 `BUILTIN_TASK_ENTITY_DEF` + `BUILTIN_TASK_VIEW_DEF`（前端镜像 server task-schema，逐字段一致）+ `BUILTIN_ENTITY_DEFS`/`BUILTIN_VIEWS` + `mergeBuiltinSchema(schema)`（null → 纯 builtin / 非 null → builtin 优先合并 + views prepend）。
- `panorama-utils.ts:parsePanoramaDsl` 跑 mergeBuiltinSchema → 前端 schema 永远含 task。
- `component-panorama-view.tsx`：fetch 时透传 `view.filter` 序列化 `?filter=k:v,k2:v2`；archiveMode state（active=传 filter / with_archived=不传）；toolbar ArchiveSwitch 槽位（仅 view.filter.archived 时）；卡片 hover 归档按钮（PATCH archived:true）+ 已归档 opacity 0.55。
- `component-panorama-route.tsx`：删 `onBack` prop + 头部返回键（变首页第二栏内嵌）；删 showMoreTab / 'more' tab / PanoramaIdle（builtin task 恒在首 tab，schema 永不空）。

### ④ 首页 IA 改造（change_plan E 组）
- `page-studio.tsx`：删 `MainView kind='panorama'` variant（独立路由态废）+ onOpenPanorama prop。
- `component-seats-panel.tsx`：删 onOpenPanorama；roster 头计数 N 减队长；第二栏内嵌 PanoramaRoute（squadId + onAtLeader 透传）。
- `component-seats-body.tsx`：删 `<SeatStats>` 2×2 + 删 `<TeamEntryRow>` + import；加 `<TokenWidget>`（图文组件，整卡点击切 token-stats）；roster「坐席·N」→「成员·N」（N=total-1）。
- `component-token-widget.tsx`（新）：今日三色比例条 + 7 日迷你柱 + 累计/预算进度条 + 整卡点击；复用 token-stats hue 配色（input=hue-blue/output=hue-violet/cache=hue-green/累计=hue-amber）。
- `component-team-entry-row.tsx`（整删）：mv `soft_deleted/v0.0.240/`；grep 残留引用清零；删 i18n key `teamEntry.*`。
- i18n `app/web/src/i18n/locales/{zh-CN,en}/studio.json`：tabs.seats「坐席」→「首页」；roster.count；新增 tokenWidget.* + task.status_labels（中文配死）。

### ⑤ 测试（change_plan F 组）
- `builtin/__tests__/task-hooks.test.ts`：依赖未满足+todo→waiting / 全 done+waiting→todo / 同值跳过 / 环依赖 / 多依赖部分 done / in_progress 不动。
- `builtin/__tests__/effective-schema.test.ts`：空板返纯 builtin / DSL+builtin 合并 / builtin 覆盖同名 DSL / views prepend。
- `reminder/__tests__/squad_task.test.ts`：leader 全队 / mate owner∪依赖 / SquadChat 返空 / archived 不入 / waiting 显依赖 / 空态。
- `__tests__/panorama-utils.test.ts`：mergeBuiltinSchema null/非 null。

## 代码↔spec 偏离核实（doc-modifier 已对齐）

1. **owner=string（非 ref→member）**：架构 spec §2.1 标「ref → member」；T1 实现 `string`——member 不在 panorama DSL entities map，ref 触发 `panorama_unknown_ref_target`；reminder 层软解析 join memberStore。前端镜像同步对齐 string。spec §2.1 已改齐。
2. **dependencies=string+pattern（非 ref[]）**：架构 spec §2.1 标「ref[] max=50」+「coder 决策点」开放；T1 实现 `string + pattern`（DSL v1 无 ref[]）+ parseDeps split。**max 不一致（已知，无害）**：server max=500（权威校验）/ 前端镜像 max=50（仅渲染）。spec §2.1 已改齐。
3. **afterTaskWrite 签名**：架构 spec §4 标 `(squadId, store, triggerId)`；实际 `(squadId, store, dataDir)`——dataDir 用于 readEffectiveSchema 展开 panorama_dir；triggerId 不参与扫描（hook 全量重算）。spec §4 已改齐。
4. **i18n 路径**：实际 `app/web/src/i18n/locales/{zh-CN,en}/{studio,plugin-config}.json`（非 `app/web/src/locales/` / 非 `_locales/*/messages.json`）。
