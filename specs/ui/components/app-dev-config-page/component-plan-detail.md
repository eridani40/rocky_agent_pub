# component-plan-detail

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-plan-detail.tsx

## 职责
方案详情独立页骨架（v0.0.347 **T4 补丁**，老板拍板「需要是个独立页面，详情页！」）：组装面包屑 + logo 标题区 + ModelRoutingPlanEditor + 底部 sticky SaveBar。
**风格唯一基准 = `components/providers/component-provider-detail.tsx`**（老板原话「绝对一致」）：面包屑形态（可点父级名 font-mono text-muted hover:text-accent + `/` + 标题 font-medium text-fg，mb-3 text-[13px]）、logo 首字母块（w-12 h-12 rounded-[12px] bg-sage-bg text-sage）+ 标题（text-[16px] font-semibold）+ mono 副标题、SaveBar variant="detail"（sticky bottom）。
边界：纯展示组装组件——**不调后端、不持业务态**（快照回滚/保存流由父级 section 持有）。

## Props（全部由 section 注入）
- plan: ModelRoutingPlan（draft，受控）
- dirty: boolean（isPlanDirty(snapshot, draft)——SaveBar dirty 展示 + 取消按钮可见性）
- saving: boolean（SaveBar saving）
- status?: ModelRoutingStatus | null（决策⑰：详情打开拉一次，item 行按 pid+mid 匹配）
- serverError?: string | null（400 透传，editor 400 区展示）
- onChange(next)、onBack（面包屑 = 快照回滚退列表，决策⑨）、onSave（SaveBar 保存 = PUT 回列表）、onReset（SaveBar 取消 = 重置回快照**留详情页**，provider 同语义）

## 结构（自上而下）
1. 面包屑：`detail-back`（`data-action-key="settings.models.plan.back"`，显示 `group.model_routing_plans.label`「模型组合方案库」可点）+ `/` + `detail-title`（纯方案名）
2. logo 首字母块 + 标题区（标题 = plan.name；mono 副标题 `plan · model routing`）
3. `ModelRoutingPlanEditor`（条目 7 列行 + 熔断区，T4 冻结不动）
4. `SaveBar variant="detail"`（saveTestId=`plan-editor-save` / cancelTestId=`plan-editor-cancel`，action-key settings.detail.save/cancel）

## 语义三分（T4，provider detail 对齐）
- SaveBar 保存 = PUT → 清快照**回列表**
- SaveBar 取消（dirty 可见）= 重置回快照**留详情页**
- 面包屑回退 = 快照回滚（isNew 移除）**退列表**（决策⑨取消语义归位）

## 消费方
- `section-model-routing-plans.tsx`（detail 态唯一渲染入口；section 超 300 行门禁拆出 + 对称 provider 的 section/detail 文件结构——拆分已报备）
