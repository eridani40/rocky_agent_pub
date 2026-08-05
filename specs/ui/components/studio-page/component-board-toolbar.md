type: spec
title: component-board-toolbar — 看板顶部单行 toolbar（左 +新建+filter / 右 zoneSwitch）
priority: P1
status: active
updated: 2026-07-31
since: v0.0.76

## 职责
看板顶部**单行不换行** toolbar——按 tab 切换左组内容；右组固定 zone 切换器：
边界：
- 纯展示 + 回调；不持 state（`tab`/`zone`/`taskFilter` 都从父 SquadBoard 注入）
- 不含 archive notice（由 SquadBoard 在 toolbar 下方独立渲染 `ArchiveNotice`，避免撑高 toolbar）
- 不渲染 modal（modal 在 SquadBoard 根）

## Props
- tab: 'goals' | 'requirements' | 'tasks'
- zone: 'active' | 'archive'
- board: Board
- taskFilter: TaskFilterState
- onTaskFilterChange: (f: TaskFilterState) => void
- onCreate?: (kind: BoardEntityKind, parentGoalId?: string) => void
- onZoneChange: (z: 'active' | 'archive') => void

## 状态 / 交互
### 左组（pinned left，）
1. **+新建 X 按钮**（`CreateButton` 子组件）：
   - 渲染条件：`zone === 'active' && onCreate`（归档区不新建；onCreate 缺省 → 隐藏向后兼容）
   - 按 tab 派 kind + label：goals→`{kind:'goal', label:'Goal'}` / requirements→`{kind:'req', label:'Requirement'}` / tasks→`{kind:'task', label:'Task'}`（**kr 不在 toolbar 派**，KR 入口在 GoalCard 内）
2. **BoardTaskFilterBar**（仅 task tab + OKR gate 开）：
   - 渲染条件：`tab === 'tasks' && isFeatureOkrOn()`（`lib/feature-gates.ts`；`specs/tech/app/[P1]feature_gate.md`）——「按 Req / 按 KR」即 OKR/req 关联呈现，gate 关时整个筛选条不渲染（仅留「全部」语义即不筛选）；组件代码 gate 内保留不删
   - 逻辑零变更，仅位置从 tasks-view 内搬到 toolbar
### 右组（pinned right）

## 视觉基线
- **左组**：（+新建 与 filter 间 8px 间距）
- **+新建 按钮**：accent 边框 + accent/12 浅底 + accent 文字 + hover 加深
- **filter / zone switch**：，与 +新建 同高
- 沿用 v0.0.60 token；本版本无设计稿（compare 不强制）

## 复用关系
- **被组合**：`component-squad-board`（根渲染单实例，board 未加载时传 `EMPTY_BOARD` 占位）
- **组合**：
- `ZoneSwitch`（`component-board-zone-bar.tsx` 三 export 之一；v0.0.76 拆分；其他两个 export
- 内联子组件 `CreateButton`（按 tab 派 kind/label/testid）
- **不组合**：`ArchiveNotice`（在 SquadBoard 内独立渲染于 toolbar 下方，避免撑高 toolbar）
