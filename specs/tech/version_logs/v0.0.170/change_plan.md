# v0.0.170 变更计划书 — squad 首页（Studio 坐席页）C 紧凑指挥台风格重构

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> 权威基线：设计稿 `reqs/[working] v0.0.170.squad_home_ui/design-c-console.html`（视觉契约）+ 现状 `studio-current.html` + `states/v0.0.170/context.md`。
> 性质：**纯前端视觉重构，零 API/零数据 hook 变更**；UT-only 验证（用户裁决豁免 AT/ET）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 核心取舍（architect 决策）

**卡 vs 行**：`component-seat-card.tsx` **重写为队长 mini 卡**（保留文件名/spec/UT 历史连续——「坐席卡」概念 = 队长卡，本来就是卡形态）；mate 行**新抽 `component-seat-row.tsx`**。两者共享的菜单机械抽 `use-seat-menu.ts`、呈现共享抽 `seat-present.ts`（DRY）。弃选「SeatCard 删除+新建两文件」：文件/spec/UT 全改名、历史断裂、改动面更大。

**testid 全保留**（DOM 锚点恒定）：`seat-card-{id}` 族（含 `-enter`/`-more`/`-avatar`/`-status`/`-badge-leader`/`-menu*`）挂到新行元素与队长卡；`seat-add-card` 形态变（虚线卡→roster 头部按钮）；`seats-mates-grid` 语义变（grid→行列表容器）。**废**：`seats-header-avatar`（页头头像下线）、`seat-stats-{*}-icon`（统计格图标下线）。新增：`seats-console` / `seats-side` / `seats-roster`。

## 符号核对结论（arch 落表前 grep 核实）

