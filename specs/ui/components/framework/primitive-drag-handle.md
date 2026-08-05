# primitive-drag-handle

> 层级: primitive
> 文件: app/web/src/components/framework/primitives/drag-handle.tsx

## 职责
拖拽手柄：grip 图标（⋮☰）视觉 + draggable 钩子，用于 ordered 列表项排序。
边界：只提供「可被拖拽」的视觉与交互入口；**排序逻辑由父级 ordered 列表组件实现**（本组件不维护列表顺序）。

## Props
- testId?: string;   // 默认 'drag-handle'

## 状态 / 交互
- 视觉：grip 图标，（拖拽中 ）
- draggable：`draggable` 属性示意，真实拖拽排序由父级配合 HTML5 DnD 或 dnd-kit 实现（spec 聚焦视觉与入口）
- hover 时图标  →  强调

## 复用关系
- 被组合：`component-ext-impl-ordered`（plugin 扩展点 impl 的 ordered 排序项）
- 组合：无
