type: spec
title: component-token-widget — 首页左列 Token 用量图文小组件（点击进 token-stats）
priority: P1
status: active
updated: 2026-08-03
since: v0.0.240

> 落点：Studio 首页 seats tab 左列（替代原 SeatStats 2×2 格 + TeamEntryRow token link）。
> 设计稿：`reqs/[working] v0.0.240.squad_task/demo-home.html`（.card.token 块，视觉契约——按 `_conventions.md §9` 视觉保真 compare MANDATORY）。
> 数据契约复用：`specs/api/overall/11c-token-stats.md` §3（fetchTokenStats series，经 `use-squad-token-stats` 共享 hook——与详情 panel 同一套 fetch/口径）。

## 职责
首页左列的 token 用量图文小组件，**整卡可点击** → 切 `MainView {kind:'token-stats'; squadId}`：
1. **今日三色比例条**：当日 input / output / cache 三段，每段独立比例条（按各自值占当日峰值的相对宽度）+ 数字（M 单位，复用 `formatTokens`）。
2. **7 日迷你柱**：series 末 7 点每日总 token（input+output+cache）的迷你柱状（高 26px，蓝→青渐变），直观趋势。
3. **累计（近 60 天合计）**：= Σ series（与详情 panel summary 同口径），数字「合计 M」；**非 budget 口径**（widget 不再查 budget，复用详情统计）。
4. **整卡点击** → `onOpenTokenStats(squadId)`；hover 整卡 box-shadow 反馈（无位移——MUST 不能让相邻元素跳动）。

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
### 今日三色比例条（核心可视化）
- 三段（input / output / cache）纵向堆叠，每段 = label「输入/输出/缓存」+ 比例条（`height:7px` track `bg-surface-2`，fill = 该值占三段最大值的百分比）+ 数字（M）。
- 比例口径（demo-home.html）：fill width = value / max(input,output,cache) * 100%（**非占比，是相对峰值**——一眼见哪个量大）。
- 颜色（复用 token-stats hue palette）：input=`var(--hue-blue)` / output=`var(--hue-violet)` / cache=`var(--hue-green)`。
- today=null → 三段全显「—」，比例条 fill=0。

### 7 日迷你柱
- 末 7 点柱（`width:10px`，`height:26px` 容器，柱高 = day.total / max(daily7) * 100%），蓝→青渐变（`linear-gradient(var(--hue-blue), #06b6d4)`），gap-1。
- daily7 为空 → 渲 7 根 0 高占位柱（保布局稳定）。
- 无交互（hover 无 tooltip，纯趋势示意）。

### 累计（近 60 天合计）
- cumulative = Σ series（近 60 天合计），=详情 panel summary 同口径（**非 budget**）。
- 文案行：`近 60 天合计 {cumulative|M}`（i18n key `studio:tokenWidget.consumedLabel`）。
- state!=='ok'（加载/失败）→ 显「—」。

### 整卡点击 + hover 反馈
- 整 `<button>` 元素包整卡（键盘可达）。
- hover → `box-shadow: 0 2px 8px rgba(0,0,0,.06)` + `transition: box-shadow .15s`（**无 transform 位移**——保布局稳定）。
- `data-action-key="studio.squad.open-token-statistics"`（与原 TeamEntryRow token link 同 action-key，ET 锚点稳定）。

## 复用关系
- 被 `component-seats-body.tsx` 左列渲染（替代 SeatStats + TeamEntryRow）。
- 数据：`use-squad-token-stats`（与 `component-token-stats-panel` 共享一套 fetch hook）。
- 组合：纯展示（无子组件）；复用 `component-token-stats-helpers`（formatTokens / formatDateShort）+ `component-token-stats-types`（pointToBreakdown / totalOf）。

## 视觉基线（demo-home.html .card.token 块）
- 卡：`rounded-xl border border-border bg-surface p-3.5`（14px padding）。
- 标题行：「Token 用量」（11px muted）+ 右侧可省 hint tag。
- 三段比例条：label 11px / track 7px 高 rounded-full / fill rounded-full / 数字 10.5px muted 右对齐。
- 7 日柱区：sub-label「7 日趋势」（10px upper muted-2）+ spark 容器 26px 高 + 柱 10px 宽 gap-1。
- 累计行：「近 60 天合计 {X}」（11px muted，数字 14px bold fg font-mono）。
- 底部行：「查看详情 ›」（11px fg）右对齐 + 左侧窗口提示（可选，11px muted-2）。
- 颜色：input=`--hue-blue`(#3b82f6) / output=`--hue-violet`(#8b5cf6) / cache=`--hue-green`(#22c55e) / 柱渐变 blue→cyan(#06b6d4)。

## 不变量
- MUST 整卡点击切 token-stats（无单独 link）。
- MUST hover 仅 box-shadow 反馈（禁 transform/displace——布局稳定）。
- MUST 累计 = Σ series（近 60 天合计，与详情合计同口径）；加载/失败显「—」。
- MUST 复用 token-stats hue 配色（视觉一致性）。
- MUST 复用 `use-squad-token-stats`（与详情 panel 一套 fetch，口径对齐——禁自己查一套/budget）。
- MUST NOT 调 mutation API（只读，经 useSquadTokenStats 复用详情 fetch）。
