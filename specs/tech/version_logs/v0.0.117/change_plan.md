# v0.0.117 变更计划书 — board 管理实体四面对齐（存储 ↔ UI ↔ agent 工具）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **核心原则（`index.md ④#16` 四面对齐 invariant）**：每个 board 实体字段/action 须 store ↔ HTTP API ↔ UI ↔ agent tools 四面同步，与 spec 一致。本版本是**代码补齐到已有 spec 声明**（`squad_tools.md §3/§4/§5` + `squad_store_projection.md §1` 早已声明 edit/archive/restore/duplicate/body/priority/deadline，实现落后）——多数 store 方法已支持字段（`createTask/createGoal/createRequirement` 皆收 body/priority/deadline），缺的是**工具 schema 声明 + handler 传参 + query 返回 + UI 编辑入口**。
>
> **新概念先落 spec 已完成**：query `detail?`（`squad_tools.md §8.5`）+ health 共享派生 invariant（§4.1）+ status/triage/detail UI 字段（`component-board-entity-modal.md`）+ 清空语义（同前）+ squad-board.md 自相矛盾修正。
>
> **数据 hook 说明**：本版本无新增/修改**数据生命周期 hook**（`use*` topic 订阅）。`use-board-edit-form` 是**纯表单 state hook**（非 data-lifecycle），board 数据仍走 SquadBoard 既有 `GET /board`——故不触发「组件-数据源拆解表」pre-coding 门禁。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统（board-ui / board-http / agent-tool / store / api-client） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | 依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

---

## A. store 层（health 共享派生 — 消除双实现，S1-5）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| store | app/server/src/stores/board-shared.ts | applyKrPatchWithHealth() | 新增 | 输入 `(goal, krId, krPatch, now)`，内部：① 定位并 merge KR 字段；② patch 触及 current/target/deadline/status 任一 → `deriveKrHealth(mergedKr, now)`；③ `deriveGoalHealth(nextKrs)` 重算父 goal health；④ 返回 `{ nextKrs, goalHealth }`（不落盘）。现无此符号，本行新增（抽 `board-write-goal.ts.doPatchKr` 现有 inline 逻辑为共享） | MUST 复用现有 `deriveKrHealth`/`deriveGoalHealth`（同文件已 export）；MUST NOT 落盘（caller 负责 updateGoal）；MUST 是 agent+HTTP 两通道唯一 health 编排入口 | squad_tools.md §4.1；squad_workitems.md §2.2；index.md ④#16 | +28 |

---

## B. agent 工具层（补 edit/archive/restore/duplicate + create body/priority/deadline + query detail + health 重算）

