# v0.0.220 变更计划书 — Academy 视图继续优化（纯 UI 删减/重定位）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

> 4 处纯 UI 改动，按文件聚合。**无后端 / API / 落库变更**；`onOpenTrainingObserve(taskId)` 为既有 prop 链路（section-student-detail→page-academy L160 → route `training-observe`），本版复用，不改其语义。

### Feature 1 — 教室详情删「训练任务」tab（保留 学生/数据集/评估器）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-ui | app/web/src/components/academy-page/section-classroom-detail.tsx | `tabs` (const L136-145) | 修改 | 从 tabs 数组删 `{ id: 'tasks', label: trainingTasks, countTag }` 整项，仅保留 students/datasets/graders 三项 | MUST 保持 students/datasets/graders 顺序与 key 不变；MUST NOT 改 tab 切换机制 | specs/ui/components/academy-page/section-classroom-detail.md §3 | -5 |
| academy-ui | app/web/src/components/academy-page/section-classroom-detail.tsx | `tab === 'tasks'` 渲染块 (L229-236) | 删除 | 删 tasks tab 内容 JSX（empty 提示 + tasks.map(TaskRow)） | MUST 删干净，无残留条件分支 | 同上 §3 | -8 |
| academy-ui | app/web/src/components/academy-page/section-classroom-detail.tsx | `activeTasks` (const L80) | 删除 | 删 `tasks.filter(... running/pending)` 派生（仅 tasks tab countTag 用，tab 删后死代码） | MUST 同步确认无其他引用再删 | 同上 §3 | -1 |
| academy-ui | app/web/src/components/academy-page/section-classroom-detail.tsx | `Props.onOpenTrainingTask` + destructure (L36, L40) | 删除 | 从 Props interface 删字段 + 从 SectionClassroomDetail 形参删 | MUST page-academy 调用点同步删（见下一行） | 同上 §3 | -2 |
| academy-ui | app/web/src/components/academy-page/section-classroom-detail.tsx | `TaskRow` import (L28) | 修改 | 从 `component-classroom-tab-panels` import 列表移除 TaskRow（保留 ResTable/StudentsGrid/useResItems/StudentCardData） | MUST NOT 删其他 import | 同上 §3 | -1 |
| academy-ui | app/web/src/components/academy-page/page-academy.tsx | `onOpenTrainingTask` prop (L144) | 删除 | 删 SectionClassroomDetail 的 `onOpenTrainingTask={(sid,tid) => setRoute({kind:'training-observe',...})}` 传参 | MUST NOT 改同文件 L160 onOpenTrainingObserve（学生详情仍用） | specs/ui/overall/12-academy.md | -1 |
| academy-ui | app/web/src/components/academy-page/component-classroom-tab-panels.tsx | `TaskRow` (export function L102) | 删除 | 删整个 TaskRow 组件定义（grep 确认唯一消费者是 section-classroom-detail，tab 删后成死代码） | MUST 删前 grep 再确认零引用；MUST NOT 删同文件 ResTable/StudentsGrid/useResItems | specs/ui/components/academy-page/component-classroom-tab-panels.md | -15 |

### Feature 2 — 学生详情左栏删版本树下 recentTasks 任务卡

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-ui | app/web/src/components/academy-page/section-student-detail.tsx | `recentTasks.map` 任务卡 JSX (L217-236) | 删除 | 删左栏版本树下 ComponentTrainingStatusBar (variant="card") 循环块（任务状态已在过程版节点 status tag 展示） | MUST 保留 ComponentVersionTree；MUST NOT 删 component-training-status-bar.tsx 组件文件（section-training-observe 仍用 variant="bar"） | specs/ui/components/academy-page/section-student-detail.md §4 | -20 |
| academy-ui | app/web/src/components/academy-page/section-student-detail.tsx | `RECENT_TASKS_LIMIT` (const L79) | 删除 | 删 `const RECENT_TASKS_LIMIT = 3` | MUST 同步清 recentTasks | 同上 §4 | -1 |
| academy-ui | app/web/src/components/academy-page/section-student-detail.tsx | `recentTasks` (useMemo L119-122) | 删除 | 删 `[...tasks].sort(createdAt desc).slice(0,N)` useMemo；`tasks` 解构保留（buildVersionNodes 仍用，L129） | MUST NOT 删 `const { student, versions, tasks } = detail` 的 tasks；MUST 清 RECENT_TASKS_LIMIT + taskNameLabel | 同上 §4 | -4 |
| academy-ui | app/web/src/components/academy-page/section-student-detail.tsx | `taskNameLabel` (function L106-109) | 删除 | 删任务名版本前缀 helper（仅任务卡用） | MUST 同步清 `TrainingTaskEntity` import（L26，taskNameLabel 删后变未用） | 同上 §4 | -4 |
| academy-ui | app/web/src/components/academy-page/section-student-detail.tsx | `ComponentTrainingStatusBar` import (L31) | 删除 | 删 import（本文件 variant="card" 用法已删；组件文件保留） | MUST NOT 删 ./component-training-status-bar 文件 | context.md findings [14:05] | -1 |

