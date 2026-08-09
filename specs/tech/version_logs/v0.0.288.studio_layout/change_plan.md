# v0.0.288 变更计划书 — Squad 首页布局重构（3 板块）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD：`specs/prd/version_logs/v0.0.288.studio_layout/prd.md`。版本上下文：`states/v0.0.288/context.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 |

## 架构裁决（对齐 PRD D1-D4 + leader 5 裁决口）

### 裁决 1：MemberRosterList 统一组件抽取

从 `component-squad-status-modal.tsx` 抽出 PanelRowView 行组件 + 分区渲染逻辑 → 新文件 `component-member-roster-list.tsx`。

- **MemberRosterList**：接 `PanelRows`（三分区）+ `showBenched` + `currentMemberId` + `onEnterChat`，内部按 running/idle/benched 渲染分区标题 + 行列表（showBenched=false 只渲染 running+idle，true 渲染全三分区）。
- **PanelRowView** 从 modal 文件迁移到新文件，`isIdle` 二元 prop 升级为 `variant: 'running'|'idle'|'benched'` 三元。benched 行 = `opacity-[0.55]` + `text-muted-2` + avatar `grayscale` + `opacity-50`（比 idle 的 `opacity-[0.85]` + `text-fg-2` 更灰）。
- 弹层 modal 和首页 SeatsBody 都接 MemberRosterList（一改全改）。

### 裁决 2：derivePanelRows 三分区扩展

`squad-status-utils.ts` 的 `derivePanelRows` 扩展：benched 不再过滤，归第三分区。
- `PanelRows` 加 `benched: PanelRow[]`
- 循环里 `m.state === 'benched'` → push benched（不再 continue 跳过）
- running/idle 分区逻辑不变（deployed 成员按 isRunningState 分两区）

### 裁决 3：布局重构落点

**SeatsBody 双列 grid → 左竖条 + 右全景双列**：

- 现状：`grid-cols-[296px_minmax(0,1fr)]` 左列 = leaderCard + TokenWidget / 右列 = roster 白卡（头+行列表）
- 改后：`grid-cols-[296px_minmax(0,1fr)]` 左列 = TokenWidget（上）+ 成员卡 MemberRosterList（下，含在岗/全部筛选头 + 新建按钮） / 右列 = PanoramaRoute（overflow-x hidden + min-w-0）
- ** SeatsPanel 底部全景 section 删除**（L176-186），全景移入 SeatsBody 右列
- **leaderCard 删除**（老板拍板「无独立队长卡片，完全复用成员列表」——队长在 MemberRosterList 的 running/idle 分区行内，isLeader badge 区分）

### 裁决 4：左竖条宽度 = 296px（保持现状）

现状左列 296px，TokenWidget + SeatCard 已适配。保持 296px 零位移（不引入新宽度值）。成员详情页 MemberPanel 内部 `max-w-[680px]` 是内容区居中限宽，与左竖条不并存（独立主区态），无实际居中需求。

### 裁决 5：TokenWidget 改造

