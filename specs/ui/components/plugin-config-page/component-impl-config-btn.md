# component-impl-config-btn

> 层级: component
> 文件: app/web/src/components/plugin-config-page/component-impl-config-btn.tsx

## 职责
impl 卡片的「齿轮配置入口」按钮（radio/checkbox/ordered 三类 ext-impl 项内共用）。点击触发父级 `onConfig(implId)` → 父级（`section-ext-point-area`）挂载 `component-schema-config-modal` 打开该 impl 的 configSchema 弹层。
边界：只管「点击转发 + 视觉」，不感知 modal 开合（父级管），不感知 schema 形状（modal 自行从 configSchema.properties 推导控件）。按钮自身 `stopPropagation` 防止冒泡到外层 impl 卡片的 onChange/toggle。

## Props
- implId: string
- onClick: (implId: string) => void

## 状态 / 交互
- 渲染：28×28 圆角按钮 + 齿轮 icon（14×14 stroke 当前色）
- 视觉（对齐设计稿 `.impl-config-btn`）： +  + ；hover → accent 边框/字/accent-surface 底
- 点击：`e.preventDefault + e.stopPropagation` 防冒泡到外层 impl 卡片（否则会触发 radio/checkbox/toggle 误翻转），然后调 `onClick(implId)` ## 复用关系

## 消费方
- `app/web/src/components/plugin-config-page/component-ext-impl-checkbox.tsx`
- `app/web/src/components/plugin-config-page/component-ext-impl-ordered.tsx`
- `app/web/src/components/plugin-config-page/component-ext-impl-radio.tsx`
