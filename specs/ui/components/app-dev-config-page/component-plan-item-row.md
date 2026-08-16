# component-plan-item-row

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-plan-item-row.tsx

## 职责
单条目 **7 列横排行**（v0.0.347 模型路由 UI v2，决策⑪/⑭；demo v2 冻结视觉契约）：col-handle（DragHandle 唯一拖拽源）/ col-order（序号 = idx+1）/ col-model（ModelPicker）/ col-time（时钟 icon + tooltip + 弹层）/ col-circuit（CircuitStatusBadge）/ col-toggle（ToggleSwitch）/ col-more（⋯ 菜单 → 删除确认）。
边界：受控展示组件，无列表逻辑；状态（弹层开合/拖拽源）由父级 editor 持有（互斥 + 排序）。
[拆分报备] editor 超 300 行硬门禁拆出（change_plan 风险点 6 授权；change_log Task 4 偏离 2）。

## Props
- item: RoutingItem                  // 条目数据（受控）
- idx: number                        // 行序（0 起；展示 idx+1；拖拽/弹层定位用）
- disabled?: boolean                 // 保存中禁用
- badge?: ModelRoutingStatusItem     // 红绿灯（status 按 providerId+modelId 匹配结果；无匹配不渲染 badge）
- timeOpen: boolean                  // 时间弹层开合（父级互斥态）
- moreOpen: boolean                  // 更多菜单开合（父级互斥态）
- isDragging: boolean                // 本行是拖拽源（视觉 opacity-35）
- isDragOver: boolean                // 本行是拖拽落点（视觉高亮 border-fg）
- invalid?: boolean                  // [v0.0.349] 条目 dangling（provider/model 已删或禁用）→ col-model 外层容器红描边 border-danger（trigger 自身已显「模型不可用: mid」；父级 editor 按 providers 判定传入）
- onPatch: (idx: number, patch: Partial<RoutingItem>) => void   // 条目字段更新
- onToggleTime: (idx: number) => void    // 时间弹层开合切换（互斥由父级保证）
- onToggleMore: (idx: number) => void    // 更多菜单开合切换
- onRequestDelete: (idx: number) => void // 点删除（父级弹 ConfirmModal）
- onDragStart: (idx: number) => void     // 手柄 dragstart
- onDragOver: (idx: number) => void      // 行 dragover（preventDefault 允许 drop）
- onDrop: (idx: number) => void          // 行 drop（排序落位）
- onDragEnd: () => void                  // 拖拽结束（清视觉态）

## 状态 / 交互
- **拖拽源仅 grip 手柄（决策⑭）**：DragHandle 自带 draggable（dragstart 冒泡到 wrapper）；行本身 draggable=false 只挂 onDragOver/onDrop（防弹层内格子拖选把行/弹层拖走）
- col-model：复用 ModelPicker（选中后 trigger 固定显示模型名，点击重开下拉；demo 下拉内搜索框不实现——ModelPicker 无搜索能力，记可接受偏离）。**[v0.0.349] dangling 呈现**：invalid=true 时 ModelPicker 外层加 `border-danger` 红描边（仅描边，不加新图标/行内文案——demo 冻结视觉契约内最小表达）；trigger label 由 formatModelDisplay 天然显「模型不可用: <modelId>」
- col-time：32×32 时钟 icon（active=已配 hours 深色 / inactive 灰）；active 时 hover tooltip 显示 `fmtHours`（如「02:00-08:00, 21:00-24:00」）；点击开 HourGridPicker 弹层（timeOpen；**点空白 = 丢弃草稿关闭**，document click listener + contains 检查）
- col-circuit：复用 CircuitStatusBadge 零改动，按 providerId+modelId 从 badge 匹配（无匹配不渲染）
- col-toggle：复用 ToggleSwitch primitive 替 v1 checkbox（enabled 翻转）
- col-more：⋯ menu → 删除 → ConfirmModal「删除路由条目？」（deleteItem.* 文案）
- 禁用行整体 opacity-60；拖拽中行 opacity-35；落点行高亮
- 测试锚点：`data-testid="plan-editor-item"` + `data-idx={idx}`

## 复用关系
- 组合：`component-hour-grid-picker`（时间弹层）+ `fmtHours`（tooltip）、`../chat/ModelPicker`、`../framework/primitives/drag-handle`、`../framework/primitives/toggle-switch`、`component-circuit-status`
- 被组合：`component-model-routing-plan-editor`（条目区逐行渲染）

## 消费方
- app/web/src/components/app-dev-config-page/component-model-routing-plan-editor.tsx
