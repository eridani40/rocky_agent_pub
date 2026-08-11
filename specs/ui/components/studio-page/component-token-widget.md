type: spec
title: component-token-widget — 首页左列 Token 用量图文小组件（点击进 token-stats）
priority: P1
status: active
updated: 2026-08-08
since: v0.0.240

> 落点：Studio 首页 seats tab 左竖条（v0.0.288 布局重构后左列上方）。
> 设计稿：`reqs/[working] v0.0.240.squad_task/demo-home.html`（.card.token 块，视觉契约——按 `_conventions.md §9` 视觉保真 compare MANDATORY）。
> 数据契约复用：`specs/api/overall/11c-token-stats.md` §3（fetchTokenStats series，经 `use-squad-token-stats` 共享 hook——与详情 panel 同一套 fetch/口径）。
> **v0.0.288 改造**：去今日三色比例条（TokenBar×3）+ 改「今日总量 / 60 天总量」两数据并排 + 7 日柱压缩 h-[22px] 变矮。

## 职责
首页左竖条的 token 用量图文小组件，**整卡可点击** → 切 `MainView {kind:'token-stats'; squadId}`：
1. **今日总量 / 60 天总量**（v0.0.288 替代三色比例条 + 累计行）：两个数据并排（justify-between），今日总量 = `totalOf(today.breakdown)`（input+output+cache 之和）；60 天总量 = `cumulative`（Σ series，近 60 天合计）。
2. **7 日迷你柱**：series 末 7 点每日总 token 的迷你柱状（高 22px，蓝→青渐变），直观趋势。
3. **整卡点击** → `onOpenTokenStats(squadId)`；hover 整卡 box-shadow 反馈（无位移——MUST 不能让相邻元素跳动）。

边界：纯展示 + 单回调；数据派生走 `useSquadTokenStats`（与详情 panel 共享 hook，一套 fetch），失败降级「—」/空柱。**不调 mutation API、不查 budget**。

## Props
- `squadId: string`
- `onOpenTokenStats: (squadId: string) => void`
- `detail: SquadDetail`（保留接口；当前复用详情统计，不直接读 detail 字段）

内部 state（从 useSquadTokenStats 派生）：
- `today: UsageBreakdown | null`（series 末点 bucket===今日，null=加载中/失败/今日无点）
- `daily7: { label: string; total: number }[]`（series 末 7 点每日总量）
- `cumulative: number`（Σ series = 近 60 天合计，=详情合计口径）
- 加载失败 → 三段降级「—」+ 柱图空 + 累计「—」

## 数据流（复用详情统计，不自己查一套）
```
useSquadTokenStats(squadId, { granularity:'day', scope:'team', from: -60d, to: today })
  → state{kind:'ok', data}  // 与详情 panel 同一套 fetch（defaultRange 近 60 天 + scope=team）
  → deriveWidgetData(data.series, todayKey):
      today    = series 末点 bucket===今日 的 pointToBreakdown
      daily7   = series.slice(-7).map(totalOf)
      cumulative = Σ series totalOf  // 近 60 天合计，=详情 panel summary 同口径
  state!=='ok' → UI 降级（骨架 / 「—」）
```
- 查询口径与详情 panel `defaultRange`（近 60 天 day）+ scope='team' 完全一致——widget 是详情数据的摘要展现。
- 复用 `pointToBreakdown` / `totalOf` / `formatTokens` / `formatDateShort`（component-token-stats-helpers / types）。

## 状态 / 交互
### 今日总量 / 60 天总量（v0.0.288 替代三色比例条 + 累计行）
- 两数据并排（`flex items-baseline justify-between`）：左 = 今日总量 `totalOf(today.breakdown)` mono bold 14px；右 = 60 天总量 `formatTokens(cumulative)` mono bold 14px。
- 每数据上方有小 label（`text-[10px] uppercase tracking-wide text-muted-2`）：左 `todayTotal`（en "Today" / zh "今日"）；右 `total60d`（en "60-day total" / zh "60 天总量"）。
- loading 态 → 两数据各显 skeleton 占位（`h-[18px] w-[60px] animate-pulse rounded bg-surface-2`）。
- today=null → 今日总量显「—」。

### 7 日迷你柱（保留，压缩变矮）
- 末 7 点柱（`width:10px`，`height:22px` 容器，柱高 = day.total / max(daily7) * 100%），蓝→青渐变（`linear-gradient(var(--hue-blue), #06b6d4)`），gap-1。
- daily7 为空 → 渲 7 根 0 高占位柱（保布局稳定）。
- 无交互（hover 无 tooltip，纯趋势示意）。

### 整卡点击 + hover 反馈
- 整 `<button>` 元素包整卡（键盘可达）。
- hover → `box-shadow: 0 2px 8px rgba(0,0,0,.06)` + `transition: box-shadow .15s`（**无 transform 位移**——保布局稳定）。
- `data-action-key="studio.squad.open-token-statistics"`（ET 锚点稳定）。

## 复用关系
- 被 `component-seats-body.tsx` 左列渲染（替代 SeatStats + TeamEntryRow）。
- 数据：`use-squad-token-stats`（与 `component-token-stats-panel` 共享一套 fetch hook）。
- 组合：纯展示（无子组件）；复用 `component-token-stats-helpers`（formatTokens / formatDateShort）+ `component-token-stats-types`（pointToBreakdown / totalOf）。

## 视觉基线（v0.0.288 改造后）
- 卡：`rounded-xl border border-border bg-surface p-3.5`（14px padding）。
- 标题行：「Token 用量」（11px muted）+ 右侧「查看详情 ›」（10px muted-2，group-hover 转 fg）。
- **今日总量 / 60 天总量**（两数据并排 `flex items-baseline justify-between`）：每数据 = 上 label（10px upper muted-2）+ 下数字（mono bold 14px fg）；loading skeleton `h-[18px] w-[60px]`。
- 7 日柱区：sub-label（10px upper muted-2）+ spark 容器 **h-[22px]** + 柱 10px 宽 gap-1。
- hover → `box-shadow: 0 2px 8px rgba(0,0,0,.06)`（无 transform 位移）。
- 颜色：柱渐变 `linear-gradient(var(--hue-blue), #06b6d4)` + `opacity-85`。

## 不变量
- MUST 整卡点击切 token-stats（无单独 link）。
- MUST hover 仅 box-shadow 反馈（禁 transform/displace——布局稳定）。
- MUST 今日总量 = `totalOf(today.breakdown)`（input+output+cache 之和）；60 天总量 = `cumulative`（Σ series，与详情合计同口径）。
- MUST 复用 `use-squad-token-stats`（与详情 panel 一套 fetch，口径对齐——禁自己查一套/budget）。
- MUST NOT 调 mutation API（只读，经 useSquadTokenStats 复用详情 fetch）。

## 消费方

- `app/web/src/components/studio-page/component-seats-body.tsx`