### Feature 3 — ver-hero 改造：删「编辑版本」按钮 / 过程版加「进入观察」

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-ui | app/web/src/components/academy-page/section-student-detail.tsx | ver-hero action 分支 (L255-268) | 修改 | formal 分支：删「编辑版本」按钮（编辑改走下方四元组卡，readOnly 本就由 `openMdEditor` 的 `readOnly: !selectedIsFormal` 控制，L149）；process 分支：原 PrimitiveStatusBadge(readonlyProcess) 改为「进入观察」按钮——`selectedVersion.createdFromTaskId` 存在时显按钮，click 调 `onOpenTrainingObserve(selectedVersion.createdFromTaskId)`；缺失则不显按钮（留空或保留 readonly badge，coder 定） | MUST 过程版定位 task 走 `selectedVersion.createdFromTaskId`（= label 前两位 major.seq 对应任务）；MUST 复用既有 `onOpenTrainingObserve(taskId)` prop，禁止新增 prop / 改其路由语义；MUST NOT 改 `openMdEditor` / `selectedIsFormal` / 四元组卡的 readOnly 逻辑；createdFromTaskId 缺失的过程版 MUST NOT 显按钮 | specs/ui/components/academy-page/section-student-detail.md §4（verHero）；context.md findings [14:05]；version-tree-nodes.ts L110 已用同链路 | +12/-9 |

### Feature 4 — sidebar 删底部训练资源组（数据集/评估器/优化 skill）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-ui | app/web/src/components/academy-page/section-classroom-list.tsx | 资源组 JSX (L128-141) | 删除 | 删 sidebar 底部 `{t('sidebar.resources')}` SIDE_LABEL 标题 + datasets/graders/skills 三行 res-item JSX | MUST 删干净；MUST NOT 删教室列表 (L113-126) / sidebar-head / foot 文案 | specs/ui/components/academy-page/section-classroom-list.md §11 | -14 |
| academy-ui | app/web/src/components/academy-page/section-classroom-list.tsx | `resCounts` (useState L38) | 删除 | 删 `useState({ datasets, graders, skills })` | MUST 聚合 useEffect 同步删 | 同上 §11 | -1 |
| academy-ui | app/web/src/components/academy-page/section-classroom-list.tsx | 资源计数聚合 `useEffect` (L40-61) | 删除 | 删逐教室 `getClassroomDetail` 求和副作用（资源组已删，计数无用） | MUST 同步清 `useEffect` from 'react' import（L9，文件内唯一 useEffect）；MUST NOT 删 useState import | 同上 §11 | -22 |
| academy-ui | app/web/src/components/academy-page/section-classroom-list.tsx | `getClassroomDetail` import (L11) | 删除 | 从 academy-api import 移除 getClassroomDetail（保留 ClassroomEntity type import） | MUST 确认文件内无其他引用 | 同上 §11 | 0（改 import 行） |
| academy-ui | app/web/src/components/academy-page/section-classroom-list.tsx | `SIDE_LABEL` import (L13) | 删除 | 从 academy-styles import 移除 SIDE_LABEL（保留 ICON_BTN、INPUT） | MUST 确认文件内无其他引用 | 同上 §11 | 0（改 import 行） |

### Feature 5 — 测试同步

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| academy-ui-test | app/web/src/components/academy-page/__tests__/section-student-detail.test.tsx | `recentTasks 渲染门` describe block (L93-141) | 修改 | 删 5 个 recentTasks `it`（N=3 上限/含终态/任务名前缀/降级/空 tasks）；新增 ver-hero 过程版「进入观察」断言：process 版 selected + createdFromTaskId 存在 → 显「进入观察」按钮 → click → `onOpenTrainingObserve` 被调以 createdFromTaskId；createdFromTaskId 缺失 → 不显按钮 | MUST 正式版 selected 不显「进入观察」；MUST NOT 为本版新增 AT/ET case（纯 UI 走 UT，CLAUDE.md 测试用例库铁律） | context.md findings；section-student-detail.md §4 | +30/-50 |

## 影响面评估

- **跨模块**：仅 `academy-ui`（app/web/src/components/academy-page/ 5 文件 + 1 测试）。**无后端 / API / 落库 / SSE / route 结构变更**。
- **破坏性变更**：无外部接口变更。内部 prop 链路：`SectionClassroomDetail` 删 `onOpenTrainingTask` prop（page-academy 同步删传参，闭环）；`SectionStudentDetail` 的 `onOpenTrainingObserve` prop 语义不变（只是 ver-hero 新增调用方，复用既有 route handler）。
- **依赖顺序**：单层 UI，无 SDK/protocol→harness 层级。Feature 1-4 互不依赖，可同 coder 顺序跑；Feature 5（测试）跟随 Feature 2+3 改动。
- **风险点**：
  1. `createdFromTaskId` 是可选字段（`?: string`），过程版可能缺失 → coder 须显式 falsy 判断，缺失时不显按钮（约束已钉）。
  2. 删 import 后 typecheck 对未用 import 会报（noUnusedLocals）→ coder 须把 TaskRow / TrainingTaskEntity / ComponentTrainingStatusBar / getClassroomDetail / SIDE_LABEL / useEffect 的未用 import 清干净（约束已逐行钉）。
  3. test 文件 `mkTask` / `mkDetail` helper 若仅 recentTasks describe 用，删 block 后可能成死代码 → coder 视实际引用决定是否顺手清（不强制）。
- **AT/ET 范围**：纯 UI 无接口契约变更 → AT/ET 豁免（按 CLAUDE.md「纯前端无 API 契约变更」惯例，orchestrator 核实后放行）；交付门禁 = UT 全绿（academy 套件）+ typecheck 全绿。

## task 拆分结论

**1-task 单 coder 续跑**。理由：

- 5 文件纯 UI 删减 + 1 测试同步，**无并行收益**（无后端 ∥ 前端切分点；4 处改动共享同一组件目录上下文）。
- 按 planner.md「优先少量任务」原则：纯串行拆 T1→T2→T3 是差分配（每独立 agent 冷恢复 ~10 分钟），1 个 coder 续跑最快。
- 改动量小（净 -100 行左右，+30/-50 在测试），单 task 1-2 小时可完成。
- 已对齐 task.json 现有 1-task 拆分（id=1，coversFiles 5 个、coversMethods 已列全）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
