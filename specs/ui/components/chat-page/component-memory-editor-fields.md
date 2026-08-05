# component-memory-editor-fields（长期记忆表单字段，无 modal 壳）

> 层级: component
> 文件: app/web/src/components/chat-page/component-memory-editor-fields.tsx
> 参考: `component-memory-editor-modal.md`（抽出源，字段/校验/testid 契约一致）
> `specs/api/overall/15-memory-ui.md §4/§5`（POST/PATCH body 校验规则）

## 职责
渲染 memory entry 的表单字段（name/intro/type/body/why/howToApply/evolvable）+ 校验 +
取消/保存按钮行。**不含 fixed 遮罩/居中卡片壳**（壳由承载方各自提供）。
1. `component-memory-modal`（本版新建，弹层二级视图 editor 态）——承载方仅在 `view==='editor'` 时挂载本组件，**挂载即代表可见**（无需 `open` prop，卸载即代表取消/返回）。
   承载方保留 `open` 受控 + fixed 遮罩 + head + close 壳，`open===true` 才挂载本组件。

## Props
- initial?: MemoryEditorInitial
- testIdPrefix: 'memory-session' | 'memory-user' | 'squad-memory'
- onCancel: () => void
- onSave: (entry: MemoryWriteInput) => Promise<void> | void

## 状态 / 交互
  直接以 `initial` 初值构造（**不用 `useEffect` 同步**——挂载语义已保证"刚打开"）。
- 校验：name/intro/body 必填；`type ∈ {feedback, project}` 强制 why + howToApply；
- `editing = !!initial?.name` → name 输入框 disabled（PATCH 不允许改 name）。
- evolvable 开关：无置灰、不防呆，全字段可编辑（`ToggleSwitch` primitive）。
- 保存失败：本地 `error` 展示（`role="alert"`），不调用 onCancel（留在原视图）。
- 保存成功：父的 `onSave` 内部处理 refetch + 关闭/返回（本组件不管后续导航）。
