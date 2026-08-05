type: spec
title: squad-board — 看板 section（受控 tab + goals/requirements/tasks 三视图 + 弹层编辑 + 活跃/归档 zone）
priority: P1
status: active
updated: 2026-07-31
since: v0.0.33.3

## 职责
渲染 squad 工作项**可编辑看板**（受控嵌入全景固定 3 tab）：受控 `tab` prop 切换三视图 + 顶部单行 toolbar（+新建 X / task filter / zone switch / refresh）+ **统一弹层**（goal/KR/req/task edit + create 共用 `component-board-entity-modal`）+ Task 状态列分列（列内 priority→updatedAt 排序）+ 筛选器（all/req/kr）+ Task 复制 + 归档/恢复 + dependsOn 断链灰链 + 发现性提示条（祖先归档移入归档区的子项计数）。

**契约边界**：
- 全实体全字段可编辑（含 owner / 摘要 description·detail / body 正文 / 关联 / 状态 status / priority / deadline / Requirement triage）—— 直调 HTTP 写端点（POST/PATCH + archive/restore/duplicate），不依赖对话工具。
- **全实体清空语义**：编辑表单 patch 组装「dirty 才提交、空串=显式清空」——区分「未改动」（不进 patch）与「改为空」（进 patch 传空串/null）。契约详见 `component-board-entity-modal.md` §Form state 清空语义。
- 编辑感知：**下次启动重建**（写回 store + agent 下次启动 reminder 含最新），不引入实时 event 推送。
- 归档：**联合检查**（archive_self_only invariant）—— archive 只改自身 archived，子树通过 `effectiveArchived` 派生（响应层算，不落库）。

边界：tab 为受控 prop（调用方仅 panorama-route，本组件不持 tab state、不渲 sub-tab 栏）；持 zone/taskFilter/editing/creating state；数据 ctx=Snapshot<Board>，乐观 patch 走 useLifecycle.mutate，写后 reload 取响应层真值。

## Props
```ts
interface SquadBoardProps {
  squadId: string;
  /** 受控必填 tab——调用方仅 panorama-route */
  tab: 'goals' | 'requirements' | 'tasks';
  /** squad 成员字典（owner/assignee 字典解析） */
  members: Member[];
  /** +新建 入口回调（kind, parentGoalId?）；缺省 → +新建 按钮全隐藏（向后兼容） */
  onCreate?: (kind: BoardEntityKind, parentGoalId?: string) => void;
  /** 看板卡片 @ 按钮回调；缺省 → 所有 @ 按钮隐藏 */
  onAtMention?: (payload: BoardMentionPayload) => void;
}
```

组件内部 state：
- `zone`：活跃 | 归档（active 默认；archive 返 `effectiveArchived==true` 的项）
- `board`：GET `/squad/:id/board?view=all&zone={active|archive}` 一次拉全；tab/filter 切换本地切片或调 `?filter=reqId|krId|all` + `?sort=priority,updatedAt` 重拉
- `editing`：当前编辑实体 `EditTarget | null`
- `creating`：当前新建实体 `EditTarget | null`
- `taskFilter`：task tab 筛选状态（mode all/req/kr + value；独立于 editing/zone state）
- 失败 / 空 / 加载三态

## 状态 / 交互

### 顶部单行 toolbar（`component-board-toolbar`）
单行 `flex items-center justify-between`：
- **左组**（pinned left）：`+新建 X` 按钮 + task tab 时紧挨 `BoardTaskFilterBar`（随 OKR feature gate 隐藏——`isFeatureOkrOn()` 为 false 时整个筛选条不渲染，见 `specs/tech/app/[P1]feature_gate.md`）
- **右组**（pinned right）：`刷新` 按钮 + `ZoneSwitch`（活跃|归档 胶囊）
- **ArchiveNotice** 在 toolbar **下方** 独立渲染（不在 toolbar 内）—— 仅活跃区 + N≥1 时显示
- 三控件外框统一 `h-7`（28px）

详见 `component-board-toolbar.md`。

### 编辑/创建流程（弹层 — `component-board-entity-modal`）

