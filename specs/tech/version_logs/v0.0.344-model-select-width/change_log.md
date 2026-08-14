---
type: change_log
title: v0.0.344 — squad 管理页模型 select 加宽
version: v0.0.344
date: 2026-08-13
related_commit: 7fb1d1b77
grounded: coder 汇报 commit 7fb1d1b77 + 代码 diff 核实
---

# v0.0.344 — squad 管理页模型 select 加宽

> 一句话：**ModelPicker 加可选 `triggerClassName` prop，squad 管理页模型 select 加宽至跟随容器**（纯 UI 样式微调，无逻辑变化）。

## 改动

| 文件 | 改动 |
|------|------|
| `app/web/src/components/chat/ModelPicker.tsx` | `ModelPickerProps` 加可选 `triggerClassName?: string`；trigger `className` 由固定值改为 `triggerClassName ?? 'w-[180px] whitespace-nowrap overflow-hidden text-ellipsis'` |
| `app/web/src/components/studio-page/component-manage-tab.tsx` | modelDefault select 传 `triggerClassName="w-full whitespace-nowrap overflow-hidden text-ellipsis"` |

## 语义要点

- **缺省不变**：`triggerClassName` 缺省走 `??` 保持 v0.0.72 UIFix2 的 `w-[180px]` 固定宽 + truncate（trigger 尺寸稳定防布局跳动），存量消费方零影响。
- **加宽动机**：squad 管理页长模型名（minimax-xxx/deepseek-xxx）被 180px 截断；w-full 跟随容器、对齐同区域 INPUT/Dropdown。

## spec 同步

- `specs/ui/overall/06-studio.md §3.2`：squad 元信息编辑 bullet 补 [v0.0.344] model select 加宽段（triggerClassName prop 语义 + 缺省回退 + 消费方传值）。
- `component-model-picker-trigger.md` 未改——该 spec 记录的是 common primitive 的 Props，不含 `chat/ModelPicker` 契约（grep 零命中）；`chat/ModelPicker` 无独立 spec，其 props 契约随消费方 spec（06-studio / new-squad-wizard / classroom-detail / section-default-models-and-request）记录。
