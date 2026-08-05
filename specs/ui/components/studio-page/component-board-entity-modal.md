type: spec
title: component-board-entity-modal — 看板实体弹层（goal/KR/requirement/task 共用；edit + create 双模式）
priority: P1
status: active
updated: 2026-07-30
since: v0.0.76

## 职责
统一的**看板实体创建 + 编辑弹层**——4 种实体（goal/KR/req/task）共用同一份 JSX（mode 区分 initial + 标题 + D1-b 守卫；字段集不区分 mode，完全一致）。仅展示 + 绑定 form state，**不直调 API**（保存分支由父 SquadBoard 按 mode 调 PATCH/POST）。
边界：
- 不拉数据（`board` snapshot 由父 SquadBoard 注入）
- 不调 API（保存回调 `onSubmit`，调用方按 mode 调对应端点）
- 不渲染按钮入口（+新建 入口在 `component-board-toolbar`；编辑铅笔在各 view 卡片上）

## feature gate（v0.0.223 OKR/req 漏出移除）
- **requirement 来源选择器**：实际渲染在字段子组件 `component-board-edit-fields.tsx` 的 **TaskFields**（非本文件 JSX 内）——`isFeatureOkrOn()` 为 false（默认）时整块不渲染（`{isFeatureOkrOn() && <Field 来源需求>}`）。
- **D1-b 强制守卫放宽**：`isCreateTaskBlocked`（本文件）= `isFeatureOkrOn() && mode==='create' && target.kind==='task' && !form.source`——gate 关时 create task **不再强制选父 requirement**（agent 不再走 OKR 链路，task 可野生创建）；gate 开时行为不变（未选 requirement 禁提交 + 按钮文案「先选父 Requirement」）。
- gate 机制权威：`specs/tech/app/[P1]feature_gate.md`；读取口统一 `lib/feature-gates.ts isFeatureOkrOn()`。

## Props
- mode: 'edit' | 'create'
- target: EditTarget
- board: Board
- members: Member[]
- onSubmit: (patch: BoardPatch) => void
- onClose: () => void

## 状态 / 交互
### 弹层生命周期（SquadBoard 根持有 editing/creating state）
- 编辑/创建互斥：开 create 前关 edit（`setEditing(null)`），同一时刻只有一个 modal。
- 关闭：取消按钮 / 遮罩点击 / 右上角 X → `onClose` → SquadBoard `setEditing(null)` / `cancelCreate`。
### Form state（mode 无关 hook）
- `mode='create'` → 字段全空 defaults
- `mode='edit'` → `findEntity(target, board)` 取 snapshot（goal/kr/req/task 分支）
- target/board/mode 变化时 reset form state（useEffect 依赖）
- `handleSubmit` 按 entity kind 组装 patch → 调 `onSubmit(patch)`

## 视觉基线
参考 `bench-modal.md` / `new-squad-wizard.md` 等 modal spec（`ModalShell` 520px 默认宽度）+ `charter-editor.md` 字段视觉基线：
- **弹层**：复用 `component-modal-shell`（widthPx=520 默认）+ `BTN_PRIMARY`/`BTN_SECONDARY` footer 按钮
- 沿用 v0.0.60 token；本版本无设计稿（compare 不强制）

## 复用关系
- **被组合**：`component-squad-board`（根持有 editing/creating state，渲染最多一个 modal）
- **组合**：
- `component-modal-shell`（弹层外壳）
- `use-board-edit-form` hook（form state + handleSubmit，v0.0.68 抽出）
- `component-board-edit-fields`（字段子组件：TitleField/KrMetricFields/TaskFields/Owner