**触发**：
- 编辑：user 点卡片编辑铅笔 → view 调 `onEdit({kind, id, parentGoalId?})` → SquadBoard `setEditing(target)` → modal `mode='edit'` 渲染
- 创建：user 点 toolbar `+新建 X`（或 KR 在 GoalCard 内 +新建 KR）→ `startCreateInternal` 调 `setEditing(null)`（互斥）+ `startCreate(kind, parentGoalId?)` → SquadBoard `setCreating(target)` → modal `mode='create'` 渲染；同时透传 `onCreate?.(kind, parentGoalId?)` 给父
- 关闭：取消按钮 / 遮罩点击 / 右上角 X → SquadBoard `setEditing(null)` / `cancelCreate()`

**字段集（create ↔ edit 完全一致）**：
| entity | 字段 |
|---|---|
| Goal | title / description（摘要） / body / owner / status |
| KR | title / current·target·unit / deadline / owner / body / status |
| Requirement | title / detail（摘要） / relatedKRId / body / status / triage 决策区 |
| Task | title / source / assignee / priority / dependsOn / deadline / body / status |

> - **status**：编辑弹层内下拉（`forceDropdown`），展示 WorkStatus 全 5 态、前端不过滤（非法跃迁服务端 `400 illegal_transition` 兜底，口径见 `component-board-edit-fields.md §StatusField`）；选 blocked/cancelled 展开 reason 输入。
> - **摘要**（Goal=description / Req=detail）：多行 `<textarea>`，在 title 后、body 前。
> - **triage 决策区**（仅 Requirement，仅 pending 可操作）：accept/defer/reject 三选项 + reason（promote 留 agent）。

字段控件类型：
- **关联字段** → `component-board-selector`（**禁原生 `<select>`** — `_conventions §10`）；task.source 走 `forceDropdown`（避免 ChoiceCards 撑高布局）
- **body 字段** → `component-board-body-editor`（markdown 编辑器）

**D1-b Task 强制先选父 Requirement**（仅 create）：submit 按钮 disabled until `form.source` 非空（文案「先选父 Requirement」）；edit 模式 source 来自 snapshot 不受限。

**提交**：
- edit → `handleSave(target, patch)` → 调对应 PATCH helper（`patchGoal/patchKR/patchRequirement/patchTask`）→ 乐观更新 board + 失败回滚 + toast
- create → `handleCreate(target, patch)` → 调对应 POST helper（`createGoal/createKR/createRequirement/createTask`）→ 乐观添加占位 + 失败回滚 + toast（成功后 reload 取响应层真值）

详见 `component-board-entity-modal.md`。

### 看板 @ 按钮 → leader 对话预填
每个 task/goal/kr/req 卡片 hover 显示 @ 按钮（共享组件 `component-board-at-button.tsx` `BoardAtMentionButton`）：onClick `onAtMention({type:'workitem', kind, id, label:entity.title})` → panorama-route 透传 → page-studio 解析 leader ChatNode + setMainView prefill → ChatComposer initialContent。
约束：仅活跃区 + 未归档项渲染；onAtMention prop 缺省 → 隐藏。

### 归档 zone + 发现性提示
- ZoneSwitch：active ↔ archive 切换（toolbar 右组）；切归档区调 `?zone=archive` 重拉。
- ArchiveNotice（活跃区，toolbar 下方独立渲染）：「N 项因祖先归档移入归档区 [查看]」—— self.archived=false 但 effectiveArchived=true 的项计数（N≥1 才显示）；[查看] 切归档区。
- 归档按钮：聚合节点（Goal/KR/Requirement）归档前若被活跃 task dependsOn → 反向提示「N 个活跃任务依赖它，归档后将断链，是否继续？」（确认框）。
- 恢复按钮（仅归档区显示）：聚合节点级联恢复从属（提示「恢复后将自动恢复 N 个子项」）；叶子（Task）恢复时向上检测祖先（若祖先 archived → 提示「它因 {祖先名} 归档而隐藏，需先恢复 {祖先名}」）。

