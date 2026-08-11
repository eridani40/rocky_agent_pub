---
type: spec
title: component-seats-view-switch — seats roster「在岗 / 全部」视图筛选 segmented 开关
priority: P1
status: active
updated: 2026-08-03
since: v0.0.244
---

> 落点：SeatsBody roster 头（计数「成员·N」右侧、「＋新增成员」左侧），**恒渲染**（不条件于是否存在 benched 成员——稳定锚点）。
> 数据契约：无（纯受控展示组件，不 fetch）。
> 同构参考：`component-panorama-archive-switch.md`（v0.0.240「活跃/含归档」）——视觉/交互同构但**不泛化**（ArchiveSwitch 的 i18n/actionKey 是 panorama 专属，泛化 blast radius 大）。

## 职责
seats roster 的**视图筛选开关**：两段「在岗」/「全部」，单选互斥（当前视图段高亮）：
1. `active`（在岗，默认）= roster 只显 `state === 'deployed'` 成员（benched 隐藏）。
2. `all`（全部）= roster 显全量成员（benched 行视觉弱化 opacity-75 + meta `mate · benched`，由 SeatRowView 既有能力呈现）。
切换 → `onChange(view)` 通知父级（SeatsBody → SeatsPanel）；过滤发生在 SeatsPanel 单点（`deriveViewRows`），本组件与 SeatsBody 都不过滤。

边界：纯展示 + 单 onChange 回调；**不持状态**（受控——`view` 由 SeatsPanel state 注入）；不 fetch、不调 API、不判断是否存在 benched。

## Props
```ts
type SeatsView = 'active' | 'all';   // 定义于 use-seats-data.ts（panel/body/UT 共用）

interface SeatsViewSwitchProps {
  view: SeatsView;
  onChange: (view: SeatsView) => void;
}
```

## 状态 / 交互
- 容器：`flex h-7 items-center gap-1 text-[11.5px] text-muted`（与 roster 头行高对齐）。
- 每段 = `<button type="button">`：active 段 `bg-surface-2 font-semibold text-fg`；inactive 段 `hover:text-fg-2` + `transition-colors`；段间 `/` 分隔（text-muted-2）。
- 可见文案（E2E 定位契约，i18n `studio` ns）：`seats.viewSwitch.active` = 「在岗」/ Active；`seats.viewSwitch.all` = 「全部」/ All。
- `data-action-key` = `studio.seats.view-active` / `studio.seats.view-all`（ET 稳定锚点）；`data-active` = `true|false`（snapshot 查当前态）。
- 键盘可达（native button）；focus-visible 走全局 `--shadow-focus` 光晕。

## 复用关系
- 被 `component-seats-body.tsx` roster 头恒渲染；view state 唯一源 = `component-seats-panel.tsx` 的 `useState<SeatsView>('active')`。
- 组合：纯展示（无子组件）；i18n 走 `studio` namespace。

## 视觉基线
- 同构 ArchiveSwitch：容器高 28px；段 `px-2 py-0.5 rounded`；active 段底色 `var(--surface-2)` + `font-semibold`；inactive 段透明底 + hover `text-fg-2`；字号 11.5px muted。
- 无 hex 硬编码；无 animate class（INV-3）。

## 不变量
- MUST 受控（不持 view state——SeatsPanel state 唯一源，避免双源）。
- MUST 恒渲染（不条件于存在 benched 成员——全 deployed 时也在场，稳定锚点）。
- MUST 文案走 t()（双语 key `seats.viewSwitch.active/all` 须 zh-CN + en 全加；defaultValue 被 parseMissingKeyHandler 覆盖失效，禁依赖）。
- MUST NOT 调 API / 自行过滤 rows（过滤单点 = SeatsPanel `deriveViewRows`）。

## 消费方

- `app/web/src/components/studio-page/component-seats-body.tsx`
