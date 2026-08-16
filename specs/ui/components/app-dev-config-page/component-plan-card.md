# component-plan-card

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-plan-card.tsx

## 职责
单张方案卡片（v0.0.347 模型路由 UI v2 外层列表，决策⑨/⑩/⑯；demo v2 plan-card 形态）：名称（rename inline 态 input）/ meta（N 个模型 + 模型名 `·` join）/ 挂载徽章（已挂载到 A、B / 未挂载）/ ⋯ 菜单（重命名/复制/删除）/ chevron；**整卡点击进详情**。
边界：受控展示组件，无数据流逻辑；状态（菜单开合/重命名草稿/挂载数据）由父级 section 持有。
[拆分报备] section 超 300 行硬门禁拆出（change_plan 风险点 6 授权；change_log Task 4 偏离 2）。

## Props
- plan: ModelRoutingPlan                            // 方案数据
- mounted: string[]                                 // 挂载名列表（空 = 未挂载；listPlanMounts 聚合，决策⑯）
- menuOpen: boolean                                 // ⋯ 菜单开合（父级单开态）
- renameDraft: { planId: string; value: string } | null  // 重命名草稿（planId 匹配本卡 = inline input 态；BUG-002 受控语义）
- onOpen: () => void                                // 整卡点击进详情
- onMenuToggle: () => void                          // ⋯ 菜单开合切换
- onRenameStart / onRenameChange / onRenameCommit / onRenameCancel  // 重命名四回调（草稿初值=原名/受控变化/Enter·blur 提交/Escape 取消；空/未变更不 PUT 由父级校验）
- onCopy: () => void                                // 复制
- onDeleteRequest: () => void                       // 删除（父级弹 ConfirmModal）

## 状态 / 交互
- 整卡 cursor-pointer + hover（border-strong + shadow）；主区点击进详情；rename 态中点击主区 stopPropagation（不触发进详情）
- rename inline：input 受控（renameDraft.value）；Enter/blur 提交、Escape 取消
- ⋯ 菜单：menuOpen 时渲染（重命名/复制/删除三项）；菜单点击 stopPropagation（不冒泡到卡片 onOpen）
- 测试锚点：`data-testid="plan-card"` + `data-plan-id={plan.id}`
- i18n：list.modelsCount / mountedTo / unmounted / moreActions + list.rename/copy/delete

## 复用关系
- 被组合：`section-model-routing-plans`（列表层）

## 消费方
- app/web/src/components/app-dev-config-page/section-model-routing-plans.tsx