| 符号 | 真实状态 | 备注 |
|---|---|---|
| `deriveMenuAvail` / `deriveMenuOpenUp` / `estimateMenuHeight` | ✓ component-seat-card-menu.tsx:71/61/53 | 菜单 popover 本体**零改动**复用 |
| `SeatCardMenuProps.anchor.openUp` | ✓ component-seat-card-menu.tsx:35 | portal body + flip-up 契约不变 |
| `MemberAvatar` size 档 | ✓ 仅 sm/md/lg/xl（member-avatar.tsx:43） | 无 34/40px：行头像用 `md`(28)、队长卡用 `lg`(48)，按 token 微调 |
| `IconBox` size 档 | ✓ 22/24/32/34（component-icon-box.tsx:19） | 无 26px：team link 图标用 `size=24` |
| `SeatRow` type | ✓ use-seats-data.ts:33 已占名 | **行组件命名 `SeatRowView` 避撞名** |
| `--btn-primary-bg`=#18181b / `--border`=#e4e4e7 / `--bg`=#fafafa / `--presence-online`=#22c55e / `--hue-amber`+`--hue-amber-bg`=#fef3c7 | ✓ tokens.css:90-143 | 设计稿 zinc 数值与现有 token 精确对齐，无 hex 硬编码 |
| i18n `seats.{sectionTeam,sectionSeats,sectionLeader,addCard.{title,hint},onlineBadge,card.*,menu.*}` | ✓ zh-CN+en studio.json 均在 | `sectionTeam`/`addCard.hint` 唯一消费方 = seats-body → 可删 |
| `seats-header-avatar` | ✓ 仅 component-seats-panel.tsx:127 自挂，UT/ET 零引用 | 可删 |
| ET `seats_console_tc1` 依赖 `seat-card-{leaderId}{,-badge-leader,-status,-enter}` + `seat-stats*` + `seat-team-entry*` | ✓ case.yaml:126-142 | 全保留，本版本不破 ET |
| `page-studio.test.tsx` 依赖 `seat-card-m2-enter`:177 / `seat-add-card`:196 | ✓ | 保留 → page-studio.test 零改动 |
| `StudioIconName` 无 dots/ellipsis 图标 | ✓ studio-icons.tsx:11-28 | more 按钮沿用 `list` 图标 |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-studio | app/web/src/components/studio-page/seat-present.ts | pulseStyle() | 新增 | 从 component-seat-card.tsx 原样迁入：presence→静态脉冲点 CSS（box-shadow 光晕，offline 无晕） | MUST 无 @keyframes（INV-3）；颜色只走 `var(--presence-*)` | design-c `.dot`；component-seat-card.md §视觉基线 | +12 |
| ui-studio | app/web/src/components/studio-page/seat-present.ts | useSeatStatusText() | 新增 | 原 `useStatusText` 迁入改名：currentWork.text 优先，空则 i18n `seats.status.{presence}` 兜底 | MUST 仍走 t() 查 i18n，不直展 code | use-seats-data.ts §statusTextSource | +10 |
| ui-studio | app/web/src/components/studio-page/use-seat-menu.ts | useSeatMenu() | 新增 | 菜单机械 hook（从 SeatCard 抽出）：`menuOpen`/`menuPos`/`moreBtnRef`/`avail`(=deriveMenuAvail)/`openMenu`（rect 定位 + flip-up deriveMenuOpenUp）/`closeMenu` + setTimeout(0) 延迟挂 window click/contextmenu/keydown 关闭监听 | MUST setTimeout(0) 延迟注册（memory dropdown-close-listener-defer-register）；MUST itemCount 由 avail 三值算；MUST NOT 在 hook 内渲染弹层（渲染归组件，走 SeatCardMenu portal） | component-seat-card-menu.md §翻转契约 | +70 |
| ui-studio | app/web/src/components/studio-page/component-seat-card.tsx | SeatCard() | 修改 | **重写为队长 mini 卡**：白卡（rounded-xl border p-3.5）内 = seclabel「队长」+ mini 行（MemberAvatar lg + presence / 名 14px 600 + 行内 LEADER badge / meta 行：pulse dot + statusText · state，12px muted 单行 truncate）+ 操作行（enter flex-1 solid `--btn-primary-bg` + more outline icon 触发菜单）；菜单=useSeatMenu+SeatCardMenu；右键 onContextMenu 保留；offline → 根 opacity-75 + enter 降 secondary | MUST 保留 testid `seat-card-{id}`/`-avatar`/`-status`/`-badge-leader`/`-enter`/`-more`/`-menu*`；MUST leader 菜单无 bench 项（deriveMenuAvail 既有硬规则）；MUST NOT 恢复 border-t-2/shadow-sm 旧 highlight（改为行内 badge 形式）；hover 不改内边距/字号 | design-c `.side .card`/`.leader-mini`；硬约束「leader highlight 改行内 badge」；_conventions §11 | +130/-160 |
| ui-studio | app/web/src/components/studio-page/component-seat-card.tsx | pulseStyle/useStatusText/MENU_GAP_PX | 删除 | 迁出至 seat-present.ts / use-seat-menu.ts | MUST 删干净无残留副本 | memory delete-old-code-fully | -30 |
| ui-studio | app/web/src/components/studio-page/component-seat-row.tsx | SeatRowViewProps | 新增 | `interface SeatRowViewProps { row: SeatRow; onEnter: () => void; onEdit?; onBench?; onDeploy?; onContextMenu?: (sessionId,x,y) => void }`（与 SeatCardProps 同形） | MUST 数据只收 `row: SeatRow`（use-seats-data 派生），组件不自行派生 | use-seats-data.ts:33 | +12 |
| ui-studio | app/web/src/components/studio-page/component-seat-row.tsx | SeatRowView() | 新增 | mate 行组件（**命名 SeatRowView 避与 SeatRow type 撞名**）：flex 行 = MemberAvatar md + presence（`-avatar`）→ who 列 w-40 flex-none（名 13.5px 600 truncate + `role · state` 11.5px muted-2）→ status 列 flex-1 min-w-0（pulse dot + statusText 单行 truncate，`-status`）→ ops 列 flex-none（enter 小 solid + more outline icon）；ops `opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity`；offline → 根 opacity-75 + enter 降 secondary；菜单=useSeatMenu+SeatCardMenu；右键 onContextMenu | MUST 保留 testid `seat-card-{id}` 族挂行元素；ops 恒渲染只变 opacity（布局稳定，_conventions §11）；MUST focus-within 也可揭示 ops（键盘可达）；行根无整行 onClick（交互只走按钮）；无 leader badge（leader 不在 mates） | design-c `.row`/`.ops`；req.md 硬约束#4 | +165 |
| ui-studio | app/web/src/components/studio-page/component-seats-body.tsx | SeatsBody() | 修改 | **重写为双列指挥台**：`seats-console` = `grid grid-cols-[296px_minmax(0,1fr)] gap-5 items-start`；左列 `seats-side`（flex-col gap-3.5）= 队长卡（wrapper 保 `seats-leader-row`）+ SeatStats + TeamEntryRow；右列 `seats-roster` 白卡（rounded-xl border overflow-hidden）= roster 头（`seats.sectionSeats` bold + 「＋ 新增成员」按钮**挂 `seat-add-card`**）+ 行列表 `seats-mates-grid`（SeatRowView × N）；mates=0 → roster 体内 `seats-empty` 占位（头部按钮仍在）；Props 接口不变 | MUST 数据继续全部由 use-seats-data 经 SeatsPanel 传入；MUST leader 卡不传 onBench；MUST `seat-add-card` 点击仍走 onHire（→ member-create 主区页，v0.0.169 语义不变）；MUST NOT 恢复 AddMemberCard 虚线卡 | design-c `.console`/`.roster`；component-seats-body.md | +140/-120 |
| ui-studio | app/web/src/components/studio-page/component-seats-body.tsx | AddMemberCard() | 删除 | 虚线卡内部组件整体删（`seat-add-card` testid 迁 roster 头按钮） | MUST 删干净；i18n `addCard.hint` 随之下线（见 locale 行） | design-c `.rhead .add` | -22 |
| ui-studio | app/web/src/components/studio-page/component-seat-stats.tsx | SeatStats() | 修改 | 容器 `flex gap-3` → **2×2 无缝格**：`grid grid-cols-2 gap-px` + 缝色底（`var(--border)`）+ rounded-xl overflow-hidden border；每格白底 `bg-surface px-3.5 py-3` | MUST 4 格全渲染（null 不隐藏格，降级「—」占位稳定）；MUST 保 `seat-stats` + `seat-stats-{online,inprogress,today-msg,today-token}` + `-num` testid | design-c `.statgrid`；component-seat-stats.md | +18/-10 |
| ui-studio | app/web/src/components/studio-page/component-seat-stats.tsx | StatCard() / StatCardProps | 修改 | 紧凑格：删 IconBox+hue+icon；纵向 num（18px 700；null→「—」muted-2 dim）+ lbl（11px muted）；online 格保 `/total` 副文本；token 保 mono + formatCount k 缩写 | MUST NOT 留 hue/icon props（死 prop）；数字语义/formatCount 不变 | design-c `.statgrid .cell/.num/.lbl` | +25/-45 |
| ui-studio | app/web/src/components/studio-page/component-seat-stats.tsx | CheckCircleIcon/LightningIcon/DatabaseIcon | 删除 | 3 个 inline SVG 随图标下线删 | MUST 删干净；`-icon` testid 废（UT 同步删 hue 断言） | | -20 |
| ui-studio | app/web/src/components/studio-page/component-team-entry-row.tsx | TeamEntryRowProps / EntryCardProps | 修改 | 删 `boardSubtitle`/`groupChatSubtitle`（死 prop——调用方从不传，YAGNI；需要时按新后端字段再设计） | MUST 两 locale 无 subtitle 相关 key 牵连（本就组件内文案）；调用方 seats-body 不传已成立 | 架构原则#2 不留死代码 | -8 |
| ui-studio | app/web/src/components/studio-page/component-team-entry-row.tsx | TeamEntryRow() / EntryCard() | 修改 | 2 卡横排 → **compact links**：容器白卡 rounded-xl border p-2 flex-col；每 link=button（flex items-center gap-2.5 px-2.5 py-2 rounded-lg hover:bg-surface-2）= IconBox size=24（hue blue/pink 保留）+ 标题 13px 500 + chevron-right ml-auto muted-2；群聊右键 onGroupChatContextMenu 保留，看板不接 | MUST 保 `seat-team-entry-row`/`-board`/`-groupchat`/`-icon` testid；MUST button 元素 + focus-visible `--shadow-focus`（键盘可达） | design-c `.side .links`；component-team-entry-row.md | +45/-55 |
| ui-studio | app/web/src/components/studio-page/component-seats-panel.tsx | SeatsPanel() header 段 | 修改 | 页头 C 化：删 header MemberAvatar（`seats-header-avatar` 废）；squad 名升 15px 600；online badge 去边框改「presence dot + `seats.onlineBadge` 文案 12px」（绿字走 `var(--presence-online)`，保 `seats-online-badge`）；tabs 改**下划线式**（px-3 py-1.5 text-[12.5px] border-b-2：active=text-fg 600 border-b-fg / inactive=text-muted border-b-transparent hover:text-fg-2，保 `data-active` + `seats-tab-*`）；header 根保 border-b | MUST activeTab state/props/主体切换逻辑零改动；MUST 删 avatar 后 grep `seats-header-avatar` 归零 | design-c `.pagehead`/`.tabs` | +30/-25 |
| ui-studio | app/web/src/i18n/locales/zh-CN/studio.json | seats.sectionTeam / seats.addCard.hint | 删除 | 两 key 删（唯一消费方 seats-body 已下线）；`seats.emptyMembers` 文案「点右下」改「点右上」（按钮迁至 roster 头） | MUST en 同步删/改；MUST grep 两 key 归零；保 `addCard.title`（roster 按钮文案） | memory i18n-key-add-checklist（双向核对） | -2/+1 |
| ui-studio | app/web/src/i18n/locales/en/studio.json | seats.sectionTeam / seats.addCard.hint / seats.emptyMembers | 修改 | 同上：删两 key + emptyMembers 右下→右上 | MUST 与 zh-CN 键集一致 | 同上 | -2/+1 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/component-seat-card.test.tsx | SeatCard 套件 | 修改 | 改写为队长 mini 卡套件：保菜单全套断言（三 handler 组合/portal body/flip-up/延迟监听/卸载清理）、leader badge（行内 amber 形式）、offline 降级、右键上抛、脉冲点无 animate；**删** h-[52px]/line-clamp-2/border-t-2/shadow-sm 旧卡断言；新增 mini 结构断言（seclabel/avatar lg/meta 行单行/enter flex-1 solid） | MUST 与重写后实现对齐；MUST 菜单行为断言不缩水（机械只换宿主） | component-seat-card.md（新版） | +120/-150 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/component-seat-row.test.tsx | SeatRowView 套件 | 新增 | 行组件套件：testid 族挂行元素、avatar md + presence、who 列 meta（role · state）、status 单行 truncate、ops `opacity-0 group-hover:opacity-100` 且恒渲染（布局稳定）、offline 降级、enter/more 回调、菜单项 role/state 组合（mate deployed→edit+bench / benched→edit+deploy）、右键上抛、无 leader badge | MUST vi.mock 走 __dirname 绝对路径（memory test-vitest-mock-absolute-path） | component-seat-row.md（新建） | +150 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/component-seat-stats.test.tsx | SeatStats 套件 | 修改 | 删 hue icon 断言（`-icon` testid 废）；保 num/「—」降级/formatCount 缩写/4 格全渲染断言；容器断言改 2×2 grid | | component-seat-stats.md（新版） | +15/-20 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/component-team-entry-row.test.tsx | TeamEntryRow 套件 | 修改 | 删 subtitle 两断言（props 删）；保 click 回调/hue（blue/pink size=24）/button 语义+focus-visible/群聊右键上抛+看板不接 | | component-team-entry-row.md（新版） | +10/-25 |
| ui-studio-ut | app/web/src/components/studio-page/__tests__/component-seats-panel.test.tsx | 结构套件 | 修改 | 结构断言对齐 console：左列 `seats-side` 内含 stats/team-entry/leader 卡、`seats-roster` 内含 `seats-mates-grid` + 头部 `seat-add-card`、header 无 avatar；DOM 分离断言改 leader 在 `seats-leader-row`（左列）/mate 在 `seats-mates-grid`（roster）；**tab 切换 + 右键浮层 + 回调套件零改动** | MUST 不改被测 props 形 | component-seats-panel.md（新版） | +40/-35 |
| ui-studio-spec | specs/ui/components/studio-page/component-seat-card.md | 整文件 | 修改 | v1.4：职责改「队长 mini 卡」（左列）；视觉基线改 C（mini 行/行内 amber badge/meta 单行/操作行）；删旧网格卡基线；testid 表保同 | coder **编码前置**先 spec 后实现；视觉基线按 §9 口径填 | _conventions.md §9 | +50/-60 |
| ui-studio-spec | specs/ui/components/studio-page/component-seat-row.md | 整文件 | 新增 | v1.0 mate 行组件契约：职责/Props/状态交互（ops hover 揭示+focus-within/offline 降级/菜单/右键）/视觉基线（行高/padding/分隔/truncate）/testid 族（挂行元素的 `seat-card-{id}` 系） | 同上 | design-c `.row` | +75 |
| ui-studio-spec | specs/ui/components/studio-page/component-seats-body.md | 整文件 | 修改 | v1.2：职责改双列 console 编排；testid 表更新（`seats-console`/`seats-side`/`seats-roster` 新增；`seat-add-card` 形态注记；`seats-mates-grid` 语义=行列表）；视觉基线改 C | 同上 | design-c `.console` | +45/-35 |
| ui-studio-spec | specs/ui/components/studio-page/component-seat-stats.md | 整文件 | 修改 | v1.1：2×2 无缝格基线；删 icon/hue 契约；testid 删 `-icon` | 同上 | design-c `.statgrid` | +20/-15 |
| ui-studio-spec | specs/ui/components/studio-page/component-team-entry-row.md | 整文件 | 修改 | v1.1：compact links 基线；Props 删 subtitle 两字段；保 hue/右键契约 | 同上 | design-c `.side .links` | +25/-20 |
| ui-studio-spec | specs/ui/components/studio-page/component-seats-panel.md | 整文件 | 修改 | v1.3：页头 C 化（无 avatar/绿 online badge/下划线 tabs）；seats tab 主体改 console 双列描述 | 同上 | design-c `.pagehead` | +25/-20 |
| ui-studio-spec | specs/ui/components/studio-page/_overview.md | 组件清单段 | 修改 | 组件树 seats-body 段改 console 结构；清单表加 component-seat-row 行；seat-card 注记改队长 mini 卡 | | | +10/-8 |
| ui-studio-spec | specs/tech/app/frontend/[P0]component_architecture.md | studio-page 文件树段 | 修改 | 文件树加 `component-seat-row.tsx`/`use-seat-menu.ts`/`seat-present.ts` 三行 + seat-card 注记改队长 mini 卡 | | [P0]component_architecture.md §2 | +5/-2 |

