# Studio 视图契约（squad 团队管理 UI）

> 管什么：**Studio** view——squad 团队管理与对话 UI 的页面结构与组件契约（左 sidebar squad 列表 + 右主区多态：首页 SeatsPanel 单页中枢 / 业务全景多 tab / token 统计 / 真聊 / member 面板 / 成员创建）。
> 不管什么：HTTP 端点契约（→ `specs/api/overall/`）；设计 token（→ `specs/ui/regulation/`）；nav-rail 改造（→ `specs/ui/components/framework/nav-rail.md`）；bizType 隔离规则（→ `specs/tech/agent/session/[P0]session_biztype.md`）。

---

## 1. 概述

Studio 是 squad 团队管理入口（nav-rail 顶部业务区第 2 项「Studio」，团队图标），与 Playground（个人对话）并列。

一句话：**左 nav-rail 切 Playground/Studio；Studio 主页 = 左 sidebar squad 单行列表（无展开树）+ 右主区多态（首页 SeatsPanel 单页中枢[首页/管理/自动工作三 tab 内联，第二栏内嵌全景] / token 统计页 / 真聊页[topbar 返回键] / member 面板[返回回 seats] / 成员创建页）；chat/member 入口收敛到首页坐席面板（坐席卡 + 坐席卡菜单）。** `[v0.0.240]` 全景从独立路由态改为首页第二栏内嵌（删 `MainView {kind:'panorama'}` + onBack 头部）；tab 首项「坐席」改名「首页」；左列 SeatStats 2×2 + TeamEntryRow → TokenWidget（图文小组件，点击进 token-stats）；roster 计数「坐席·N」→「成员·N」（N 减队长）；全景固定首 tab = task（kanban 4 列）。`[v0.0.243]` task 改普通 entity + system 标记（落盘进 schema），恢复「更多」固定 tab + PanoramaIdle 引导。`[v0.0.237 removed]` 原「目标/需求/任务三固定 tab + 团队看板整组件嵌入」随 charter/task/goal/requirement/board 全链路移除。

### 1.1 bizType 二分（UI 侧）

| tab | view | 数据源 | 列表隔离 |
|---|---|---|---|
| **Playground** | `currentView='playground'` | `GET /session?bizType=playground`（缺省） | 不含 studio session |
| **Studio** | `currentView='studio'` | `GET /squad`（squad 列表）+ `GET /session?bizType=studio` | 不含 playground session |

两个 tab 物理隔离：squad 一旦建立，Playground 列表不受污染（bizType 过滤保证）。

---

## 2. Studio 主页布局

```
┌─────────────────────────────────────────────────────────────┐
│ ┌──────┐ ┌──────────────┐ ┌──────────────────────────────┐ │
│ │nav-  │ │ studio       │ │ 首页 SeatsPanel (唯一 landing)│ │
│ │rail  │ │ sidebar      │ │  [首页] [管理] [自动工作]    │ │
│ │ 56px │ │ (无 tree)    │ │  ────────────────────────    │ │
│ │      │ │              │ │  首页 tab:                   │ │
│ │ R    │ │ + 新建       │ │   ┌ 左列 seats-side 296px ┐ ┌ 右列 seats-roster ┐│
│ │ 💬   │ │              │ │   │ 队长 mini 卡           │ │ 头: 成员·N + ＋新增││
│ │ 👥   │ │ • Squad A    │ │   │ TokenWidget 图文       │ │ mate 行 × N        ││
│ │      │ │ • Squad B    │ │   │ （整卡点击进 token-stats）│ │（hover 现 ops）   ││
│ │ ⚙    │ │              │ │   └───────────────────────┘ └───────────────────┘│
│ │      │ │              │ │  第二栏「项目全景」内嵌：     │ │
│ │      │ │              │ │   [任务(builtin)] [动态 view] + 工作面板         ││
│ │      │ │              │ │  管理 tab: ManageTab 内联    │ │
│ │      │ │              │ │  自动工作 tab: AutoworkTab   │ │
│ └──────┘ └──────────────┘ └──────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
   主区其他态（互斥）：token-stats / chat / member / member-create（各带返回键回首页）
```

