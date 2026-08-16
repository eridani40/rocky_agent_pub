# component-circuit-status

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-circuit-status.tsx

## 职责
熔断状态红绿灯呈现（v0.0.347 模型路由）。消费 status 端点 presentation 字段，呈现**用户友好状态词**（D16 presentation 权威映射，禁熔断词）：
- normal → 🟢 正常（无倒计时）
- abnormal → 🔴 异常（带倒计时 remainingSeconds，每秒刷新）
- observing → 🟡 观察中（无倒计时）
边界：纯展示组件；数据（presentation/remainingSeconds）由父级拉取传入。

## Props
- presentation: CircuitPresentation   // 'normal' | 'abnormal' | 'observing'
- remainingSeconds?: number           // open 时剩余秒数（abnormal 才有；倒计时本地每秒递减）
- tickMs?: number                     // 测试注入：倒计时 tick 间隔（ms），默认 1000

## 导出
- CircuitPresentation 类型：'normal' | 'abnormal' | 'observing'（对齐 api §2.6 D16 权威值）

## 状态 / 交互
- abnormal 带倒计时：接收服务端 remainingSeconds 快照后本地每秒递减，到 0 显示 0s
- 服务端只给快照，本地 countdown state 递减；remainingSeconds 变更时重置
- 测试锚点：`data-testid="circuit-status"` + `data-presentation="<presentation>"`

## 复用关系
- 被组合：`component-plan-item-row`（UI v2 col-circuit 按条目 providerId+modelId 匹配渲染；决策⑰——详情层单方案拉 status，列表层不放红绿灯）

## 消费方
- `app/web/src/components/app-dev-config-page/component-plan-item-row.tsx`（UI v2 起；v1 直接消费方 section-model-routing-plans 已随列表红绿灯区退役）
