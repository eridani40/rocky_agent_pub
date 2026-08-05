type: component
purpose: chat-input-bar 底部按钮行内的审批模式选择器（2 档 enum，session 级持久化，绿灯短路 ask）
since: v0.0.148
updated: 2026-07-15

# component-input-approval-mode-picker

## 0. 职责
session 级审批模式选择器（2 档 enum），位于 input-bar 按钮行**最左位**（effort picker 左侧）。
- 21px 纯图标 trigger（AlertIcon，语义=注意/审批区）
- trigger 色调随模式变：`normal` = text-fg / `greenlight` = text-accent（绿灯态视觉强调）
- hover → 单行预览菜单（当前模式 selected 高亮）
- click → 完整菜单（2 档平铺，当前模式 selected 高亮）

## 3. trigger + hover 预览 + click 菜单（三态）
| approvalMode 状态 | trigger 图标色调 | hover 预览内容（1 条） | click 菜单 |
|---|---|---|---|
| `normal`（缺省） | text-fg | `普通`（selected 高亮） | 2 档平铺，normal 项 selected |
| `greenlight` | text-accent（绿灯态视觉强调） | `绿灯`（selected 高亮） | 2 档平铺，greenlight 项 selected |

## Props
- approvalMode: 'normal' | 'greenlight' | null
- disabled?: boolean
- onChange: (mode: 'normal' | 'greenlight') => void

## 复用关系
- trigger：21px（`CHAT_ACTION_BTN_CLS`），按钮行内
- 菜单（preview + menu 共用 `PICKER_PANEL_CLS`）：
- z=`--z-popover`（L2）浮在消息流之上