- **左 nav-rail**（改造见 `specs/ui/components/framework/nav-rail.md`）：brand「R」置顶 + 顶部业务区（Playground 对话图标 + Studio 团队图标）+ 底部设置组折叠（齿轮收纳）。
- **中 studio-sidebar**（~224px）：squad 单行列表 + 顶部「新建 squad」按钮；点 squad 行 = 落首页 seats（无手风琴展开态、无子节点树、无右键菜单）。
- **右主区**（多态互斥）：
  - **seats**（默认 landing）：`component-seats-panel` 单页中枢，头部 3 tab 内联切换（首页/管理/自动工作）；**全景内嵌第二栏**（v0.0.240——原独立 panorama 路由态废，删 `MainView {kind:'panorama'}`），详见 §3/§4
  - **token-stats**：token 统计独立路由态（入口 = 首页左列 TokenWidget 整卡点击），详见 §5
  - **chat**：squadChat 群聊 / member 单聊，topbar 返回键常驻（`ChatTopbarBackBtn` 存在即挂），详见 §7
  - **member**：`section-member-panel` 编辑面板，返回恒回首页 seats（唯一入口 = 坐席卡菜单编辑），详见 §6
  - **member-create**：`section-member-create` 成员创建页（Fresh/Derive），返回/取消/创建成功均回首页 seats（唯一入口 = roster 头「＋ 新增成员」按钮），详见 §9

**右键「复制 Session ID」菜单**：触发点 = 坐席卡右键 + 队长卡群聊按钮（复制 squadChat sessionId）；实现由 `component-studio-context-menu.tsx` primitive 承接（seats-panel 持 state + 渲染），浮层内按钮点击 `navigator.clipboard.writeText(sessionId)` + 关闭。

---

## 3. 团队首页单页中枢 SeatsPanel

点侧栏 squad 行选中 squad → 主区切 seats 路由态，进入**团队首页单页中枢**。SeatsPanel 头部三 tab（首页/管理/自动工作）**首页内联切换内容**。

- **头部（常驻）**：团队名（15px/600）+ 在线数 badge（绿字圆点 `--presence-online`）+ 三 tab（下划线式：激活 `border-b-2 border-b-fg`；本地 activeTab state 切主体，不改 mainView）。
- **数据**：现有 store（SquadDetail）+ `getBudgetUsage(id)` 一次挂载 GET（tokenUsed；limit=-1/失败 → null 降级不显示或「—」）；presence 派生自 `useStudioUnreadMeta().stateMap`（SSE 驱动）；`member.currentWork.text` 状态行。**后端零新增端点**。

### 3.1 首页 tab（缺省，双列指挥台 + 第二栏全景内嵌）

grid `296px + 1fr` 两列：

- **左列**（flex-col gap-3.5）：
  - **队长 mini 卡**（`SeatCard`，单卡）：seclabel「队长」→ mini 行（MemberAvatar lg + presence 点 → 名 14px/600 + **行内 amber LEADER badge** → meta 行 = 脉冲点 + `statusText · state` 单行 truncate）→ 操作行（「进入对话」flex-1 solid + **「群聊」灰色 outline**（与「进入对话」各占一半；右键复制 squadChat sessionId）+ 「更多」outline icon → 菜单弹层）
  - **TokenWidget 图文小组件**（v0.0.240 替代 SeatStats 2×2 + TeamEntryRow）：今日三色比例条（input/output/cache）+ 7 日迷你柱 + 累计/预算进度条；**整卡点击** → 主区切 token-stats 路由态（详 `specs/ui/components/studio-page/component-token-widget.md`）
