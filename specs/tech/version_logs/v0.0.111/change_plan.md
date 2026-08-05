# v0.0.111 变更计划书 — 工作项三态可见性 + team 硬删除 + reminder 团队 workspace

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 权威设计：`states/v0.0.111.workitem_visibility/design-plan.md`（用户已确认）+ `team-delete-research.md`（block② 执行顺序）。block③（prompt）已完成，不在本表。

## ⚠️ 核对与漂移（architect 对代码实地核对，coder/doc-modifier 以此为准）

1. **`agentManager.abort` 签名 = `abort(sessionId, runId, modeKey)`**（agent-manager.ts:432），非设计稿暗示的 `abort(squadId)`。abort 一个 session 的当前 run 需 `session.currentRunId` + `modeKey=MODE_KEY_CURRENT`（`'current'`，agent-run-registry.ts:18）。→ 本表新增 `AgentManagerImpl.abortSession(sid)` 封装（内部读 currentRunId + MODE_KEY_CURRENT），disposeSquad 调它，不外泄 mode-key。
2. **`unregisterHeartbeatJobs(squadId)` 已是 SquadRuntime 私有方法**（squad-runtime.ts:165，内部 `registeredJobIds.delete`）。disposeSquad 同类内可直接调——**无需另加 public 入口**（设计稿说"加 per-squad 公共入口"，实际 public 入口就是 disposeSquad 本身）。
3. **"4 个 per-squad Map" 实为 1 Set + 3 Map**：`ensuredSquads=Set<string>`（:55）、`registeredJobIds`/`fileWatchers`/`schedulerFacades`=Map（:57/:59/:61）。`registeredJobIds` 由 `unregisterHeartbeatJobs` 内部 delete；disposeSquad 只需再清 `ensuredSquads`/`fileWatchers`(+stop)/`schedulerFacades`。
4. **session 枚举**：`member.sessionId` 存在（squad-runtime-helpers.ts:29 用 `m.sessionId`）；`squadChatSession` = `squad.squadChatSessionId`（SquadRecord 字段，team-tool.ts:26 / runtime-context.ts:278 确认）。枚举集 = `squadChatSessionId` + 各 `member.sessionId`。
5. **`deleteSquad`（squad-store.ts:83）仅删 record**（`{root}/squad/{id}.json` via `deleteAsync`），**不删办公室目录** `{root}/squads/{id}/` → 需 `rmSync(squadRootDir(dataDir,id))` 单独删（`squadRootDir` squad-store.ts:212 存在，返 `join(root,'squads',squadId)`）。`deleteSession`（session-store.ts:329）已级联 `rmSync(sessions/{sid})`(:340) + `onSessionDestroyed`(:347) 注销内存 cron。
6. **board-read `zoneFilter` 现签名 `(selfArchived, effArchived, zone)`**（board-read.ts:158）——cancelled 在 `.map(toXItem)` 前对**原始 entity** 过滤（`effectiveCancelled(ent, view)`），**zoneFilter 不改签名**（cancelled 已在其上游滤掉）。
7. **三工具 runQuery 现状：不建 ancestorView、不 filter archived/cancelled/readable**（goal-tool.ts:225 sync、requirement-tool.ts:201 sync、task-tool.ts:233 async），仅按 owner/status/assignee 等过滤——**违反 squad_tools.md query 可见性契约（现状 bug）**。需各自 `buildAncestorView(listGoals+listRequirements+listTasks)` 后叠加过滤。
8. **board item HTTP schema 不新增 `effectiveCancelled` 字段**：cancelled 项完全不返回 → 该字段恒 false 无意义。`effectiveCancelled` 仅作派生在过滤点内联算，不进 `11b §2.1` schema（保 schema 稳定，减 doc-sync）。
9. **`config.dataDir` + `config.squadId` 均在 SessionConfig**（memory.ts:53 读 `config.dataDir`；squad_charter.ts:89 读 `config.squadId`）→ block④ 新 provider 数据源就绪。
10. **UI onDelete 线路**：`page-studio.tsx`（拥 squads/selectedSquadId 状态）→ `section-squad-panel.tsx`（SquadPanelProps）→ `component-manage-tab.tsx`（ManageTab，section-squad-panel.tsx:73 渲染）。onDelete 须逐层透传。
11. **`agentManager.abort` 需 `MODE_KEY_CURRENT`** 从 `app/server/src/agent/agent-run-registry.ts` 导出（值 `'current'`）——abortSession 内部引用。

