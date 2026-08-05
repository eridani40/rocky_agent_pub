# v0.0.168 — squad 首页收敛为单页中枢（IA 优化）

> **主体**：v0.0.165 引入的坐席面板升级为「squad 单页中枢」——顶部 tab（坐席/管理/自动工作）**内联切换**面板内容，不再切主区路由态；坐席卡「更多」菜单激活为「编辑 + bench/deploy」承接旧成员 tab 操作；leader 独立成一行更强 highlight；末位挂「+ 新增成员」虚线卡承接 hire 入口；侧栏手风琴展开树删除，只保留 squad 行；看板页/成员编辑页顶部补返回键回首页；单聊顶栏角色头像的「点击进 member 面板」入口移除。
>
> **纯前端 IA 优化 + 后端零改动**：所有操作走既有 HTTP 契约；Squad/Member schema 与 event topic 不变；聊天/看板/hire/bench 既有功能语义不变，只动入口与布局。
>
> **概念权威源**：`specs/ui/overall/06-studio.md` v1.8 + `specs/ui/components/studio-page/{component-seats-panel,component-seat-card,squad-panel,member-panel,member-chat-page,squad-board,studio-sidebar,bench-modal,hire-member-form}.md`。
>
> **无设计稿** → 视觉保真度门禁跳过；视觉沿用 v0.0.165 银灰体系 + regulation。**版本裁决**（用户 2026-07-16）：豁免 AT/ET，UT + typecheck + code-review 保留，用户人工验证。

---

## 1. 已确认决策（用户裁决）

| # | 决策 |
|---|------|
| D1 | 顶部三 tab（`seats-tab-{seats,panel,autowork}`）**内联切换** seats-panel 内容；管理/自动工作 tab 的**内容**（旧 SquadPanel admin-tab + autowork-tab）搬进 seats-panel，不再切主区路由态、不再进 SquadPanel |
| D2 | 旧 SquadPanel **成员 tab 整体取消**：deploy/bench/edit 单成员操作 → 坐席卡「更多」菜单；「新增成员」按钮 → 坐席卡网格末位「+」虚线卡 |
| D3 | 坐席卡「更多」（`seat-card-{id}-more`）激活为菜单：**mate = 编辑 + bench/deploy**（按 state 显可用项）；**leader = 仅编辑**（沿用 v0.0.57「leader 无 bench」，且 leader 建队即 deployed 也无 deploy） |
| D4 | bench 走现有 `bench-modal`（reason 必填）；deploy 直接 POST 无弹层——沿用 v0.0.57 spec |
| D5 | leader 独立一行 + 视觉 highlight 强于 v0.0.165「`--border-strong` 描边」（具体强化形式由 architect + UI spec 定，PRD 只约束「一眼可辨」） |
| D6 | 侧栏 `studio-sidebar` **删除手风琴展开树**（`squad-tree-board-*` / `squad-tree-session-*` 全去），只保留 squad 行（点击 = 选中 + 进首页坐席 tab）+ 新建按钮。**未读红点** 随子节点消失；新的可见回显位置留后续版本增强（本版承认过渡期未读态无侧栏直观可见） |
| D7 | 看板页（squad-board）顶部**新增**「← 返回」；成员编辑页 `member-panel-back` 返回目标统一改为**首页坐席 tab** |
| D8 | 单聊顶栏 `squad-chat-role-avatar` **移除 onClick**——头像只作身份展示不可点；member 编辑唯一入口 = 坐席卡「更多」→「编辑」 |
| D9 | **后端/API/数据模型零改动**（所有操作走既有端点，无新增 event/schema） |
| D10 | 侧栏 chat 入口消失后，chat-topbar `from` 门控是否简化 / 返回键是否常驻由 architect 决定（PRD 只约束「从首页进的对话必有返回键 + 返回目标 = 首页坐席 tab」） |

---

## 2. 功能清单

### 2.1 功能 A：squad 首页 tab 内联渲染（P0）

顶部三 tab 全部内联，不切主区路由态：
| tab | 内容 | 来源 |
|-----|------|------|
| 坐席（`seats-tab-seats`，默认） | 统计条 + 团队入口 + 坐席卡网格（含 leader 独立行 + 「+」卡） | v0.0.165 seats-panel 主内容（本版加 leader 行 + 「+」卡） |
| 管理（`seats-tab-panel`） | squad 元信息（name/description/modelDefault）+ charter 编辑器 + 危险操作区（v0.0.111） | 旧 SquadPanel admin-tab（`component-manage-tab`）整块内联 |
| 自动工作（`seats-tab-autowork`） | autonomy toggle + heartbeat-config + budget-meter + 调度历史 | 旧 SquadPanel autowork-tab（`component-autowork-tab`）整块内联 |

