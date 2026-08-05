# v0.0.165 — UI 视觉体系升级（暖橙 → 银灰）+ 坐席面板

> **主体**：换主色调 + 组件视觉重塑（terracotta 暖橙 → 银灰中性 + 8 色彩虹身份点缀，light-only，严肃基调）。**唯一附加的功能/交互变更** = studio 引入「坐席面板」新 IA + chat-topbar 条件返回按钮。其它章节涉及的组件均为**视觉侧影响面**，产品行为不变、后端零改动。
>
> **概念权威源**（本 PRD 引用不发明）：`specs/ui/regulation/01-tokens.md`（唯一 hex 权威）+ `02-components.md`（跨页组件视觉规则，含坐席卡 §9 / 模型选择面板 §7 / 消息时间 §6）+ `03-principles.md`（中性壳彩色身份 / 白名单彩色边界 / 严肃基调 / light-only）+ `specs/ui/overall/06-studio.md`（studio 现契约，本版新增坐席 tab 需增补）+ 设计稿 `reqs/[working] v0.0.165.ui_upgrade/design/*.html`（视觉权威）。
>
> **有设计稿 → 视觉保真度门禁 MANDATORY**（layout/font/border/color 逐维度 compare，走 vision_check.py compare）。

---

## 0. 背景与动机

### 0.1 换肤动机
现有 terracotta 暖橙体系（`specs/tech/app/frontend/[P0]design_system.md` §5.1）视觉焦点太强，与「长期陪伴、信息密度大」的 agent 工具型定位不匹配；参考 macOS App Store（银灰壳 + 彩色内容）与 Multica/Linear（极简白灰 + 身份点缀），把 chrome 中性化，让彩色专职承载「谁 / 什么身份」（成员 / skill / plugin / model / brand）。

### 0.2 坐席面板动机
现状 studio 团队管理 tab（`current/studio-members.png` 单列 member card）只是配置界面；进对话必须从左侧会话列表点入，缺「团队全景 + 快速进入」视图。本版本引入 call-center console 风格「坐席面板」——统计条 + 团队入口 + 成员坐席卡网格，坐席卡直接承载「谁在忙 / 谁空 / 谁离线」的一眼扫描，点卡进对话。

### 0.3 附带缺陷修复（用户裁决 §3.4.1）
1. Playground idle hero 标题「开始新对话」与下方按钮语义重复 → 去标题，按钮适当放大。
2. 对话消息 block 下**无时间显示** → 每条消息下方补浅色小字 mono 时间。
3. app dev config 内嵌模型选择面板与外部设置内模型面板视觉不一致 → 全站统一为一个契约（regulation §7）。
4. 设置页仍有主题（Dark/Light）配置项，深色代码全站残留 → 一并下线（本版 light-only）。

---

## 1. 已确认决策（用户裁决，直接引用）

| # | 决策 | 出处 |
|---|------|------|
| D1 | 主色调走 Multica/Linear 系纯白 + 浅灰（非 App Store vibrancy 材质） | req §3.1 |
| D2 | 彩虹 palette 固定 8 色 + `hash(identityId)%8`；使用边界白名单制（仅头像 / icon-box / brand / presence，禁按钮/边框/tab/focus） | req §3.2 + regulation 01 §1.7 + 03 §2 |
| D3 | **light-only**：设置页删主题项、tokens 无 dark 变量集、组件不写 `dark:` 分支 | req §3.3 + regulation 03 §4 |
| D4 | **严肃基调**：无 floaty/wave/pulse/入场动效（idle hero 浮动/挥手/脉冲全去），无装饰性 emoji，文案陈述式短句 | req §3.4 + regulation 03 §3 |
| D5 | 消息时间：agent 左对齐 / user 右对齐，`.msg-time` 10.5px mono `--muted-2` | req §3.4.1(2) + regulation 02 §6 |
| D6 | 模型选择面板全站统一契约：trigger 收起态 + 300px panel 展开态；chat 输入区 / studio 默认模型 / settings 模型页 / app dev config **同一实现** | req §3.4.1(3) + regulation 02 §7 |
| D7 | 坐席面板 IA 过渡期共存：**左侧成员会话列表保留**；从坐席进入的对话 chat-topbar 显示「← 返回」，从左侧进入不显示（未来左侧入口下线后返回按钮成为唯一回退路径） | req §3.5 |
| D8 | **后端零改动**：坐席卡数据只用现有 API 已有字段，缺失字段降级不显示，本版不新增 presence/token 计数等后端能力 | context §视觉改版 findings + req §3.5「PRD/架构落细节」 |