- **右列 roster**（白卡 rounded-xl border）：**roster 头**（计数「**成员 · N**」+ **视图筛选 toggle**「在岗 / 全部」（v0.0.244，segmented 两态，默认「在岗」，恒渲染——`SeatsViewSwitch` 受控组件，view state 唯一源 = SeatsPanel `useState<SeatsView>('active')`）+ 「＋ 新增成员」按钮 → 主区 member-create 创建页）+ **mate 行列表**（`SeatRowView` × N，仅 mate；mates=0 → 体内空态占位，roster 头、视图开关与新增按钮仍在）。行结构：avatar md + presence → who 列（名 + `role · state`）→ status 列（脉冲点 + statusText）→ ops 列（「进入对话」+「更多」，**ops 恒渲染 opacity-0，hover/focus-within 揭示**，布局稳定 + 键盘可达）
  - **计数口径**（v0.0.244）：N = **当前视图行数**（「成员·{{count}}」，count 减队长）——在岗视图 N = deployed mate 数（benched 不计）；全部视图 N = 全队 mate 数（含 benched）。「显示几个就是几个」，计数与列表一一对应。过滤单点 = `SeatsPanel` `deriveViewRows(rows, view)`（active → `member.state === 'deployed'`；all → 全量），`SeatsBody`/`SeatsViewSwitch` 不过滤。
  - **视图筛选交互**（v0.0.244）：在岗视图默认只渲染 deployed mate 行（benched 隐藏）；切「全部」渲染全量 mate 行（deployed + benched，benched 行视觉弱化 opacity-75 + `mate · benched` meta，复用 SeatRowView 既有 offline 呈现）。在「全部」视图下可 hover benched 行 → ops 列「更多」→ deploy 项（仅 benched 渲染）恢复回在岗（SSE 推送 state 变更自动刷新，无需手动刷新页面）。全 deployed 场景两视图输出一致。

**第二栏（首页底部追加，v0.0.240）**：栏标题「项目全景」+ 内嵌 `<PanoramaRoute squadId onAtLeader members>`（无 onBack 头部，详 §4）。

**SeatCard / SeatRowView 共用规则**：
- **presence 三态**（无 idle）：stateMap[sessionId] ∈ {running,interrupting,suspended} → busy；`member.state==='benched'` → offline；else → online
- **菜单项**（卡/行同一规则）：编辑（→ 进 member-panel）+ bench（**仅 mate + deployed** 渲染，走 BenchModal 填 reason 必填）/ deploy（**仅 benched** 渲染）。**leader 菜单无 bench 项**（硬规则，UI 双层拒）
- **菜单机械**：`use-seat-menu.ts` hook（开关 state + 触发按钮 rect 定位 + flip-up + `setTimeout(0)` 后挂 window click/contextmenu/Escape 关闭监听——延迟必需，躲同次事件冒泡关闭 bug）；弹层走 portal body；呈现共享 `seat-present.ts`（pulseStyle 静态脉冲点 / useSeatStatusText）
- **offline 卡/行**：根 opacity 0.75 + 「进入对话」降 secondary 型（benched 成员的呈现）

### 3.2 管理 tab（ManageTab 内联）

- **squad 元信息编辑**：name / description / modelDefault（PATCH /squad/:id）。
- **默认推理强度（v0.0.279，effortDefault）**：modelDefault 下方加 effortDefault 下拉（Dropdown 原语 `component-shared-selector`，4 档 default/low/high/max，state 初始 = `detail.effortDefault`——后端回显 ?? 'default' 恒有值）；dirty 判定 `effortDefault !== detail.effortDefault`（改档可 save / 改回不可）；save patch 恒带 effortDefault（显式 'default' 也落盘，对齐后端 PATCH `!== undefined` + 显式落盘语义）。团队默认覆盖链：成员显式档（low/high/max）→ 用之；否则团队 effortDefault（low/high/max）→ 用之；否则 undefined（厂商默认，encode 不注入）——详见 `specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.8`。i18n：`studio:manageTab.effortDefaultLabel` + `studio:manageTab.effortOptions.{default|low|high|max}`（en/zh 双语）。
- **`[v0.0.237 removed]`** 原 charter 编辑器（4 字段 form + history）已随 charter 全链路移除——管理 tab 不再有 charter section。
- **危险操作区（team 硬删除/解散）**：底部删除按钮 + 二次确认弹层（复用 ModalShell）。须**输入完整队名匹配**才启用「确认删除」（防误删）；确认 → `DELETE /squad/:id`（硬删：member session + 历史 + 调度全物理清、不可逆；工作产出保留——workspaces/交付/temp/outputs/reports 原地不动，详 `11a-squad-endpoints.md §1.5`）→ 从 sidebar 移除 + 切走选中。

