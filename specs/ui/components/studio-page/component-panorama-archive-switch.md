---
type: spec
title: component-panorama-archive-switch — 任务 kanban「活跃 / 含归档」segmented 开关
priority: P2
status: active
updated: 2026-08-02
since: v0.0.240
---

> 落点：panorama view toolbar 左组（仅 `view.filter.archived` 声明时由父级条件渲染）。
> 设计稿：`reqs/[working] v0.0.240.squad_task/demo-home.html`（.kbar-switch 块，视觉契约）。
> 数据契约：无（纯受控展示组件，不 fetch）。

## 职责
任务 kanban（或任意声明 `archived` 字段 + `view.filter.archived` 的 view）的**归档范围 segmented 开关**：
1. 两段「活跃」/「含归档」，单选互斥（active 段高亮）。
2. 切换 → `onChange(mode)` 通知父级（`component-panorama-view`）重 fetch：`active` = 带 view.filter（隐藏归档）；`with_archived` = 不传 filter（看全部含归档，已归档卡片 opacity 0.55 弱化）。

边界：纯展示 + 单 onChange 回调；**不持状态**（受控——`mode` 由父级 `archiveMode` state 注入）；不 fetch、不调 API。

## Props
```ts
type ArchiveMode = 'active' | 'with_archived';

interface ArchiveSwitchProps {
  mode: ArchiveMode;
  onChange: (mode: ArchiveMode) => void;
}
```

## 状态 / 交互
- 容器：`flex h-7 items-center gap-1 text-[11.5px] text-muted`（toolbar 高度 28px 对齐）。
- 每段 = `<button type="button">`：active 段 `bg-surface-2 font-semibold text-fg`；inactive 段 `hover:text-fg-2` + `transition-colors`。
- `data-action-key` = `studio.panorama.archive-{active|with_archived}`（ET 锚点稳定）；`data-active` = `true|false`（便于 snapshot 查当前态）。
- 键盘可达（native button）；focus-visible 走全局 `--shadow-focus` 光晕。

## 复用关系
- 被 `component-panorama-view.tsx` toolbar 左组条件渲染（`hasArchiveFilter = Object.prototype.hasOwnProperty.call(view.filter, 'archived')` 为 true 时）。
- 组合：纯展示（无子组件）；i18n 走 `studio` namespace（label 走 `t('studio:panorama.archive.active')` = 「活跃」 / `t('studio:panorama.archive.withArchived')` = 「含归档」）。

## 视觉基线（demo-home.html .kbar-switch）
- 容器高 28px（toolbar 行高对齐）；段 `px-2 py-0.5 rounded`。
- active 段底色 `var(--surface-2)` + `font-semibold`；inactive 段透明底 + hover `text-fg-2`。
- 字号 11.5px muted-2（与 toolbar 其他元素一致）。
- 无 hex 硬编码。

## 不变量
- MUST 受控（不持 mode state——父级 archiveMode state 唯一源，避免双源）。
- MUST 仅 `view.filter.archived` 时由父级渲染（无归档概念的 view 不显示）。
- MUST NOT 调 API（切换只通知父级，由父级重 fetch 带/不带 filter）。

## 消费方

- `app/web/src/components/studio-page/component-panorama-view.tsx`
