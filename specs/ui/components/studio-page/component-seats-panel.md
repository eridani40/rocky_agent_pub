# component-seats-panel

> 层级: section
> 文件: app/web/src/components/studio-page/component-seats-panel.tsx
> v0.0.244：新增 seats 视图筛选——`useState<SeatsView>('active')` 持视图 state（唯一源）；mateRows 派生 = `seats.filter(!isLeader)` → `deriveViewRows(rows, view)` 单点过滤（active → 只留 `state==='deployed'`）；SeatsBody 加 `view`/`onViewChange` 透传 roster 头 `SeatsViewSwitch`。
> v0.0.276：seats 激活即刷新——每次进入/返回 seats（初始 mount + selectSquad + fallbackToSeats 回落 + handleChatBack chat 返回）父层 page-studio 都 reloadDetail 重拉 detail（见「数据刷新语义」节）。
> v0.0.305：页头 onlineBadge 消费 squad 聚合数据（`getAgg`，SSE 值优先 / useSeatsData 兜底）——统计数字与 sidebar 同源（统一数据源，不各自算各自）。

## 职责
Studio 主区「团队首页」单页中枢容器：常驻头部（squad 名 + 在线 badge + 坐席/管理/自动工作 3 tab）+ 按 activeTab 切换主体：
- `seats`：**双列指挥台**（`SeatsBody` → seats-console）——左列 296px+ 右列 roster 白卡
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
- getAgg?: (squadId: string) => SquadAggregate | undefined;  // [v0.0.305] squad 聚合数据（统一数据源；optional 旧消费方兼容）

## 状态 / 交互
- **面板级 SaveBar + dirty 上推（v0.0.317）**：ManageTab / AutoworkTab 通过 `onSaveBarChange` 回调上推 `SaveBarController`（`{dirty, saving, save(), cancel()}`）；SeatsPanel 持 `saveBarCtrl` state，在 panel/autowork tab 底部统一渲染 `SaveBar`（common 组件，variant 缺省 tab）。seats tab 无 SaveBarController，不渲染 SaveBar。
- **tab 切换 dirty 保护（v0.0.317）**：`handleTabSwitch(tab)` 检查 `saveBarCtrl?.dirty`——dirty 时弹 ConfirmModal（确认丢弃改动 → `cancel()` + 切 tab；取消 → 关 modal 留当前 tab）；不 dirty 直接切。切出 seats tab 总是直接切（无 dirty）。
- header tab 点击 → `handleTabSwitch(id)`（非直接 setActiveTab）
- **seats 视图筛选（v0.0.244）**：`seatsView: SeatsView = 'active' | 'all'`（默认 'active' 在岗），**view state 归本组件（唯一源）**；过滤单点 = `mateRows = deriveViewRows(seats.filter(r => !r.isLeader), seatsView)`（active → `member.state === 'deployed'`；all → 全量）；`view`/`onViewChange` 透传 SeatsBody（SeatsBody/SeatsViewSwitch 均不持状态不过滤）。leaderRow 不受过滤影响（leader 恒 deployed）；页头 onlineBadge 口径零改（不属 roster 头计数）
- **buildMemberChatNode 公共 helper（v0.0.268 DRY）**：本组件内部 `buildMemberChatNode` 实现改为委托 `squad-status-utils.ts` 公共 helper（成员查找 + ChatNode 组装，tag 规则 leader→`squadTree.tagLeader` / mate→`squadTree.tagSingle` + squadId）——**坐席卡「进入对话」与成员状态弹层（v0.0.269 起 `component-squad-status-modal`，268 为 SquadStatusEntry 面板）「进入对话」同源组装**（PRD §5 概念对齐）。签名保留（`(memberId) => ChatNode | null`，caller 零改动）。
- 空成员态（`detail.members.length === 0`）：只显 leader 行（后端保证有 leader）与「+」卡；mates 段落隐藏
- **页头 onlineBadge 消费聚合数据（v0.0.305）**：`const agg = getAgg?.(squadId); const onlineCount = agg?.onlineCount ?? stats.onlineCount;`——SSE 值（`squad_meta` 实时推送）优先，`useSeatsData` 派生兜底（GET detail 静态）。与 sidebar 第二行同源（统一数据源，PRD §4.3）。**member 粒度坐席卡仍走 useSeatsData + stateMap**（粒度不同不冲突，PRD §2.2）；`useSeatsData` 的 `stats.onlineCount/inProgressCount` 保留（坐席卡/其他消费仍用）。
- **SeatStats 2×2 统计条已不在渲染树（v0.0.288 布局重构）**：`component-seat-stats.tsx` 组件文件保留（UT 仍测）但 SeatsBody 已改为 TokenWidget + 成员列表卡 + 全景（`component-seats-body.md`）——v0.0.305 的「统计条消费聚合数据」落到页头 onlineBadge（唯一数字统计位）。

