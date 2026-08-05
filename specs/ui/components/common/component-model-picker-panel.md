# component-model-picker-panel

> 层级: primitive
> 文件: app/web/src/components/common/component-model-picker-panel.tsx

## 职责
模型选择「展开态」panel primitive：**300px 白卡**（默认宽，；消费方可 override 到自适应），`radius-lg` +  +  + 。内含：
1. **可选顶部搜索框**（`searchable=true` 时渲染，本地过滤 items）
2. **可选顶部题目行**
3. **可选 extraTopItems 区**（用于「继承默认」/「a(默认)」等特殊置顶项，出现在常规 items 之上并加分割线）
4. **常规 items 列表**：每行 = 24px IconBox（provider hash 色）+ mono 13px 模型名 + 可选 meta（如 "free"）+ 选中态黑色 ✓；hover ，active/selected

## Props
- providerId: string
- providerLabel?: string;   // 可选（分组场景用；InputModelPicker 常规平铺不用）
- modelId: string
- modelLabel: string;       // 展示用（若 provider 未给 label 就 fallback modelId）
- meta?: string;            // 右侧小字，如 "free" / "beta"
- key: string;              // React key
- label: string;            // 展示文本（消费方已 i18n 好）
- onClick: () => void
- selected?: boolean;       // selected 高亮
- testId?: string;          // 可选覆盖 testid
- items: PickerItem[]
- value?: { providerId: string; modelId: string } | null
- onPick: (item: PickerItem) => void
- panelTestid: string

## 状态 / 交互
- **受控 open**：panel 只在消费方渲染时挂载；关闭由消费方 `open=false`（本 panel 不管闭合）
- **搜索**：本地 `useState<string>('')`，实时过滤 items 的 `modelLabel + providerLabel + modelId` 三字段（大小写不敏感）；搜索框清空 = 显全量
- **extraTop 与常规 items 之间有  分割**（仅当两者都非空）
- **empty**：搜索过滤后剩 0 项且 extraTop 也空 → 显 `emptyMessage`（若给）
- **键盘 / 焦点**：本版本不实现键盘导航（沿用旧实现的鼠标交互），后续可扩展

## 视觉基线
  - IconBox size=24（provider hash 色）
  - 选中 ✓：（黑色，非彩色，regulation 02 §1）
- **无 hex**：所有色走 `var(--*)` / tailwind    alias

## 复用关系
- 组合：`component-icon-box`（provider 图标）