### 3.3 自动工作 tab（AutoworkTab 内联，五块垂直堆叠）

- **自主性 toggle**（总开关 killswitch）：= `squad.enableHeartBeat`（PATCH /squad/:id，toggle 后 ≤1s 生效——killswitch 走调度层 handler gate0 动态，job 恒注册）。关 = 心跳收起/停调度（角色纯 reactive）。
- **群聊开关（v0.0.270，enableGroupChat）**：= `squad.enableGroupChat`（PATCH /squad/:id，默认 true=开）。关 = 群聊可见性关闭——agents 不再注入 SquadChat（squad_agents_status 不渲染 SquadChat 行）、坐席卡「群聊」按钮隐藏、`send_message('squadchat')` 报错（成员仅私聊）；squad 实体/session 恒存在，仅控可见性，重开即时恢复。组件契约 `studio-page/component-group-chat-toggle.md`。
- **heartbeat-config（squad 级心跳配置）**：interval segmented chip（5/15/30/60，默认 15）+ activeWindows 多段增删（每段 start/end + 移除按钮 + 「添加时间段」按钮 + 空态提示）+ scope switch（all/whitelist + 成员勾选）+ 保存/重置（reset → heartbeatConfig=null）。写走 `PATCH /squad/:id {heartbeatConfig}`（组件 spec `heartbeat-config.md` 权威）。总开关关时显「已被总开关停用」提示。
- **budget meter（含配置交互）**：仪表展示（consumed/remaining/limit + 进度条 + 窗口结束时间，轮询 GET /squad/:id/budget/usage + SSE `session_usage_update` 即时 refetch）+ 配置块（开关 off→null 不限量 / on→limit 限量，默认 1_000_000 + limit 输入 + 保存）；budget=null 显「不限量」。写走 `PATCH /squad/:id {budget}`。
- **调度历史**：`GET /squad/:id/scheduler/history?limit=50`，每条含 role / reason(heartbeat|file-changed) / result(fired|skipped_*) / at / path? / actionSummary?；时间倒序（最新在前）；手动刷新按钮（无 SSE 实时推送）。

---

## 4. 业务全景（首页第二栏内嵌 panorama DSL + task 普通 entity）

**入口（v0.0.240 改造 / v0.0.243 task 改普通 entity）**：全景从独立路由态（原 `MainView {kind:'panorama'}` + onBack 头部）改为**首页第二栏内嵌**（seats tab 底部追加栏「项目全景」+ 内嵌 `<PanoramaRoute>`）。原 TeamEntryRow「业务全景」link 随组件废除。`[v0.0.237 removed]` 原「固定 3 tab（Tasks/Goals/Requirements）+ 团队看板整组件嵌入 + OKR feature gate」；`[v0.0.243]` task 改普通 entity（落盘进 squad schema，system:true 标记 + lazy migration，get_schema 直接返含 task 的 DSL）。

**tab host 架构**（`component-panorama-route.tsx`，无 onBack 头部）——`PanoramaRoute` 持 `activeTab` state（默认 = `schema.views[0]?.id`，'more' 不作默认），渲统一 tab 条 + 按 activeTab 受控分发：

