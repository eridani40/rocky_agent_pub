# v0.0.117 — Tech Change Log（board 管理实体四面对齐：存储 ↔ HTTP ↔ UI ↔ agent tools）

> 跨版本发布说明（版本轴）。本目录级变更见 `specs/tech/squad/log.md`（位置轴）。
> method 级冻结契约见 `specs/tech/version_logs/v0.0.117/change_plan.md`；本文记实现相对 change_plan 的偏差 + 落地事实。

## 概览

board 每个实体的字段/action 补齐到已声明的 spec 全表，达成**四面对齐 invariant**（`index.md ④#16`）：store ↔ HTTP API ↔ UI（列表+编辑）↔ agent tools（读+写）。核心是「代码补齐到已有 spec 声明」——`squad_tools.md §3/§4/§5` + `squad_store_projection.md §1` 早已声明 edit/archive/restore/duplicate/body/priority/deadline，实现落后。触发 bug = Goal.description 列表渲染但编辑弹层缺字段（所见不即所得）。

## §1 store / health 共享派生

### 1.1 `applyKrPatchWithHealth`（agent==HTTP 两通道唯一 health 编排入口）

抽单一共享编排函数消除双实现：KR 编辑（改 current/target/deadline/status 任一）时重算 KR health + 联动父 goal health。agent `goal.edit` KR 分支与 HTTP `PATCH /krs/:kid` 两通道复用它，禁各自 inline 重算（否则算法漂移=脏 health）。→ `[P1]squad_tools.md §4.1`、`[P1]squad_workitems.md §2.2`

**偏差（相对 change_plan A 段）**：change_plan A 段写函数落 `app/server/src/stores/board-shared.ts`（与 `deriveKrHealth`/`deriveGoalHealth` 同文件）。**实际落 `app/server/src/handlers/board-shared.ts`**（board handlers 共享层）——`deriveKrHealth`/`deriveGoalHealth` 定义在 `stores/board-shared.ts` 并经 `stores/board-store.ts` barrel re-export，`applyKrPatchWithHealth` 从 `../stores/board-store` import 复用。理由：该函数是 handler + agent-tool 两个消费方的编排层，放 handlers 共享层符合调用方向（store 层不反向依赖 handler 语义）。orchestrator 已裁决，spec §4.1 落法句已改到 `handlers/board-shared.ts`。

### 1.2 HTTP PATCH requirement 补 raisedBy + triage

`board-write-req.ts.pickRequirementPatch` 补收 `raisedBy`（`Partial<CreateRequirementBody>` 早声明，实现漏读 = 静默单面缺失）；`doPatchRequirement` 编排 triage：仅 pending 可 triage（非法 → `400 illegal_triage`），联动 status（accept→pending / defer,reject→cancelled）。promote 决策不经 HTTP（交 agent）。→ `specs/api/overall/11b-squad-workitems.md §3.5.1/§3.6`

## §2 agent 工具补齐（goal / requirement / task / team）

### 2.1 三工具补 edit / archive / restore（+task duplicate）+ create 字段

- **goal-tool**：GOAL_ACTIONS 补 archive/restore；create_objective/create_kr 补传 body（KR 加 deadline）；filterGoalPatch 白名单加 body；`runEdit` KR 分支改调 `applyKrPatchWithHealth`（含 body/deadline/status/current 全字段 + health 重算；status 走 `isWorkStatus`+`isLegalWorkTransition` 状态机校验，非法 → `illegal_transition`）；runArchive/runRestore self-only 不级联。
- **requirement-tool** / **task-tool**：补 edit/archive/restore（task 另补 duplicate）+ create 字段（req body / task priority·deadline·body，修 S1-3 静默丢弃）。
- **team-tool**：query 去 dead 字段 `tools`（v0.0.48 已死）+ 补只读 `intro`（不开 member 写面，v3 保留）。

**偏差（拆分落地）**：
- `task-tool.ts`（现 271 行 + ~85 必超 300）→ runEdit/runDuplicate/runArchive/runRestore 抽 `task-tool-actions.ts`（change_plan B3 预案内）。
- `requirement-tool.ts`（临界）→ runEdit/runArchive/runRestore 抽 `requirement-tool-actions.ts`（change_plan B2「超则拆」触发）。
- **task.duplicate 不复制 `body`**：`runDuplicate` 的 `createTask` 仅传 source/assignee/deadline，不传 body（副本仅复制骨架，正文 leader 重写）。与 spec §3 duplicate 复制规则一致（本次 spec 补明「不复制 body」消歧）。
- **requirement.edit relatedKRId 坏链校验精度有限**：无独立 `getKr`，实现用 `board.getGoal(krId)` 探测——krId 是 KR id（`KR-xxxx`）非 goal id，对合法 KR 也常 miss → `console.warn` 可能误报。仅日志提示，**不阻断写入、不影响落库正确性**（坏链容忍是设计）。spec §5 edit 行已如实标注。

