---
type: spec
title: component-team-entry-row — [DEPRECATED v0.0.240] 团队入口 compact links
priority: P2
status: deprecated
updated: 2026-08-02
since: v0.0.165
---

> **状态：DEPRECATED（v0.0.240 整组件废除）**。组件源码已 mv 至 `soft_deleted/v0.0.240/component-team-entry-row`；本 spec 仅作历史留存，不再描述当前态。
> 废除原因：v0.0.240 首页 IA 改造——业务全景入口由第二栏内嵌 PanoramaRoute（task tab 首项）取代；token 统计入口由 TokenWidget 整卡点击取代（原 compact links 列表整体废）。
> 替代：`component-seats-body.tsx` 左列改用 `<TokenWidget>`（图文组件，点击进 token-stats）；第二栏内嵌 `<PanoramaRoute>`（业务全景 tab host）。

## 历史职责（已废，仅供参考）
团队入口 compact links（C 指挥台左列末张白卡内）：业务全景 + token 统计 link 纵向排列。每 link = 24px hue icon-box + 标题 + 右侧 chevron。

v0.0.237 已先删「看板 link」（随 board 全链路移除）；v0.0.240 删整组件（业务全景 link + token 统计 link 都被新 IA 取代）。

## 复用关系（历史）
原被 `component-seats-body.tsx` 左列 `seats-side` 渲染；v0.0.240 起该位置渲染 `<TokenWidget>`。

## i18n 清理
`studio.json` 原 `teamEntry.*` i18n key 随组件废删除（中英同步）。