### B1. goal 工具（goal-tool.ts）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-tool | app/server/src/agent/tools/goal-tool.ts | GOAL_ACTIONS | 修改 | 补 `archive`/`restore`（现有 create_objective/create_kr/update_progress/edit/set_status/query，缺 archive/restore） | MUST 与 squad_tools.md §4 表一致 | squad_tools.md §4 | +1 |
| agent-tool | app/server/src/agent/tools/goal-tool.ts | goalTool.definition.inputSchema.properties | 修改 | 补 flat 顶层 `body`（create_objective/create_kr 用）+ `archivedBy`（archive 用）+ `detail`（query 用 boolean）；`patch` description 补 body/deadline/status（KR） | MUST schema 声明 handler 实读的每个 flat 字段（承诺即真收，§0）；schema-handler 一致由 squad-tool-schema.test.ts 兜底 | squad_tools.md §0/§4/§8.5；index.md ④#7 | +4 |
| agent-tool | app/server/src/agent/tools/goal-tool.ts | runCreateObjective() | 修改 | createGoal 调用补传 `body`（store 已收，line 138 附近仅传 description）；krs[] 已经 parseKrs 带 body | MUST NOT 丢 input.body | squad_tools.md §4；审计 S3-13 | +2 |
| agent-tool | app/server/src/agent/tools/goal-tool.ts | runCreateKr() | 修改 | addKr 调用补传 `body`/`deadline`（store `addKr` 已收） | MUST NOT 丢 body/deadline | squad_tools.md §4；审计 S3-13 | +2 |
| agent-tool | app/server/src/agent/tools/goal-tool.ts | filterGoalPatch() | 修改 | 白名单补 `body`（现仅 title/description/ownerMemberId） | MUST 只加 body（goal 无 status/deadline，KR 才有） | squad_tools.md §4；审计 S3-11 | +2 |
| agent-tool | app/server/src/agent/tools/goal-tool.ts | applyKrPatch() | 修改/删除 | 现 mutate title/target/unit/ownerMemberId。**改为不再单独 mutate**——runEdit 的 KR 分支改调 `applyKrPatchWithHealth`（含 body/deadline/status/current 全字段 + health 重算）；本函数可保留为纯字段 merge（供 applyKrPatchWithHealth 内部复用）或删除并入 shared | MUST KR.edit 支持 body/deadline/status/current/target（此前缺）；status MUST 走 WorkStatus 状态机校验（illegal_transition） | squad_tools.md §4/§4.1；审计 S1-5/S3-11 | +6/-4 |
| agent-tool | app/server/src/agent/tools/goal-tool.ts | runEdit() | 修改 | KR 分支改调 `applyKrPatchWithHealth(goal, krId, patch, now)` → `updateGoal(goalId, {krs, health})`（health 重算联动父 goal，修 S1-5 双通道不一致）；goal 分支用扩后 filterGoalPatch（含 body） | MUST NOT 走 updateGoal 不派生 health 的旧路径；MUST 与 HTTP doPatchKr 复用同一 shared 函数 | squad_tools.md §4.1；squad_workitems.md §2.2；index.md ④#16 | +14/-4 |
| agent-tool | app/server/src/agent/tools/goal-tool.ts | runArchive() | 新增 | archive action：goal/KR archive（archived=true + archivedAt + archivedBy）；只改自身不级联 | MUST self-only（联合检查模型）；MUST NOT 级联子 | squad_tools.md §4；squad_archive.md §1 | +20 |
| agent-tool | app/server/src/agent/tools/goal-tool.ts | runRestore() | 新增 | restore action：goal/KR restore（archived=false + 清 archivedAt/archivedBy） | MUST self-only | squad_tools.md §4；squad_archive.md §1 | +16 |
| agent-tool | app/server/src/agent/tools/goal-tool.ts | runQuery() | 修改 | 加 `detail` 分支：`input.detail===true` → goal 返 description/body + krs[] 明细（id/title/current/target/unit/status/health/deadline/body/ownerMemberId）；默认走现有 summaryGoal 精简 | MUST detail!==true 时返回形态与现状完全一致（向后兼容 AT） | squad_tools.md §8.5；PRD §5.4 | +14 |
| agent-tool | app/server/src/agent/tools/goal-tool.ts | summaryGoal() | 保留 | detail=false 分支复用（不改） | — | squad_tools.md §8.5 | 0 |
| agent-tool | app/server/src/agent/tools/goal-tool.ts | run() dispatch | 修改 | run() 内 action 分派补 archive/restore 路由 | MUST 权限 leader/user（archive/restore leader only） | squad_tools.md §4 | +4 |