- **tab 装配顺序**：① **task tab（首项）**——后端 `injectSystemEntities` 保证 `task_kanban`（kanban 4 列 todo/waiting/in_progress/done）恒在 schema.views 首项；label「任务」（配死中文）→ ② DSL `schema.views` 其他动态 tab 顺延（`<PanoramaView activeViewId={activeTab}>`，view.component = kanban/table/bar_chart）→ ③ **固定「更多」tab 永远在最右**（`PANORAMA_MORE_TAB_ID = 'more'`，v0.0.243 恢复，不依赖 schema）。`activeTab === 'more'` → 渲 `<PanoramaIdle>`（白卡引导——点「找 leader 搭看板」按钮跳 leader 单聊 + composer 预填「帮我搭建一个看板，展示…」模板文本，预填待发不自动 send；详见 `component-panorama-idle.md`）。
- **schema 读取**：`GET /squad/:id/panorama/schema` 返**含 task entity 的 DSL**（v0.0.243 起后端 `ensureSystemEntities` 兜底，task 落盘进 board.yaml）→ 前端 `parsePanoramaDsl`（最小结构守卫，不再合成——前端镜像 builtin 常量 v0.0.243 已废除，后端单一来源）。
- **工作面板**（`component-panorama-view`，受控 `activeViewId`，动态 tab 共用）：按 `view.component` 装配 kanban/table/bar_chart；task tab = kanban 4 列（按 status 分组，列头色带 + 卡片左缘竖条）；拖拽改状态（kanban + group_by==states.field）→ `POST .../transition`；弹层新建/编辑 → `component-panorama-entity-modal`；**归档开关**（`ArchiveSwitch`，仅 `view.filter.archived` 时显示，task view 永远满足——切 active/with_archived）+ 卡片 hover 归档按钮（PATCH archived:true）；事件流面板（**默认收起**，v0.0.243 改）+ SSE 乐观更新（含 source=system 的 task 自动依赖 transition）。
- **schema 变化校验**：schema 加载 / SSE `panorama_schema_update` 后校验 activeTab 仍合法（动态 view 或 'more'），否则回落 defaultTab。
- **数据**：全景 = `GET /squad/:id/panorama/schema`（DSL）+ `GET /squad/:id/panorama/entities/:entity?filter=...`（实例，filter 由 view.filter 透传）+ `GET /squad/:id/panorama/events`（事件流）。
- **SSE**：`POST /sse/subscribe { topic: "panorama", group: "panorama:squad:{squadId}:entity" }`（复用全局 `/sse` 通道；topic=静态注册类别，per-squad 隔离走 group 路由键），收 `panorama_entity_update`（透传 view 乐观更新）/ `panorama_schema_update`（重拉 schema + 重建 tab 装配 + 校验 activeTab）。
- 组件 spec：`specs/ui/components/studio-page/{component-panorama-route,component-panorama-view,component-panorama-idle,component-panorama-archive-switch,component-panorama-entity-modal}.md`。端点契约 `specs/api/overall/14-panorama-endpoints.md`。task 普通 entity + system 标记权威 `specs/tech/squad/[P1]panorama_builtin.md`。

---

## 5. Token 统计页（独立路由态）

**入口（v0.0.240 改造）**：首页 seats tab 左列 `<TokenWidget>` 整卡点击 → 主区切 token-stats 路由态（原 TeamEntryRow「Token 统计」link 随组件废除，被 TokenWidget 整卡点击取代）。

- **头部**：`TokenStatsRoute` 头部左上返回键（视觉复用 `ChatTopbarBackBtn` primitive）→ 退出回首页 seats
- **主体**（`TokenStatsPanel` state 持有 + 4 维度控制条 + 主图切换）：
  - **4 维度**（详见 PRD §2.2 + 组件 spec）：粒度（day 跨天 / hour 单日）+ 范围（team 整个团队=Σ member / 单个 memberId）+ 类型（total/input/output/cache/cacheRate）+ 视图（calendar 日历热力 / timeline 时间轴堆积图）
  - **model 筛选下拉**：数据源 = `response.availableModels`（从 token_usage_stat 数据派生的 distinct (providerId,modelId) 组合，**非 squad.modelDefault 配置**）；「全部」+ 每条 distinct model；`__unknown__` 显「未知模型」；空数据时下拉不渲染
  - **日期选择**（仅 granularity=hour 显）：'YYYY-MM-DD' date input，默认今天
- **503 降级**：sqlite 未就绪 → 主区显「统计功能未就绪」空态（不崩页面）
- **数据**：`GET /squad/:id/token-stats`（11c §3，返回 `TokenUsageQueryResult { series, availableModels?, ... }`）
- 组件 spec：`specs/ui/components/studio-page/component-token-stats.md`（合并版，覆盖 route/panel/controls/calendar/timeline/tooltip 子组件 + types/helpers）。端点契约 `specs/api/overall/11c-token-stats.md`。产品口径权威 `specs/prd/overall/08-squad-studio.md §8.10`。

