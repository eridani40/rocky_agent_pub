# component-autowork-tab（自动工作 tab 容器 — toggle + heartbeat-config + budget + history 四块组合）

> 层级: component（squad-panel「自动工作」tab 内容容器；v0.0.57 新建）
> 文件: app/web/src/components/studio-page/component-autowork-tab.tsx

## 职责
squad-panel「自动工作」tab 的**组合容器**：垂直堆叠四块——`squad-autonomy-toggle`（总开关）+ `heartbeat-config`（squad 级心跳配置：间隔/时段/范围）+ `budget-meter`（预算配置 + 实时仪表）+ `auto-work-history`（心跳唤醒历史）。
边界：
- **纯容器**：只透传 `detail` / `onSaveMeta` 给子组件，自身无数据流、无状态、无副作用。
- 四块各自管数据流。
- **heartbeat-config 从 member-panel 迁入本容器**（心跳升级 squad 级；member-panel 不再有心跳 section）。

## Props
- detail: SquadDetail
- onSaveMeta: (patch: PatchSquadBody) => Promise<void>;  // 透传给 SquadAutonomyTo...

## 状态 / 交互
- 无本地态。容器只组合（**四块**）：

## 视觉基线
- 容器：（三块垂直堆叠，块间距 20px）。
- 三块视觉零改。
- demo 是方向原型（非设计师权威稿），不强制自动 vision_check compare；用户 E2E 自测代替（test-plan §3 / §5）。

## 复用关系
- **被组合**：`component-seats-panel`（首页 SeatsPanel `activeTab === 'autowork'` 分支直接渲
- **交叉引用**：与 `component-manage-tab`（管理 tab）平级；`onSaveMeta` 与 manage-tab 共用（PATCH