### Task 看板视图
- **4 状态列**：pending / in_progress / blocked / done，列宽响应式 `min-w-[200px] flex-1`（窄屏最小 200px 横向滚动、宽屏平铺铺满，外层 `overflow-x-auto` 兜底；与全景 DSL kanban 列同一范式）。无 cancelled 列——后端 GET /board 不返 cancelled 项（effectiveCancelled 三通道全隐藏，cancel 终态不可恢复）。
- **归档区「因 parent 归档」标注**：归档区中被祖先归档拽入的子项（`effectiveArchived ∧ !self.archived`）显示该标注，区分「因上级归档」而非自身归档；title 属性列具体归档祖先。仅归档区显示。
- **列内排序**：priority desc（urgent>high>medium>low>none）→ updatedAt desc（默认 `?sort=priority,updatedAt`）。
- **筛选器**（toolbar 左组）：全部 / 按 Req / 按 KR 三选项；选中 req/kr 后展开自定义下拉选具体 Req/KR；按 KR 筛选含其下所有 Requirement 的 task（join requirement.relatedKRId）。**随 OKR feature gate 隐藏**：「按 Req / 按 KR」即 OKR/req 关联呈现，`isFeatureOkrOn()` 为 false 时整个筛选条不渲染（仅留「全部」语义即不筛选；组件代码 gate 内保留不删）。
- **复制按钮**：调 POST `/squad/:id/board/tasks/:tid/duplicate`；新 task 入 pending 列（title=副本；source/assignee/deadline 同；status=pending；priority=none；**不复制 dependsOn**）；乐观添加 + 失败回滚。
- **dependsOn 灰链**：被依赖 task 归档后，依赖项的 dependsOn 区域内该链接显示灰链标记「（已归档）」。

### 数据刷新策略（非显而易见：为什么乐观 + reload 双层）
- **ctx=Snapshot\<Board\> 单聚合对象**（非 entity 列表）：useLifecycle 的 ctx 是一个 `Board`（包含 goals/requirements/tasks 三个 collection），不是三个独立 store。所有 mutate 都 patch 这一个聚合对象。
- **默认乐观 mutate**：编辑/归档/复制后 `mutate((ctx) => applyBoardPatch(ctx!, target, patch))` 立即把改动 shallow-merge 到本地 ctx（即时反馈，不等 HTTP）。
- **写后 reload 取响应层真值**（归档/恢复/创建）：**必须 reload**——`effectiveArchived` / `readable` / `completionPct` 是**响应层派生字段**，由后端 `buildAncestorView`（`app/server/src/stores/board-archive.ts`，构造祖先索引图）算；前端 `applyBoardPatch` 是 shallow merge、**无祖先图、不能重算后代 effectiveArchived**——乐观 patch 只改 self.archived，后代 stale → 不 reload 会导致归档祖先的子项「未归档」错觉。
- **编辑单字段不 reload**：单 entity 字段（title/status/owner/body 等）patch 后不 reload——shallow merge 已覆盖；派生字段（completionPct）由后端在下次 GET /board 时算，编辑时容忍 stale。
- **失败回滚**：写端点 4xx/5xx → `mutate(() => prev)` 还原写前 ctx + toast 错误（复用 mutate 的 ref-latest 写回路径，不重订阅）。
- **手动 refresh 兜底**：刷新按钮（toolbar 右组 ZoneSwitch 前）供 user 主动 refetch。
- **不引入 SSE / polling**（与 chat 页的根本差异）：board 是 CRUD-only——编辑/归档感知靠**下次启动重建**（agent 下次启动 reminder 含最新），无需实时同步。多端一致性靠刷新按钮 + 写后 reload 兜底，不维护跨端 event 通道。

### 空状态 / 失败状态 / 加载状态
独立空 banner 友好提示 / 失败 banner + 重试 / 骨架屏。
+新建 入口在父级 toolbar（不被子 view `length===0` early-return 吞），空态也能新建。

## 复用关系
- **被组合**：`component-panorama-route` 固定 3 tab（goals/requirements/tasks）受控嵌入（tab prop + onCreate/onAtMention 透传）。原独立 board 路由态 + `component-studio-board-route.tsx` 已整体软删（首页 TeamEntryRow 看板 link 同步删除，业务全景成查看 目标/需求/任务 的唯一入口）。
- **组合**：
  - `component-board-toolbar`（单行 toolbar：+新建 + task filter + refresh + zone switch）
  - `component-board-entity-modal`（4 实体共用弹层，edit + create 共用）
  - `component-board-goals-view` / `component-board-requirements-view` / `component-board-tasks-view`（三视图；仅渲染卡片列表，入口上提）
  - `component-board-task-card`（task 单卡 + 编辑/归档/恢复/复制/@ 按钮；编辑按钮 onClick 上抛 onEdit → 父弹 modal）
  - `component-board-at-button`（看板卡片 @ 按钮共享组件）
  - `component-board-selector`（native 选择器，含 `forceDropdown`；禁原生 select）
  - `component-board-body-editor`（body markdown 编辑器）
  - `component-board-edit-fields`（字段子组件：TitleField/KrMetricFields/TaskFields/OwnerField/BodyField）
  - `component-board-zone-bar`（3 export：ZoneSwitch / ArchiveNotice / BoardZoneBar 向后兼容组合）
  - `component-board-task-filter-bar`（嵌入 toolbar 左组）
  - `use-board-edit-form` / `use-board-create`（hook — form state + create 提交）
  - `component-placeholder-banner`（空/失败状态）
  - 共享 `studio-styles.ts` / `studio-icons.ts` / `component-modal-shell.tsx`

