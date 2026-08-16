# component-model-routing-plan-editor

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-model-routing-plan-editor.tsx

## 职责
方案详情编辑器（v0.0.347 模型路由 UI v2，决策⑪）：**条目区委托 PlanItemRow 渲染 7 列横排行** + 熔断高级区常显 + 服务端 400 透传。持有弹层互斥态（时间弹层/更多菜单单开）与拖拽排序逻辑；同模型约束本地预检经 plan-lib 阻止保存。
边界：受控组件（value/onChange）；不直接调 API（保存由父级 section 完成）；纯函数校验已迁出至 `model-routing-plan-lib`。

## Props
- value: ModelRoutingPlan                      // 方案 draft（受控；无 name 编辑——改名走列表卡片 ⋯ 菜单）
- onChange: (next: ModelRoutingPlan) => void   // draft 变更回调
- serverError?: string | null                  // 服务端 400 message（父级保存失败透传展示）
- disabled?: boolean                           // 保存中禁用
- status?: ModelRoutingStatus | null           // 方案红绿灯（父级进详情时拉一次；item 行按 pid+mid 匹配，决策⑰）
- providers?: ProviderItem[]                   // [v0.0.349] providers 列表透传（section useProviders 拉取）：① validatePlanLocal 二参存在性预检；② 逐行 invalid 判定（providerId+modelId 未命中 enabled provider 的 enabled model）

## 导出
- ModelRoutingPlanEditor（默认导出；仅组件本体）
- **纯函数已迁出**：validatePlanLocal / reindexPriorities / DEFAULT_CIRCUIT / PlanValidationError → `model-routing-plan-lib.ts`（v2 300 行门禁拆分，change_log Task 4 偏离 2）

## 状态 / 交互
- 弹层互斥态：`openTimeIdx` / `openMoreIdx`（-1 = 全关，单开）；`pendingDeleteIdx`（条目删除确认）
- 拖拽排序：行 onDragOver（允许 drop）/ onDrop（splice 移位 + reindexPriorities + 关全部弹层）；拖拽源仅 grip 手柄（行 draggable=false，决策⑭）；drop 后 priority 重排（index+1）
- 条目操作：新增条目按钮（追加末尾，enabled 默认 true）；删除走 ⋯ 菜单 → ConfirmModal（deleteItem.*「删除路由条目？」）
- 熔断高级区**常显**（决策⑮）：CIRCUIT_FIELDS 5 参数（failureThreshold/successThreshold/timeoutSeconds/errorRateThreshold/minRequests）grid 布局，每参数 label + number input + 默认值 hint（「默认 {{value}}」）；空串=回默认（patchCircuit）；value.circuit 缺省用 DEFAULT_CIRCUIT 展示。**[滑窗增量 2026-08-14]** minRequests 标签改「窗口样本数」（en "Min Window Samples"）——语义为错误率滑动窗口内最小有效样本数；windowSize（默认 20）UI 暂不暴露字段（API 层可配，未来需要时加输入框）
- 本地预检：validatePlanLocal(value, providers)（同模型约束：≤2 条/禁 2 带时间/禁 2 不带时间/带时间在上，按启用条目统计）——不合法由父级 handleSave 拦截不 PUT。**[v0.0.349] dangling 存在性预检**：providers 传入时每条目 (providerId, modelId) 未命中 enabled provider 的 enabled model → `modelRouting.validate.itemModelInvalid`（实时显示在本地预检区，与服务端 PUT 400「model not found or disabled」双保险）；providers 缺省不做存在性检查（向后兼容）
- i18n：`modelRouting.editor.*`（detailTitle「方案：{{name}}」/ degradeOrder「降级顺序（拖拽排序，序号即优先级）」/ timeCondition「时间限制」/ circuit* 5 参数 + defaultHint）+ `modelRouting.deleteItem.*`

## v2 已退役交互
- ↑/↓ moveItem 按钮排序（改 grip 拖拽排序；moveItem 死代码已删，死代码原则）
- 时间模式 select（不限/只在以下小时可用）+ inline HourGridPicker 展开 + timeOpenIndex 初始化（改时钟 icon 弹层，见 component-plan-item-row）
- name input（改名走列表卡片 ⋯ 菜单 rename inline）
- onServerErrorClear prop（死代码已删，bebf504cc：editor 声明未调用，section 保存前已自行清错）
- 折叠式熔断高级区 circuitOpen（改常显）

## 复用关系
- 组合：`component-plan-item-row`（7 列行）、`../common/component-confirm-modal`（条目删除确认）、`model-routing-plan-lib`（纯函数）
- 被组合：`section-model-routing-plans`（详情页）

## 消费方
- app/web/src/components/app-dev-config-page/section-model-routing-plans.tsx
