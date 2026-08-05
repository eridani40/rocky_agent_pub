---
type: spec
title: UI Regulation · 组件规范（v0.0.165 银灰体系）
status: active
updated: 2026-07-17
since: v0.0.165
related: [01-tokens.md, 03-principles.md]
---

# UI Regulation · 组件规范

> 视觉参考实现：`reqs/[working] v0.0.165.ui_upgrade/design/_shell.css` + `_gallery.html`（用户已确认）。
> 组件实现级契约（props/交互）仍归 `specs/ui/components/`；本文件管**跨页面统一的视觉规则**。

## 1. 按钮（黑白灰四型）

| 型 | 视觉 | 用途 |
|---|---|---|
| primary | 黑底 `--btn-primary-bg` 白字 | 确定 / 保存 / 新建 / 进入对话——每视图至多一个焦点动作 |
| secondary | 白底灰边 | 取消 / 次要动作 |
| ghost | 透明，hover 浅灰底 | 图标钮 / 不显眼操作 |
| danger | 红底白字 | 删除等破坏性操作 |

尺寸：默认 h32 / sm h26 / lg h40（idle hero 主按钮特批 h46）。圆角 md。**禁止**：橙/彩色按钮、渐变按钮。

## 2. Badge

胶囊形（radius-full）+ 11px + 可选 6px 圆点。四态映射 `--success/--warning/--danger/--info` 浅底深字；中性 badge（LEADER / deployed / free）= `--surface-2` 底 + `--fg-3` 字 + `--border` 边。

## 3. Avatar（彩虹身份）

方形圆角（sm 24/默认 32/lg 48/xl 64，圆角随尺寸 sm→xl），底色 = palette hash 分配（01-tokens §1.7），白字单字。
**presence 点**：右下角覆盖，白描边 2px，四态色见 01-tokens §1.6。会话头像 / 坐席卡 / 成员列表统一此规则。

## 4. Icon-box（彩色小图标底）

32px（可 22/24 缩放）圆角 md，浅底 `--hue-*-bg` + 主色 `--hue-*` 线性图标。用于 skill / plugin / model / 团队入口图标。同一实体 hash 同色。

## 5. 表单控件

- **input/textarea**：白底 + `--border-2` 边 + radius-md；focus = `--border-strong` 边 + `--shadow-focus` 灰环。**焦点不用彩色**。
- **toggle**：36×20，选中 = 黑底 `--btn-primary-bg`（不再用橙）。
- **checkbox**：黑选中态。
- 表单标签：12px 600 `--fg-2`；mono 小标（如 MODELDEFAULT）10.5px `--muted-2`。

## 6. Chat 消息区

- **agent 气泡**：白底 + `--border` 边 + 左上角 radius-xs（4px）尖角。
- **user 气泡**：`--fg` 黑底白字 + 右上角 radius-xs 尖角。
- **消息时间（MANDATORY）**：每条消息 block 下方 `.msg-time` —— 10.5px mono `--muted-2`，agent 左对齐 / user 右对齐（用户裁决 2026-07-17）。
- **tool-card**：`--surface-2` 底 + `--border` 边 + 12px `--fg-3`，收起单行。
- **附件 pill**：mono 11.5px；user 气泡内用半透明白变体。

## 7. 模型选择面板（全局统一契约 — 用户裁决 2026-07-17）

**统一的是样式，不是数据**（用户澄清 2026-07-17）：chat 输入区 / studio 默认模型 / settings 模型页 / app dev config 的模型选择共用同一套视觉 primitives：
- **trigger 收起态**：白底 `--border-2` 边 radius-md，内含 22px icon-box（provider hash 色）+ mono 模型名 + 下拉箭头
- **panel 展开态**：300px 白卡 radius-lg + `--shadow-lg`，顶部搜索框，列表项 = 24px icon-box + mono 模型名 + 选中 ✓（黑色），active 项 `--surface-3` 底
- 视觉样例：design/_gallery.html「模型选择面板」节

**选项构成/数据源归各消费方，不统一**：
- session/chat 对话模型 picker：列表含「默认模型」项，且该模型在下方模型列表中重复出现一次——正确行为，保留
- app config 默认模型 picker：本身在定义默认，列表**无**「默认模型」项
- 各消费点的分组/排序/数据源一律保持现状；primitives 只管长相，数据由消费方注入

## 8. 列表与导航

- **list-item**：radius-md，hover `--surface-2`，active `--surface-3` + `--fg`。**active 不用彩色文字/边框**。
- **nav-rail**：56px `--chrome` 底；nav-item 36px，active = `--surface-3` 底 + `--fg` 图标（不再橙色）。brand R = `--brand-grad` 渐变块。
- **tabs**：文字 tab + 2px 下划线，active = `--fg` 下划线 + `--fg` 字（不用橙线）。

## 9. 坐席面板（studio console，v0.0.165 新增）

- **统计条**：4 格白卡（在线数 / 进行中任务 / 今日消息 / 今日 token），34px 彩色 icon-box + 22px 数字。
- **坐席卡**：白卡 radius-xl p16，网格 3 列；结构 = avatar-lg+presence → 名字/角色 → 状态行（`--surface-2` 底圆角块 + 脉冲点 + 一句话）→ meta 行（mono 11px：in/out token + 最近活跃）→ 操作行（黑「进入对话」+ secondary 更多）。
- leader 卡 `--border-strong` 边；离线卡整体 0.75 透明度 + 「进入对话」降 secondary。
- **返回按钮**：从坐席面板进入的对话，chat-topbar 左侧显示「← 返回」（ghost 型）；从左侧列表进入不显示。

## 10. mock 窗（设计稿约定）

设计稿统一 1440×900 mock-window（titlebar 36px + 红黄绿点）呈现；截图 device_scale_factor=2。