- **删**：TokenBar 函数（L59-71）+ 今日三色比例条区域（L112-126）+ 累计行 consumedLabel（L150-156）
- **改**：三色条区域替换为「今日总量 / 60 天总量」两数据并排（mono bold 14px）
- **留**：7 日迷你柱（h-[26px] → h-[22px] 压缩变矮）
- **整卡点击**进 token-stats 保留（button + onClick）

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| studio-squad | app/web/src/components/studio-page/squad-status-utils.ts | PanelRows.benched | 新增 | interface 加 `benched: PanelRow[]` 第三分区字段 | MUST 与 running/idle 并列；MUST 默认空数组（无 benched 成员时） | PRD D2 §2.2；裁决2 | +1 |
| studio-squad | app/web/src/components/studio-page/squad-status-utils.ts | derivePanelRows() | 修改 | 循环里 `m.state === 'benched'` → push benched（不再 continue 跳过）；返回 `{ running, idle, benched }`。running/idle 分区逻辑不变（deployed 成员按 isRunningState 分两区） | MUST benched 不再过滤；MUST running/idle 口径不变（deployed + isRunningState）；MUST 返回三区；MUST 纯函数无副作用 | PRD D2/F6 §2.2/§3.2；裁决2 | +4/-1 |
| studio-squad | app/web/src/components/studio-page/component-member-roster-list.tsx | MemberRosterList | 新增 | 统一成员列表组件：接 `rows: PanelRows` + `showBenched: boolean` + `currentMemberId?` + `onEnterChat`。内部按 running/idle 分区渲染（showBenched=true 时追加 benched 第三分区）；每区分区标题 `running · N` / `idle · N` / `benched · N`（N>0 才渲染区标题+行）；空态 = emptyMembers | MUST showBenched=false 只渲 running+idle（弹层/在岗）；MUST showBenched=true 渲染三分区（全部）；MUST 分区标题 N=0 时不渲染该区；MUST 空态文案 seats.emptyMembers | PRD D2/F5/F8 §2.2/§3.2；裁决1 | +55 |
| studio-squad | app/web/src/components/studio-page/component-member-roster-list.tsx | PanelRowView | 新增（迁移+扩展） | 从 squad-status-modal.tsx 迁移到新文件。`isIdle: boolean` → `variant: 'running'\|'idle'\|'benched'`。benched 灰显 = `opacity-[0.55]` + `text-muted-2` + avatar `grayscale opacity-50`（比 idle 的 `opacity-[0.85]` + `text-fg-2` 更灰）。running 保留 SpinnerRing 动态标识。防套娃 + hover chat icon + onClick 不变 | MUST benched 比 idle 更灰（opacity 更低 + 文字更淡 + avatar 灰度）；MUST idle 弱化口径不变（opacity-[0.85]+text-fg-2+色块降透明度）；MUST running SpinnerRing 保留；MUST 防套娃 + hover chat icon + onClick 逻辑不变；MUST export 供单测 | PRD D2/F7/F9 §2.2/§3.2；裁决1；既有 PanelRowView L47-109 | +95 |
| studio-squad | app/web/src/components/studio-page/component-member-roster-list.tsx | MemberRosterListProps | 新增 | interface `{ rows: PanelRows; showBenched: boolean; currentMemberId?: string; onEnterChat: (memberId: string) => void }` | MUST 对齐 PRD §2.2 组件契约；MUST showBenched 必填（消费方显式控制） | PRD §2.2 | +6 |
| studio-squad | app/web/src/components/studio-page/component-squad-status-modal.tsx | PanelRowView 引用 | 修改 | 删除 PanelRowView 本地定义（迁移到 component-member-roster-list.tsx）；改为 import `{ MemberRosterList }`。modal body 的 running/idle 分区手写渲染替换为 `<MemberRosterList rows={rows} showBenched={false} currentMemberId={currentMemberId} onEnterChat={enterChat} />` | MUST 弹层 showBenched=false（弹层天然无 benched）；MUST 不改 modal shell（Portal + Esc + 遮罩 + refreshDetail）；MUST 不改 SquadStatusContext 数据注入模式；MUST 文件从 216 行减 ~70 行（PanelRowView 迁出 + 分区渲染委托） | PRD D2/F5 §2.2；裁决1 | +5/-70 |
| studio-squad | app/web/src/components/studio-page/component-squad-status-modal.tsx | ComponentSquadStatusModal() | 修改 | `const rows = derivePanelRows(...)` 解构不变（返三区但弹层只传 showBenched=false→MemberRosterList 只渲 running+idle）；modal body 委托 MemberRosterList | MUST derivePanelRows 调用不变（返三区）；MUST showBenched=false | PRD D2 §2.2 | +3/-25 |
| studio-layout | app/web/src/components/studio-page/component-seats-body.tsx | SeatsBody() | 修改 | 双列布局重构：左列 = TokenWidget（上）+ 成员卡 MemberRosterList（下，含在岗/全部筛选头 + 新建按钮）；右列 = PanoramaRoute（overflow-hidden + min-w-0）。删除 leaderCard（队长在 MemberRosterList 分区行内 isLeader badge）。成员卡头 = SeatsViewSwitch + 新建按钮（从现状 roster 头迁移）；MemberRosterList 接 `showBenched={view==='all'}` | MUST 左列 296px（保持现状 grid-cols-[296px_minmax(0,1fr)]）；MUST 右列 overflow-hidden + min-w-0（不横滑）；MUST 删 leaderCard（无独立队长卡——PRD 老板澄清）；MUST 成员卡头保留在岗/全部切换 + 新建按钮（F4）；MUST showBenched=view==='all'（active→false / all→true）；MUST derivePanelRows 替代 deriveViewRows（统一数据派生——PanelRow 含 presence/statusTextSource 同源 SeatRow） | PRD D1/D2/F1/F2/F3/F4/F8 §2.1/§2.2/§3.1/§3.2；裁决1/3/4 | +40/-60 |
| studio-layout | app/web/src/components/studio-page/component-seats-body.tsx | SeatsBodyProps | 修改 | 新增 `memberStateMap: Record<string, SessionState>`（derivePanelRows 需）；新增 `onAtLeader?: (msg: string) => void`（透传 PanoramaRoute）；删除 `leaderRow`（无独立队长卡）；`mateRows: SeatRow[]` → 删除（改用 derivePanelRows 从 detail 派生）；`stats: SeatStatsData` 删除（TokenWidget 内部 hook 自取） | MUST memberStateMap 由 SeatsPanel 从 page-studio 注入（已有）；MUST onAtLeader 透传（PanoramaRoute 需）；MUST 删 leaderRow/mateRows/stats（改用 derivePanelRows + TokenWidget 内部 hook） | PRD D1/D2；裁决3 | +4/-6 |
| studio-layout | app/web/src/components/studio-page/component-seats-panel.tsx | 底部全景 section | 删除 | 删除 L176-186 `<section className="border-t ...">` 全景内嵌（移入 SeatsBody 右列）。import PanoramaRoute 保留（透传给 SeatsBody）或删（若 SeatsBody 直接 import） | MUST 全景从底部移到 SeatsBody 右列；MUST border-t 分隔线删除 | PRD D1 §2.1；裁决3 | -12 |
| studio-layout | app/web/src/components/studio-page/component-seats-panel.tsx | ComponentSeatsPanel() | 修改 | SeatsBody 传 `memberStateMap` + `onAtLeader` + `squadId`（PanoramaRoute 需要）；删除透传 leaderRow/mateRows/stats（SeatsBody 不再需） | MUST 传 memberStateMap（page-studio 已注入 SeatsPanel）；MUST 传 onAtLeader（PanoramaRoute 需要） | PRD D1；裁决3 | +5/-5 |
| studio-token | app/web/src/components/studio-page/component-token-widget.tsx | TokenBar() | 删除 | 删除三色比例条单段函数（L59-71） | MUST 完全删除（不再使用） | PRD D3 §2.3；裁决5 | -13 |
| studio-token | app/web/src/components/studio-page/component-token-widget.tsx | TokenWidget() 三色条区域 | 修改 | 删除今日三色比例条区域（L112-126）+ 累计行（L150-156）；替换为「今日总量 / 60 天总量」两数据并排（今日总量 = `totalOf(today)` mono bold 14px；60 天总量 = `formatTokens(data.cumulative)` mono bold 14px）。7 日柱保留但 h-[26px]→h-[22px] 压缩。loading 态改为两数据 skeleton | MUST 今日总量 = totalOf(today.breakdown)（input+output+cache 之和）；MUST 60 天总量 = data.cumulative（现状已有）；MUST 7 日柱保留（h-[22px] 压缩变矮）；MUST 整卡点击进 token-stats 保留；MUST loading skeleton 适配 | PRD D3/F10/F11/F12/F13/F14 §2.3/§3.3；裁决5 | +15/-30 |
| studio-token | app/web/src/i18n/locales/en/studio.json + zh-CN/studio.json | tokenWidget.* | 修改 | 删 `kindInput`/`kindOutput`/`kindCache`（三色条标签不再用）；新增 `todayTotal`（en "Today" / zh "今日"）+ `total60d`（en "60-day total" / zh "60 天总量"）；`todayLabel`/`trend7d`/`consumedLabel` 删或改（consumedLabel 被 total60d 替代；todayLabel 改为 todayTotal） | MUST en + zh-CN 双语同步；MUST 删不用的 kindInput/Output/Cache；MUST 新增 todayTotal/total60d | PRD D3 §2.3；裁决5 | +4/-6×2 |
| tests | app/web/src/components/studio-page/__tests__/squad-status-utils.test.ts | derivePanelRows 三分区 | 修改 | ①deployed+running → running 区 ②deployed+非 running → idle 区 ③benched → benched 区（不再过滤） ④suspended deployed → idle 区（INV-2 口径）⑤无成员 → 三区空 | MUST benched 进 benched 区断言（核心修复）；MUST 既有 running/idle 用例全绿 | PRD D2/F6 §3.2 | +25 |
| tests | app/web/src/components/studio-page/__tests__/component-member-roster-list.test.tsx（新） | MemberRosterList + PanelRowView | 新增 | ①showBenched=false → 渲染 running+idle 不渲染 benched ②showBenched=true → 渲染三分区 ③benched 行灰度类（opacity-[0.55]+text-muted-2+grayscale）比 idle 行更灰 ④hover chat icon + 防套娃（currentMemberId 行不渲染 icon）⑤running 行有 SpinnerRing ⑥空态 emptyMembers | MUST 纯渲染测试（jsdom）；MUST benched 灰度断言（opacity/grayscale class） | PRD D2/F7 §3.2 | +80 |
| tests | app/web/src/components/studio-page/__tests__/component-token-widget.test.tsx | TokenWidget 改造 | 修改/新增 | ①去三色条后结构断言（无 TokenBar DOM）②今日总量 = totalOf(today.breakdown) 正确 ③60 天总量 = cumulative 正确 ④7 日柱保留 ⑤整卡点击 onOpenTokenStats 触发 | MUST mock useSquadTokenStats；MUST 无 TokenBar 断言 | PRD D3 §3.3 | +40 |

