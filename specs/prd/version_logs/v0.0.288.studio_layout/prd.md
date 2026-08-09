# v0.0.288 PRD — Squad 首页布局重构（3 板块）

- **版本号**: v0.0.288
- **版本主题**: studio-page 首页布局重构为左竖条（token+成员）+ 右全景；成员列表统一组件 + token 卡改造
- **需求文件**: `reqs/[working] v0.0.288/req.md`（老板 2026-08-08 09:20 提 + 09:30 三点确认）
- **工作目录**: `worktrees/0.0.288-studio-layout`
- **类型**: 用户可感知 UI 变化（布局重构 + 组件统一 + token 卡改造）→ 完整 PRD

---

## 1. 背景

### 1.1 现状

- **首页布局**（page-studio → SeatsPanel → SeatsBody）：双列指挥台 `grid-cols-[296px_minmax(0,1fr)]`——左列 296px（队长 mini 卡 + TokenWidget 图文组件）+ 右列 roster（成员行列表 + 视图筛选 + 新增成员）；全景（PanoramaRoute）在 SeatsPanel 底部 section（border-t 分隔，全宽内嵌）。
- **token 卡片**（component-token-widget.tsx，161 行）：今日三色比例条（TokenBar × 3 = input/output/cache）+ 7 日迷你柱 + 近 60 天累计。
- **成员弹层**（component-squad-status-modal.tsx，216 行）：chat 右上浮菜单「团队状态」→ L3 modal，`derivePanelRows` 分 running 上 / idle 下两区 + PanelRowView 组件（idle 弱化 opacity-[0.85]）+ hover 进入对话 icon + 防套娃。
- **两套数据派生**：
  - `derivePanelRows`（squad-status-utils.ts）：弹层用，deployed 成员分 running/idle 两区，**benched 过滤**
  - `deriveViewRows`（use-seats-data.ts）：seats-body 用，active/all 筛选（active=只 deployed；all=全量含 benched），**无分区**

### 1.2 痛点（老板拍板）

1. **布局**：双列指挥台信息密度不均（左列窄放队长卡+token，右列 roster），全景在底部不突出——需重构为左竖条（token+成员）+ 右全景（填满屏幕主体）。
2. **成员列表**：首页 roster 与 chat 弹层是两套组件 + 两套数据派生，展现逻辑割裂——老板强制统一（一改全改）。
3. **token 卡片**：今日三色比例条 95% 是缓存没意义、占高——去比例条，改今日总量/60 天总量两个数据，变矮。

---

## 2. 核心决策

### D1. 布局重构：左竖条 + 右全景（3 板块）