---

## 2. 功能 A：全站视觉体系换肤（银灰 + 彩虹身份）

**描述**：把 tokens.css 全套替换为 regulation 01 定义的银灰体系，清零产品代码硬编码 hex（≈66 处），组件通过 CSS 变量自动跟随。
**优先级**：P0
**用户故事**：作为用户，我希望产品视觉从「暖橙陶土」切换为「银灰中性 + 彩色身份点缀」，chrome 让位给内容，成员 / skill / plugin 一眼可分辨。

### 2.1 影响面
- **应用 chrome**：`--bg #fafafa` / `--surface #ffffff` / `--chrome #f7f7f8`；nav-rail、titlebar、面板底一律走银灰系。
- **按钮四型**（regulation 02 §1）：primary=黑底白字 / secondary=白底灰边 / ghost=透明 / danger=红底；**去除所有橙色按钮和渐变按钮**。「确定 / 取消」均归此四型。
- **Badge 状态色**（regulation 02 §2）：`--success/--warning/--danger/--info` 浅底深字；中性 badge（LEADER / deployed / free）走 `--surface-2` + `--fg-3` + `--border`。
- **表单控件**：input focus 从暖橙 → `--border-strong` 边 + `--shadow-focus` 灰环；toggle 选中态从橙 → 黑；checkbox 黑选中态。
- **列表 / tab**：active 从暖橙下划线/边框 → `--fg` 下划线 + `--fg` 字。
- **Avatar 彩虹身份**（regulation 02 §3 + 03 §2）：成员头像 role-based 三色 → `hash(identityId)%8` 分配 8 色 palette；presence 点右下角覆盖白描边 2px。
- **Icon-box**（regulation 02 §4）：skill / plugin / model / 团队入口用 32px 圆角 md 浅底 `--hue-*-bg` + 主色 `--hue-*` 线性图标，同实体 hash 同色。
- **brand mark**：R logo 用 `--brand-grad` 渐变块（全站与 playground idle hero orb 共两处）。Playfair Display 衬线字下线。

### 2.2 E2E Use Cases（本节）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-A1 | 启动应用 → 观察整体视觉 | 全站为银灰中性 chrome（`--bg #fafafa` + `--surface #ffffff`），无任何 terracotta 橙色元素 |
| UC-A2 | 打开 Playground → 观察 CTA / focus / active tab | 主 CTA = 黑底白字；input focus = 灰环无彩色；tab active = 黑下划线 |
| UC-A3 | 打开 studio 成员列表 → 观察多个成员头像 | 每个成员头像为 palette 8 色之一；同一 memberId 每次进入颜色恒定（hash 分配） |
| UC-A4 | 打开 skill 页 → 观察 skill 图标 | 每个 skill 有 32px 彩色 icon-box（`--hue-*-bg` 底 + `--hue-*` 图标） |
| UC-A5 | 全局 grep 检查（辅助）：应用运行时 DOM inspect 观察 chrome 元素 | 无硬编码 `#DC2626` / `#B89160` / `#5B7A6B` 出现在 chrome 类元素 |

---

## 3. 功能 B：严肃基调 + 深色模式下线

**描述**：删除全站装饰性动效与 emoji；设置页移除主题（Dark/Light）配置项；tokens.css 移除 dark 变量集与所有 keyframes。
**优先级**：P0
**用户故事**：作为用户，我希望界面陈述式、无装饰性动效干扰；不再看到"主题切换"选项。

### 3.1 交互细节
- **动效清零**：删除 tokens.css 中 `drawerUp / fadeIn / floaty / idlePulse / wave` 等 keyframes；idle hero 浮动 orb、挥手 emoji、脉冲效果全去。仅保留 ≤150ms 的 hover/按压过渡（regulation 03 §3）。
- **Emoji 清零**：界面文案（含 idle hero、settings、toast、empty state）不带 👋🎉 类装饰 emoji。**消息内容里用户/agent 自己发的不管**（这属于对话内容）。
- **主题项下线**：`04-config-center-ui.md §3.9.2 appearance` group 的 `theme` key 从 UI 移除；`GET /config/app` 若仍返回 theme 字段前端忽略；设置页只保留 `locale` group（+ providers/user_memory/web_search 等既有 group）。**appearance group 若清空则整个 group 从 group 列表隐藏**。
- **idle hero 简化**（补丁 §3.4.1(1)）：Playground 空态去除「开始新对话」标题；保留下方 CTA 按钮，尺寸放大到 h46（regulation 02 §1 特批档），文字「新建对话」。