## 视觉基线要点（coder 填组件 spec「视觉基线」字段用，_conventions §9 口径）

- **布局**：双列 `296px + minmax(0,1fr)` gap 20px、顶端对齐；左列三卡堆叠 gap 14px；roster = 白卡（rounded-12 / 1px `--border` / overflow-hidden），头（px-4 py-2.5 + 底分隔）+ 行列表
- **行**：padding 10px 16px；行分隔 1px 浅底分隔线（取最接近 token，`--surface-2`/`--border` 档，末行无）；hover 行底 `--bg`(#fafafa)；ops opacity 0→1（transition .12s）
- **字体**：页头 h1 15-18px/650；tab 12.5-13px；队长卡名 14px/650、行名 13.5px/600；meta 11.5px muted-2；状态 12.5px fg-3（idle/online fallback 时 muted）；统计 num 18px/700 + lbl 11px muted
- **边框/圆角**：卡 1px `--border` + rounded-xl(12px)；按钮 rounded-md(7-8px)；无 hex 硬编码
- **配色**：全 zinc token 系（`--bg`/`--surface`/`--border`/`--fg`/`--muted`/`--muted-2`）；彩色仅 4 处 = 头像 hash 色 / presence 点（`--presence-*`）/ LEADER badge（`--hue-amber-bg`+`--hue-amber`）/ team link icon hue 浅底（blue/pink）
- **按钮**：enter solid `--btn-primary-bg`(#18181b) 白字；more outline `--border` 灰字 icon-only；roster 头 add outline 小按钮；offline 时 enter 降 secondary（白底灰边）
- **INV-3**：无 @keyframes/无动画类；脉冲点 box-shadow 静态光晕

## 影响面评估

- **零 API/零后端/零数据 hook**：`use-seats-data.ts` 不动（SeatRow/SeatStatsData 契约不变）；`component-seat-card-menu.tsx` popover 本体不动；page-studio.tsx 不动
- **代码**：改 6 tsx（seat-card 重写/seats-body 重写/seat-stats/team-entry-row/seats-panel 局部 + 删 AddMemberCard）；新增 3 文件（seat-row.tsx/use-seat-menu.ts/seat-present.ts）；改 2 locale；无文件级删除
- **UT**：改 4 套件 + 新增 1 套件；`page-studio.test.tsx`/`use-seats-data.test.ts`/`component-seat-card-menu.test.tsx` 零改动（testid 全保留）
- **ET**：`seats_console_tc1` 依赖 testid 全保留，本版本 UT-only 验证（用户裁决豁免 AT/ET），ET 不进白名单、不受损
- **spec**：6 改 1 新增（coder 前置）+ 2 总纲同步（doc-modifier 阶段 5 复核）
- **依赖顺序**：seat-present.ts + use-seat-menu.ts（底层共享）→ seat-card/seat-row（两形态）→ seats-body/seats-panel（编排）→ UT；i18n 删 key 与 seats-body 同 task
- **风险点**：① 行 ops `opacity-0` 下 Playwright/jsdom「可见性」判定——UT 只断 class 与存在性，不断 visibility；② `seats-mates-grid` 语义变 grid→list，旧断言若按 grid class 判会假 fail（本表已列 UT 更新）；③ 统计格去 icon 后 4 格辨识度靠 label，视觉验收走人肉（用户亲自）

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
