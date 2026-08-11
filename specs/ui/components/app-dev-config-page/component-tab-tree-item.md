# component-tab-tree-item（tab 树单项）

> 层级: component
> 文件: app/web/src/components/app-dev-config-page/component-tab-tree-item.tsx

## 职责
应用设置页左侧 tab 树的单项 button。受控组件（selected 由父级管理），点击上抛 onSelect。视觉态：active（选中高亮）/ inactive（hover 浅底）。通用区 item 与系统设置区（收起区）item 共用本组件，差异仅在挂载位置。

## Props
- tabId: string
- label: string
- active: boolean
- onSelect: () => void

## 视觉基线
- active： + 左 3px accent 竖条
- 字体 weight 仅 400/600（收敛，禁 serif/mono）

## 消费方
- `app/web/src/components/app-dev-config-page/page-app-settings-merged.tsx`