### 3.2 E2E Use Cases（本节）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-B1 | 打开 settings → 观察 group 列表 | 无「主题 / Appearance」相关项（若原 appearance group 仅剩 theme 则整 group 隐藏，否则该项被移除） |
| UC-B2 | 打开 Playground 空态 → 观察 idle hero | 无「开始新对话」标题；下方仅一个放大的「新建对话」CTA 按钮（h46） |
| UC-B3 | 打开任意页面停留 3s → 观察是否有元素持续动画 | 无 floaty/wave/pulse 等持续动效；仅 hover/按压过渡（≤150ms） |
| UC-B4 | 全站文案观察 | 无装饰性 emoji（👋🎉 等）出现在 idle hero / settings / toast / empty state |

---

## 4. 功能 C：消息时间显示

**描述**：对话区每条消息 block 下方以浅色小字 mono 展示该条消息的发送时间。
**优先级**：P1
**用户故事**：作为用户，我希望知道每条消息何时发出，方便回顾时序。

### 4.1 交互细节
- **样式**（regulation 02 §6）：`.msg-time` = 10.5px mono `--muted-2`；agent 消息左对齐 / user 消息右对齐。
- **数据源**：消息本身已有 timestamp（`message.createdAt` 或 SSE 事件时间）——**后端零改动**，前端读既有字段格式化。
- **格式**：`HH:mm`（同日）；跨日附日期 `MM-dd HH:mm`（具体阈值由前端实现定，非产品硬约束）。
- **覆盖范围**：playground chat / studio 单聊（leader/mate）/ studio 群聊（squadChat）—— 三 chat 页同源共用 `BaseChatPage`（`specs/ui/components/chat-page/_overview.md §4.4`），只需在共享内核 `ChatStream` 每条 message block 追加时间元素。
- **布局稳定性**（CLAUDE.md「布局稳定性 MANDATORY」）：消息时间元素**始终占据固定行高**，不受 hover 状态影响；不导致相邻消息位移。

### 4.2 E2E Use Cases（本节）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-C1 | 打开 playground 已有对话 → 观察每条消息 | user 消息右下 / agent 消息左下均有 10.5px mono 灰字时间（HH:mm 格式） |
| UC-C2 | 发送新消息 → 观察消息 block | 新消息下方立即出现时间，样式同 UC-C1 |
| UC-C3 | 进入 studio 单聊 leader → 观察消息时间 | 同 UC-C1，样式一致（BaseChatPage 同源） |

---

## 5. 功能 D：模型选择面板全站统一

**描述**：把 app dev config 内嵌的模型选择面板与外部设置内模型面板、chat 输入区模型 picker、studio 默认模型 picker 统一为**一个组件实现**，同一视觉契约（regulation 02 §7）。
**优先级**：P1
**用户故事**：作为用户，我希望在任何地方选择模型时看到同一个面板长相，不产生「这两个 UI 是不是同一个产品」的错乱感。

### 5.1 契约（regulation 02 §7）
- **trigger 收起态**：白底 `--border-2` 边 radius-md，内含 22px icon-box（provider hash 色）+ mono 模型名 + 下拉箭头。
- **panel 展开态**：300px 白卡 radius-lg + `--shadow-lg`；顶部搜索框；列表项 = 24px icon-box + mono 模型名 + 选中 ✓（黑色）；active 项 `--surface-3` 底。
- **视觉样例**：`design/_gallery.html`「模型选择面板」节。

### 5.2 挂载点（全站四处 → 同一实现）
1. **playground chat 输入区**（既有 `component-input-model-picker`，`chat-input-bar` 内）
2. **studio 单聊 / 群聊输入区**（既有 `chat-model-picker`，v0.0.91.ui_fix 已迁 input-bar）
3. **settings 模型页**（provider 内 model list 选择）
4. **app dev config 内嵌模型选择**（凡涉及模型选择处）

**架构说明**：本版属**视觉/交互契约统一**——若既有实现已足以承载（如 `component-input-model-picker`），则通过 CSS 统一 + trigger/panel 抽离即可；若三处实现有分歧则以 `component-input-model-picker` 为基线合并。具体重构由 architect 在 change_plan 拍板。