### B2. requirement 工具（requirement-tool.ts）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-tool | app/server/src/agent/tools/requirement-tool.ts | REQ_ACTIONS | 修改 | 补 `edit`/`archive`/`restore`（现 create/triage/promote_to_goal/set_status/query） | MUST 与 squad_tools.md §5 表一致 | squad_tools.md §5；审计 S3-11/S3-12 | +1 |
| agent-tool | app/server/src/agent/tools/requirement-tool.ts | requirementTool.definition.inputSchema.properties | 修改 | 补 flat 顶层 `body`（create 用）+ `patch`（edit 用 object，含 title/detail/body/raisedBy/relatedKRId）+ `archivedBy` + `detail`（query 用 boolean，注意与 create 的 detail 字段名冲突——query 复用同一 boolean 名歧义，改用独立键或 handler 按 action 区分：**coder 定位**，倾向 query 用 `detail:boolean` + create 需求详情改由 patch/独立字段区分） | MUST schema 声明 handler 实读 flat 字段（§0）；MUST 消除 create-detail(string) vs query-detail(boolean) 命名冲突 | squad_tools.md §0/§5/§8.5；index.md ④#7 | +5 |
| agent-tool | app/server/src/agent/tools/requirement-tool.ts | runCreate() | 修改 | createRequirement 调用补传 `body`（store 已收，line 128 附近仅传 detail/relatedKRId） | MUST NOT 丢 input.body | squad_tools.md §5；审计 S3-13 | +2 |
| agent-tool | app/server/src/agent/tools/requirement-tool.ts | runEdit() | 新增 | edit action：patch 覆盖 title/detail/body/raisedBy/relatedKRId + lastWriteMessageId；改 relatedKRId 校验 KR 存在（坏链容忍 warn）；调 updateRequirement | MUST leader only；MUST NOT 改 status（status 走 set_status） | squad_tools.md §5；审计 S3-11 | +18 |
| agent-tool | app/server/src/agent/tools/requirement-tool.ts | runArchive() | 新增 | archive action：archived=true + archivedAt + archivedBy；self-only | MUST self-only | squad_tools.md §5；squad_archive.md §1 | +14 |
| agent-tool | app/server/src/agent/tools/requirement-tool.ts | runRestore() | 新增 | restore action：archived=false + 清归档字段 | MUST self-only | squad_tools.md §5；squad_archive.md §1 | +12 |
| agent-tool | app/server/src/agent/tools/requirement-tool.ts | runQuery() | 修改 | 加 detail 分支：detail=true → 追加 detail/body/triage（现返 id/title/status/raisedBy/relatedKRId） | MUST detail!==true 时形态不变（向后兼容） | squad_tools.md §8.5；PRD §5.4 | +8 |
| agent-tool | app/server/src/agent/tools/requirement-tool.ts | run() dispatch | 修改 | 补 edit/archive/restore 路由 + LEADER_ONLY_ACTIONS 加 edit/archive/restore | MUST 权限 leader only（edit/archive/restore） | squad_tools.md §5 | +5 |

> **300 行拆分（requirement-tool.ts 现 235 行，+~65 行后约 300）**：临界。若超 300，把 runEdit/runArchive/runRestore 三个新 handler 抽到 `requirement-tool-actions.ts`（同目录同模式），主文件 import。**coder 按实际行数定**（超则拆，不超则内联）。

