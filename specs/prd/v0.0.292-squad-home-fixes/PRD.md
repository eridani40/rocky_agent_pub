# v0.0.292 PRD — Squad 首页问题修复 + Leader 卡片重设计

- **版本号**: v0.0.292
- **版本主题**: 首页成员计数修正 + leader 卡片反色重设计 + 全景卡片边界/高度 + 整页滚动 + 群聊开关挪 tab
- **需求文件**: `states/v0.0.292/req.md`（老板 2026-08-08 11:17 提，5 点）
- **工作目录**: `worktrees/0.0.292-squad-home-fixes`
- **类型**: 用户可感知 UI 变化 → 完整 PRD
- **前置版本**: v0.0.288（首页布局重构：左竖条+右全景），本版本基于 288 迭代

---

## 1. 背景

### 1.1 现状（v0.0.288 后）

v0.0.288 完成首页布局重构为「左竖条（token 卡上 + 成员卡下，~300px）+ 右全景」，但遗留 5 个问题：

1. **成员计数排除 leader**：成员列表头「成员·N」的 N = 非队长行数（`nonLeaderCount` 过滤掉 `isLeader`）。老板要求改回列表实际长度（含队长）。
2. **leader/mate 标识不显著 + 页面无视觉重心**：leader 入 MemberRosterList 行内仅一个小 badge（`bg-bg-warm` + 10px mono `LEADER`），与其他 mate 行视觉无差异。页面没有重心——用户最常用的 leader 对话入口淹没在列表里。
3. **右侧全景无卡片边界**：左竖条 token 卡 + 成员卡有 `rounded-xl border border-border bg-surface` 白卡边界，但右侧全景（PanoramaRoute）直接裸露在 flex 容器中，无外层卡片包裹，视觉割裂。同时各卡片高度被内侧滚动/固定高度限制，内容多时在卡片内部滚动而非撑开。
4. **页面无法滚动**：根容器 `flex flex-1 min-h-0`，但内容超出时整页无滚动（可能是 `min-h-0` + `overflow-hidden` 导致内容被截断）。
5. **群聊开关在错误 tab**：`GroupChatToggle` 当前在「自动工作 tab」（`AutoworkTab` 第 2 块），老板要求挪到「管理 tab」。

---

## 2. 核心决策

### D1. 成员计数改回列表实际长度（点1）

成员列表头「成员·N」的 N 改为**当前视图实际行数**（含 leader）：

- `view === 'active'`：N = running 行数 + idle 行数（含 leader 行，不再 `nonLeaderCount`）
- `view === 'all'`：N = running + idle + benched 行数（含 leader 行）

**改动范围**：`component-seats-body.tsx` 的 `memberCount` 计算逻辑——删除 `nonLeaderCount` 过滤函数，直接用 `rows.running.length + rows.idle.length (+ rows.benched.length)`。

**i18n**：`seats.sectionMembers`（「成员·{{count}}」）插值不变，count 值变。

### D2. Leader 卡片反色重设计（点2）

**设计目标**：leader = 页面视觉重心 = 最常见对话入口。通过反色设计让 leader 行从所有成员行中脱颖而出。

**设计方案 — Leader 行反色整行高亮**：

Leader 在 MemberRosterList 行内不再与 mate 同样式，而是**整行反色**：

| 属性 | Mate 行（现状不变） | Leader 行（新增） |
|------|-------------------|------------------|
| 行背景 | 透明（hover `bg-surface-2`） | `bg-fg`（黑底，恒显不靠 hover） |
| 名字色 | `text-fg`（白底黑字） | `text-surface`（黑底白字 = 反色） |
| badge | `bg-bg-warm` + `text-muted` + `text-[10px]` | `bg-white/15` + `text-white/80` + **加大 `text-[10.5px] font-semibold`** |
| presence 文字 | `text-muted` | `text-white/60` |
| hover | `bg-surface-2` | `bg-fg/90`（微调，保持反色底） |
| avatar | 正常 | **保持原色不变**（avatar 已有角色色，反色背景下保持辨识度） |
| SpinnerRing | accent 旋转环（running 时） | 保持（running 时仍转） |
| hover chat icon | `text-fg-2 opacity-0→1` | `text-white/70 opacity-0→1` |

**关键设计点**：
- Leader 行**恒显反色底**（不靠 hover）——进页面第一眼就能定位 leader。
- Leader 行 hover 不位移/不变 layout（仅微调背景色 `bg-fg → bg-fg/90`）。
- Avatar 不反色——avatar 是角色色色块，在黑底上保持原色更有辨识度。
- Leader 恒渲染在 running 分区第一行（`derivePanelRows` 已保证 leader 排在 running 首位——leader 恒 deployed + running 状态）。

