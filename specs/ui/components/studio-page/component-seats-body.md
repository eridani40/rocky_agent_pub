---
type: spec
title: component-seats-body — SeatsPanel seats tab 主体（左竖条 + 右全景）
priority: P1
status: active
updated: 2026-08-08
since: v0.0.168
---

> 文件: app/web/src/components/studio-page/component-seats-body.tsx
> v0.0.240 改造：左列 SeatStats 2×2 格 + TeamEntryRow 删除 → 替换为 `<TokenWidget>`（图文组件，整卡点击进 token-stats）；roster 头计数「坐席·N」→「成员·N」（N=总人数−队长）；首页 IA 三 tab 第一项文案「坐席」→「首页」。
> v0.0.244 视图筛选：roster 头新增 `<SeatsViewSwitch>`（在岗/全部，恒渲染）；props 加 `view`/`onViewChange`；计数 N = **当前视图行数**（mateRows 已被 SeatsPanel 按视图过滤，本组件零过滤）。
> **v0.0.288 布局重构**：双列指挥台 → 左竖条（token 卡上 + 成员卡下，~300px）+ 右主体全景；成员卡头部群聊图标按钮（enableGroupChat 条件渲染，icon-only 无文字）+ 加号 icon-only；队长卡删除（队长入 MemberRosterList 行内 isLeader badge 区分）；roster 头「＋新增成员」文字按钮 → 加号 icon-only 按钮。
> **v0.0.292 修复**：① 成员计数 N 改回列表实际长度（含 leader，不再排除）；② 右侧全景加外层卡片边界（同左卡风格）；③ 成员列表卡移除 overflow-hidden 高度随内容撑开；④ 根容器加 overflow-y-auto 整页可滚动。

## 职责
SeatsPanel `activeTab === 'seats'` 时渲染的主体。[v0.0.288] 从双列指挥台重构为 **左竖条 + 右全景**：
- **左竖条**（~300px，flex-col gap）：上 `<TokenWidget>`（token 用量卡，整卡点击切 token-stats）+ 下成员列表卡（头部 + `<MemberRosterList>` 行列表）
- **右主体**：`<PanoramaRoute>`（全景填满屏幕，overflow-x hidden 不横滑，正常上下滚动）
- **成员卡头部**（一行式，左右两端对齐）：
  - **左侧**：标题「成员·N」（N=当前视图行数）
  - **右侧**（`ml-auto flex items-center gap-3`，依次）：`SeatsViewSwitch`（在岗/全部，恒渲染）→ **群聊图标按钮**（`enableGroupChat !== false` 时渲染，icon-only 无文字，→ onOpenGroupChat）→ **加号图标按钮**（icon-only 无文字，→ onHire）
- [v0.0.288] 队长卡（原左列 SeatCard leaderRow）删除——队长入 MemberRosterList 行内，以 `isLeader` badge 区分
- 空态 = 当前视图 `mateRows.length === 0` → MemberRosterList 内 `seats-empty` 占位（成员卡头部仍在）
数据继续全部由 `use-seats-data` 经 SeatsPanel 传入（本组件纯编排，零派生变更；TokenWidget 内部自 fetch tokenStats + budget）。

## Props
- `detail: SquadDetail`
- `memberStateMap: Record<string, SessionState>;  // 成员 session state map（derivePanelRows 需要，SeatsPanel 从 page-studio 注入）`
- `view: SeatsView;              // 当前视图（active=在岗 / all=全部），控制 showBenched`
- `onViewChange: (v: SeatsView) => void;  // 视图切换回调（透传 SeatsViewSwitch.onChange）`
- `onEnterChat: (node: ChatNode) => void`
- `onOpenGroupChat: (node: ChatNode) => void`  // `detail.enableGroupChat !== false` 时成员卡头部渲染群聊图标按钮
- `onOpenTokenStats?: (squadId: string) => void;   // TokenWidget 整卡点击`
- `onHire: () => void`
- `buildMemberChatNode: (memberId: string) => ChatNode | null`
- `buildGroupChatNode: () => ChatNode`
- `onAtLeader: () => void;  // 全景「更多」tab 的「去群聊 @leader」透传`
- `onContextMenu?: (sessionId: string, x: number, y: number) => void;  // 右键 → 父级浮层菜单（复制 sessionId）`