### B3. task 工具（task-tool.ts）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-tool | app/server/src/agent/tools/task-tool.ts | TASK_ACTIONS | 修改 | 补 `edit`/`archive`/`restore`/`duplicate`（现 create/assign/claim/update_status/query） | MUST 与 squad_tools.md §3 表一致 | squad_tools.md §3；审计 S3-11/S3-12 | +1 |
| agent-tool | app/server/src/agent/tools/task-tool.ts | taskTool.definition.inputSchema.properties | 修改 | 补 flat 顶层 `priority`/`deadline`/`body`（create 用，**description 已承诺 priority?/deadline? 却缺 schema — S1-3 核心 bug**）+ `patch`（edit 用 object）+ `archivedBy` + `detail`（query 用 boolean） | MUST schema 声明 handler 实读的每个 flat 字段（承诺即真收，§0）；schema-handler 一致由 squad-tool-schema.test.ts 兜底 | squad_tools.md §0/§3/§8.5；index.md ④#7；审计 S1-3 | +5 |
| agent-tool | app/server/src/agent/tools/task-tool.ts | runCreate() | 修改 | createTask 调用补传 `priority`/`deadline`/`body`（store `createTask` 已收 line 44-52，工具 line 148-153 不传 → 恒 priority=none/无 deadline） | MUST NOT 静默丢 priority/deadline/body（承诺即真收） | squad_tools.md §3；审计 S1-3 | +4 |
| agent-tool | app/server/src/agent/tools/task-tool.ts | runEdit() | 新增 | edit action：patch 覆盖 title/body/priority/deadline/source/assignee/dependsOn + lastWriteMessageId；mate 限字段子集（title/body/priority/deadline，不改 source/assignee）；改 source 校验 requirementId（坏链 warn）；调 updateTask | MUST mate 仅自己 task 字段子集；leader 任意；MUST NOT 改 status（走 update_status） | squad_tools.md §3；审计 S3-11 | +26 |
| agent-tool | app/server/src/agent/tools/task-tool.ts | runDuplicate() | 新增 | duplicate action：建 new Task title="{原} 副本"、source/assignee/deadline 同步、status=pending、priority=none、dependsOn=[]、新 id | MUST leader only；MUST NOT 复制 dependsOn；status/priority 强制重置 | squad_tools.md §3；审计 S3-12 | +18 |
| agent-tool | app/server/src/agent/tools/task-tool.ts | runArchive() | 新增 | archive：archived=true + archivedAt + archivedBy；self-only | MUST self-only；mate 仅自己 task | squad_tools.md §3；squad_archive.md §1 | +16 |
| agent-tool | app/server/src/agent/tools/task-tool.ts | runRestore() | 新增 | restore：archived=false + 清归档字段 | MUST self-only；mate 仅自己 task | squad_tools.md §3；squad_archive.md §1 | +12 |
| agent-tool | app/server/src/agent/tools/task-tool.ts | runQuery() | 修改 | 加 detail 分支：detail=true → 追加 priority/deadline/body/reason（现返 id/title/status/assignee/source/dependsOn） | MUST detail!==true 时形态不变（向后兼容） | squad_tools.md §8.5；PRD §5.4 | +8 |
| agent-tool | app/server/src/agent/tools/task-tool.ts | run() dispatch | 修改 | 补 edit/duplicate/archive/restore 路由 + 权限（create/assign/duplicate leader only；edit/archive/restore mate 仅自己） | MUST 权限按 action 校验 | squad_tools.md §3 | +8 |

> **300 行拆分（task-tool.ts 现 271 行，+~85 行必超 300）**：MUST 拆。方案：新 handler（runEdit/runDuplicate/runArchive/runRestore）抽到 `task-tool-actions.ts`（同目录），主 `task-tool.ts` import + dispatch。既有 create/assign/claim/update_status/query 留主文件。

### B4. team 工具（team-tool.ts）— 小项

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent-tool | app/server/src/agent/tools/team-tool.ts | runQuery() | 修改 | query 返回去 dead 字段 `tools`（m.tools，v0.0.48 已死）+ 补 `intro`（m.intro，只读） | MUST NOT 加 member 写面（v3 保留，本版本仅只读 intro）；MUST 去 tools（dead field 不暴露） | squad_tools.md §2.2；审计 S3-15；index.md ④#8 | +1/-1 |

---

