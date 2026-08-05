---
type: spec
title: component-seats-body — SeatsPanel seats tab 主体（双列指挥台 + 第二栏全景内嵌）
priority: P1
status: active
updated: 2026-08-03
since: v0.0.168
---

> 文件: app/web/src/components/studio-page/component-seats-body.tsx
> v0.0.240 改造：左列 SeatStats 2×2 格 + TeamEntryRow 删除 → 替换为 `<TokenWidget>`（图文组件，整卡点击进 token-stats）；roster 头计数「坐席·N」→「成员·N」（N=总人数−队长）；首页 IA 三 tab 第一项文案「坐席」→「首页」。
> v0.0.244 视图筛选：roster 头新增 `<SeatsViewSwitch>`（在岗/全部，恒渲染）；props 加 `view`/`onViewChange`；计数 N = **当前视图行数**（mateRows 已被 SeatsPanel 按视图过滤，本组件零过滤）。

## 职责
SeatsPanel `activeTab === 'seats'` 时渲染的主体，**双列指挥台**：
- **左列**（`seats-side`，296px）：队长 mini 卡（`SeatCard`，wrapper 保 `seats-leader-row`）→ `<TokenWidget>`（token 用量图文小组件，整卡点击切 token-stats 路由态）
- **右列 roster 白卡**（`seats-roster`）：roster 头（计数「成员·N」+ **视图筛选开关** `SeatsViewSwitch` + 「＋新增成员」）+ 行列表 `seats-mates-grid`（`SeatRowView` × N，仅 mate）
- mates=0（当前视图无 mate 行）→ roster 体内 `seats-empty` 占位（roster 头、视图开关与新增按钮仍在）
> 第二栏「项目全景」由 SeatsPanel 直接内嵌 `<PanoramaRoute>`（不在本组件内）。
数据继续全部由 `use-seats-data` 经 SeatsPanel 传入（本组件纯编排，零派生变更；TokenWidget 内部自 fetch tokenStats + budget）。

## Props
- `detail: SquadDetail`
- `seats: SeatRow[];             // 全体（leader + mates），已由 use-seats-data 排序`
- `leaderRow: SeatRow | null;    // leader（后端保证有；null 兜底）`
- `mateRows: SeatRow[];          // 除 leader 外、已被 SeatsPanel 按当前视图过滤的成员行（本组件不再过滤）`
- `stats: SeatStatsData;         // 透传（TokenWidget 等；onlineCount=deployed 口径不受视图影响）`
- `view: SeatsView;              // [v0.0.244] 当前视图（active=在岗 / all=全部），SeatsPanel state 注入`
- `onViewChange: (v: SeatsView) => void;  // [v0.0.244] 视图切换回调（透传 SeatsViewSwitch.onChange）`
- `onEnterChat: (node: ChatNode) => void`
- `onOpenGroupChat: (node: ChatNode) => void`
- `onOpenTokenStats?: (squadId: string) => void;   // TokenWidget 整卡点击（替代原 TeamEntryRow token link）`
- `onEditMember: (m: Member) => void`
- `onBenchMember: (m: Member) => void`
- `onDeployMember: (id: string) => void`
- `onHire: () => void`
- `buildMemberChatNode: (memberId: string) => ChatNode | null`
- `buildGroupChatNode: () => ChatNode`
- `onContextMenu?: (sessionId: string, x: number, y: number) => void;  // 右键 → 父级浮层菜单（复制 sessionId）`

> v0.0.240 删除的 props：`onOpenBoard`（board 全链路 v0.0.237 已删，本版本清残留）；`onOpenPanorama`（第二栏内嵌不再走 setMainView 切路由）。

## 状态 / 交互
- 纯展示，无状态（视图 view 受控于 SeatsPanel，本组件不持）
- leader 卡不传 `onBench`（硬规则）；mate 行三 handler 全传
- 「＋ 新增成员」按钮（`seat-add-card`）→ `onHire`（主区 member-create 创建页）
- **视图筛选开关**（v0.0.244，spec 见 `component-seats-view-switch.md`）：roster 头计数右侧、「＋新增成员」左侧**恒渲染**（不条件于存在 benched）；切换只经 `onViewChange` 上抛，过滤发生在 SeatsPanel `deriveViewRows` 单点
- roster 头计数 N = `mateRows.length`（队长不计）——**跟随当前视图**：在岗视图 = 在岗 mate 数；全部视图 = 全部 mate 数（「显示几个就是几个」，v0.0.244 用户裁决）
- 空态判断 = 当前视图 `mateRows.length === 0`（跟随视图：在岗视图无 deployed mate 时也显空态）

## 视觉基线
- 左列：双卡堆叠（队长卡 / TokenWidget 各白卡 rounded-xl border）
- roster 头：计数 13.5px/600 fg 左置；右组 `ml-auto flex items-center gap-3` = 视图开关（28px 高，视觉基线见 `component-seats-view-switch.md`）+ 「＋新增成员」按钮
- 行列表：行分隔 1px `--surface-2`（末行无）；空态 `seats-empty` 居中 muted 12.5px padding 40px 24px
- 无 hex，无 animate class

## i18n（v0.0.240 同步；v0.0.244 增补）
- `studio:seats.tab.seats` 文案「坐席」→「首页」（三 tab 第一项 labelKey = `seats.tab.{seats|panel|autowork}`）
- `studio:seats.sectionMembers`「坐席·N」→「成员·{{count}}」（N 减队长，插值；v0.0.244 起 N=当前视图行数）
- [v0.0.244] 新增 `studio:seats.viewSwitch.{active,all}`（在岗/全部，双语，详 `component-seats-view-switch.md`）
- 新增 `studio:tokenWidget.*`（详 `component-token-widget.md`）
- 新增 `studio:task.statusLabels`（todo→未开始 / waiting→等待中 / in_progress→进行中 / done→已结束）
- 删除 `studio:teamEntry.*`（TeamEntryRow 废，中英同步清）
- 实际 i18n 路径：`app/web/src/i18n/locales/{zh-CN,en}/studio.json`（非 `app/web/src/locales/`）