> v0.0.288 删除的 props：`seats`/`leaderRow`/`mateRows`/`stats`（改用 derivePanelRows 从 detail+memberStateMap 派生 + TokenWidget 内部 hook 自取）；`onEditMember`/`onBenchMember`/`onDeployMember`（D2 统一组件自然结果——MemberRosterList 纯展示行无管理按钮，成员管理归 member 面板）。

## 状态 / 交互
- 纯展示，无状态（视图 view 受控于 SeatsPanel，本组件不持）
- [v0.0.288] 队长卡删除，leader 入 MemberRosterList 行内（isLeader badge 区分，无 bench/deploy 按钮）
- **数据派生统一**（v0.0.288）：`derivePanelRows(detail, memberStateMap)` 替代旧 `deriveViewRows`——三分区 running/idle/benched（含 leader 行），`MemberRosterList` 消费。`showBenched={view==='all'}` 控制渲染（active→running+idle / all→三分区）。
- **群聊条件渲染**（v0.0.288 迁移）：`detail.enableGroupChat !== false` 时成员卡头部渲染群聊图标按钮（icon-only 无文字，→ onOpenGroupChat + 右键 onContextMenu 复制 sessionId）；关时不渲染。群聊入口从原队长卡迁移到成员卡头部。
- **加号图标按钮**（v0.0.288）：成员卡头部右侧末尾，icon-only 无文字（替代原「＋新增成员」文字按钮）→ `onHire`（主区 member-create 创建页）
- **视图筛选开关**：成员卡头部右组首位**恒渲染**（不条件于存在 benched）；切换只经 `onViewChange` 上抛，`showBenched=view==='all'` 控制 MemberRosterList 渲染范围
- 成员卡头部计数 N = 当前视图**实际行数（含队长）**（running+idle 或 +benched）——跟随在岗/全部切换。[v0.0.292] 改回含 leader（288 的排除 leader 逻辑废弃）

## 视觉基线
- [v0.0.288] 左竖条：~300px 宽，flex-col gap——上 TokenWidget 卡 + 下成员列表卡（各白卡 rounded-xl border）
- [v0.0.292] **根容器**：`flex flex-1 min-h-0 gap-5 px-6 py-5 overflow-y-auto`（新增 `overflow-y-auto`，整页可垂直滚动）
- [v0.0.292] **成员列表卡**：`rounded-xl border border-border bg-surface`（删除 `overflow-hidden`，高度随内容撑开）
- [v0.0.292] **右全景容器**：`min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-surface p-4`（新增卡片边界 + padding，同左卡风格）
- [v0.0.288] 右主体：PanoramaRoute 全景填满屏幕主体（overflow-x hidden 不横滑，overflow-y auto 上下滚动）
- 成员卡头部：计数 13.5px/600 fg 左置；右组 `ml-auto flex items-center gap-3` 依次 = `SeatsViewSwitch`（28px 高，见 `component-seats-view-switch.md`）→ **群聊图标按钮**（icon-only，enableGroupChat !== false 时渲染）→ **加号图标按钮**（icon-only，新增成员）
- 行列表：行分隔 1px `--surface-2`（末行无）；空态 `seats-empty` 居中 muted 12.5px padding 40px 24px
- 无 hex，无 animate class

## i18n（v0.0.240 同步；v0.0.244 增补）
- `studio:seats.tab.seats` 文案「坐席」→「首页」（三 tab 第一项 labelKey = `seats.tab.{seats|panel|autowork}`）
- `studio:seats.sectionMembers`「坐席·N」→「成员·{{count}}」（[v0.0.292] N=当前视图实际行数含队长；288 的「减队长」废弃）
- [v0.0.244] 新增 `studio:seats.viewSwitch.{active,all}`（在岗/全部，双语，详 `component-seats-view-switch.md`）
- 新增 `studio:tokenWidget.*`（详 `component-token-widget.md`）
- 新增 `studio:task.statusLabels`（todo→未开始 / waiting→等待中 / in_progress→进行中 / done→已结束）
- 删除 `studio:teamEntry.*`（TeamEntryRow 废，中英同步清）
- 实际 i18n 路径：`app/web/src/i18n/locales/{zh-CN,en}/studio.json`（非 `app/web/src/locales/`）