## C. HTTP handler 层（health 共享派生复用 + PATCH req 补 raisedBy/triage）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| board-http | app/server/src/handlers/board-write-goal.ts | doPatchKr() | 修改 | 现有 inline health 重算（line 118-131：判 current/target/deadline/status → deriveKrHealth + deriveGoalHealth）**替换为调 `applyKrPatchWithHealth`**（消除双实现，与 agent 通道复用同一函数） | MUST NOT 保留 inline 重算逻辑（删旧 map 分支）；MUST 结果与替换前一致（回归 UC-2/UC-10） | squad_tools.md §4.1；11b §3.2；index.md ④#16 | +6/-10 |
| board-http | app/server/src/handlers/board-write-goal.ts | import deriveKrHealth/deriveGoalHealth | 修改 | 若 doPatchKr 不再直接调 derive*，import 改为 `applyKrPatchWithHealth`（现从 '../stores/board-store' barrel import；确认 board-store barrel re-export 新函数） | MUST 确认 board-store barrel 导出 applyKrPatchWithHealth（否则改 import 源） | squad_tools.md §4.1 | +1/-1 |
| board-http | app/server/src/handlers/board-write-req.ts | pickRequirementPatch() | 修改 | 补收 `raisedBy`（{kind,id} 校验 kind∈user\|member；现漏收，违 11b §3.5）+ `triage`（{decision:accept\|defer\|reject, reason?}）；triage 仅 pending 可写（否则 400 illegal_triage），联动 status（accept→pending / defer,reject→cancelled） | MUST raisedBy 对齐 11b §3.5；MUST triage decision 不含 promote（HTTP 不给 promote）；MUST 仅 pending 可 triage | 11b §3.5/§3.5.1；审计 S3-15；PRD §4.5 | +14 |
| board-http | app/server/src/handlers/board-write-req.ts | doPatchRequirement() | 修改 | 若 triage 写入需前置校验（pending gate）+ 定序（先 triage+status 再叠加其余字段 patch），在此编排 | MUST triage 前置 pending 校验；非法 → 400 illegal_triage | 11b §3.5.1 | +8 |

---

## D. 前端 UI 层（弹层 status/摘要/triage 编辑 + 清空语义 + 卡片 reason/deadline/KR status 展示）

### D1. 表单 hook（use-board-edit-form.ts，现 170 行）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| board-ui | app/web/src/components/studio-page/use-board-edit-form.ts | UseBoardEditFormResult | 修改 | 加 `status`/`setStatus`（WorkStatus）、`statusReason`/`setStatusReason`、`detail`/`setDetail`（req 摘要）、`triageDecision`/`setTriageDecision`、`triageReason`/`setTriageReason` | MUST 全实体加 status（goal/kr/req/task）；detail 仅 req；triage 仅 req | component-board-entity-modal.md §Form state；PRD §3.2/§4.1/§4.5 | +12 |
| board-ui | app/web/src/components/studio-page/use-board-edit-form.ts | useBoardEditForm() 初始化 useEffect | 修改 | edit 模式载 status（全实体 snapshot.status）+ req.detail + reset triage（triage 不预填决策，仅 pending 显示）；create 模式默认 status=pending | MUST edit 载 snapshot.status；MUST NOT 预填 triageDecision | component-board-entity-modal.md §Form state | +10 |
| board-ui | app/web/src/components/studio-page/use-board-edit-form.ts | handleSubmit() | 修改 | ① **清空语义**：body/description/detail/unit/deadline/owner/assignee 改「dirty 才提交、空串=显式清空」（替换现有 `if(unit)/if(deadline)` 空值跳过）；② status 进 patch（选中即提交）+ blocked/cancelled 带 statusReason（task 用 reason 字段）；③ req triage 进 patch（triageDecision 非空时）+ triageReason | MUST 空串可清空（区分未改 vs 改空）；MUST NOT 沿用「空值跳过」；status 非法跃迁由服务端拒（前端不预判） | component-board-entity-modal.md §清空语义；squad-board.md §契约边界；PRD §3.4 | +18/-6 |

> **300 行拆分（use-board-edit-form.ts 现 170 行，+~34 行 → ~200）**：不超，内联。若清空语义引入逐字段 initial 快照追踪显著膨胀，可把 patch 组装抽 `buildBoardPatch(state, target)` 纯函数到同文件或 `board-patch.ts`——**coder 定位**。