```
┌──────────────────────────────────────────────────────────┐
│ ┌────────┐ ┌──────────┐ ┌────────────────────────────┐  │
│ │nav-rail│ │sidebar   │ │ 常驻 header（squad名+badge │  │
│ │ 56px   │ │ ~224px   │ │  + 3 tab 下划线）          │  │
│ │        │ │          │ ├──────────┬─────────────────┤  │
│ │ R      │ │ + 新建   │ │ 左竖条   │ 右主体=全景     │  │
│ │ 💬     │ │          │ │ ~300px   │ PanoramaRoute   │  │
│ │ 👥     │ │ • SquadA │ │ ┌token卡┐│ 卡片独立区域    │  │
│ │ ⚙     │ │ • SquadB │ │ │ 变矮  ││ +高度           │  │
│ │        │ │          │ │ ├──────┤│ 正常上下滚动    │  │
│ │        │ │          │ │ │成员卡││ 填满屏幕        │  │
│ │        │ │          │ │ │running││ **左右不可横滑**│  │
│ │        │ │          │ │ │idle  ││                 │  │
│ │        │ │          │ │ │benched││                 │  │
│ │        │ │          │ │ └──────┘│                 │  │
│ └────────┘ └──────────┘ └──────────┴─────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

- **左竖条**（~300px，leader 把握具体 px，与成员详情页宽度取居中值）：上 token 卡片 + 下成员列表卡片，垂直堆叠（flex-col gap）。
- **右主体 = 全景**（PanoramaRoute）：保持现形态（卡片独立区域 + 高度 + 正常上下滚动）；**填满屏幕、左右不可横滑**（`overflow-x: hidden` + `min-w-0`）。
- **header 不变**：squad 名 + online badge + 3 tab（首页/管理/自动工作）保持。
- 管理Tab 和 自动工作 Tab 内联切换不变（仅首页 tab 主体改为左竖条+右全景）。

### D2. 成员列表统一组件（老板强制：chat 弹层 ≡ 首页列表）

**核心**：抽统一组件 `MemberRosterList`（或类似命名），chat 弹层和首页成员列表共用同一套组件 + 数据派生 + 展现逻辑。

**统一内容**：
- **数据派生统一**：`derivePanelRows` 扩展为三分区 `running / idle / benched`（现状只 running/idle + benched 过滤→改为 benched 归第三分区不过滤）。
- **三分区展现**：
  - **running**（上）：正常色 + SpinnerRing 动态标识
  - **idle**（中）：弱化（opacity-[0.85] + text-fg-2 + 色块降透明度，现状 isIdle 逻辑保留）
  - **benched**（下）：**比 idle 更灰**（进一步降 opacity 如 opacity-[0.55] + text-muted-2 + avatar 灰度滤镜）
- **分区筛选靠 member 筛选条件控制**：
  - chat 弹层：天然无 benched（只显 deployed → running+idle）
  - 首页「在岗」视图：同弹层（running+idle）
  - 首页「全部」视图：running+idle+benched 三分区
- **行交互统一**：hover 进入对话 icon + 防套娃（currentMemberId）+ 点击进入对话——弹层和首页共用。

**组件契约**（新建 spec `component-member-roster-list.md`）：
```ts
interface MemberRosterListProps {
  rows: { running: PanelRow[]; idle: PanelRow[]; benched: PanelRow[] };
  currentMemberId?: string;      // 防套娃
  onEnterChat: (memberId: string) => void;
  showBenched: boolean;           // false=弹层/在岗（running+idle）；true=全部（三分区）
}
```

**数据派生扩展**（`derivePanelRows` → 三分区）：
```ts
interface PanelRows {
  running: PanelRow[];   // deployed + isRunningState
  idle: PanelRow[];      // deployed + 非 running（含 suspended）
  benched: PanelRow[];   // state === 'benched'（不再过滤）
}
```

### D3. Token 卡片改造（变矮 + 去三色条 + 改数据）

| 改动 | 说明 |
|------|------|
| **去今日三色比例条** | 删除 TokenBar × 3（input/output/cache 比例条，95% 缓存没意义） |
| **保留 7 日迷你柱** | 现状保留（末 7 点 + maxOfDay 归一化 + 渐变色） |
| **改「今日总量 / 60天总量」** | 两个数据替代三色条 + 累计：今日总量 = `totalOf(today.breakdown)`；60 天总量 = `cumulative`（现状已有） |
| **变矮** | 去三色条（~42px 区域）后卡片自然变矮；7 日柱保留但压缩高度（26px → ~22px 可选，架构定） |
| **整卡点击进 token-stats** | 现状保留（button + onClick → onOpenTokenStats） |

**改后 token 卡片结构**（上→下）：
1. 标题行（「Token 用量」+ 「查看详情 ›」）
2. 今日总量 / 60 天总量（两个数据并排或上下，mono font + 粗体）
3. 7 日迷你柱（保留现状）

### D4. 全景不横滑（布局稳定性）

- 右主体 PanoramaRoute 填满屏幕 + **左右不可横滑**：`overflow-x: hidden`（或 `overflow-hidden`）+ 内部卡片 `min-w-0` 防 flex 溢出。
- 全景内部正常上下滚动（`overflow-y: auto`）。
- 全景卡片独立区域 + 高度（保持现形态，不改 PanoramaRoute 内部）。

### D5. 成员卡片头部布局（老板拍板定稿 2026-08-08 09:52）

成员列表卡片头部一行式布局，左右两端对齐：

```
成员xx                              在岗/全部  聊天图标  加号
└─ 左侧标题（成员计数）              └─ 从「在岗」开始全部右对齐 ─┘
```

- **左侧**：标题「成员·N」（N=当前视图行数，跟随在岗/全部切换）
- **右侧**（`ml-auto flex items-center gap-3`，依次）：
  1. **在岗/全部切换**（SeatsViewSwitch，恒渲染，现状保留）
  2. **群聊图标按钮**（入口替代原独立队长卡的群聊功能；**以群聊开关 `enableGroupChat !== false` 为显示条件**；关时不渲染；**纯图标无文字**）
  3. **加号图标按钮**（新增成员，替代原「＋新增成员」文字按钮；**纯图标无文字**）
- **群聊入口迁移**：原队长卡（SeatCard leaderRow）里的群聊功能移到成员卡头部图标按钮；队长本人移入 MemberRosterList 行内，以 `isLeader` badge 区分（不再单独一张队长卡占左列）
- **图标按钮无文字**：群聊入口和新增成员都用图标按钮（icon-only），去掉文字标签，节省左竖条横向空间

---

## 3. 功能需求

### 3.1 布局重构（3 板块）

| # | 需求 | 说明 |
|---|------|------|
| F1 | 首页 tab 主体改左竖条+右全景 | 左竖条 ~300px（token 卡 + 成员卡）；右主体 PanoramaRoute |
| F2 | 左竖条垂直堆叠 | token 卡片（上）+ 成员列表卡片（下），flex-col gap |
| F3 | 右全景填满屏幕不横滑 | overflow-x hidden + min-w-0；正常上下滚动 |
| F4 | header + 3 tab 不变 | squad 名 + badge + 首页/管理/自动工作 tab 切换保留 |

### 3.2 成员列表统一组件

| # | 需求 | 说明 |
|---|------|------|
| F5 | 抽 MemberRosterList 统一组件 | chat 弹层 + 首页列表共用（一改全改） |
| F6 | derivePanelRows 扩展三分区 | running/idle/benched（benched 不再过滤，归第三分区） |
| F7 | benched 灰显（比 idle 更灰） | opacity-[0.55] + text-muted-2 + avatar 灰度 |
| F8 | showBenched 筛选控制 | 弹层/在岗=false（running+idle）；全部=true（三分区） |
| F9 | 行交互统一 | hover 进入对话 + 防套娃 + 点击进对话 |

### 3.3 成员卡片头部布局

| # | 需求 | 说明 |
|---|------|------|
| F15 | 成员卡头部一行式布局 | 左标题「成员·N」+ 右组右对齐（在岗/全部 → 群聊图标 → 加号） |
| F16 | 群聊图标按钮（icon-only 无文字） | enableGroupChat !== false 时才渲染；替代原队长卡群聊功能 |
| F17 | 加号图标按钮（icon-only 无文字） | 替代原「＋新增成员」文字按钮 → onHire |

### 3.3 Token 卡片改造

| # | 需求 | 说明 |
|---|------|------|
| F10 | 去今日三色比例条 | 删 TokenBar × 3 |
| F11 | 改今日总量/60天总量 | 两个数据替代三色条+累计 |
| F12 | 保留 7 日迷你柱 | 现状保留 |
| F13 | 变矮 | 去三色条后自然降高 |
| F14 | 整卡点击进 token-stats | 现状保留 |

---

## 4. 关键用户路径

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 进 Studio 选 squad → 首页 tab | 看到 3 板块布局：左竖条（token 卡上 + 成员卡下）+ 右全景填满主体 |
| UC-2 | 首页点击 token 卡片 | 进入 token-stats 统计页（整卡点击不变） |
| UC-3 | 首页 token 卡片查看数据 | 看到「今日总量 / 60 天总量」两个数据 + 7 日迷你柱（无三色比例条） |
| UC-4 | 首页成员卡切换「在岗/全部」 | 在岗=running+idle 分区；全部=running+idle+benched 三分区 |
| UC-5 | 首页「全部」视图看 benched 成员 | benched 在最下面，比 idle 更灰（opacity 更低 + 文字更淡） |
| UC-6 | chat 页右上浮菜单「团队状态」 | 弹层成员列表与首页「在岗」视图视觉一致（同组件同逻辑） |
| UC-7 | 首页右全景区域查看卡片 | 全景填满屏幕主体，左右不横滑，正常上下滚动 |
| UC-8 | 首页成员行 hover | 出现「进入对话」icon；点击进入该成员单聊 |
| UC-9 | 首页成员卡头部点群聊图标（群聊开启时） | 进入 squad 群聊页（入口从原队长卡迁移到头部图标按钮） |

---

## 5. 概念对齐（specs/ui + specs/tech）

| 概念 | 位置 | 关系 |
|------|------|------|
| SeatsPanel / SeatsBody | `component-seats-panel.tsx` / `component-seats-body.tsx` | 本版本重构主体（双列→左竖条+右全景） |
| TokenWidget | `component-token-widget.tsx` | 本版本改造（去三色条+改数据+变矮） |
| squad-status-modal / PanelRowView | `component-squad-status-modal.tsx` | 统一组件目标（MemberRosterList 抽出共用） |
| derivePanelRows | `squad-status-utils.ts` | 扩展三分区（benched 不再过滤） |
| deriveViewRows | `use-seats-data.ts` | 首页 active/all 筛选（与统一组件协调） |
| PanoramaRoute | `component-panorama-route.tsx` | 右主体（从底部 section 移到右侧主体区） |
| SeatsView | `use-seats-data.ts`（'active'\|'all'） | 首页成员卡在岗/全部切换（控制 showBenched） |

**新概念**：
- `MemberRosterList`（统一成员列表组件：running/idle/benched 三分区 + showBenched 筛选控制）
- `PanelRows` 扩展（`benched: PanelRow[]` 第三分区）

---

## 6. 边界 / 不做

- ❌ 不改 PanoramaRoute 内部（全景保持现形态，只改外部容器布局）
- ❌ 不改 nav-rail / studio-sidebar（左侧两栏不变，只改主区首页 tab 内部布局）
- ❌ 不改管理 tab / 自动工作 tab（仅首页 tab 主体重构）
- ❌ 不改 member 面板 / member-create / chat 路由（非首页 tab 的主区态不变）
- ❌ 不改 token-stats 统计详情页（仅改首页 token 卡片入口形态）
- ❌ 不新增 SSE 订阅（弹层数据注入模式保留，经 Context / detail 快照）
- ❌ 不做成员列表搜索/过滤（仅在岗/全部视图切换 + 三分区）
- ❌ 不改 7 日迷你柱的配色/数据口径（仅保留，不调整）

---

## 7. 验收口径

### 能力不变量
- [ ] 3 板块布局落地（左竖条 token+成员 / 右全景）
- [ ] token 卡片去三色条 + 今日总量/60天总量 + 7 日柱 + 变矮
- [ ] 成员列表统一组件（chat 弹层 ≡ 首页列表，一改全改）
- [ ] running/idle/benched 三分区 + benched 比 idle 更灰
- [ ] 成员卡头部布局：左标题 + 右组（在岗/全部 → 群聊图标 → 加号），图标按钮无文字
- [ ] 群聊图标按钮 enableGroupChat 条件渲染（关时不渲染）
- [ ] 全景填满屏幕 + 左右不横滑

### 回归不变量
- [ ] header + 3 tab 切换不变化
- [ ] 管理 tab / 自动工作 tab 不变化
- [ ] token 卡整卡点击进 token-stats 不变化
- [ ] 成员行 hover 进入对话 + 防套娃不变化
- [ ] 全景内部卡片/看板不变化
- [ ] 布局稳定性：板块出现/消失/切换不致元素位移

---

## 8. 测试建议

- **UT（主要）**：
  - `derivePanelRows` 三分区扩展：running/idle/benched 正确分组（benched 不再过滤）
  - `MemberRosterList` 统一组件：showBenched=true/false 分区渲染 + benched 灰度样式
  - TokenWidget：去三色条后结构断言 + 今日总量/60天总量数据正确
  - 布局：左竖条 + 右全景 grid/flex 结构断言（不横滑 overflow-x hidden）
- **ET（用户可感知布局变化）**：3 板块布局呈现 / token 卡点击进统计 / 成员卡在岗全部切换 / benched 灰显 / 全景不横滑（UC-1~7）

---

## 9. 版本总结

- **布局重构**：首页 tab 双列指挥台 → 左竖条（token 卡上 + 成员卡下，~300px）+ 右全景（填满屏幕不横滑）
- **统一组件**：抽 `MemberRosterList`（chat 弹层 + 首页列表共用）；`derivePanelRows` 扩展三分区（running/idle/benched）；benched 比 idle 更灰；`showBenched` 筛选控制
- **成员卡头部布局**：左标题 + 右组右对齐（在岗/全部 → 群聊图标 → 加号）；群聊入口从队长卡迁移到头部图标按钮（enableGroupChat 条件渲染，icon-only 无文字）；加号也改 icon-only
- **token 卡改造**：去今日三色比例条 + 改「今日总量/60天总量」+ 保留 7 日迷你柱 + 变矮
- **零改动**：PanoramaRoute 内部 / nav-rail / sidebar / 管理tab / 自动工作tab / token-stats 详情页 / SSE 订阅模式
- **UT + ET**：统一组件三分区 + token 改造 + 布局结构 + ET 布局呈现
