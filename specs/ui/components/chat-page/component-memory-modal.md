# component-memory-modal（长期记忆弹层，二级视图）

> 层级: component
> 文件: app/web/src/components/chat-page/component-memory-modal.tsx
> （被 `component-chat-float-menu` 承载，取代 ws-panel「长期记忆」tab）
> 以 `crud` prop 下传，与 badge 同一实例 —— **不在本组件内重新调用 `useMemoryCrud`**）

## 消费方

- `components/chat-page/component-chat-float-menu.tsx`

## 职责
state**）+ 顶部返回按钮 + idle 空态。list 态复用 `component-memory-entry-card`；editor 态复用 `component-memory-editor-fields`。**不弹层套 modal**——editor 是同一弹层内的二级视图，非叠加。

## Props
- crud: MemoryCrud
- onClose: () => void

## 状态 / 交互
- `view = crud.editor.open ? 'editor' : 'list'`。
- **list 态**：
  - 顶部返回按钮 `memory-modal-back`（仅 editor 态渲染）→ 同 `onCancel`。
- **归档 = 单击直接执行，无确认层**（架构裁决，见 `component-chat-float-menu.md §4`）：`component-memory-entry-card` 的 archive 按钮点击直接触发 `onArchive` 回调，本组件**不加二次
- 关闭：遮罩点击 / `memory-modal-close` 按钮 → `onClose`（不影响 `crud.editor` 状态，下次重开
  仍是上次的 view——若担心残留可在 `onClose` 内附带 `crud.setEditor({open:false})`，实现取此更
  干净的重开体验：每次重开默认回列表态）。

## 复用关系
- 数据：`use-memory-crud.ts`（由父传入，不自建）。