---

## 6. Member 面板

**入口（单入口）**：首页坐席卡菜单 → 「编辑」项 → member-panel（占用主区路由切换，非模态）；左上「返回」按钮回**首页 seats**。

**布局**：单页面向下滚动，2 section（姓名介绍 + skills）；修改后右下角悬浮**保存**按钮（`position: fixed bottom-4 right-4`，仅当有未保存改动时显示）。

### 6.1 section：姓名 / 介绍

- 字段：name + intro + workStyle（可空多行）。
- 保存 → PATCH /squad/:id/member/:mid（仅传改动字段，不可改 role/state/squadId/sessionId）。

### 6.2 section：skills（overlay 语义）

- skills mode switch（off=inherit 继承全局 / on=custom 自定义）+ off 收起、on 展开 `component-member-skill-filter`（简化 enable/disable + 搜索筛选器，始终挂载 + CSS 折叠）。
- **overlay 语义**：生效 skill = workspace 层恒生效 + builtin/app 层按 `member.skillConfig`（inherit→全局 enabled / custom→全局叠加 overrides）叠加。resolve 权威 `specs/tech/squad/[P1]session_config_studio.md §3.2`。
- 组件 spec 见 `specs/ui/components/studio-page/member-panel.md` + `component-member-skill-filter.md`。

---

## 7. Chat（真聊）

**入口（单路径——chat 入口全部收敛到首页）**：
- 首页坐席面板 SeatCard 「进入对话」按钮 → 进入 leader/mate 单聊
- 首页队长卡「群聊」按钮（操作行中档与「进入对话」各占一半，灰色 outline；右键复制 squadChat sessionId）→ 进入 squadChat 群聊
- topbar 左侧**返回键常驻**（`ChatTopbarBackBtn`，ghost h32 + ChevronLeft + i18n `common:action.back`），点击回落首页 seats

**消息时间行**：三 chat 页共享内核 `ComponentMessageStream` 在每条消息 bubble 后插入 `<MsgTime iso={msg.createdAt} side={sideResolver(msg)}/>` primitive——一次改覆盖 playground / studio 单聊 / studio 群聊（三页同源）；视觉 = 10.5px mono `--muted-2`，agent 左对齐 / user 右对齐（regulation 02 §6）。组件 spec：`specs/ui/components/chat-page/component-msg-time.md`。

**共享渲染内核 ChatStream + 可见性策略**：群聊/单聊复用 playground 的共享内核 `component-message-stream.tsx`，三视图差异收敛到 4 个可选策略 hook（不传 = playground 默认行为）：

| 策略 hook | 单聊（leader/mate） | 群聊（squadChat） | playground（参考） |
|---|---|---|---|
| `resolveActor(msg)` | user → MemberAvatar(role='user')；其他 → MemberAvatar(member) | user → MemberAvatar(role='user', name=用户名)；a2a inbox → MemberAvatar(member) + name 前缀 | 默认 Rocky icon / U 色块 |
| `messageFilter(msg)` | **不传**（全展示，仅滤 reminder） | `m => isUser(m) \|\| isA2aInbox(m)`（**白名单**：mute assistant answer + tool + reminder） | 不传（全展示） |
| `blockFilter(block, msg)` | 内核默认 `DEFAULT_BLOCK_FILTER`（滤 `isSystemReminder=true` 的 text block） | 内核默认 `DEFAULT_BLOCK_FILTER`（同左） | 内核默认 |
| `sideOfMessage(msg)` / `sideResolver` | **传 `memberSideResolver`：a2a inbox → 右**（与 user 同侧，是「输入」）；其他 → 默认 | **不传**（沿用默认：a2a inbox→左即便 `role='user'`，群聊 a2a = 「他人发言」→ 与 member 同侧） | 不传（按 role） |

