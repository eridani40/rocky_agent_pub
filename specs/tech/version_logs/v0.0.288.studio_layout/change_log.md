# v0.0.288 tech change log — Squad 首页布局重构（3 板块）

> 对应需求：`reqs/[working] v0.0.288/req.md`（用户可感知 UI 变化 → 完整 PRD）。
> PRD：`specs/prd/version_logs/v0.0.288.studio_layout/prd.md`（D1-D5 + F1-F17 + UC-1~9）。
> 权威契约：`specs/tech/version_logs/v0.0.288.studio_layout/change_plan.md`（17 行 method 级表，frozen）。

## 变更摘要

### 需求与动机

Studio 首页布局重构为左竖条（token 卡上 + 成员卡下）+ 右全景（填满屏幕不横滑）；成员列表统一组件（chat 弹层 ≡ 首页列表，一改全改）；token 卡去三色比例条改今日/60天总量变矮。

### 方案（5 项架构裁决）

1. **MemberRosterList 统一组件抽取**：从 squad-status-modal.tsx 抽出 PanelRowView + 分区渲染 → 新文件 component-member-roster-list.tsx。弹层和首页共用（一改全改）。
2. **derivePanelRows 三分区扩展**：benched 不再过滤，归第三分区（state==='benched' → push benched 不再 continue 跳过）。
3. **布局重构落点**：SeatsBody 双列 grid → 左竖条 296px（TokenWidget 上 + 成员卡下）+ 右全景 PanoramaRoute（overflow-hidden + min-w-0）；SeatsPanel 底部全景 section 删除；leaderCard 删除（队长入 MemberRosterList 行内 isLeader badge）。
4. **左竖条宽度 = 296px**（保持现状零位移）。
5. **TokenWidget 改造**：删 TokenBar×3 + 累计行 → 今日总量/60天总量并排；7 日柱 h-26px→h-22px 变矮。

### T1 — MemberRosterList 统一组件（commit 48c5cc741）

- **component-member-roster-list.tsx**（200 行）：MemberRosterList（三分区分组渲染 + showBenched 控制）+ PanelRowView（从 modal 迁出，isIdle 二元 → variant 三元 'running'|'idle'|'benched'）。
- **squad-status-utils.ts**：derivePanelRows 扩展三分区（PanelRows 加 benched: PanelRow[]；循环 m.state==='benched' → push benched 不跳过）。
- **component-squad-status-modal.tsx**：PanelRowView 迁出（本地定义删除）→ import MemberRosterList + showBenched=false 委托渲染。

### T2 — 布局重构（commit eb30bf358 + 13502ac80 review fix）

- **component-seats-body.tsx**（144 行）：双列 → 左竖条 296px（TokenWidget 上 + 成员卡下）+ 右全景。成员卡头部 = 左标题「成员·N」+ 右组（SeatsViewSwitch → 群聊图标 icon-only enableGroupChat 条件 → 加号 icon-only）。derivePanelRows 替代 deriveViewRows。SeatsBodyProps 删 seats/leaderRow/mateRows/stats/onEditMember/onBenchMember/onDeployMember → 增 memberStateMap/onAtLeader。
- **component-seats-panel.tsx**：底部全景 section 删除（移入 SeatsBody 右列）。

### T3 — TokenWidget 改造（commit 60b23ef2a）

- **component-token-widget.tsx**（147 行）：删 TokenBar 函数 + 三色比例条区域 + 累计行 → 今日总量/60天总量并排（mono bold 14px）+ 7 日柱 h-22px。
- **i18n**：删 kindInput/kindOutput/kindCache；新增 todayTotal/total60d（en+zh 双语）。

## 代码↔spec 核实表（doc-modifier）

| 核实项 | 代码位置 | 核实结果 |
|---|---|---|
| MemberRosterList 三分区 + showBenched 控制 | component-member-roster-list.tsx L129-200（running/idle/benched 区 + showBenched && hasBenched 判定）| ✅ false 只渲 running+idle / true 渲三分区 |
| PanelRowView variant 三元灰度策略 | L31-110（benched opacity-[0.55]+text-muted-2+grayscale+opacity-50；idle opacity-[0.85]+text-fg-2+opacity-70；running SpinnerRing）| ✅ benched 比 idle 更灰 |
| derivePanelRows 三分区（benched 不再过滤） | squad-status-utils.ts L100-124（m.state==='benched' → push benched 不跳过）| ✅ 返 { running, idle, benched } 三区 |
| squad-status-modal 委托 MemberRosterList | L25 import + L105-109 `<MemberRosterList showBenched={false}>` | ✅ PanelRowView 本地定义已删 |
| SeatsBody 左竖条+右全景布局 | component-seats-body.tsx L68-139（w-[296px] 左列 flex-col + 右列 min-w-0 overflow-hidden）| ✅ 删 leaderCard |
| 成员卡头部布局（左标题+右组在岗/全部→群聊→加号） | L80-118（SeatsViewSwitch + groupChatEnabled 条件 Icon chat + Icon plus，全 icon-only）| ✅ 群聊 enableGroupChat !== false 条件渲染 |
| derivePanelRows 替代 deriveViewRows | L58 `useMemo(() => derivePanelRows(detail, memberStateMap))` | ✅ 不再用 deriveViewRows |
| showBenched=view==='all' | L125 `showBenched={view === 'all'}` | ✅ active→false / all→true |
| TokenWidget 去三色条 + 今日/60天总量并排 | component-token-widget.tsx L98-119（两数据 flex justify-between + skeleton loading）| ✅ TokenBar 函数已删 |
| 7 日柱 h-22px 压缩 | L124 `flex h-[22px] items-end gap-1` | ✅ h-26→h-22 |
| SeatsBodyProps 删 onEditMember/onBenchMember/onDeployMember | component-seats-body.tsx L27-45（仅 onHire 保留）| ✅ D2 统一组件自然结果 |

## 偏离

**T2 报的 SeatsBodyProps 删 onEditMember/onBenchMember/onDeployMember** = PRD D2 统一组件的自然结果（MemberRosterList 纯展示行无管理按钮——成员管理归 member 面板），非设计偏离。change_plan 已在 SeatsBodyProps 行声明「删除 leaderRow/mateRows/stats」，onEdit/Bench/Deploy 三个回调是 leaderCard/SeatCard 管理功能的残留——leaderCard 删 + derivePanelRows 替代 deriveViewRows 后这三个回调无消费方，删除合理。

## 文档同步

| 文件 | 变更 |
|------|------|
| `specs/ui/components/studio-page/component-member-roster-list.md` | **新建** 组件 spec（职责/Props/三分区灰度策略/状态交互/复用关系/视觉基线） |
| `specs/ui/components/studio-page/component-seats-body.md` | frontmatter + Props（删旧增新）+ 状态/交互段（derivePanelRows 替代 + 删 leaderCard + 头部布局） |
| `specs/ui/components/studio-page/component-squad-status-modal.md` | 头部补 MemberRosterList 委托说明 + 面板内容段改委托描述 |
| `specs/ui/components/studio-page/component-token-widget.md` | frontmatter + 职责（去三色条+今日/60天总量）+ 状态/交互段 + 视觉基线段 + 不变量段全面更新 |