## 数据来源（CRUD only — 无 SSE，无 polling）

### REST 端点矩阵
| 用途 | 端点 |
|------|------|
| 拉全板（挂载 + zone 切换 + 写后 reload + 手动 refresh） | GET `/squad/:squadId/board?view=all&zone={active\|archive}` |
| 新建 | POST `/squad/:id/board/{goals\|goals/:gid/krs\|requirements\|tasks}` |
| 编辑 | PATCH `/squad/:id/board/{goals/:id\|goals/:gid/krs/:kid\|requirements/:id\|tasks/:id}` |
| 归档/恢复 | POST `/squad/:id/board/{entity}/:id/{archive\|restore}` |
| 复制 task | POST `/squad/:id/board/tasks/:tid/duplicate` |

query：`?filter={reqId|krId|all}`（task tab）+ `?sort=priority,updatedAt`（task 列内排序）。

### 派生字段（响应层算，UI 不重算）
- `readable`：联合检查 self + 祖先 archived（archive §1 invariant）
- `effectiveArchived`：self.archived ∨ 任一祖先 archived（后端 `buildAncestorView` 构造祖先索引图算）
- `completionPct`：Goal=KR 算术平均；KR=current/target

**前端 `applyBoardPatch` 只 shallow merge patch 到目标 entity**——不重算派生字段（无祖先图）。这是写后必须 reload 的根因（见上「数据刷新策略」）。

## 视觉基线（无设计稿）
- 按既有 Studio token + token 对齐验收（视觉保真 compare 不强制）。
- **容器**：`flex flex-col gap-4`。
- **toolbar**：单行不换行；左组 +新建 按钮 accent 边框 + accent/12 浅底；filter/zone switch；三控件外框统一 `h-7`（28px）。
- **zone switch**：右组胶囊双态（active=accent 实底 / archive=ghost），文案「活跃 / 归档」。
- **archive notice**：toolbar 下方金黄 banner（`bg-warm/40 border border-gold/40 rounded-md px-3 py-2 text-[12.5px]`）+ 「查看」ghost link。
- **卡片 / health 着色 / progress 条**：identity 色系 sage/gold/accent。
- **kanban 列宽**：4 列响应式 `min-w-[200px] flex-1`（窄屏最小 200px + 水平滚动兜底，宽屏等比平铺铺满容器）；列内顺序按 priority→updatedAt。
- **编辑/创建弹层**：复用 `ModalShell`（520px 默认宽度）；字段间距 `gap-3`；label `font-mono text-[10px] uppercase`；input `rounded-md border border-border-2 bg-surface`；详见 `component-board-entity-modal.md`。
- **native 选择器**：见 `component-board-selector.md`（choice 卡 / 自定义下拉 / forceDropdown）。
- **body 编辑器**：见 `component-board-body-editor.md`（markdown textarea + charter-editor 视觉基线）。

> **约束（布局稳定性）**：task-card 的 reason/deadline 区块 + KrRow 的 deadline/status 按**有无字段决定条件渲染**，不因 hover 抖动、不挤压相邻卡片。status reason 输入 + triage 决策区按状态**条件展开**（选 blocked/cancelled 才显 reason；仅 pending 才显 triage 区）。
> @ 按钮 + 新建按钮（含 toolbar 的 +新建 X 与 GoalCard 内的 +新建 KR）**仅活跃区渲染**；已归档项即使活跃区也不显 @ 按钮；onAtMention / onCreate prop 缺省 → 对应按钮隐藏。
