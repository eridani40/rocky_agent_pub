# v0.0.111 change_log — 工作项三态可见性 + team 硬删除 + reminder 团队 workspace

> 版本轴发布说明（跨版本）。位置轴变更见 `specs/tech/squad/log.md`。
> 权威设计：`change_plan.md`（method 级合同）+ `states/v0.0.111.workitem_visibility/design-plan.md`（用户确认）。

## 块① 工作项三态可见性（active / archive / cancel × reminder/工具/UI）

**新概念**：`effectiveCancelled` 派生 + cancel 联合检查（cancel 优先级最高：任一祖先 `status==='cancelled'` → 后代三通道全不可见）；三态×三通道可见性矩阵。

- **`board-archive.ts`**（cancel 级联单一权威）：`krAncestors/reqAncestors/taskAncestors` 祖先链元素 `{archived}`→`{archived,cancelled}`；新增 `readSelfCancelled`（四 kind switch 闭合）+ `effectiveCancelled(entity, view)`（镜像 `effectiveArchived`，看 `status`）。导出供 reminder/tools/board-read 复用（禁本地判 status）。
- **reminder**（`squad_reminder_shared.ts`）：`filterReadableBoard`/`isTaskReadable` 在 `readable==true` 上叠加 `!effectiveCancelled`；`squad_board.ts.formatBoardReminder` 渲染 KR 前过滤 `k.archived || k.status==='cancelled'`。
- **工具 query**（`goal/requirement/task-tool.ts.runQuery`）：`buildAncestorView` 后默认滤 `effectiveArchived ∨ effectiveCancelled`；`filter.includeArchived===true` 保留 archive 仍滤 cancel。inputSchema 加 `includeArchived: boolean`。修 v0.0.60 现状 bug（query 曾不 filter）。
- **board-read.ts**（HTTP）：三段在 `.map(toXItem)` 前 `.filter(!effectiveCancelled(ent, view))`（cancelled 不进任何 zone），再 `zoneFilter` 分 active/archive。响应 schema 不新增 effectiveCancelled 字段。
- **UI**：`component-board-tasks-view.tsx` COLUMNS / `component-board-requirements-view.tsx` STATUS_GROUPS 移除 `'cancelled'`（后端不返）；`component-board-task-card.tsx` 归档区「因 parent 归档」标注（`squad-board-task-{tid}-archived-by-parent`）。

**spec 同步**：`[P1]squad_archive.md §1/§3/§4`；`11b-squad-workitems.md §4.1`；`[P1]squad_tools.md §0/§3`；`squad-board.md`/`06-studio.md`（coder 已改，doc 核对）。

## 块② team 硬删除（teardown → 删 session → 删数据）

**新概念**：`SquadRuntime.disposeSquad` per-squad 运行时 teardown + `dissolveSquad` 硬删编排（teardown 先于删数据，防潜伏调度）。

- **`agent-manager.ts.abortSession(sid)`**（新增）：读 `session.currentRunId` → `abort(sid, runId, MODE_KEY_CURRENT)`；封装 mode-key 不外泄；幂等。
- **`squad-runtime.ts.disposeSquad(squadId)`**（新增 public）：枚举会话 → `abortSession` 各会话 → `unregisterHeartbeatJobs`（复用私有）→ 停 file-watcher → 清 `ensuredSquads`/`schedulerFacades`；MUST NOT `engine.stop`（进程单例）。
- **`squad-dissolve.ts.dissolveSquad`**（新文件）：① `disposeSquad` → ② 枚举会话 `deleteSession`（级联 rm 目录+cron）→ ③ `deleteSquad`（删 record）→ ④ `rmSync(squadRootDir)`（删办公室目录）。顺序不可颠倒。
- **`handlers/squad.ts`**：`DELETE /squad/:id` handler（404 not found → dissolveSquad → 200 `{deleted:true}`）；`SquadRuntimePort` 加 `disposeSquad`。
- **UI**：`squad-api.ts.deleteSquad` + `component-squad-delete.tsx`（危险操作区 + 输队名二次确认）+ `component-manage-tab`/`section-squad-panel`/`page-studio` onDelete 透传（删成功后移除 sidebar + 切走选中）。
- 附带修 **BUG-001**（`board-write-goal.ts` doCreateGoal 位置猜回执 → 用 createGoal 返回值）。

**spec 同步**：`[P1]scheduler.md §9`；`[P1]data_model.md §1.1`；`11a-squad-endpoints.md §1.5`（DELETE 新增）；`06-studio.md`/`component-squad-delete.md`；schema_defs/squad/squad.ts + heartbeat-adapter.ts 注释「squad 不可删」改为可硬删。

## 块④ reminder 团队 workspace

- **`reminder/squad_workspace.ts`**（新文件）：`SquadWorkspaceReminderProvider`——leader/mate 产出 `Team workspace: <dataDir/squads/squadId>`，缺 dataDir/squadId 返 `[]`；与个人 `workspace.ts` 并存（单一职责）；不去重（静态路径交 dedup reducer）。
- **`plugin.json`**：注册 `system_reminder` EP impl `squad_workspace` + i18n key。

**spec 同步**：`[P1]squad_reminder_providers.md §4.5/§6/§12`。

## 代码-spec 一致性核对结论

逐项核对 coversFiles 实现 == spec 契约，全部一致，无代码偏离 spec 需修正：
- `effectiveCancelled` 确为 cancel 级联单一权威，被 reminder/tools/board-read 三通道复用（非各自本地判 status）。
- `dissolveSquad` 顺序确为 teardown→deleteSession→deleteSquad→rmSync（会话 ID 在删 record 前快照）。
- `abortSession` 确封装 `MODE_KEY_CURRENT`（agent-run-registry 导出 `'current'`）。
- 三工具 query 确用 `includeArchived` 参数 + `buildAncestorView` 后默认滤 archived∨cancelled。
- board-read 确在 zone 过滤前先滤 effectiveCancelled。