**实现方式**：`PanelRowView` 新增 `row.isLeader` 判断，当 `isLeader === true` 时应用反色 className 集合（覆盖默认 running/idle/benched 样式）。**Leader 行不受 variant 灰度策略影响**（leader 恒 deployed 在 running 区，但即使 idle/benched 也不灰显——leader 恒反色高亮）。

### D3. 全景卡片边界 + 高度撑开（点3）

#### D3a. 右侧全景加外层卡片边界

右侧全景容器从裸 `min-w-0 flex-1 overflow-hidden` 改为**带卡片边界的容器**：

```
旧：<div className="min-w-0 flex-1 overflow-hidden">
新：<div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-surface p-4">
```

与左侧 token 卡 + 成员卡风格一致（`rounded-xl border border-border bg-surface`）。

#### D3b. 卡片高度随内容撑开（去内侧滚动）

**机制**：移除卡片容器的固定高度 / `max-height` / `overflow-y: auto` 约束，让卡片高度由内容自然决定：

- 成员列表卡：移除 `overflow-hidden`（当前 `overflow-hidden rounded-xl border`），改为 `rounded-xl border`（内容撑开高度）。
- 右侧全景卡：内部 PanoramaRoute 的滚动行为保持（全景有自己的卡片+看板体系），但外层卡片高度不固定——如果全景内容多，卡片跟着撑高。
- TokenWidget 卡：内容固定（今日总量/60天总量/7日柱），高度天然固定，无需改。

### D4. 整页可滚动（点4）

**问题根因**：当前根容器 `<div className="flex flex-1 min-h-0 gap-5 px-6 py-5">` 中 `flex-1 min-h-0` 让容器填满父级但不超出——内容超出时被 `overflow-hidden` 截断。

**修复方案**：

根容器改为允许垂直滚动：

```
旧：<div className="flex flex-1 min-h-0 gap-5 px-6 py-5">
新：<div className="flex flex-1 min-h-0 gap-5 px-6 py-5 overflow-y-auto">
```

- 左竖条 + 右全景作为 flex 行并排，当任一列内容高度超出视口时，整页垂直滚动。
- 左竖条 `w-[296px] shrink-0` 保持固定宽。
- 左竖条内部 `flex-col gap-3.5` 保持垂直堆叠，但移除 `shrink` 约束让其内容撑开（`flex-col` 天然撑开高度）。
- 右全景列 `flex-1 min-w-0` 保持自适应宽度。

**布局不变量**：左右并排结构不变（不改为上下堆叠），只是允许整页滚动。

### D5. 群聊开关从「自动工作 tab」挪到「管理 tab」（点5）

**当前位置**：`AutoworkTab` 第 2 块（`SquadAutonomyToggle` 之后、`HeartbeatConfigSection` 之前）。

**目标位置**：`ManageTab`（管理 tab）—— squad 元信息编辑区（name/description/modelDefault/effortDefault）之后、危险操作区（`SquadDeleteSection`）之前。

**改动**：
- `component-autowork-tab.tsx`：删除 `<GroupChatToggle>` 块（剩余四块：toggle + heartbeat + budget + history）。
- `component-manage-tab.tsx`：在保存按钮之后、`SquadDeleteSection` 之前插入 `<GroupChatToggle squadId={detail.id} enableGroupChat={detail.enableGroupChat} onPatch={onSaveMeta} />`。
- `component-autowork-tab.md` spec：更新组合块从五块→四块，删除 group-chat-toggle 引用。
- `component-group-chat-toggle.md` spec：挂载位置从 autowork-tab → manage-tab。
- `ManageTab` 需新增 `onSaveMeta` prop 透传给 GroupChatToggle（已有 `onSaveMeta`，无需新增）。

---

## 3. 功能需求

### 3.1 成员计数修正（点1）

| # | 需求 | 说明 |
|---|------|------|
| F1 | 计数含 leader | N = 当前视图实际行数（running+idle 或 +benched），不再排除 leader |

### 3.2 Leader 卡片反色重设计（点2）