- 成员 tab 取消（D2）；studio 主区**只有一个 landing = seats-panel**。
- tab 视觉沿用 seats-panel 现有 header 三 tab 栏（regulation 02 §8）。

### 2.2 功能 B：坐席卡「更多」菜单激活（P0）

- 触发：坐席卡「更多」按钮 → 菜单浮层（相对按钮定位）。
- **mate 卡菜单**（按 `member.state` 显）：编辑 / bench（deployed 时）/ deploy（benched 时）。
- **leader 卡菜单**：仅编辑（D3）。
- 关闭：点外部 / Escape / 执行任一项后自动关。
- 布局稳定：按钮始终可见（不 hover 才出现）；菜单浮层用 portal/绝对定位，不导致坐席卡位移。

### 2.3 功能 C：leader 独立一行（P1）

- 布局：leader 卡独占坐席网格第一行；mate 卡从第二行开始。
- 视觉强化（D5）：比 v0.0.165 「`--border-strong`」更强（具体由 UI spec 定），保证一眼可辨。
- testid 沿用（`seat-card-{leaderId}` + `-badge-leader`）；无 leader 时首行留空/跳过。
- 布局稳定：强化元素固定尺寸；leader / mate 行边界固定。

### 2.4 功能 D：「+ 新增成员」虚线卡（P0）

- 位置：坐席网格 mate 区末位一格；与 leader 行不同排。
- 样式：虚线边框卡，尺寸 = 坐席卡，中心「+」+ 「新增成员」文案；hover 加强边框不改尺寸。
- 点击：打开现有 `hire-member-form`（fresh/derive，沿用 v0.0.33.1 spec）；`member-hire-btn` 语义迁到此卡。
- testid：建议 `seat-card-add-member`（由 UI spec 定）。

### 2.5 功能 E：侧栏 studio-sidebar 手风琴树删除（P0）

- 保留：容器 / squad 列表行 / `studio-new-squad-btn` / squad 行选中态。
- 删除：squad 行展开动作 + 展开子树（`squad-tree-board-{squadId}` / `squad-tree-session-{sessionId}` 及派生 avatar / unread-dot 全部移除）。
- `expandedId` 状态 + `onOpenBoard` / `onOpenChat` prop 清理由 architect 定；右键菜单（v0.0.129 复制 Session ID）随 chat 子节点消失（保留与否由 architect 定）。
- 未读态（后端 `unread` + `session_meta` 广播）**不变**；只是侧栏可见入口消失（新的可见回显位置留后续版本，本版承认过渡期无直观未读可见）。

### 2.6 功能 F：看板 / 成员编辑页返回键（P0）

- **看板页**（squad-board）顶部左侧新增「← 返回」（ghost 型，视觉同 `chat-topbar-back-btn`）→ 回 `{kind:'seats', squadId}`。testid 建议 `squad-board-back-btn`（由 UI spec 定）。
- **成员编辑页** `member-panel-back`（v0.0.33.1 已存在）返回目标改为**首页坐席 tab**（原「上一视图」逻辑取消，统一到坐席 tab）。
- 布局稳定：返回键始终占位，不 hover 才出现，不推挤 topbar 其他元素。

### 2.7 功能 G：单聊顶栏头像编辑入口删除（P1）

- 保留 `squad-chat-role-avatar` 元素（MemberAvatar + name + tag 身份展示 + ET anchor）。
- 移除 `onClick` → `onOpenMember` 绑定；无 hover 提示、无 `cursor: pointer`。
- member 编辑唯一入口 = 坐席卡「更多」→「编辑」（D8）。

---

## 3. 关键用户路径（MANDATORY — 用户人工验证覆盖）

覆盖本版全部产品可感知变更。本版豁免 AT/ET，用户人工按下列路径验证。

