# component-key-model-picker（model picker primitive）

> 层级: common primitive
> 文件: app/web/src/components/common/component-key-model-picker.tsx

> **使用范围（v0.0.230 验收返工起）**：playground 默认模型（default_models.chat）已改用统一的
> `chat/ModelPicker`（清除交互在外层包，见 `app-dev-config-page/section-default-models-and-request.md`）；
> 本组件现仅 consolidation（整理配置 modelId 行）使用。

## 职责
配置页 key 卡片形式的 model 选择器 primitive。trigger button + dropdown 菜单（按 provider 分组）+ x 清除按钮。选了模型后右侧显示 x，点 x 清空字段（`onChange(undefined)`）。

## Props
- value?: string
- onChange: (next: string | undefined) => void
- testIdSuffix: string

## 视觉基线
- **trigger（`ModelPickerTrigger` primitive）**：高 32px，白底  +  + radius-md；已配 → 左侧 22px IconBox（provider hash 8 色之一） + mono `${providerLabel} / ${modelLabel}` + 右侧 chevron；未配 → placeholder「未配置」（muted 色）+ chevron，无 IconBox
  - 降级：value 存在但 providers 未加载/被删 → 无 IconBox 但仍显 modelId 文本
- **x 清除按钮**：trigger 右侧， × 号；始终渲染
- **菜单（`ModelPickerPanel` primitive）**：300px 白卡（regulation 02 §7）， +  +  + ，顶部搜索框（`searchable=true`），列表项 = 24px IconBox + mono 13px 模型名 + mono 11px modelId 副标 + 黑色 ✓（selected）+  active 底
