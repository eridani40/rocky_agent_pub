type: spec
title: component-board-at-button — 看板卡片 @ 按钮共享组件
priority: P1
status: active
updated: 2026-07-07
since: v0.0.68

## 职责
渲染 hover-only @ 按钮（`<button>@</button>`）—— onClick 调 `onAtMention({type:'workitem', kind, id, label})`。**纯展示组件**，切换 leader 对话 + 预填 pill 由父侧 page-studio `BoardRoute onAtMention` handler 处理。
边界：
- 不持 state（onClick 直接转发 `onAtMention` prop）
- 不构 display
- 不解析 leader ChatNode（page-studio 的责任）

## Props
- type: 'workitem'
- kind: string
- id: string
- label: string
- testid: string
- kind: string
- id: string
- label: string
- onAtMention?: (payload: BoardMentionPayload) => void
- groupHoverClass: string

## 视觉基线
- aria-label：「在 leader 对话中 @ 此项」；title：「@ 到 leader 对话」

## 复用关系
- **不组合**（纯叶子组件，无下游依赖）