| # | 需求 | 说明 |
|---|------|------|
| F2 | Leader 行整行反色高亮 | 黑底（`bg-fg`）白字（`text-surface`），恒显不靠 hover |
| F3 | Leader badge 强化 | 反色底上 `bg-white/15 text-white/80`，加大 `text-[10.5px] font-semibold` |
| F4 | Leader 行 hover 仅微调底色 | `bg-fg → bg-fg/90`，无位移 |
| F5 | Leader avatar 保持原色 | 反色底上 avatar 不反色，保持角色色辨识度 |
| F6 | Leader 行不受 variant 灰度影响 | leader 恒反色高亮（即使 idle/benched 不灰显） |

### 3.3 全景卡片边界 + 高度撑开（点3）

| # | 需求 | 说明 |
|---|------|------|
| F7 | 右侧全景加外层卡片边界 | `rounded-xl border border-border bg-surface`（同左卡风格） |
| F8 | 成员列表卡高度随内容撑开 | 移除 `overflow-hidden`，内容撑开卡片高度 |
| F9 | 全景卡片高度随内容撑开 | 全景外层卡片高度不固定，内容多则撑高 |

### 3.4 整页可滚动（点4）

| # | 需求 | 说明 |
|---|------|------|
| F10 | 整页可垂直滚动 | 根容器 `overflow-y-auto`，内容超出视口时整页滚动 |

### 3.5 群聊开关挪 tab（点5）

| # | 需求 | 说明 |
|---|------|------|
| F11 | GroupChatToggle 从 autowork-tab 删除 | 自动工作 tab 不再有群聊开关 |
| F12 | GroupChatToggle 挪入 manage-tab | 元信息编辑区之后、危险操作区之前 |

---

## 4. 关键用户路径

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 进 Studio 选 squad → 首页 tab | 看到 leader 行黑底白字反色高亮，明显高于其他 mate 行 |
| UC-2 | 首页查看成员列表头计数 | 「成员·N」N = 列表实际行数（含 leader），随在岗/全部切换 |
| UC-3 | 首页查看右侧全景 | 全景有白卡边界包裹（与左卡同风格），不裸露 |
| UC-4 | 首页成员多时滚动页面 | 整页垂直滚动（不在卡片内部滚动），卡片高度随内容撑开 |
| UC-5 | 首页点 leader 行 | 进入 leader 单聊（leader 行是页面视觉重心，最易找到） |
| UC-6 | 首页 leader 行 hover | 底色微调（`bg-fg → bg-fg/90`），出现 chat icon；行不位移 |
| UC-7 | 切到「管理」tab | 看到群聊可见性开关（在元信息编辑区下方、危险操作区上方） |
| UC-8 | 切到「自动工作」tab | 不再有群聊开关（四块：总开关 + 心跳 + 预算 + 历史） |
| UC-9 | 管理 tab 关闭群聊开关 | 回首页，成员卡头部群聊图标按钮消失（enableGroupChat=false 时不渲染） |

---

## 5. UI 契约增量更新

### 5.1 component-member-roster-list.md（计数逻辑）

SeatsBody 传入 MemberRosterList 的计数 N 变更：
- **旧**：N = `nonLeaderCount(running) + nonLeaderCount(idle) (+ nonLeaderCount(benched))`（排除 leader）
- **新**：N = `running.length + idle.length (+ benched.length)`（含 leader，列表实际长度）

### 5.2 component-member-roster-list.md（Leader 行反色样式）

PanelRowView 新增 leader 行反色样式集：

| 元素 | Leader 行 className |
|------|-------------------|
| 行根 button | `group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors bg-fg hover:bg-fg/90` |
| avatar span | 无额外样式（保持原色） |
| 名字 span | `truncate text-[12.5px] font-medium text-surface` |
| badge span | `shrink-0 rounded-xs px-1 py-px font-mono text-[10.5px] font-semibold bg-white/15 text-white/80` |
| SpinnerRing | 保持 accent 旋转环（running 时） |
| presence 文字 | `block truncate text-[11px] text-white/60` |
| hover chat icon | `shrink-0 text-white/70 opacity-0 group-hover:opacity-100` |

**优先级**：`row.isLeader` 反色样式 **覆盖** variant 灰度策略（leader 恒反色，不受 running/idle/benched 影响）。

### 5.3 component-seats-body.md（全景卡片边界 + 高度/滚动）

- **根容器**：`flex flex-1 min-h-0 gap-5 px-6 py-5 overflow-y-auto`（新增 `overflow-y-auto`）
- **成员列表卡**：`rounded-xl border border-border bg-surface`（删除 `overflow-hidden`）
- **右全景容器**：`min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-surface p-4`（新增卡片边界 + padding）
- **左竖条**：`flex w-[296px] shrink-0 flex-col gap-3.5`（不变，内容撑开高度）

