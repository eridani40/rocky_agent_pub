# studio-sidebar

> 层级: section
> 文件: app/web/src/components/studio-page/section-studio-sidebar.tsx
> since: v0.0.168 单行列表 · v0.0.305 视觉升级（B 方案头像+两行+排序+置顶）

## 职责
Studio 左中栏（w-56 ~224px）：头部「小队」标题 + 新建按钮；列表渲染每个 squad 的**两行行卡片**（彩色字母头像 + 团队名 + 「X 在线 · Y 工作中」状态行）。
点 squad 行 → 上抛 `onSelectSquad`，page-studio 落首页 seats（IA 决策 D6，`{kind:'seats', squadId}`）。
边界：squads 列表由 page-studio 传入；本组件不管展开态 / detail 缓存 / SSE 订阅本身（只消费 page-studio 下发的 `getAgg` 聚合数据）；chat/board 入口全部改为首页坐席卡与团队入口卡。

## Props
```ts
interface StudioSidebarProps {
  squads: SquadSummary[];                        // 列表（含 [v0.0.305] 3 个 optional 聚合字段）
  selectedSquadId: string | null;
  onSelectSquad: (id: string) => void;
  onNewSquad: () => void;
  /** [v0.0.305] squad 聚合数据取数回调（统一数据源；optional 旧消费方兼容）。
   *  page-studio 传 `getAgg(squadId) = aggregateMap[squadId] ?? squads.find(id) 的 3 字段` */
  getAgg?: (squadId: string) => SquadAggregate | undefined;
}
```

## 状态 / 交互

### 行卡片（SquadRow，v0.0.305 B 方案）
- **头像**：32×32（`h-8 w-8`）圆角 8px（`rounded-lg`），团队名**首字符**（trim 后 charAt(0)，中文取首字、英文取首字母大写；空名兜底 `#`），白字 14px font-bold，底色 = `hashHueIndex(squad.id)` 8 色 palette（`var(--hue-{name})`，复用 hue-hash 单例，INV-5 不重复实现）。
- **第一行**：团队名 15px `font-semibold`，`truncate`；选中态 `text-accent`。
- **第二行**：`X 在线 · Y 工作中` 11px `text-muted`（i18n `sidebar.status` 模板变量 `{{online}}/{{working}}`）；**Y>0 时**「工作中」数字旁加**橙色脉冲圆点**（8px `bg-orange` + `animate-pulse` + `aria-hidden`，仅视觉装饰不参与布局）。
- **第二行渲染条件**：`onlineCount !== undefined && inProgressCount !== undefined` 才渲染（旧后端无字段 → 只显示名字，不 crash，PRD §6）。
- 点行 → `onSelectSquad(squad.id)`（page-studio 落 `{kind:'seats', squadId}` + reload detail）。键盘可达：`role="button"` + `tabIndex={0}` + `Enter`/`Space` 触发同 onClick。

### 排序（useMemo，`sortSquads` 纯函数）
```
排序 = [置顶组（pin 顺序，组内 lastActiveAt desc）] + [非置顶组（lastActiveAt desc）]
```
- 排序键 `sortKey = agg?.lastActiveAt ?? squad.lastActiveAt ?? squad.updatedAt`（SSE 值优先，GET 兜底，旧后端降级 updatedAt = 现状）。
- 未知 squadId（pin 列表有但 squads 没有）渲染时忽略（不写回，惰性清理）。

### pin 置顶（localStorage）
- **按钮**：行右侧 hover 显隐（`opacity-0` 未 hover 未 pin / `opacity-100` hover 或已 pin）；**`style={{visibility:'visible'}}` 恒占位不位移**（禁 display:none 入常规流，对齐布局稳定性铁律）。
- **icon**：pin 态 = 实心 `pin-filled` accent / 未 pin = 空心 `pin` muted；aria-label = i18n `sidebar.pin` / `sidebar.unpin`。
- **点击**：`e.stopPropagation()`（不触发 onSelectSquad）→ toggle：已 pin 移除、未 pin 插入头部 → 写 localStorage `studio.squadPins`（JSON string[]；损坏 → [] 不 crash）→ 立即重排。

## 视觉基线
- **容器**：`w-56 flex flex-col border-r border-border bg-surface`；头部 px-4 pb-3 pt-4（mono 11px uppercase 标题 + plus 新建按钮）。
- **行**：`px-2.5 py-2 rounded-lg` + 选中 `bg-accent-surface` / hover `bg-bg-warm`；行高两行 ~48px。
- **头像**：`flex h-8 w-8 items-center justify-center rounded-lg text-[14px] font-bold text-white` + `background: var(--hue-{name})`。
- 第二行：`mt-0.5 flex items-center gap-1 text-[11px] leading-tight text-muted`。
- 空态：`sidebar.empty` 文案（不变）。
- 无 vision_check compare（无设计稿，对齐 PRD §3 B 方案）。

## 复用关系
- 被组合: `page-studio`（getAgg 由 page-studio 经 useSquadMeta aggregateMap 合并下发）
- 组合: `studio-icons`（plus/pin/pin-filled）+ `lib/hue-hash`（hashHueIndex + HUE_PALETTE 8 色）
- 数据: `use-squad-meta.ts` SquadAggregate（SSE `squad_meta` 订阅产物）+ `squad-types.ts` SquadSummary
- 已删: `component-squad-tree`（soft_deleted/v0.0.168/）；手风琴展开/未读红点/右键浮层菜单（v0.0.168 移出）
