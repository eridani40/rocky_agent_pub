type: spec
priority: P1
status: deprecated
updated: 2026-07-05
since: v0.0.60

## Props
- target: EditTarget
- members: Member[]
- board: BoardSnapshot
- mode?: 'create' | 'edit'
- onSave: (patch: BoardPatch) => void
- onCancel: () => void

## 视觉基线
- **组合**：`component-board-selector`（关联字段 selector 仍在新 modal 内复用）+ `component-board-body-editor`（body 字段，同）+ `use-board-edit-form` hook
