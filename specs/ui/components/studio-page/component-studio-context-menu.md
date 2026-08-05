# component-studio-context-menu

> 层级: primitive（可能被任何持 sessionId 的 studio 触发点消费）
> 文件: app/web/src/components/studio-page/component-studio-context-menu.tsx

## 职责
Studio 复制 Session ID 的右键浮层菜单——`fixed` 定位（左上锚点 x/y）+ 单菜单项「复制 Session ID」→ `navigator.clipboard.writeText(sessionId)` + `onClose`。
> 触发点从侧栏 chat 树节点（`squad-tree-session-*` 右键）迁到**首页坐席卡**与**群聊入口**；群聊触发点自团队入口 link 挪入队长卡群聊按钮：
> - 坐席卡（`seat-card-{memberId}`）右键 → 复制该 member session id
> - 队长卡群聊按钮右键 → 复制 squadChat session id
> - 侧栏 squad 行（无 sessionId）+ 看板入口卡（`seat-team-entry-board`，无 sessionId）不接右键（浏览器默认菜单）

## Props
- sessionId: string
- x: number
- y: number
- onClose: () => void

## 状态 / 交互
- **关闭监听**：`useEffect([onClose])` 内 `setTimeout(0)` 后挂 window `click` / `contextmenu` / `keydown(Escape)`——**setTimeout(0) 延迟必需**：躲开「打开菜单的同一次 click / contextmenu 事件」冒泡到 window 立刻触发关闭 bug。cleanup 清 timer + 三个 listener。
- **无状态其他**：不持 open 布尔（父级传入 = 渲染，null 隐藏）。

## 视觉基线
- **z-index**：。

## 复用关系
- 被组合: `component-seats-panel.tsx`（seats-panel 持 contextMenu state + 渲染 primitiv
- 组合: 无（纯 UI + i18n）
- 触发上抛（自坐席卡 / 队长卡群聊按钮 → SeatsBody `onContextMenu` prop → SeatsPanel `openContext
