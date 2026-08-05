# component-seats-panel

> 层级: section
> 文件: app/web/src/components/studio-page/component-seats-panel.tsx
> v0.0.244：新增 seats 视图筛选——`useState<SeatsView>('active')` 持视图 state（唯一源）；mateRows 派生 = `seats.filter(!isLeader)` → `deriveViewRows(rows, view)` 单点过滤（active → 只留 `state==='deployed'`）；SeatsBody 加 `view`/`onViewChange` 透传 roster 头 `SeatsViewSwitch`。

## 职责
Studio 主区「团队首页」单页中枢容器：常驻头部（squad 名 + 在线 badge + 坐席/管理/自动工作 3 tab）+ 按 activeTab 切换主体：
- `seats`：**双列指挥台**（`SeatsBody` → `seats-console`）——左列 296px+ 右列 roster 白卡
- `panel`：`ManageTab`（元信息 form + charter 编辑器 + 危险操作区）
- `autowork`：`AutoworkTab`（toggle + heartbeat + budget + history 四块）
**tab 切换 = 本组件内 state 切主体，头部常驻不跳页**。

## Props
- squadId: string
- detail: SquadDetail
- stateMap: Record<string, SessionState>
- onEnterChat: (node: ChatNode) => void
- onOpenGroupChat: (node: ChatNode) => void
- onOpenTokenStats?: (squadId: string) => void
- onEditMember: (member: Member) => void;         // 「更多」菜单 → 编辑
- onBenchMember: (member: Member) => void;        // 「更多」菜单 → bench（走现有 BenchMo...
- onDeployMember: (memberId: string) => void;     // 「更多」菜单 → deploy（仅 benched 成员）
- onHire: () => void;                             // 「+」卡 → 打开现有 hire 表单
- onSaveMeta: (patch: PatchSquadBody) => Promise<void>
- onDelete: () => Promise<boolean>
- onAtLeader: () => void;                         // 全景「更多」tab 引导 @leader（透传内嵌 PanoramaRoute）
- initialTab?: SeatsPanelTab;                     // 可选初始 tab（默认 'seats'）

## 状态 / 交互
- header tab 点击 → `setActiveTab(id)`；其他状态零副作用
- **seats 视图筛选（v0.0.244）**：`seatsView: SeatsView = 'active' | 'all'`（默认 'active' 在岗），**view state 归本组件（唯一源）**；过滤单点 = `mateRows = deriveViewRows(seats.filter(r => !r.isLeader), seatsView)`（active → `member.state === 'deployed'`；all → 全量）；`view`/`onViewChange` 透传 SeatsBody（SeatsBody/SeatsViewSwitch 均不持状态不过滤）。leaderRow 不受过滤影响（leader 恒 deployed）；页头 onlineBadge / TokenWidget / SeatStats 口径零改（不属 roster 头计数）
- 空成员态（`detail.members.length === 0`）：只显 leader 行（后端保证有 leader）与「+」卡；mates 段落隐藏

## 视觉基线
- 布局：，主 header 底边 `--border`；主体 padding 20px 24px
- **页头**：squad 名 Inter 15px/600 fg（无 header avatar）；online badge 去边框 = presence 点 + i18n `seats.onlineBadge` 文案 12px 绿字（`color:var(--presence-online)`）
- **tabs 下划线式**：`px-3 py-1.5 text-[12.5px] border-b-2 -mb-px`——active = text-fg 600 + ；inactive = text-muted +  + hover:text-fg-2；保 `data-active` 属性
- seats 主体双列指挥台视觉基线详见 `component-seats-body.md`