- 共用谓词（`isUser` / `isA2aInbox` / `sideOfMessage` / `memberSideResolver`）在 `chat-page/chat-actor-strategy.tsx`（策略由 `deriveRenderStrategy(chrome)` 按 chrome.groupRender/memberId 数据驱动，SectionChatSession 消费）。
- reminder 块级过滤是**内核全局默认**（零侵入——`encodeContentBlock` 不读此字段，reminder 仍透明发 LLM）。
- **a2a 双重身份**：发出端 = assistant 的 tool_call（agent 调 send_message 工具）；接收端 = inbox 消息（`sender.source='agent'` + ref，渲染为左侧角色名前缀气泡）。
- **sideResolver 单一职责**：只控「左右侧」；头像/名字仍由 `resolveActor` 决定（解耦）。
- **run 态与 playground 同源**：SSE 主驱动（`agent_loop` + `session_panel` 喂同一套纯 reducer）+ 初始 GET；run 中渲染 on-message spinner + 停止按钮圆环（复用 playground 组件，详见 `02-llm-chat.md §3`）。装配统一在 `chat-page/section-chat-session.tsx`（单聊 `capabilities.runState=true` 挂 run 态；群聊 `runState=false` 走 enabled 门零订阅）。
- **IME 守护**：textarea `onKeyDown` 加 `isComposing || keyCode===229` 检查，组字中 Enter 不发送（群聊/单聊同款）。

### 7.1 群聊页（squadChat）

- a2a 消息（`sender.agent.ref.type∈{leader,mate}`）渲染**角色名前缀** `ref.name:`；user 消息右深底气泡（语义=「你」）。
- 复用 playground chat 气泡视觉（user 右 `--fg` 黑底白字 / agent 左白底灰边，regulation 02 §6）。
- input-bar 内含 InputModelPicker trigger（per-call override；详见组件 spec）。
- 组件 spec 见 `specs/ui/components/studio-page/squad-chat-page.md`。

### 7.2 单聊页（leader/mate）

- leader/mate session 直接接 user POST → final text 回复（不经 SquadChat）。
- **无角色名前缀**（单聊只有一个对端角色）；复用 playground chat 视觉。
- 顶栏**角色头像**（identity dot + name）= **纯身份展示**（`<div>`，不可点，无 cursor / 无 hover）。
- input-bar 内含 InputModelPicker trigger（改 member.model 持久化）。
- 组件 spec 见 `specs/ui/components/studio-page/member-chat-page.md`。

---

## 8. 新建 squad wizard

**入口**：studio-sidebar 顶部「新建 squad」按钮。

**字段**（POST /squad body）：
- `name`（required）
- `description`（optional）
- `modelDefault`（required，ModelRef 选择器）
- `leader.name`（required，建队即建 leader）

**`[v0.0.237 removed]`**：原 `charter`（4 字段）建队入参已移除——squad 不再有 charter 字段。

**提交**：POST /squad → createSquadService（建 squad + leader member + leader session + squadChat session + 目录骨架，详见 data_model.md §4）→ 成功后跳转首页 seats。

组件 spec：`specs/ui/components/studio-page/new-squad-wizard.md`。

---

## 9. 成员创建页（弹层已废，主区页面）

**入口（单入口）**：首页 SeatsPanel seats tab roster 头「＋ 新增成员」按钮 → 主区切 member-create 路由态。

**页面结构**（组件 spec 权威 `specs/ui/components/studio-page/member-create.md`；视觉基线 = member-panel 编辑页同款：topbar 返回 + `max-w-[680px]` Card 纵向）：

- **模式切换**（choice-cards 二选一）：**Fresh** / **Derive**。
- **Fresh**：profile Card——name（必填单行）/ intro（必填单行）/ workStyle（可空多行，直传后端 trim 回写）；**skills Card**（inherit/custom switch + `component-member-skill-filter`，创建时即可配 skills；off=inherit 提交不传 skillConfig）。
- **Derive**：父成员选择卡（本 squad 内非 leader 成员）+ 可选覆盖 name/intro/workStyle（skills 继承父，不暴露 skills Card）。
- **valid**：Fresh = name+intro trim 非空；Derive = 选中父成员；提交按钮常驻（**非** dirty FAB）+ 创建中防重。
- **提交**：POST /squad/:id/member（body 含可选 `workStyle`，11a §2.1）→ createMemberService（建 member + mate session + workspace + 回填双向 + append squad.memberIds，详见 data_model.md §5）→ 回首页 seats，坐席区出现新坐席。
- **取消/返回**：回首页 seats，不创建任何数据。

