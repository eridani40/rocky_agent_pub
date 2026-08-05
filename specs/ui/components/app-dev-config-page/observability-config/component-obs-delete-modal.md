# component-obs-delete-modal

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/observability-config/component-obs-delete-modal.tsx
> 视觉契约: reqs/v0.0.11/easy-opc-config-v10.html L440-456（modal）

## 职责
删除可观测性配置的二次确认 modal。点遮罩 / 取消 / 关闭 → 取消；「确认删除」→ 执行删除。

## Props
- target: ObservabilityConfig;   // 待删项
- onCancel: () => void
- onConfirm: (id: string) => void

## 状态 / 交互
- 遮罩点击 → `onCancel`；modal 内点击 `stopPropagation`。
- 「取消」按钮 → `onCancel`；关闭图标 → `onCancel`。
- 「确认删除」按钮（danger）→ `onConfirm(target.id)`。
- 按 ESC → `onCancel`（标准 modal 行为）。
