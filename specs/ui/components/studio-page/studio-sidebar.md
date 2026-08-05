# studio-sidebar

> 层级: section
> 文件: app/web/src/components/studio-page/section-studio-sidebar.tsx

## 职责
Studio 左中栏（~224px）：头部「小队」标题 + 新建按钮；列表渲染每个 squad 的**单行**（无展开树）。
点 squad 行 → 上抛 `onSelectSquad`，page-studio 落首页 seats（IA 决策 D6，`{kind:'seats', squadId}`）。
边界：squads 列表由 page-studio 传入；本组件不管展开态 / detail 缓存 / SSE 消费；chat/board 入口全部改为首页坐席卡与团队入口卡。

## Props
- squads: SquadSummary[]
- selectedSquadId: string | null
- onSelectSquad: (id: string) => void
- onNewSquad: () => void

## 状态 / 交互
- 无本地展开态；点 squad 行 → `onSelectSquad(squad.id)`（page-studio 落 `{kind:'seats', squadId}` + reload detail）。
- squad 行支持键盘可达：`role="button"` + `tabIndex={0}` + `Enter`/`Space` 触发同 onClick。
- `expandedId` 单值手风琴 state / detail 懒加载缓存 / dataVersion effect 清缓存 / 未读红点 / 右键浮层菜单（本组件不再持）。

## 视觉基线
- **容器**：宽 (224px) +  + 右 ，flex column。
- 树节点 padding/字号 / TreeChild MemberAvatar / BoardNode target 图标 / 未读红点 / running spinner / suspended 「?」标记。

## 复用关系
- 被组合: `page-studio`
- 组合: `studio-icons`（squad 行图标 + 新建按钮 plus 图标）
- : `component-squad-tree`（组件文件已移入 `soft_deleted/v0.0.168/`）；`common/member-avat
