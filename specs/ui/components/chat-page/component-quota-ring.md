# component-quota-ring

> 层级: component（纯展示）
> 文件: app/web/src/components/chat-page/component-quota-ring.tsx（73 行）
> 引入版本: v0.0.356
> updated: 2026-08-15

## 职责
单 SVG 用量环 + 中心文本 + 下标签。用于 `component-quota-provider-card` 收起态双环。

## Props
- `percent: number` — 0-100
- `label: string` — 下标签（如「5小时额度」）
- `centerText: string` — 中心文案（如单单位剩余时间）
- `fast?: boolean` — 消耗偏快时环与数字琥珀

## 渲染
- SVG 双 circle：底环（`trackColor`）+ 进度环（`color`），用 `stroke-dashoffset` 表达百分比
- 两 circle 均 `stroke="currentColor"`，颜色由 `className` 的 `text-*` 工具类（`text-fg`/`text-gold`/`text-muted`/`text-border`/`text-bg-warm`）继承——`text-*` 只设 `color`，circle 描边色经 `currentColor` 取值（缺 stroke 则圆环不渲染只剩中心数字）
- `role="progressbar"` + `aria-label`（provider + 档位 + 已用%）
- fast 时进度环/中心文本 `text-gold`（琥珀）

## 复用关系
- 被组合：`component-quota-provider-card.md`（收起态双档双环）

## i18n
文案由父级 `component-quota-provider-card` 通过 props 传入（`quotaModal` ns）。
