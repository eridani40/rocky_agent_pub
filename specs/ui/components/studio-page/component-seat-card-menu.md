# component-seat-card-menu

> 层级: primitive（SeatCard「更多」菜单弹层，v0.0.168 拆分）
> 文件: app/web/src/components/studio-page/component-seat-card-menu.tsx

## 职责
坐席卡「更多」按钮触发的 fixed 定位 popover。按 role/state 组合渲染菜单项：
- 编辑（`onEdit` 提供时）
- bench
- deploy（**仅 member.state === 'benched' && onDeploy 提供**）
拆分自 `component-seat-card.tsx`（原文件加菜单后超 300 行）。菜单开关状态 + 关闭监听归父级（SeatCard），本组件仅纯展示 + 关按钮 stopPropagation 防事件冒泡关自己。

## Props
- member: Member
- isLeader: boolean
- anchor: { x: number; y: number; openUp?: boolean }
- onEdit?: (member: Member) => void
- onBench?: (member: Member) => void
- onDeploy?: (memberId: string) => void
- onClose: () => void

## 视觉基线
- z-index：`var(--z-popover)`
- 无 hex，无 animate class（INV-3 严肃基调）
