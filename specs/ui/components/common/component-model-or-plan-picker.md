---
name: component-model-or-plan-picker
type: component
consumers:
  - app-dev-config-page/section-default-models-and-request（playground 默认模型 chat 行，ns=app-dev-config）
  - studio-page/component-manage-tab（squad 管理 tab 默认模型行，ns=studio）
since: v0.0.347 (T6)
---

# ModelOrPlanPicker — 模型/方案合并单 select（严格互斥二选一）

> 老板 21:44 拍板「二选一，放在一个 select 里面（上面是模型下面是方案）」+ 22:22「必须只保留一个有效的」。
> 决策㉕：新组件，不扩展 ModelPicker/Panel；㉛：严格互斥由消费方/hook 落（组件只发回调）。

## 何时用

同一配置位要么选「默认模型」要么挂「路由方案」时用本组件替代 ModelPicker——单 select 两组（上「模型」下「方案」）。

## Props

```ts
interface ModelOrPlanPickerProps {
  value: ModelOrPlanValue | null;          // 当前值（null=未设置态 placeholder）
  plans: { id: string; name: string }[];   // 方案清单（消费方各自 listModelRoutingPlans 后映射）
  onPickModel: (sel: ModelSelection) => void;
  onPickPlan: (planId: string) => void;
  ns?: 'app-dev-config' | 'studio';        // i18n 命名空间（modelOrPlan.* 5 keys 双 ns 同构；默认 app-dev-config）
  actionKey?: string;                      // trigger data-action-key（E2E 锚点）
  triggerClassName?: string;               // trigger 宽度覆盖（v0.0.344 范式；缺省 w-[180px]）
}
type ModelOrPlanValue =
  | { kind: 'model'; selection: ModelSelection }
  | { kind: 'plan'; planId: string; planName: string };
```

**互斥写语义不在组件内**——组件只发 onPickModel/onPickPlan；清对侧 draft 由消费方（manage-tab pick 合一 / hook handleMountChange 双向清）负责。

## 结构

- **trigger**：复用 `ModelPickerTrigger`（不自创）。显示：模型 = formatModelDisplay「provider / model」；方案 = 「方案 · <名>」（planName 空时经 plans 反查 → planId 兜底）；未选 = placeholder「选择模型或方案」（`modelOrPlan.placeholder`）。
- **panel**（300px 白卡，class 复刻 ModelPickerPanel：`w-[300px] bg-surface border border-border rounded-lg shadow-lg py-1 overflow-hidden`）：
  - 搜索框（h-[30px] text-[12.5px]，复刻三字段过滤 + 方案 name/id）
  - 上组「模型」（`modelOrPlan.groupModels`）：useProviders 展平 + 双层 enabled!==false 过滤；行 = IconBox 24px + mono text-[13px]（provider / model），aria-selected 比对 providerId+modelId
  - 下组「方案」（`modelOrPlan.groupPlans`）：行 = 方案名，aria-selected 比对 planId；**空 → 组标题恒显 + 「暂无方案」**（`modelOrPlan.emptyPlans`，不隐藏组标题）
  - 组标题 `px-3 py-1.5 text-xs text-muted select-none border-b border-border`
- 外点关闭（wrapRef 范式）；选中即收起。

## i18n（modelOrPlan.*，双 ns 同构）

| key | zh-CN | en |
|---|---|---|
| groupModels | 模型 | Models |
| groupPlans | 方案 | Plans |
| placeholder | 选择模型或方案 | Select a model or plan |
| emptyPlans | 暂无方案 | No plans yet |
| planPrefix | 方案 | Plan |

actionKey 体系：行级 `common.model-or-plan.pick-model` / `common.model-or-plan.pick-plan`；搜索 `common.model-or-plan.search`。

## UT

`app/web/src/components/common/__tests__/component-model-or-plan-picker.test.tsx`（15 例：两组渲染/选择回调/双向高亮/空态/两组过滤/外点收起/trigger 显示 6 态）。