## 影响面评估

- **跨模块**：studio-squad（squad-status-utils + component-member-roster-list 新 + squad-status-modal）+ studio-layout（seats-body 重构 + seats-panel 全景移位）+ studio-token（token-widget 改造 + i18n）+ 3 测试文件。无后端/API/协议改动，纯前端 UI 重构。
- **零改动声明**：PanoramaRoute 内部 / nav-rail / sidebar / 管理 tab / 自动工作 tab / token-stats 详情页 / SSE 订阅模式 / member 面板 / chat 路由。
- **关键设计决策**：
  1. **MemberRosterList 新文件**（不从 squad-status-modal export）：独立文件 = 独立 import 路径 + 独立 spec + 独立单测。弹层和首页两个消费方 import 同一组件。
  2. **PanelRowView variant 三元**（不从 isIdle 二元扩展）：三元 variant 语义清晰（running/idle/benched 各自灰度策略），避免 isIdle + isBenched 双布尔组合。迁移时改签名（弹层调用方改 variant='running'|'idle'）。
  3. **derivePanelRows 替代 deriveViewRows**（首页 SeatsBody）：统一数据派生源——derivePanelRows 返三分区 PanelRow（含 presence/statusTextSource），首页不再用 deriveViewRows（无分区）。SeatsView='active'|'all' 仍保留（控制 showBenched），但过滤逻辑从 deriveViewRows 移到 MemberRosterList 内部（showBenched=false 不渲 benched 区）。
  4. **删 leaderCard**（无独立队长卡片）：队长在 MemberRosterList 的 running/idle 分区行内，isLeader badge 区分（PanelRowView 已有 leader/mate badge）。leaderCard 的群聊入口/右键等操作需迁移到行内或省略（编码期确认——PRD 说不做独立队长卡，但群聊入口是 SeatsBody 现有功能，可能需保留在某处）。
  5. **TokenWidget 数据并排**：今日总量 + 60 天总量水平排列（justify-between），替代三色条 + 累计行两块区域。自然变矮（三色条 ~42px + 累计行 ~20px → 两数据 ~24px）。
