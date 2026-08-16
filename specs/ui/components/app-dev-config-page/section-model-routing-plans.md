# section-model-routing-plans

> 层级: section
> 文件: app/web/src/components/app-dev-config-page/section-model-routing-plans.tsx

## 职责
模型组合方案库区块（v0.0.347 模型路由 **UI v2 两层结构**，决策⑨；models tab providers section 下方）：
- **列表层**：方案卡片列表（PlanCard：名称/meta/挂载徽章/⋯ 菜单/chevron）+ 新建方案
- **详情独立页**（T4 补丁，老板拍板「独立页面」）：`component-plan-detail`（面包屑回退 + logo 标题区 + ModelRoutingPlanEditor + 底部 sticky SaveBar），**风格唯一基准 = `components/providers/component-provider-detail.tsx`**（绝对一致）；进详情 `structuredClone` 深拷贝快照
- **detail 态独占 tab 内容区契约**（T4）：本 section 经 `onViewLevelChange` 上抛 view level；detail 态时父级 `section-tab-panel` 隐藏 models tab 其余 group（providers 区及其标题，互斥由构造保证——detail 态下另一 section 列表不可见）
- 删除确认（ConfirmModal 提示解除挂载 detached）；挂载徽章数据聚合（listPlanMounts）
边界：**自渲染即时操作**（不走 page-tab dirty，同 provider 独立 save 流范式）；后端零改动。

## Props
- `onViewLevelChange?: (level: 'list' | 'detail') => void`（T4：view level 上抛，同 SectionProviders v0.0.140 机制；挂载初始 list——切 tab 重挂后父级状态复位）
- `onPlanDeleted?: (detached: string[], planId: string) => void`（**[v0.0.349] BUG-004**：删除方案后上抛 detached 清单 + planId——page 级 `useAppSettingsConfig` 跨 tab 存活的 mountDraft/mountSnapshot 持已删 planId 会导致会话 tab trigger 残显「方案 · <planId>」；detached 含 'playground' 时 page 调 `clearPlaygroundMountState(planId)` 清本地挂载态。回调按现有结构透传：section → section-tab-panel → page，无事件总线）

## 状态 / 交互
- 视图态：`{ level: 'list' }` | `{ level: 'detail', planId, isNew }`（planId 指向 plans 内 draft；isNew = 新建未落库）
- 数据态：plans / view / loading / error / **status**（详情单方案红绿灯，决策⑰——列表层不放红绿灯）/ **mounts**（Record<planId, string[]> 挂载名列表）/ **snapshot**（进详情深拷贝）/ confirmDelete / renameDraft / menuPlanId（⋯ 菜单单开态）/ **saving**（SaveBar 保存中）
- **providers 数据源 + loaded 门控（[v0.0.349] T2）**：挂载 `useProviders()` 拉实时 providers（拉取失败仍渲染列表，error 仅日志）；`providersLoaded` 门控 dangling 预检/红描边——**未加载完成不判 invalid**（防加载窗口全量误判，异步集合作存在性校验须 loaded 标志；`lib/providers.ts` useProviders 返回 `{providers, error, loaded}`，loaded=首次拉取成功）。providers 透传给 editor（`providers?` prop：validatePlanLocal 二参存在性预检 + 逐行 invalid 判定，见 `component-model-routing-plan-editor.md`）
- **T4 退出/回退三分语义**（provider detail 对齐）：
  - SaveBar「保存」（`plan-editor-save`）= validatePlanLocal → reindexPriorities + circuit 空对象清理 → PUT → **清快照回列表**（风险点 1：保存成功后快照必清 null）→ reload
  - SaveBar「取消」（`plan-editor-cancel`，dirty 时可见）= **重置回快照留详情页**（resetToSnapshot：structuredClone 快照写回 plans，不退出）
  - 面包屑回退（`detail-back`，显示「模型组合方案库」可点）= cancelDetail：isNew → 从 plans 移除；否则回滚快照；清快照/status **回列表**（决策⑨取消语义保留在此）
- dirty 判定：`isPlanDirty(snapshot, draft)`（lib，JSON 内容比对；语义对齐 provider detail isDirty）
- i18n（`modelRouting` ns，zh/en 同步）：list.create/rename/copy/delete/loading/empty/**modelsCount「{{count}} 个模型」/mountedTo「已挂载到 {{names}}」/unmounted「未挂载」/moreActions**、editor.degradeOrder/timeCondition/circuit*5/defaultHint/addItem、validate.* 7 条、status.normal/abnormal/observing + titles、delete.*、deleteItem.*、time.popoverHeader/unselected/clearSchedule/confirm/errEmpty/errFull；详情页文案走 `group.model_routing_plans.label`（面包屑）+ common ns SaveBar（saveBar.save/cancel/saving/dirty）
- **T4 删除 key**：editor.back/save/cancel/detailTitle（旧 detail header 按钮组废弃，SaveBar common ns 替代）
- **v2 删除 key**：editor.nameLabel/timeLabel/timeAny/timeHours、time.helper/clearAll（被新交互替代）

## v2 已退役交互
- v1 单层列表 + 列表行红绿灯 statusMap 全量拉（改详情层单方案拉，决策⑰）
- v1 renameDraft 直接列表内行内编辑无快照（改名保留 inline 但卡片化；编辑污染由快照回滚修复）
- v1 edit 视图态（改 detail；无 name input——改名走卡片 ⋯ 菜单）

## 复用关系
- 组合：`component-plan-card`（列表卡片）、**`component-plan-detail`（详情独立页骨架：面包屑/logo 标题区/SaveBar 组装，风格基准 provider detail）**、`component-model-routing-plan-editor`（详情编辑器主体，条目 7 列行 + 熔断区，冻结不动）、`../common/component-confirm-modal`（方案删除确认）、`../common/component-save-bar`（variant="detail"，可选 saveTestId/cancelTestId 测试锚点——T4 additive props）、`model-routing-plan-lib`（validatePlanLocal/reindexPriorities/**isPlanDirty**）
- 数据：`model-routing-api`（list/save/delete/status/**listPlanMounts** + defaultPlanName/copyPlanName）、`model-routing-types`

## 消费方
- `app/web/src/components/app-dev-config-page/section-tab-panel.tsx`（models case：list 态两 group 并存渲染 `<SectionModelRoutingPlans onViewLevelChange={setPlansViewLevel} />`；detail 态独占渲染——providers detail 时本 section 隐藏，本 section detail 时 providers 区+标题隐藏；切 tab 重置防 stale）
- `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts`（L45 注释 + L47 `MODEL_ROUTING_PLANS_GROUP_ID = 'model_routing_plans'` 自渲染 group 常量，不进 KV_GROUPS/TAB_KV_GROUPS）
- studio 侧挂载（零改动）：`app/web/src/components/studio-page/component-manage-tab.tsx`（routingPlanId state + Dropdown nullableLabel「未挂载」+ PATCH `modelRoutingPlanId: routingPlanId ?? null`；见 `specs/ui/overall/06-studio.md §3.2`）