| # | 路径 | 断言落点 |
|---|------|---------|
| **P1** | 选队 → 首页坐席 tab → mate 坐席卡「进入对话」→ chat-topbar「← 返回」 | 坐席进对话正常 + 返回键正确回落首页坐席 tab |
| **P2** | 首页 → mate 坐席卡「更多」→ 菜单点「编辑」→ member 编辑页 → 点顶部返回 | 编辑入口生效；返回目标 = 首页坐席 tab |
| **P3** | 首页 → mate 坐席卡（deployed）「更多」→「bench」→ 填 reason → 确认 | bench-modal 正常、bench 成功、坐席卡刷新为 offline |
| **P4** | 首页 → mate 坐席卡（benched）「更多」→「deploy」 | 无弹层直接 deploy；坐席卡刷新为 online/busy |
| **P5** | 首页 → 团队入口卡「看板」→ 看板页 → 点顶部「← 返回」 | 回到首页坐席 tab |
| **P6** | 首页顶部 tab 点「管理」 | seats-panel 内容区**内联渲染**管理内容（元信息 form + charter + 危险区）；主区路由不变；不进旧 SquadPanel |
| **P7** | 首页顶部 tab 点「自动工作」 | seats-panel 内容区**内联渲染**自动工作（toggle + heartbeat + budget + history）；主区路由不变 |
| **P8** | 首页 → 网格末位「+」虚线卡 → hire-member-form → 完整走 hire 流程 | 表单打开、提交成功、新成员坐席卡出现在网格 |
| **P9** | 侧栏观察 | 只有新建按钮 + squad 列表行；点 squad 行不展开子树；无 `squad-tree-board-*` / `squad-tree-session-*` DOM |
| **P10** | leader 坐席卡观察 + 「更多」菜单 | leader 独占一行且 highlight 明显；「更多」菜单**仅显示「编辑」** |
| **P11** | 首页 → 坐席卡进单聊 → 点顶栏角色头像 | 无跳转、无弹层（头像仅作静态身份展示） |

---

## 4. 范围界定

### 4.1 IN
- 首页三 tab 内联（A）+ 坐席卡菜单（B）+ leader 独立行（C）+ 「+」虚线卡（D）+ 侧栏树删除（E）+ 返回键改造（F）+ 单聊头像 onClick 移除（G）

### 4.2 OUT（本版不做）
- **后端/API/数据模型改动**：零改动（D9）
- **聊天/看板/hire/bench 功能语义**：不变，只动入口与布局
- **未读态新可见位置设计**（侧栏树删除后）：留后续版本，本版承认过渡期
- **旧 SquadPanel 组件物理删除 / 路由态 `{kind:'panel'}` 清理**：由 architect 决定（PRD 只约束「用户不再走到 SquadPanel 路径」）
- **AT/ET 自动化**：豁免（用户裁决）

---

## 5. 非功能需求

- **布局稳定性（MANDATORY）**：「更多」按钮 / leader 强化元素 / 「+」虚线卡 / 首页 tab 栏 / 返回键 全部**固定占位**——hover/切换 tab/菜单展开收起不导致其他元素位移。
- **一致性**：bench-modal / hire-member-form 表单结构、字段、testid 全沿用；仅入口迁移。
- **视觉**：沿用 v0.0.165 银灰体系 + regulation 02（§8 tab 底部下划线、§9 坐席卡）。
- **兼容性**：后端零改动 → tests/api 冒烟集不受影响；ET 冒烟集与本版 UI 结构冲突处由 architect 判定是否更新（本版豁免 ET 不主动跑）。

---

## 6. 边界与衔接

| 零件 | 归属 |
|------|------|
| Studio 主区契约 + 首页 tab 内联 + 侧栏结构 + chat/board 回落 + 单聊头像入口移除 | `specs/ui/overall/06-studio.md`（doc-modifier 阶段） |
| seats-panel tab 内联 + 「+」虚线卡 + leader 独立行 | `specs/ui/components/studio-page/component-seats-panel.md`（本版更新） |
| 坐席卡菜单（mate/leader 差异化） | `specs/ui/components/studio-page/component-seat-card.md`（本版更新） |
| 侧栏树删除 + squad 行只做选中 | `specs/ui/components/studio-page/studio-sidebar.md`（本版更新） |
| 看板页返回键 | `specs/ui/components/studio-page/squad-board.md`（本版新增 back-btn） |
| 成员编辑页返回目标改为首页坐席 | `specs/ui/components/studio-page/member-panel.md`（本版更新 `member-panel-back` 语义） |
| 单聊顶栏头像 onClick 移除 | `specs/ui/components/studio-page/member-chat-page.md`（本版更新） |
| bench-modal / hire-member-form | 沿用（无改动） |
| 变更契约（method 级） | `specs/tech/version_logs/v0.0.168.ui_opt/change_plan.md`（architect 阶段） |

---

**version**：1.0（v0.0.168 首版；PRD 覆盖：首页 tab 内联 + 坐席卡菜单 + leader 独立行 + 「+」虚线卡 + 侧栏树删除 + 返回键改造 + 单聊头像入口移除；后端零改动；AT/ET 豁免、用户人工验证）