---

## 10. 空状态

Studio 主页无 squad 时：引导文案 + 「新建 squad」CTA 按钮。

---

## 11. 视觉基线（design token + 设计稿）

全站 token/组件视觉规则归 `specs/ui/regulation/{01-tokens,02-components,03-principles}.md` 银灰体系（light-only + 8 色 hue palette + brand-grad）。逐组件基线以 `specs/ui/components/studio-page/*.md` 为准（已对齐 regulation）。

- **整体**：银灰 token（`--bg=#fafafa` / `--surface=#ffffff` / `--fg=#0a0a0a` / `--btn-primary-bg=#18181b`），与 Playground 一致。详见 `specs/ui/regulation/01-tokens.md §1`。
- **studio-sidebar**：宽 ~224px，`bg-chrome` + 右 `border`；squad 卡片 `rounded-md` + hover `bg-surface-2`。
- **tab 栏**：`border-b` + 激活态 `text-fg` + 2px 底部下划线（regulation 02 §8）。
- **坐席面板（双列指挥台）**：白底面板；左列 296px 白卡组（队长 mini 卡 `rounded-xl + border + p-3.5` + 统计 2×2 无缝格 `gap-px` 缝色底 + 团队 compact links 白卡 `p-2`）+ 右列 roster 白卡（`rounded-xl border overflow-hidden`，行分隔 `--surface-2`，hover 行底 `--bg`）；leader 标识 = 行内 amber badge；offline 卡/行 opacity 0.75；无 @keyframes、无 hover 位移（布局稳定）。视觉契约 `reqs/[done] v0.0.170.squad_home_ui/design-c-console.html`；组件基线详 `specs/ui/components/studio-page/component-seat-{card,row,stats}.md`。
- **member 面板悬浮保存**：primary 黑按钮 + 阴影。
- 设计稿：`reqs/` 各版本 design html。

---

## 12. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| Studio view 整体契约 + 首页单页中枢（SeatsPanel 3 tab 内联）+ member 面板 + 真聊 | 本文 ✅ |
| nav-rail（Playground/Studio 入口 + 设置组折叠） | `specs/ui/components/framework/nav-rail.md` |
| bizType 字段隔离规则 | `specs/tech/agent/session/[P0]session_biztype.md` |
| Squad / Member 数据模型 + 建队/hire 事务 | `specs/tech/squad/[P1]data_model.md` |
| HTTP API 端点（squad CRUD + member 管理 + token-stats + panorama） | `specs/api/overall/` |
| 组件 spec（studio-sidebar / component-seats-panel / component-seats-body / component-seat-card / component-seat-row / component-seat-card-menu / component-studio-context-menu / component-seat-stats / component-team-entry-row / component-token-stats / member-panel / member-create / new-squad-wizard / bench-modal / component-squad-delete / component-manage-tab / component-autowork-tab / heartbeat-config / budget-meter / **component-group-chat-toggle** / panorama 组件族） | `specs/ui/components/studio-page/`（含视觉基线），实现见 `app/web/src/components/studio-page/`（卡/行共享抽离 `use-seat-menu.ts` + `seat-present.ts`）。**`[v0.0.237 removed]`**：原 charter-editor / squad-board / component-board-* 组件已随 charter/board 全链路移除 |
| Studio chat 组件 spec（squad-chat-page / member-chat-page） | `specs/ui/components/studio-page/` |
| 共享渲染内核 ChatStream + 可见性策略机制 | `02-llm-chat.md §3` + `specs/tech/app/frontend/[P0]component_architecture.md §3.3` |
| MemberAvatar 组件 spec（色块 + 首字母，对端 member 头像） | `specs/ui/components/common/member-avatar.md` |