## 新概念（待 doc-modifier 阶段 5 补 spec；本版本引入）

- **`effectiveCancelled` 派生 + cancel 联合检查**（cancel 优先级最高：任一祖先 cancelled → 后代三通道全不可见）→ 补 `specs/tech/squad/[P1]squad_archive.md §1/§3`（与 effectiveArchived 并列）。
- **三态可见性矩阵**（active/archive/cancel × reminder/工具/UI）→ 补 `squad_archive.md §3`（UI-Agent 两层规则升级为三态三通道）。
- **`SquadRuntime.disposeSquad` per-squad 运行时 teardown 语义 + `dissolveSquad` 硬删编排**（teardown 先于删数据，防潜伏调度）→ 补 `specs/tech/squad/[P1]scheduler.md` + `data_model.md §1.1`（"squad 不可删"改"可硬删/解散"）。
- **`squad_workspace` reminder provider**（团队盘根路径，leader+mate；与个人 workspace 并存）→ 补 `specs/tech/squad/[P1]squad_reminder_providers.md`。
- **API 契约**：`DELETE /squad/:id`（`11a-squad-endpoints.md` 新增）；GET /board 不再返 cancelled + 工具 query `includeArchived` 参数 + 默认滤 archived/cancelled（`11b-squad-workitems.md` §4 + squad_tools.md §3）。
- **i18n**：block④ 新 provider 的 `__MSG_plugin.builtin.rocky_context.impl.squad_workspace.description__` 需在 locale 补 key（coder 加，doc-modifier 核对）。

## 变更清单（行 = 一个函数/符号）