- **回归不变量保持**：
  1. header + 3 tab 切换不变（SeatsPanel 只改 seats tab 主体）✅
  2. 管理/自动工作 tab 不变（非 seats tab）✅
  3. token 卡整卡点击进 token-stats ✅
  4. 成员行 hover 进对话 + 防套娃 ✅（PanelRowView 逻辑迁移不变）
  5. 全景内部卡片/看板不变 ✅（只改外部容器）
  6. 弹层成员列表 ≡ 首页列表 ✅（同一 MemberRosterList）
- **风险点**：
  1. leaderCard 群聊入口迁移——队长卡现有 onOpenGroupChat + onGroupChatContextMenu（右键复制 sessionId）。删 leaderCard 后这些操作需迁移到 PanelRowView 行内（或首页某处保留群聊入口）。编码期确认：PRD 说「无独立队长卡片，完全复用成员列表」——但群聊入口是 squad 级操作（非单成员），可能需在成员卡头或 header 保留。
  2. deriveViewRows 是否仍需——首页改用 derivePanelRows 后 deriveViewRows 可能成死代码（仅 active/all 过滤，现由 showBenched 替代）。检查其他消费方（ SeatsViewSwitch 控制在岗/全部仍需 SeatsView state，但过滤逻辑移到 MemberRosterList）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