### D2. 字段子组件（component-board-edit-fields.tsx，现 278 行）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| board-ui | app/web/src/components/studio-page/component-board-edit-fields.tsx | StatusField | 新增 | status 下拉子组件：接收 kind/id/value/onChange + 当前 status；选项按 WorkStatus 状态机可跃迁项过滤；选 blocked/cancelled 展开 reason 输入；用 component-board-selector（禁原生 select）；testid `-selector-status` + `-status-reason-input` | MUST 选项状态机过滤；MUST 禁原生 select（_conventions §10）；blocked/cancelled 才显 reason | component-board-entity-modal.md §status 字段；squad-board.md testid；PRD §2.3 | +40 |
| board-ui | app/web/src/components/studio-page/component-board-edit-fields.tsx | TriageField | 新增 | req triage 决策区子组件：accept/defer/reject 三选项 + reason；仅 status==='pending' 渲染；testid `-triage-{decision}` + `-triage-reason-input` | MUST 仅 pending 渲染；MUST NOT 含 promote 选项 | component-board-entity-modal.md §triage；PRD §2.4/§4.5 | +32 |
| board-ui | app/web/src/components/studio-page/component-board-edit-fields.tsx | DescriptionField | 修改 | 现为 Goal 专用；泛化支持 req detail（entity 参数区分 goal→description/req→detail 的 testid+label）；或复用现签名（已带 target 参数） | MUST 复用同一多行 textarea 样板；testid 按 entity 区分（description vs detail） | component-board-entity-modal.md §detail；PRD §3.2 | +6 |

> **300 行拆分（edit-fields.tsx 现 278 行，+~78 行必超 300）**：MUST 拆。方案：新增的 StatusField + TriageField 抽到 `component-board-edit-fields-status.tsx`（或按职责 `component-board-status-field.tsx` + `component-board-triage-field.tsx`），主 edit-fields.tsx re-export 或 entity-modal 直接 import 新文件。既有 TitleField/KrMetricFields/TaskFields/OwnerField/DescriptionField/Field 留主文件。**coder 按 _conventions §2 组件分层命名**。

### D3. 弹层组装 + 视图展示

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| board-ui | app/web/src/components/studio-page/component-board-entity-modal.tsx | BoardEntityModal render | 修改 | 全实体渲染 StatusField；req 渲染 DetailField（detail）+ TriageField；绑定 form 新 state | MUST status 全实体渲染；detail/triage 仅 req | component-board-entity-modal.md §字段集 | +14 |
| board-ui | app/web/src/components/studio-page/component-board-task-card.tsx | BoardTaskCard render | 修改 | 补渲染 reason（blocked/cancelled 时，灰底小字卡片底部，testid `-reason`）+ deadline（有则显，testid `-deadline`）；无值不占位/条件渲染 | MUST 布局稳定（无值不占位或固定，不因 hover 抖动）；MUST NOT 挤压相邻卡片 | squad-board.md v0.0.117 testid；PRD §4.3/§4.4 | +16 |
| board-ui | app/web/src/components/studio-page/component-board-goals-view.tsx | KrRow | 修改 | 补渲染 KR deadline（有则显，testid `-deadline`）+ status badge（testid `-status`，此前 KrRow 不渲染 status → KR 恒显 pending 不可辨） | MUST 布局稳定；有 deadline 才显 | squad-board.md v0.0.117 testid；PRD §4.2/§4.4 | +12 |

### D4. api-client（squad-api-board.ts）— 无 method 级变更

`patchGoal/patchKR/patchRequirement/patchTask`（line 38/53/77/98）**已 `JSON.stringify(body)` 泛型透传** patch 对象——status/statusReason/detail/triage 字段随 patch 透传，**无需改 helper**。此行仅声明「本文件无变更」，防 planner 误切 task。

---

## E. 前端组件 spec 清单（本版本涉及组件 — 归属 `studio-page/`）

> 归 `specs/ui/components/studio-page/`（squad board 一级目录）。架构师已改的 = 本版本已落；coder pre-coding 待补的 = 编码前置产出。