### 5.3 E2E Use Cases（本节）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-D1 | playground chat 输入区点模型 trigger → 展开 panel | 300px 白卡 + 搜索框 + 列表；trigger/panel 符合 regulation §7 |
| UC-D2 | studio 单聊 leader 输入区点模型 trigger → 展开 panel | 视觉与 UC-D1 完全一致（同一组件） |
| UC-D3 | settings 模型页选择 model → 展开面板 | 视觉与 UC-D1 完全一致 |
| UC-D4 | app dev config 内嵌模型选择 → 展开面板 | 视觉与 UC-D1 完全一致（不再是旧的异构面板） |

---

## 6. 功能 E：studio 坐席面板（新 IA + chat-topbar 条件返回）

**描述**：studio 主区新增「坐席」tab，展示**统计条 + 团队入口 + 成员坐席卡网格**；坐席卡直接点入对话。从坐席面板进入的对话 chat-topbar 显示「← 返回」按钮回到坐席面板；从左侧成员列表进入的对话不显示（保留旧路径共存）。
**优先级**：P0
**用户故事**：作为团队 owner，我希望一眼看到全队成员当前状态（在线 / 忙碌 / 离线）+ 一键进对话，不用先展开左侧树。

### 6.1 UI 组成（regulation 02 §9 + design `studio-console.html`）
- **统计条**：4 格白卡（在线数 / 进行中任务 / 今日消息 / 今日 token），34px 彩色 icon-box + 22px 数字。**数据可得性见 §6.4**；不可得的格降级显示「—」或不渲染整格。
- **团队入口区**：看板 / 群聊两个入口卡（复用现有 `squad-tree-board-{squadId}` / squadChat 语义路由）。
- **坐席卡网格**：白卡 radius-xl p16，网格 3 列。每张卡结构 =
  - avatar-lg + presence 点（右下角，白描边 2px）
  - 名字 / 角色
  - **状态行**：`--surface-2` 底圆角块 + 脉冲点 + 一句话状态描述
  - **meta 行**：mono 11px（in/out token + 最近活跃时间）
  - **操作行**：黑底「进入对话」primary + secondary「更多」按钮
- **leader 卡**：外圈 `--border-strong` 边突出。
- **离线卡**：整体 0.75 透明度 + 「进入对话」降 secondary。

### 6.2 IA 与返回按钮（决策 D7）
- **过渡期共存**：左侧成员会话列表继续保留；坐席面板作为**新入口**并存。
- **返回按钮显示条件**：`chat-topbar` 左侧显示「← 返回」（ghost 型）**仅当**该对话是**从坐席面板进入**的。
  - 「来源」追踪方式（**架构定，PRD 只约束语义**）：路由 state / 会话历史 / 临时 flag 皆可，产品硬约束 = 「面板→对话→返回按钮回面板」链路必须成立；「侧栏→对话」链路不显示返回按钮。
  - 从坐席进入并点返回 → 回到坐席面板（不是回到 Studio 空态）。
- **未来演进**（非本版）：左侧 chat 入口下线后，返回按钮成为唯一回退路径。本版**不下线左侧入口**。

### 6.3 tab 位置与 studio-sidebar 关系
- 坐席面板归属为 studio 主区的**新路由态**（与 §2.2「团队看板页」并列的 MainView kind），入口 = studio-sidebar 顶部/或新 tab。**入口具体位置由 architect + 设计稿 studio-console.html 定**（PRD 只保证「进得来」）。
- 现有 3-tab squad 面板（管理/成员/自动工作）**保留不变**；坐席面板是**新增视图**，不替换任何既有 tab。

### 6.4 数据字段可得性（**架构核实清单** — 后端零改动前提下的假设）

| 坐席卡字段 | 假设的现有数据源 | 若不可得则降级 |
|-----------|----------------|---------------|
| presence 4 态（online/busy/idle/offline） | 派生自 `member.state`（deployed→online / benched→offline）+ session run 态（running/reasoning→busy）；无「idle」概念 | 只显示 online/busy/offline 三态，不显示 idle |
| 状态行一句话 | `member.currentWork`（v0.0.116 已入 `SquadDetail.members[]`，见 studio §4.5 备注） | 无值 → 显示 `在线待命` / `已下岗` 兜底文案 |
| meta·最近活跃时间 | member session 的 `updatedAt` 或最新一条 message 的 timestamp | 无值 → 该字段隐藏（保持行高） |
| meta·in/out token | **后端无 per-member 计数字段** | **本版不显示**（或整个 meta 行只保留最近活跃） |
| 统计条·在线数 | `squad.members` 中 deployed 数量 | 直接可得 |
| 统计条·进行中任务 | squad 下 session 处于 running 态的数量 | 若无聚合端点 → 前端遍历 sessions 现算或降级为「—」 |
| 统计条·今日消息 | 后端**无 per-day 聚合** | **本版降级为「—」或整格不渲染** |
| 统计条·今日 token | 后端有 squad 级 budget usage（v0.0.116 `GET /squad/:id/budget/usage`）但非「今日」维度 | 用 budget consumed 展示（改文案「已用 token」）或降级为「—」 |