### 块① 工作项三态可见性（active / archive / cancel × reminder/工具/UI）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| board-archive | app/server/src/stores/board-archive.ts | krAncestors / reqAncestors / taskAncestors | 修改 | 祖先链元素 `{archived}`→`{archived,cancelled}`；cancelled=祖先 `status==='cancelled'`（KR/Goal/Req 均有 status 字段） | MUST NOT 改 readable/effectiveArchived 行为（二者只读 `.archived`）；坏链容忍逻辑不变 | design-plan §块①.1；squad_archive §2；漂移#1 | +12/-6 |
| board-archive | app/server/src/stores/board-archive.ts | listAncestors | 修改 | 返回类型同步 `{archived,cancelled}[]`；kind 分派不变 | MUST 保持四 kind 分派 switch 闭合 | squad_archive §2 | +2/-2 |
| board-archive | app/server/src/stores/board-archive.ts | readSelfCancelled | 新增 | 取 entity 自身 `status==='cancelled'`（镜像 readSelfArchived，联合类型分流四 kind） | MUST 覆盖 goal/kr/requirement/task（switch 闭合，缺 kind 编译失败） | squad_archive §1 | +8 |
| board-archive | app/server/src/stores/board-archive.ts | effectiveCancelled | 新增 | `self.status==='cancelled' ∨ 任一祖先 cancelled`（镜像 effectiveArchived）；cancel 联合检查单一权威 | MUST 与 effectiveArchived 同结构；导出供 reminder+board-read+tools 复用 | design-plan §块①.1；squad_archive §1；原则#12 | +9 |
| reminder | app/plugins/builtins/rocky_context/prompt/squad_reminder_shared.ts | filterReadableBoard | 修改 | 三段过滤在 `readable` 基础上叠加 `!effectiveCancelled`（goal/req/task 顶层） | MUST 复用 board-archive effectiveCancelled，不本地判 status；normalize 后 status 缺省 pending | design-plan §块①.2；squad_archive §3 | +12/-4 |
| reminder | app/plugins/builtins/rocky_context/prompt/squad_reminder_shared.ts | isTaskReadable | 修改 | 加 `!effectiveCancelled` 判定（自动覆盖 squad_tasks + computeDowngradedDeps dependsOn 降级） | MUST 与 filterReadableBoard 同口径 | design-plan §块①.2；squad_archive §4 | +4/-1 |
| reminder | app/plugins/builtins/rocky_context/prompt/squad_board.ts | formatBoardReminder | 修改 | 渲染 `g.krs` 前过滤 `k.archived \|\| k.status==='cancelled'`（KR 子级 bug 修复） | MUST NOT 改顶层 goals/reqs/tasks 过滤（filterReadableBoard 已管）；只滤 KR 渲染 | design-plan §块①.2 | +4/-1 |
| tools | app/server/src/agent/tools/goal-tool.ts | runQuery | 修改 | `buildAncestorView(listGoals+listRequirements+listTasks)`→默认滤 `effectiveArchived∨effectiveCancelled`；`filter.includeArchived===true` 保留 archive 仍滤 cancel；owner/status 过滤保留 | MUST 保持 sync 签名；MUST 复用 board-archive 派生 | design-plan §块①.3；squad_tools §3；漂移#7 | +15/-2 |
| tools | app/server/src/agent/tools/goal-tool.ts | inputSchema.filter.properties | 修改 | 加 `includeArchived: {type:'boolean'}`（描述"默认 false，true 含归档"） | MUST 默认行为=false | design-plan §块①.3 | +1 |
| tools | app/server/src/agent/tools/requirement-tool.ts | runQuery | 修改 | 同 goal：build view + 默认滤 archived+cancelled + includeArchived；status/raisedBy 过滤保留 | MUST 保持 sync 签名 | design-plan §块①.3；squad_tools §3 | +15/-2 |
| tools | app/server/src/agent/tools/requirement-tool.ts | inputSchema.filter.properties | 修改 | 加 `includeArchived` 属性 | MUST 默认 false | design-plan §块①.3 | +1 |
| tools | app/server/src/agent/tools/task-tool.ts | runQuery | 修改 | 同上（async）；在 mate 可见性过滤后叠加 archived+cancelled 过滤 | MUST 保持 async 签名 + mate 自己/待认领可见性 | design-plan §块①.3；squad_tools §3 | +15/-2 |
| tools | app/server/src/agent/tools/task-tool.ts | inputSchema.filter.properties | 修改 | 加 `includeArchived` 属性 | MUST 默认 false | design-plan §块①.3 | +1 |
| board-read(HTTP) | app/server/src/handlers/board-read.ts | handleBoardRead | 修改 | goals/reqs/tasks 三段在 `.map(toXItem)` 前对原始 entity `.filter(!effectiveCancelled(ent, ancestorView))`（cancelled 不进任何 zone）；import effectiveCancelled | MUST NOT 改 zoneFilter 签名；MUST 用 board-archive effectiveCancelled | design-plan §块①.4；11b §4.1；漂移#6 | +8/-0 |
| UI | app/web/src/components/studio-page/component-board-tasks-view.tsx | COLUMNS | 修改 | 移除 `'cancelled'`（line 42，后端已不返 cancelled） | MUST NOT 引入尺寸随状态变化 | design-plan §块①.5；memory component-size | +1/-1 |
| UI | app/web/src/components/studio-page/component-board-requirements-view.tsx | STATUS_GROUPS | 修改 | 移除 `'cancelled'`（line 40） | 同上 | design-plan §块①.5 | +1/-1 |
| UI | app/web/src/components/studio-page/component-board-tasks-view.tsx | 归档区子项「因 parent 归档」标注（coder 定位精确渲染点） | 修改 | 归档 zone 中 `effectiveArchived ∧ !self.archived` 的项标注归档来源（替代/并存现活跃区提示条，编码时定） | MUST 视觉标注只增内容不改布局尺寸（visibility 非条件渲染） | design-plan §块①.6；memory component-size | +8/-2 |

