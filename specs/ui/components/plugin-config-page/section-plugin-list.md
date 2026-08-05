# section-plugin-list

> 层级: section
> 文件: app/web/src/components/plugin-config-page/section-plugin-list.tsx

## 职责
插件 tab 的插件列表区。遍历 plugins 渲染 `component-plugin-item`。
**数据源**：REST CRUD 无 SSE——本组件是受控展示，plugins 列表来自父级 `page-plugin-config` 挂载 `GET /config/plugin` inventory 的 `plugins[]`；toggle 上抛父级（v0.0.67 全页只读化后 toggle 实为 noop）。无 SSE。
边界：不直接持有开关状态，toggle 事件上抛 `onToggle`。

## Props
- plugins: { id: string; name: string; desc: string; enabled: boolean }[]
- onToggle: (pluginId: string, next: boolean) => void
- disabled?: boolean

## 状态 / 交互
- 纯展示 + 转发 toggle
- 每个 plugin 开关**独立**（约束见 component-plugin-item）
-  disabled=true：透传给所有 component-plugin-item（plugin toggle 全 disabled，配置只读化）

## 复用关系
- 组合：`component-plugin-item`（逐个 plugin）