**架构阶段必须核实**每项字段的实际可得性；不可得项按上述降级方案落地，**不新增后端字段/端点**（决策 D8）。

### 6.5 E2E Use Cases（本节）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-E1 | studio 主区进「坐席」入口 → 观察面板 | 看到统计条（4 格，可得字段有值 / 不可得显示「—」）+ 团队入口 + 成员坐席卡网格 |
| UC-E2 | 观察坐席卡 | 每张卡有 avatar+presence 点 + 名字/角色 + 状态行 + meta 行 + 「进入对话」按钮 |
| UC-E3 | 点某坐席卡「进入对话」→ 进入对话 → 观察 chat-topbar | topbar 左侧有「← 返回」按钮（ghost 型） |
| UC-E4 | 点 UC-E3 的「← 返回」→ 观察当前视图 | 回到坐席面板（不是 studio 空态、不是别的 tab） |
| UC-E5 | 从左侧成员会话列表点某 member → 进入对话 → 观察 chat-topbar | topbar **无**「← 返回」按钮（保留旧行为） |
| UC-E6 | leader 坐席卡 vs mate 坐席卡 | leader 卡有 `--border-strong` 突出边框 |
| UC-E7 | benched（离线）成员坐席卡 | 整卡 0.75 透明度；「进入对话」为 secondary 型 |

---

## 7. 关键用户路径（MANDATORY — 测试最低覆盖要求）

覆盖本版本全部产品可感知变更。**每条路径至少一个 ET case（AT 本版无需——无 API 契约变更，见 §9）。**

| # | 路径 | 断言落点 |
|---|------|---------|
| **P1** | 打开 studio → 进「坐席」tab → 看到成员状态卡 → 点「进入对话」 → chat-topbar 有「← 返回」按钮 → 点返回 → 回到坐席面板 | 面板渲染 + 卡片可点 + 返回按钮出现 + 返回后视图正确 |
| **P2** | 打开 studio → 从左侧成员会话列表点 member → 进入对话 → chat-topbar 无「← 返回」按钮 | 旧路径不受影响，无返回按钮 |
| **P3** | 启动应用 → 全站视觉观察（nav-rail / 按钮 / badge / 头像） | 银灰体系生效（chrome 无橙色）+ 头像 palette 8 色 + brand R 渐变块 |
| **P4** | 打开任意 chat 页 → 发消息 / 观察既有消息 | 每条消息 block 下方有浅色小字 mono 时间（agent 左 / user 右） |
| **P5** | 打开 settings → 观察 group 列表 | **无**主题（Dark/Light）配置项 |
| **P6** | 依次打开：playground chat 输入区模型 picker / studio 单聊模型 picker / settings 模型页 / app dev config 模型选择 | 4 处面板视觉完全一致（同一契约） |
| **P7** | 打开 Playground 空态 | 无「开始新对话」标题；仅一个放大的「新建对话」CTA + 无装饰性 emoji + 无持续动效 |

---

## 8. 非功能需求

### 8.1 视觉保真度（MANDATORY — 有设计稿）
- test-plan 必须列 compare checks，逐维度（layout / font / border / color）对照 `design/*.html`；跑 `vision_check.py compare` 全 PASS 才可合并。
- 明显偏差建 `BUG-xxx-[open].md` 标「视觉保真」；除非用户确认可带 known-issue 合并。

### 8.2 布局稳定性（CLAUDE.md MANDATORY）
- 消息时间元素、坐席卡按钮 hover 态、chat-topbar 返回按钮的出现/消失**不导致其他元素位移**。返回按钮**条件出现**必须预留空间或绝对定位。