### 块② team 硬删除（teardown → 删 session → 删数据）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-manager | app/server/src/agent/agent-manager.ts | abortSession | 新增 | 读 `session.currentRunId` → 若存在 `await this.abort(sid, runId, MODE_KEY_CURRENT)`；无 run → no-op；返回 Promise\<void\> | MUST 封装 MODE_KEY_CURRENT 不外泄；幂等（session 不存在安全返回） | 漂移#1/#11；agent-manager.ts:432；agent-run-registry.ts:18 | +12 |
| squad-runtime | app/server/src/squad/squad-runtime.ts | disposeSquad | 新增(public) | per-squad 运行时 teardown：枚举 squad 会话(squadChatSessionId + 各 member.sessionId)→ `agentManager.abortSession` 各会话；`unregisterHeartbeatJobs(squadId)`；`fileWatchers.get(squadId)?.stop()`+delete；`ensuredSquads.delete`；`schedulerFacades.delete`；返回 Promise\<void\> | MUST 复用私有 unregisterHeartbeatJobs（不另开 public，漂移#2）；幂等（未 ensure/不存在也安全）；MUST NOT `engine.stop`（进程单例） | design-plan §块②.1；research §①；scheduler §9/§10；漂移#3/#4 | +32 |
| squad handler port | app/server/src/handlers/squad.ts | SquadRuntimePort | 修改 | 接口加 `disposeSquad(squadId): Promise<void>` | MUST 与 SquadRuntime 实现签名一致（router.ts:524 注入真实例已满足） | 漂移#2；design-plan §块②.1 | +1 |
| squad-dissolve | app/server/src/squad/squad-dissolve.ts | dissolveSquad | 新增(文件+函数) | 硬删编排：① `await squadRuntime.disposeSquad(id)` → ② 枚举会话(squadChatSessionId+member.sessionId) `await sessionStore.deleteSession(sid)` 各(级联 rm 目录+cron) → ③ `await squadStore.deleteSquad(id)`(删 record) → ④ `rmSync(squadRootDir(dataDir,id),{recursive,force})`(删办公室目录) | MUST 顺序不可颠倒（teardown 先于删数据，防潜伏调度）；MUST 用 squadRootDir 不字面拼 `~`（BUG-004 护栏） | research §硬删执行顺序；漂移#5；原则打包护栏#4 | +55 |
| squad handler | app/server/src/handlers/squad.ts | handleDeleteSquad | 新增 | `DELETE /squad/:id`：校验 squad 存在(404)→ makeStores → `dissolveSquad({squadId, squadRuntime, sessionStore, squadStore, memberStore, dataDir})` → 200 `{deleted:true}` | MUST 404 when not found；MUST 调 dissolveSquad 不内联编排 | 11a-endpoints(新增)；design-plan §块②.3 | +22 |
| squad handler | app/server/src/handlers/squad.ts | handleSquadRoute | 修改 | `/squad/:id` 分支加 `method==='DELETE'` → handleDeleteSquad；405 Allow 头加 `DELETE`；文件头注「无 DELETE / squad 不可删」表述改（doc-modifier 最终核对） | MUST 保持既有 GET/PATCH 分支 | design-plan §块②.3 | +4/-2 |
| UI api | app/web/src/lib/squad-api.ts | deleteSquad | 新增 | `req(/squad/${id}, {method:'DELETE'})` → Promise\<void\>（透传 status） | MUST 复用 `req<T>` 封装 | design-plan §块②.4 | +5 |
| UI | app/web/src/components/studio-page/component-squad-delete.tsx | SquadDeleteSection | 新增(文件+组件) | 危险操作区：删除按钮 + ModalShell 二次确认（输入框 == 队名 才启用「确认删除」）；确认调 props.onDelete | MUST 复用 ModalShell；输入≠队名时确认按钮 disabled；条件内容用 visibility 不改尺寸 | design-plan §块②.4；component-modal-shell.tsx | +88 |
| UI | app/web/src/components/studio-page/component-manage-tab.tsx | ManageTab | 修改 | props 加 `onDelete`；底部渲染 `<SquadDeleteSection squadName={detail.name} onDelete={onDelete} />` | MUST NOT 改现有 onSaveMeta/onSaveCharter | design-plan §块②.4 | +6/-1 |
| UI | app/web/src/components/studio-page/section-squad-panel.tsx | SquadPanel / SquadPanelProps | 修改 | SquadPanelProps 加 `onDelete`；透传给 ManageTab（line 73） | MUST 仅透传，不在此实现删除逻辑 | 漂移#10 | +2/-1 |
| UI | app/web/src/components/studio-page/page-studio.tsx | onDelete 回调 wiring | 修改 | 提供 onDelete 给 SquadPanel：调 `squad-api.deleteSquad(id)` → 成功后从 `squads` 移除 + `setSelectedSquadId(null)`(切走) + reloadSquads | MUST 删成功后无「已删团队/历史」入口（硬删不留） | design-plan §块②.4；research §前端 | +12 |

