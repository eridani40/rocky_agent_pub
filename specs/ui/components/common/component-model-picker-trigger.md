# component-model-picker-trigger

> 层级: primitive
> 文件: app/web/src/components/common/component-model-picker-trigger.tsx

## 职责
模型选择「收起态」trigger primitive：**白底 + border-2 边 + radius-md**，内含：
- 左侧 **22px IconBox**（provider hash 派生 8 色之一，`hueBy=providerId`；未配时不渲染 IconBox）
- 中间 **mono 13px 模型名**（或 placeholder）；单行、超长 truncate
- 右侧 **下拉箭头（chevron down）**（size 13px muted）
**边界**：受控 `onClick` 展开／收起由消费方管理；纯展示；无 hex 硬编码；无 hover preview / 无点击外部关闭逻辑（那些是消费方职责）。

## Props
- value?: {
- providerId: string;   // 用于 IconBox hueBy hash
- modelId: string
- modelLabel: string;   // 展示文本（消费方拼好，如 `${providerLabel} / ${modelLabel}`）
- placeholder?: string
- disabled?: boolean
- onClick: () => void
- testId: string
- ariaLabel?: string
- title?: string
- size?: TriggerSize
- className?: string
- ariaHaspopup?: 'listbox' | 'menu' | 'true'
- ariaExpanded?: boolean

## 状态 / 交互
- 纯展示：点击调 `onClick`，不持有 open state
- `disabled=true`：视觉降透明 + ，onClick 不触发
- `value=null` + ：显 placeholder 文本 + chevron，不渲 IconBox（留空避免误导「已配了某 provider」）

## 视觉基线
  - `sm`：（chat-input 场景，未来备用）
- **IconBox**：size=22（hueBy=value.providerId），不显 icon（无 SVG，纯浅底色块，仅用作 provider hash 分色的视觉锚）

## 复用关系
- 组合：`component-icon-box`
- **不被** `chat-page/component-input-model-picker.tsx` 组合（chat 输入区特例保 21px BrainI
