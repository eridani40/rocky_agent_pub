# component-plugin-item

> 层级: component
> 文件: app/web/src/components/plugin-config-page/component-plugin-item.tsx

## 职责
单个插件项卡片：插件名称 + 描述 + 启用开关。
边界：只管展示一个 plugin + 转发 toggle；**不感知其他 plugin**（独立性是关键）。

## Props
- plugin: { id: string; name: string; desc: string; enabled: boolean }
- onToggle: (next: boolean) => void
- disabled?: boolean

## 状态 / 交互
- 开关点击 → `onToggle(!enabled)`
- **关键约束：每个 plugin 开关完全独立**。父级 section-plugin-list 必须给每个 plugin 维护独立的 `enabled`，**严禁多个 plugin 共享同一 state 字段**——这是旧版「两个 plugin 开关联动」的根因
-  disabled=true：ToggleSwitch disabled（点击/键盘均不触发 onToggle），整卡片 opacity-60 视觉只读提示。用于配置只读化（plugin 启停代码声明）

## 复用关系
- 被组合：`section-plugin-list`
- 组合：（生产用其替代内联开关）
