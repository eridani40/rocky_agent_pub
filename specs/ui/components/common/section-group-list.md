# section-group-list

> 层级: section
> 文件: app/web/src/components/common/section-group-list.tsx

## 职责
通用 group 列表区块：纵向排列多个 group，点选切换当前 group。app-dev config 的 config group 与 plugin config 的扩展点 group 共用本组件（两者结构一致：一组可选项，选中一个）。
边界：只管列表展示 + 选中态转发；不含 group 内部内容渲染。

## Props
- groupId: string;     // group 唯一标识（app-dev: config group id；plugin: 扩展点 id）
- groups: GroupItem[];                // 全部 group
- selected: string;                   // 当前选中 groupId
- onSelect: (groupId: string) => void

## 状态 / 交互
- 点击某 group → `onSelect(groupId)`
- 左竖条始终预留 1px 占位，切换选中不位移（同 nav-rail 布局稳定性约束）

## 复用关系
- 组合：`component-group-list-item`（逐项渲染）
- 被组合：`section-config-layout`（app-dev config）、`section-ext-point-area`（plugin 扩展
