type: component
purpose: chat-input-bar 底部按钮行内的 effort 推理强度选择器（4 档 enum，session 级持久化）
since: v0.0.148
updated: 2026-07-15

# component-input-effort-picker

## 0. 职责
session 级 effort 推理强度选择器（4 档 enum），位于 input-bar 按钮行**次左位**（审批模式 picker 右侧、模型选择左侧）。
- 21px 纯图标 trigger（ZapIcon，语义=能量/算力强度）
- hover → 单行预览菜单（当前档位 selected 高亮）
- click → 完整菜单（4 档平铺，当前档 selected 高亮）
- 选中即写 `session.effort`（PUT /session/:id 透传）→ 立即对后续 LLM 请求生效

## 3. trigger + hover 预览 + click 菜单（三态）
| effort 状态 | trigger 图标色调 | hover 预览内容（1 条） | click 菜单 |
|---|---|---|---|
| `default`（缺省） | text-fg | `默认`（selected 高亮） | 4 档平铺，default 项 selected |
| `low` / `high` / `max` | text-accent | 对应档位 i18n 文案（selected 高亮） | 4 档平铺，对应项 selected |

## Props
- effort: 'default' | 'low' | 'high' | 'max' | null
- disabled?: boolean
- onChange: (level: 'default' | 'low' | 'high' | 'max') => void

## 复用关系
- trigger：21px（`CHAT_ACTION_BTN_CLS`），按钮行内
- 菜单（preview + menu 共用 `PICKER_PANEL_CLS`）：
- z=`--z-popover`（L2）浮在消息流之上
