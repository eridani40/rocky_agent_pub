---
type: spec
title: UI Regulation · 设计 Token（v0.0.165 银灰体系）
status: active
updated: 2026-07-17
since: v0.0.165
related: [02-components.md, 03-principles.md]
---

# UI Regulation · 设计 Token

> **权威源**：`reqs/[working] v0.0.165.ui_upgrade/design/tokens.css`（设计稿物理源，用户已确认）。
> 本文件 = token 词表 + 语义规范；产品实现 `app/web/src/styles/tokens.css` 必须照抄本表，不得手填 hex。
> **替代关系**：v0.0.165 起本目录取代 `specs/tech/app/frontend/[P0]design_system.md` §2/§5 的暖橙色系定义（该文件同步改写指向本目录）。
> **light-only**：深色模式已下线（用户裁决 2026-07-17），无 `[data-theme=dark]` 变量集。

## 1. 色板（唯一 hex 权威表）

### 1.1 背景 & 表面

| token | hex | 用途 |
|---|---|---|
| `--bg` | `#fafafa` | 应用底色 |
| `--surface` | `#ffffff` | 卡片 / 面板 / 主区 |
| `--surface-2` | `#f4f4f5` | 输入框底、二级底、hover 态 |
| `--surface-3` | `#e4e4e7` | 三级底、pressed、active 列表项 |
| `--chrome` | `#f7f7f8` | nav-rail / titlebar 等窗体 chrome |

### 1.2 文字

| token | hex | 用途 |
|---|---|---|
| `--fg` | `#0a0a0a` | 主文字 |
| `--fg-2` | `#3f3f46` | 次文字 / 表单值 |
| `--fg-3` | `#52525b` | 三级文字 |
| `--muted` | `#71717a` | 说明 / metadata |
| `--muted-2` | `#a1a1aa` | 弱化（占位、消息时间） |

### 1.3 边框

| token | hex | 用途 |
|---|---|---|
| `--border` | `#e4e4e7` | 常规分隔 |
| `--border-2` | `#d4d4d8` | 二级分隔 / 输入框边 |
| `--border-strong` | `#a1a1aa` | focus 边框 / 强调 |

### 1.4 CTA（黑白灰，含确定/取消）

| token | hex | 用途 |
|---|---|---|
| `--btn-primary-bg` | `#18181b` | 主 CTA 底（确定/保存/进入对话） |
| `--btn-primary-hover` | `#000000` | 主 CTA hover |
| `--btn-primary-fg` | `#ffffff` | 主 CTA 文字 |
| `--btn-secondary-bg` | `#ffffff` | 次 CTA / 取消底 |
| `--btn-secondary-hover` | `#f4f4f5` | 次 CTA hover |
| `--btn-secondary-border` | `#d4d4d8` | 次 CTA 边 |
| `--btn-secondary-fg` | `#18181b` | 次 CTA 文字 |
| `--btn-ghost-fg` | `#52525b` | 幽灵按钮文字 |
| `--btn-ghost-hover-bg` | `#f4f4f5` | 幽灵按钮 hover 底 |
| `--btn-danger-bg` / `--btn-danger-fg` | `#dc2626` / `#ffffff` | 危险操作 |

### 1.5 状态语义

| token | hex（前景/底） | 用途 |
|---|---|---|
| `--success` / `--success-bg` | `#16a34a` / `#dcfce7` | 已启用 / 成功 |
| `--warning` / `--warning-bg` | `#f59e0b` / `#fef3c7` | 推理中 / 警示 |
| `--danger` / `--danger-bg` | `#dc2626` / `#fee2e2` | 失败 / 危险 |
| `--info` / `--info-bg` | `#3b82f6` / `#dbeafe` | Beta / 信息 |

### 1.6 presence（坐席状态点四态）

| token | hex | 语义 |
|---|---|---|
| `--presence-online` | `#22c55e` | 在线 / 待命 |
| `--presence-busy` | `#f97316` | 忙碌 / 推理中 |
| `--presence-idle` | `#eab308` | 闲置 |
| `--presence-offline` | `#a1a1aa` | 离线 |

### 1.7 彩虹 palette（8 色，仅身份识别）

| token | 主色 | 浅底（icon-box 用） |
|---|---|---|
| `--hue-rose` | `#f43f5e` | `#ffe4e6` |
| `--hue-orange` | `#f97316` | `#ffedd5` |
| `--hue-amber` | `#f59e0b` | `#fef3c7` |
| `--hue-green` | `#22c55e` | `#dcfce7` |
| `--hue-teal` | `#14b8a6` | `#ccfbf1` |
| `--hue-blue` | `#3b82f6` | `#dbeafe` |
| `--hue-violet` | `#8b5cf6` | `#ede9fe` |
| `--hue-pink` | `#ec4899` | `#fce7f3` |

分配规则：`hash(identityId) % 8` 取 index（同一 id 永远同色）。**使用边界见 03-principles.md §2**。

### 1.8 brand

| token | 值 | 用途 |
|---|---|---|
| `--brand-grad` | `linear-gradient(135deg,#8b5cf6 0%,#ec4899 50%,#f97316 100%)` | R logo / idle hero orb（全站仅此两处） |

## 2. 字体

| token | 字体族 | 用途 |
|---|---|---|
| `--font-sans` | Inter, system-ui | 正文、UI 文案 |
| `--font-mono` | JetBrains Mono, ui-monospace | 代码、模型名、token 计数、时间戳、metadata |

- base font-size 14px / line-height 1.5；root 16px（保 Tailwind rem 刻度）
- Playfair Display（serif）**下线**——brand mark 改用渐变色块 R，不再用衬线字

## 3. 圆角 / 阴影 / 层级

| 组 | token → 值 |
|---|---|
| 圆角 | `xs 4 / sm 6 / md 8 / lg 10 / xl 12 / 2xl 16 / full 9999` |
| 阴影 | `xs / sm / md / lg` 极弱灰阶（见 tokens.css，禁自造 box-shadow）；`--shadow-focus: 0 0 0 3px rgba(24,24,27,0.15)` |
| z 轴 | `--z-base 0 / --z-floating 10 / --z-popover 50 / --z-modal 1000`（沿用 _layering.md 标尺） |