## 数据刷新语义（seats 激活即刷新）

**每次进入/返回 seats 视图都重新拉取 squad detail**（成员状态 + presence 新鲜）——由父层 `page-studio.tsx` 触发 `reloadDetail(squadId)`（GET /squad/:id → setDetail；失败 setDetail(null) → seats 走 loading 兜底），SeatsPanel 是纯函数组件，detail 变化自然全量 re-render（等效「整个重新渲染页面」）。覆盖全部进入/返回入口：

| 入口 | 触发点 | reloadDetail |
|---|---|---|
| 初始 mount | 挂载拉 squad 列表后自动选中第一个 squad | `await reloadDetail(id)`（既有） |
| selectSquad（切 squad） | 侧栏点 squad 行落 seats | `void reloadDetail(id)`（既有） |
| fallbackToSeats（mutation 回落 + token-stats/member/member-create 返回） | mutation handler 簇回落首页 seats | `void reloadDetail(selectedSquadId)`（v0.0.276 新增，非空时） |
| handleChatBack（chat 返回） | chat 页 topbar 返回键回 seats | `void reloadDetail(chatBackSquadId)`（v0.0.276 新增，非空时） |

**为什么需要（bug 核心）**：running/idle 状态（presence 三态 + spinner）**已由 SSE 实时覆盖**——`useStudioUnreadMeta` 订阅 `session_meta _all` → `stateMap[sid]`，`useSeatsData` 的 `derivePresence/isRunning` 走 stateMap，SSE 一直推。但 **presence 文本（member.currentWork）无 SSE**——Member.currentWork 只在 SquadDetail.members[]（presence tool 写 member store，不推 session_meta）→ **reloadDetail 是唯一刷新途径**。member.state（deployed/benched）为 detail 静态（mutation 后 refresh 已处理），reloadDetail 兜底。

**fire-and-forget（R5）**：进/返 seats 调 `void reloadDetail`（不 await 阻塞渲染）——立即渲染旧 detail，GET 返回 setDetail 新对象 → re-render 更新；本地 server GET 快，用户几乎无感。

**保留与双拉接受**：selectSquad / 初始 mount / member-panel 返回（onBack 既有 reloadDetail）/ mutation 后 refresh（reloadDetail + reloadSquads 并行）全部保留不变。mutation 路径会 refresh（内部 reloadDetail）+ fallbackToSeats（又 reloadDetail）**两次 GET /squad/:id**——幂等无害（GET 轻量、频率低、setDetail 同值无害），接受不玩精细判断。

## 视觉基线
- 布局：，主 header 底边 `--border`；主体 padding 20px 24px
- **页头**：squad 名 Inter 15px/600 fg（无 header avatar）；online badge 去边框 = presence 点 + i18n `seats.onlineBadge` 文案 12px 绿字（`color:var(--presence-online)`）
- **tabs 下划线式**：`px-3 py-1.5 text-[12.5px] border-b-2 -mb-px`——active = text-fg 600 + ；inactive = text-muted +  + hover:text-fg-2；保 `data-active` 属性
- seats 主体双列指挥台视觉基线详见 `component-seats-body.md`
