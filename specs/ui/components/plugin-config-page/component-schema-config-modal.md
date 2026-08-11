# component-schema-config-modal

> 层级: component
> 文件: app/web/src/components/plugin-config-page/component-schema-config-modal.tsx

## 职责
impl 的 schema 配置弹层。按 `configSchema`（JSON Schema）`properties.<key>.type` 渲染对应控件（string/number/boolean/enum/object），用户编辑 draft 后独立保存或取消，不污染父级表单状态。
边界：只管「按 configSchema 渲染 + 收集值 + 保存/取消」；不感知扩展点类型、不负责校验复杂规则（仅按 type 分发渲染）；保存通过 `onSave` 上抛，由父级合并到 impl 的 config 值。

## Props
- implId: string
- configSchema?: JsonSchema
- value: Record<string, unknown>
- open: boolean
- onClose: () => void
- onSave: (v: Record<string, unknown>) => void
- readOnly?: boolean

## 状态 / 交互
- `open === false` → 不渲染
- `open === true` → 渲染遮罩 + 居中弹层；内部 `draft` 拷贝 `value`，编辑仅改 `draft` - `string` + `enum: [...]` keyword → `KeyChoiceCards`（select，候选值来自 enum）
  - `string`（无 enum）→ `KeyInput` - `number` / `integer` → 数字 input（受控 `type=number`）
  - `boolean` → `KeyBoolean`（switch）
  - `object` → 分组（嵌套渲染子 ，每组带标题）
- `readOnly=true`：fieldset `disabled` 隔绝所有内部控件 + 隐藏保存按钮（仅展示「关闭」）；`onSave` 不会被调用。
- `configSchema` 缺省 /  为空 → 渲染空字段表（兜底 undefined / 非对象 → 空对象）。
- 「保存」→ `onSave(draft)` → `onClose`；「取消」/遮罩/× → 直接 `onClose`（丢弃 draft）

## 消费方
- `app/web/src/components/plugin-config-page/section-ext-point-area.tsx`
