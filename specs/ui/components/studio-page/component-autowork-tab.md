# component-autowork-tab（自动工作 tab 容器 — dirty 管理者 + 四块组合）

> 层级: component（squad-panel「自动工作」tab 内容容器；v0.0.57 新建）
> 文件: app/web/src/components/studio-page/component-autowork-tab.tsx
> **[v0.0.292] GroupChatToggle 迁出**：群聊可见性开关从本 tab 删除，挪入 manage-tab（元信息编辑区后、危险操作区前）。本 tab 从五块→四块。
> **[v0.0.316] 方案 A**：从「纯容器」提升为「dirty 管理者」——3 子组件改受控上报，本组件持 draft + dirty + save + cancel + 底部统一保存按钮。

## 职责
squad-panel「自动工作」tab 的**组合容器 + dirty 管理者**：垂直堆叠四块——`squad-autonomy-toggle`（总开关）+ `heartbeat-config`（squad 级心跳配置）+ `budget-meter`（预算配置 + 实时仪表）+ `auto-work-history`（心跳唤醒历史）+ **底部统一保存/取消按钮**。

> **[v0.0.316] 核心变化**：本组件从纯容器提升为 dirty 管理者——持 3 draft useState（enableHeartBeat / heartbeatConfig / budget），聚合 dirty；3 子组件改受控（上报 onChange）；底部新增统一保存/取消按钮（BTN_PRIMARY 风格，dirty 高亮，saving 禁用）。

边界：
- **dirty 管理**：持 3 个独立 draft useState（D2：不合并为单一对象，避免每次改一字段 spread 整个对象）；dirty 派生 = 三字段各自 !== detail 对应字段（复合对象 JSON.stringify 比较）。
- **统一 save**：一次 PATCH 合并 3 字段（enableHeartBeat + heartbeatConfig + budget）。
- **cancel**：draft 回 detail 原值（3 useState reset）。
- **detail 外部变化同步**：useEffect `[detail]` → 保存成功后父级 refresh 回灌时重置 3 draft。
- auto-work-history 只读，不纳入 dirty。

## Props
```ts
interface AutoworkTabProps {
  detail: SquadDetail;
  /** 统一保存（PATCH /squad 合并提交） */
  onSaveMeta: (patch: PatchSquadBody) => Promise<void>;
}
```

## 状态 / 交互
- 3 个 draft useState：`enableHeartBeatDraft` / `heartbeatConfigDraft` / `budgetDraft`（init = detail 对应字段）。
- `saving: boolean` + `saveError: string | null`。
- dirty 派生（三字段比较）。
- save()：一次 PATCH 合并 3 字段。
- cancel()：3 draft 回 detail 原值。
- 子组件 JSX 改受控（传 draft 值 + onChange）。
- 底部保存/取消按钮（AutoWorkHistory 之后，`flex justify-end`，dirty 高亮 + saving 禁用）。

## 视觉基线
- 容器：（五块垂直堆叠，块间距 20px）。
- 五块视觉零改。
- demo 是方向原型（非设计师权威稿），不强制自动 vision_check compare；用户 E2E 自测代替（test-plan §3 / §5）。

## 复用关系
- **被组合**：`component-seats-panel`（首页 SeatsPanel `activeTab === 'autowork'` 分支直接渲
- **交叉引用**：与 `component-manage-tab`（管理 tab）平级；`onSaveMeta` 与 manage-tab 共用（PATCH
- **组合（child）**：`component-squad-autonomy-toggle` + `heartbeat-config` + `budget-meter` + `auto-work-history`。（**[v0.0.292] GroupChatToggle 迁出到 manage-tab**；**[v0.0.316] 3 子组件改受控：传 draft 值 + onChange 上报，不再自管 PATCH/save**）

## 消费方

- `app/web/src/components/studio-page/component-seats-panel.tsx`