### 8.3 一致性守则（regulation 03 §5）
- 硬编码 hex 零散写 = code review FAILED；只允许引用 token（Tailwind utility 或 `var(--*)`）。
- 同一控件全站一个长相（模型面板、toggle、badge、avatar）—— 发现两处不一致即 bug。

### 8.4 无后端改动
- 本版 tests/api（AT）**零新增 case**（无 API 契约变更）；仅需既有 AT 冒烟集回放不 regressed。

---

## 9. 范围界定（IN / OUT）

### 9.1 IN
- 全站视觉换肤（tokens.css 重写 + 硬编码 hex 清零）
- 按钮 / badge / avatar / icon-box / 表单控件视觉重塑
- 消息时间显示（三 chat 页）
- 模型选择面板全站统一
- 设置页主题项下线 + tokens dark 变量集下线 + keyframes 下线 + 装饰 emoji 下线
- Playground idle hero 简化（去标题、按钮放大）
- studio 坐席面板（新 IA 视图）
- chat-topbar 条件返回按钮

### 9.2 OUT（本版不做）
- **深色模式**：已下线，不做也不留开关（决策 D3）
- **左侧成员会话列表下线**：过渡期共存，本版不动（决策 D7）
- **presence 后端能力**：不新增 `presence` 字段/端点，全部前端派生 + 降级（决策 D8）
- **per-member token 计数**：不新增后端聚合，坐席卡 meta 行 in/out token 本版降级不显示（§6.4）
- **今日消息 / 今日 token 聚合端点**：不新增，统计条相应格降级为「—」或不渲染（§6.4）
- **左侧 nav-rail / chat 入口下线**：留后续版本
- **移动端适配**：本版仅桌面 Electron
- **动效恢复选项**：严肃基调是产品定位裁决（决策 D4），无「让用户切回动效」的开关

---

## 10. 边界与衔接

| 零件 | 归属 |
|------|------|
| token 词表 + 语义规范（唯一 hex 权威表） | `specs/ui/regulation/01-tokens.md` |
| 跨页组件视觉规则（按钮/avatar/icon-box/消息时间/模型面板/坐席卡） | `specs/ui/regulation/02-components.md` |
| 设计原则（中性壳彩色身份 / 白名单 / 严肃基调 / light-only） | `specs/ui/regulation/03-principles.md` |
| Studio 页整体契约 + 坐席面板 tab / 组件 testid 补充 | `specs/ui/overall/06-studio.md`（本版增补，doc-modifier 阶段落） |
| chat-topbar 返回按钮 testid 契约 | `specs/ui/components/chat-page/_overview.md § component-chat-topbar`（本版增补，doc-modifier 阶段落） |
| 组件视觉基线（字体/尺寸/边框/配色 token 对照设计稿） | `specs/ui/components/**/*.md`「视觉基线」字段（coder 阶段填） |
| tokens.css 物理源改写 | `app/web/src/styles/tokens.css`（照抄 regulation 01 §1） |
| 旧暖橙 spec 改写 | `specs/tech/app/frontend/[P0]design_system.md` §2/§5 改指向 `specs/ui/regulation/`（doc-modifier 阶段） |
| E2E 测试（视觉保真 + 功能 dom_asserts） | `tests/e2e/**`（e2e-test-designer 按 test-plan 设计 + compares[]） |

---

## 11. 里程碑

- **PRD 确认**：本文件用户 review 通过
- **架构确认**：`specs/tech/version_logs/v0.0.165.ui_upgrade/change_plan.md` 8 列齐全 + §6.4 字段可得性核实结论
- **test-plan 确认**：路径→case 映射（P1-P7）+ 视觉保真 compare 清单（8 张设计稿 × layout/font/border/color 4 维度）
- **编码**：tokens.css 重写 + 硬编码 hex 清零 + 坐席面板新增 + chat-topbar 返回按钮 + 消息时间 + 模型面板统一 + idle hero 简化 + 设置主题项下线
- **验证**：ET 通过率 ≥70%、hard_fail=0、P1-P7 全 PASS、视觉保真 compare 全 PASS
- **doc-modifier**：`specs/ui/overall/06-studio.md` 补坐席 tab §2.3；`chat-page/_overview.md` 补 topbar 返回 testid；`design_system.md` §2/§5 改写指向 regulation

---

**version**：1.0（v0.0.165 首版；PRD 覆盖：视觉换肤 + 严肃基调 + 消息时间 + 模型面板统一 + 坐席面板 + chat-topbar 条件返回；后端零改动）