### 块④ reminder 团队 workspace

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| reminder | app/plugins/builtins/rocky_context/reminder/squad_workspace.ts | SquadWorkspaceReminderProvider（default export class） | 新增(文件) | `provide(ctx)`：`readSessionType(ctx)∈{leader,mate}` 否则 `[]`；`teamRoot=path.join(config.dataDir,'squads',config.squadId)`；缺 dataDir/squadId → `[]`；产出 `[{id:'squad_workspace',tier:'info',content:'Team workspace: '+teamRoot}]`；构造器 `(implId,cfg)` | MUST 不去重（路径静态，交 dedup reducer）；MUST NOT 塞进个人 workspace.ts（单一职责）；readSessionType 从 `../prompt/squad_reminder_shared` import | design-plan §块④；漂移#9；system_reminder EP；squad_charter.ts:64 | +52 |
| reminder | app/plugins/builtins/rocky_context/plugin.json | impls[] squad_workspace 注册块 | 新增 | 加 `{implId:'squad_workspace', point:'system_reminder', impl:'./reminder/squad_workspace.ts', description:'__MSG_...squad_workspace.description__'}`（镜像 squad_board 块 :260-263） | MUST 结构与既有 system_reminder impl 块一致 | design-plan §块④；plugin.json:260 | +6 |

## 影响面评估

- **跨模块**：块①=board-archive(store 派生) + reminder providers(plugin) + tools(agent) + board-read(HTTP) + 2 UI view；块②=agent-manager + squad-runtime + 新 squad-dissolve service + squad handler + 3 UI；块④=1 新 plugin provider + plugin.json。
- **依赖顺序**：`board-archive.effectiveCancelled`（底层派生）必须先落，reminder/tools/board-read 三处消费方才能编译。块② `abortSession`→`disposeSquad`→`dissolveSquad`→handler 自底向上。
- **破坏性**：GET /board 不再返 cancelled 项、工具 query 默认不返 archived/cancelled（行为变更，属修 bug 对齐契约）；`DELETE /squad/:id` 为**不可逆硬删**（session+历史物理删）——AT 用临时 squad 验证，勿删真实数据。
- **风险点**：(a) 块② teardown 顺序错 → 潜伏调度残留（约束已钉死）；(b) abortSession 依赖 currentRunId 快照，并发 run 期间 abort 属 best-effort，disposeSquad 后续 deleteSession 会最终清干净；(c) reminder providers 属 plugin，改动需能被 `build-plugins.ts` 编译进 asar（无新第三方依赖，squad_workspace 与 squad_board 同构，无打包新增风险）；(d) i18n 新 key 缺失只降级为占位符，不阻断。
- **概念-spec 一致**：新增 effectiveCancelled / disposeSquad / dissolveSquad / squad_workspace 均属新概念，doc-modifier 阶段 5 须补入对应 tech KB（见「新概念」小节），否则 spec 落后于代码。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder。
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
- coder 按代码实际调整（spec/change_plan 漂移）须向 orchestrator 汇报偏离 → 记 doc-sync 待办 → doc-modifier 阶段 5 统一对齐。

