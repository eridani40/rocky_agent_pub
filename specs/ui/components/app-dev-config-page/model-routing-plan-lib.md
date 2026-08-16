# model-routing-plan-lib

> 层级: lib（纯函数库，非组件；随组件目录组织）
> 文件: app/web/src/components/app-dev-config-page/model-routing-plan-lib.ts

## 职责
方案纯函数库（v0.0.347 模型路由 UI v2）：validatePlanLocal / reindexPriorities / DEFAULT_CIRCUIT / PlanValidationError 从 plan-editor 迁出（v1 在 editor 内导出；UI v2 重写后 editor 300 行硬门禁拆分，change_log Task 4 偏离 2）。**语义零变化**；editor 与 section 共用。
已删：moveItem（v1 ↑/↓ 按钮排序工具，拖拽排序替代后零引用死代码，死代码原则）。

## 导出
- DEFAULT_CIRCUIT: Required<CircuitConfig>  // 熔断默认 { failureThreshold:4, successThreshold:2, timeoutSeconds:60, errorRateThreshold:0.6, minRequests:10 }（对齐 PRD §2.7 + tech §6）
- validatePlanLocal(plan): PlanValidationError[]  // 同模型约束本地预检（保存前校验 + 单测）
- PlanValidationError 类型  // 预检错误 i18n key 列表（空数组 = 合法）：nameRequired / itemsRequired / sameModelMax2 / sameModel2Time / sameModel2NoTime / timeAboveUnconditional / itemModelRequired
- reindexPriorities(items): RoutingItem[]  // priority 重算（index+1，落盘前）
- isPlanDirty(snapshot, draft): boolean  // [T4] SaveBar dirty 判定（JSON 内容比对；语义对齐 provider detail isDirty）

## 校验规则（validatePlanLocal，对齐 PRD §2.8 UC-21/22/23 + api §2.2 校验表）
- name/items 非空；每条目 providerId+modelId 非空
- 同模型（providerId+modelId）按**启用条目**分组：≤2 条、禁 2 带时间、禁 2 不带时间
- 带时间条目必须排在不带时间条目上面（minTimeIndex < maxNoTimeIndex）
- 按「启用条目」统计（停用不占额度）

## 消费方
- app/web/src/components/app-dev-config-page/component-model-routing-plan-editor.tsx（预检 + 熔断默认 + reindex）
- app/web/src/components/app-dev-config-page/section-model-routing-plans.tsx（handleSave 预检 + reindexPriorities）
- 单测引用（validatePlanLocal / reindexPriorities / DEFAULT_CIRCUIT）