| 组件 spec | 层级 | 操作 | 状态 |
|---|---|---|---|
| `squad-board.md` | section | 修改 | ✅ 架构已改（字段表补 status/摘要/triage 修自相矛盾 + 清空语义契约 + v0.0.117 testid 表 + version 5.0） |
| `component-board-entity-modal.md` | component | 修改 | ✅ 架构已改（status/detail/triage 字段集 + 清空语义 + testid + version 1.2） |
| `component-board-edit-fields.md` | component | 新建 | ⏳ coder pre-coding 产出（现无此 spec，实现在 .tsx；本版本加 StatusField/TriageField + DescriptionField 泛化，coder 先补 spec 后实现，含 300 行拆分落地） |
| `component-board-task-card.md` | component | 新建 | ⏳ coder pre-coding 产出（现无此 spec；本版本加 reason/deadline 展示，coder 先补 spec 记渲染契约 + testid） |
| `component-board-goals-view.md` | component | 新建/可选 | ⏳ KrRow deadline/status 展示契约已在 squad-board.md testid 表落；若 coder 判需独立 spec 则补，否则沿用 squad-board.md 为宿主契约 |

---

## 影响面评估

- **跨模块**：store（1 新函数）→ agent-tool（3 工具大改 + 1 小改）+ board-http（2 handler）+ board-ui（hook + 字段子组件 + 弹层 + 2 视图）。api-client 无变更。
- **破坏性变更**：无。query `detail` 默认 false → 返回形态向后兼容（既有 AT 不破）；PATCH req 加 raisedBy/triage 是**加收字段**（旧调用不传则不影响）；health 共享派生替换后结果须与替换前一致（回归 UC-2/UC-10）。
- **依赖顺序**（底层先于上层）：
  1. `applyKrPatchWithHealth`（board-shared.ts）先落 + 确认 board-store barrel re-export。
  2. board-write-goal.ts.doPatchKr + goal-tool.ts.runEdit 各自改调 shared（依赖 1）。
  3. 其余 agent-tool（edit/archive/restore/duplicate/create 传参/query detail）+ board-write-req（raisedBy/triage）互相独立，可并行。
  4. 前端 hook + 字段子组件 + 弹层 + 视图（依赖 UI spec，已落）——独立于后端，可并行。
- **风险点**：
  - **schema-handler 一致性**（`index.md ④#7`）：三工具 inputSchema 补的每个 flat 字段（body/priority/deadline/patch/archivedBy/detail）**必须**在 handler 真读，`__tests__/squad-tool-schema.test.ts` 静态断言兜底——加字段务必同步 handler，否则 UT fail。
  - **requirement create-detail(string) vs query-detail(boolean) 命名冲突**：同一 inputSchema property 名 `detail` 两义（create 需求详情 string / query boolean）。coder MUST 消歧（query 用 boolean `detail`，create 需求详情已有 `detail:string` → 二者同名类型冲突）。**倾向**：query 参数改名（如 `withDetail:boolean`）或 create 详情字段保持 detail、query 用 detail 布尔靠 action 上下文区分——**coder 定位并汇报选择**。goal/task 无此冲突（create 无 detail 字段）。
  - **300 行硬约束**：task-tool.ts（必超，MUST 拆 `task-tool-actions.ts`）+ edit-fields.tsx（必超，MUST 拆 status/triage 子组件文件）+ requirement-tool.ts（临界，coder 定）。
  - **health 派生回归**：替换 doPatchKr inline 逻辑后 UC-2（KR current/target/deadline → health 动态）+ UC-10（agent==HTTP 一致）必须回归绿。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- **spec↔code 双向对齐**：本表基于 spec + 已核对代码符号（GOAL_ACTIONS/REQ_ACTIONS/TASK_ACTIONS 位置、deriveKrHealth/deriveGoalHealth 在 board-shared.ts、store create* 已收 body/priority/deadline、pickRequirementPatch 漏 raisedBy、team-tool 返 dead tools 缺 intro 均已 grep 确认）。coder 若发现符号漂移，按代码实际调整 + 汇报偏离，doc-modifier 阶段 5 统一修 spec。
