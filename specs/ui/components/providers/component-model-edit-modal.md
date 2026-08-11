# component-model-edit-modal

> 层级: component
> 文件: app/web/src/components/providers/component-model-edit-modal.tsx
> 参考: specs/ui/components/providers/_overview.md §5

## 职责
model 编辑弹层：底部「确定」回写父级 draft（**不调后端、非保存**）+ 「取消」。
边界：只产出 model draft 给父级；不感知 provider、不持久化。
新增(model=null) → modelId 可编辑；编辑(已有 model) → modelId 只读（diff 配对 key）。

## Props
- modelId: string
- contextWindow: number
- maxOutputTokens: number
- label: string
- enabled: boolean
- model: ModelInstance | null;       // null=新增
- onConfirm: (model: ModelInstance) => void
- onCancel: () => void

## 状态 / 交互
- 字段：label / modelId / contextWindow(number) / maxOutputTokens(number) / enabled(checkbox)
- modelId 新增可编辑 / 编辑只读
- valid = modelId 非空 && label 非空（确定按钮 disabled 控制）
- 取消/外部点击关闭：`onCancel` ## 视觉基线
> 无版本设计稿 → 沿用 v0.0.7 既有 modal 规格（参考 reqs/v0.0.7/easy-opc-config-v6b.html modal + f-input）。

## 复用关系
- 被组合：component-provider-detail（model 添加/编辑入口）
- 不组合其他 component（最末端渲染层）

## 消费方
- `app/web/src/components/providers/component-provider-detail.tsx`
