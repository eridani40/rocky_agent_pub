---
type: spec
title: component-seat-row — mate 坐席行
priority: P1
status: deprecated
updated: 2026-08-09
since: v0.0.170
---

> **DEPRECATED（v0.0.288 重构后零引用，代码待清理）**：首页成员列表/坐席卡已由 `component-member-roster-list.tsx`（MemberRosterList 三分区）取代；`component-seat-row.tsx` 生产代码无任何 import。本文保留作历史契约。

# component-seat-row

> 层级: component
> 文件: app/web/src/components/studio-page/component-seat-row.tsx

## 职责
单条 mate 坐席行（roster 行列表的一行）：avatar + presence 点 → who 列（名 + `role · state`）→ status 列（脉冲点 + statusText 单行）→ ops 列（进入对话 solid + 更多 outline icon → 弹菜单）。
**只服务 mate**。
菜单项规则与 SeatCard 完全一致。
边界：纯展示 + 回调上抛；数据只收 `row: SeatRow`（use-seats-data 派生），组件不自行派生；不 fetch；行根**无整行 onClick**（交互只走按钮）。

## Props
- row: SeatRow
- onEnter: () => void
- onEdit?: (member: Member) => void
- onBench?: (member: Member) => void
- onDeploy?: (memberId: string) => void
- onContextMenu?: (sessionId: string, x: number, y: number) => void

## 状态 / 交互
- **ops hover 揭示（布局稳定，_conventions §11）**：ops 列**恒渲染**，——只变透明度不占位变化；**focus-within 同样揭示**（键盘 tab 到按钮时可见，键盘可达）
- **offline 行**：根 `opacity-75`；「进入对话」降 secondary 型（白底灰边），不用 primary solid
- **右键**：行根 onContextMenu → preventDefault + 上抛 `(member.sessionId, clientX, clientY)`
- **「更多」菜单**：与 SeatCard 完全同机械——`use-seat-menu`+ `SeatCardMenu` portal 弹层；菜单项按 role/state 组合渲染（见 component-seat-card-menu.md）
- **status 列文案**：`currentWork.text` 优先（fg-3）；空则 i18n `seats.status.{presence}` 兜底（此时 muted-2 弱化，对齐设计稿 `.st.idle`）
- **脉冲点**：CSS-only 静态 `box-shadow` 光晕（**无 @keyframes**——INV-3），颜色 `--presence-*`
- **running spinner**：`row.isRunning=true` → name 后挂 `<SpinnerRing size="sm">`（复用 `common/spinner-ring.tsx`，10×10， 占位防位移 INV-9）。**`isRunning` = `isRunningState(sessionState)` = `state ∈ {running, interrupting}`，deliberately 排除 suspended**。**区别于 `presence='busy'`**：busy 含 suspended（用于 inProgressCount 统计 + 脉冲点颜色），isRunning 不含——两概念有意分离，禁合并。派生源：`use-seats-data.ts` 的 `isRunningState`（export 纯函数），stateMap 来自 `useStudioUnreadMeta`。

## 视觉基线
- 行：`flex items-center gap-3 padding: 10px 16px`；行分隔 1px `--surface-2`（末行无）；hover 行底 `--bg`(#fafafa)（transition-colors，不改内边距/字号）
- who 列：；名行 =  容器内 = 名 Inter 13.5px/600 fg 单行 truncate + 可选 running spinner；meta `role · state` Inter 11.5px muted-2
- status 列：；脉冲点  + 文案 Inter 12.5px 单行 truncate（currentWork=fg-3 / fallback=muted-2）
- 无 hex 硬编码；无 keyframes/无动画类

## 消费方

无（零引用，疑似死代码）。