### 2.2 query `detail?` 读面（agent 按需拉长文本）

三工具 query 加 boolean 参数（goal/task 用 `detail?`；requirement 用 `withDetail?` 消歧 create 的 `detail:string` 同名冲突，task4 定案）。默认 false 返精简摘要（现状不变，向后兼容）；true 返长文本 + KR 明细。reminder 不注入长文本（token 成本，四面对齐 invariant 下的有意豁免）。→ `[P1]squad_tools.md §8.5`

## §3 前端 UI（弹层 status/摘要/triage + 清空语义 + 卡片展示）

### 3.1 status 下拉——前端全 5 态不过滤（服务端 400 兜底）

`StatusField`（`component-board-edit-fields-status.tsx`）的 `STATUS_OPTIONS` 固定 WorkStatus 全 5 态，**前端不预判状态机过滤**、不裁剪当前态可跃迁项；合法性由服务端强校验，非法跃迁 → `400 illegal_transition`（前端 toast）。用 `BoardSelector`（`forceDropdown`，禁原生 select）。

**spec 对齐（doc-sync 核实定案）**：`component-board-edit-fields.md §StatusField` 口径「全 5 态、前端不过滤」== 代码，为权威源。`component-board-entity-modal.md` 与 `squad-board.md` 原写「按 WorkStatus 状态机当前态可跃迁项过滤」**与代码矛盾**，本次改齐到「全 5 态不过滤 + 服务端 400 兜底」。ET 归因记录里的「按状态机过滤选项」是误述——ET 修复实测走「合法跃迁链」是为避开服务端 400，非前端过滤。

> **agent 通道 vs 前端通道的 status 校验分层**：agent `goal.edit` KR status **在工具层做状态机校验**（`isLegalWorkTransition`，非法即拒）；前端 StatusField **不做**任何过滤/校验（交服务端）。两层策略不同但都正确——记录清楚避免混淆。

### 3.2 清空语义（全实体统一，空串=显式清空）

`use-board-edit-form.ts.handleSubmit`：可空文本字段（body/description/detail/unit/deadline/owner/assignee）dirty 检测（当前值 ≠ initial snapshot）才进 patch，进 patch 传当前值（含空串/null=清空）。旧「空值跳过」（`if(unit)/if(deadline)`）作废。owner/assignee 同走 dirty 检测（`if(owner !== snap.owner)`）。清空后 readback 可能返空串或 null（两者均表「已清空」，消费方同等对待）。→ `11b §3.5` 清空语义注 + `component-board-entity-modal.md §清空语义`

### 3.3 卡片展示 + triage 决策区

- task-card 补 reason（blocked/cancelled 时）+ deadline；KrRow 补 status badge + deadline（此前 KrRow 不渲染 status → KR 恒显 pending 不可辨）。KrRow status/deadline/owner 三项合并为底部单个 `flex flex-wrap` 元信息行（testid 各自不变）。
- Requirement 弹层加 `TriageField`（accept/defer/reject + reason，仅 pending 渲染，不含 promote）+ `DetailField`（detail 摘要，复用 Goal DescriptionField 样板）。

## §4 spec↔code 对齐结论（doc-modifier 核实）

- 四面对齐 invariant `index.md ④#16` 已落，本版本全部按其补齐，无静默单面演进。
- 已核实无实现偏离 spec 契约的死代码：agent status 状态机校验真实生效、health 两通道复用同一函数、query detail 默认形态向后兼容、PATCH triage illegal_triage 兜底真实。
- 修正的 spec↔code 偏离（本次对齐）：① `applyKrPatchWithHealth` 文件路径 `stores/`→`handlers/`；② status 下拉「状态机过滤」→「全 5 态不过滤」（entity-modal.md + squad-board.md 对齐 edit-fields.md == 代码）；③ duplicate 不复制 body（spec 补明）；④ relatedKRId 坏链校验精度有限（spec 如实标注）。
