type: spec
title: component-board-edit-fields — 看板编辑字段子组件集
priority: P1
status: active
updated: 2026-07-11
since: v0.0.60

## 职责
- 字段原子（Field/TitleField/BodyField/OwnerField）全实体共用
- 实体专属字段块（KrMetricFields / TaskFields / DescriptionField）
-：StatusField（全实体 status 下拉）、TriageField（req triage 决策区）
边界：
- 只渲染 UI，不持 state（state 在 useBoardEditForm hook）