### 5.4 群聊开关 tab 位置变更

- **component-autowork-tab.md**：组合块从五块 → 四块（删除 GroupChatToggle 引用）
- **component-group-chat-toggle.md**：挂载位置从 `component-autowork-tab.tsx` → `component-manage-tab.tsx`（元信息编辑区后、危险操作区前）
- **component-manage-tab.tsx**：新增 GroupChatToggle 渲染（`onSaveMeta` 已有，无需新增 prop）

---

## 6. 概念对齐（specs/ui）

| 概念 | 位置 | 关系 |
|------|------|------|
| SeatsBody | `component-seats-body.tsx` | 根容器滚动 + 成员卡 overflow + 全景卡片边界（F7-F10） |
| MemberRosterList / PanelRowView | `component-member-roster-list.tsx` | Leader 行反色样式 + 计数修正（F1-F6） |
| AutoworkTab | `component-autowork-tab.tsx` | 删除 GroupChatToggle（F11） |
| ManageTab | `component-manage-tab.tsx` | 新增 GroupChatToggle（F12） |
| GroupChatToggle | `component-group-chat-toggle.tsx` | 挂载位置迁移（autowork→manage） |

**无新概念引入**——本版本是 288 的迭代修复，不新增组件/数据结构。

---

## 7. 边界 / 不做

- ❌ 不改 PanoramaRoute 内部（全景卡片/看板体系不变，只改外层容器加边界）
- ❌ 不改 derivePanelRows 派生逻辑（三分区 + leader 排序不变）
- ❌ 不改 TokenWidget 卡片（内容固定高度天然不变）
- ❌ 不改 nav-rail / studio-sidebar / header / 3 tab 切换
- ❌ 不改 member 面板 / member-create / chat 路由
- ❌ 不新增 SSE 订阅 / API 变更
- ❌ 不改 SeatsViewSwitch / 加号按钮 / 群聊图标按钮（头部布局不变）
- ❌ Leader 行不单独抽组件（在 PanelRowView 内 isLeader 分支处理，保持统一组件）

---

## 8. 验收口径

### 能力不变量
- [ ] 成员列表头计数 N = 列表实际行数（含 leader）
- [ ] Leader 行黑底白字反色高亮（恒显，`bg-fg` + `text-surface`）
- [ ] Leader badge 强化（`bg-white/15 text-white/80 text-[10.5px] font-semibold`）
- [ ] Leader avatar 保持原色（反色底上不反色）
- [ ] Leader 行 hover 仅微调底色（`bg-fg → bg-fg/90`），无位移
- [ ] 右侧全景有白卡边界（`rounded-xl border border-border bg-surface`）
- [ ] 成员列表卡高度随内容撑开（无内侧滚动）
- [ ] 整页可垂直滚动（内容超出时 `overflow-y-auto`）
- [ ] 群聊开关在「管理 tab」（元信息编辑区后、危险操作区前）
- [ ] 「自动工作 tab」不再有群聊开关

### 回归不变量
- [ ] header + 3 tab 切换不变化
- [ ] 左竖条 token 卡 + 成员卡垂直堆叠不变化
- [ ] TokenWidget 整卡点击进 token-stats 不变化
- [ ] 成员行 hover 进入对话 + 防套娃不变化
- [ ] SeatsViewSwitch 在岗/全部切换不变化
- [ ] 三分区（running/idle/benched）渲染 + 灰度策略（mate 行）不变化
- [ ] 全景内部卡片/看板不变化
- [ ] 群聊开关功能（PATCH enableGroupChat + refresh 回灌）不变化
- [ ] 布局稳定性：切换视图/tab 不致元素位移

---

## 9. 测试建议

- **UT（主要）**：
  - `memberCount` 计算含 leader（active=all + all=all 两视图）
  - `PanelRowView` leader 行 className 断言（`bg-fg` + `text-surface` + badge 强化）
  - `PanelRowView` leader 行覆盖 variant 灰度（leader 在 idle/benched 区仍反色）
  - `AutoworkTab` 不渲染 GroupChatToggle
  - `ManageTab` 渲染 GroupChatToggle（在正确位置）
- **ET（用户可感知视觉变化）**：
  - Leader 行反色高亮呈现（UC-1）
  - 全景卡片边界 + 整页滚动（UC-3, UC-4）
  - 群聊开关在管理 tab（UC-7, UC-8）
