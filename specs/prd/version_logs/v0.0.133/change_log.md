# v0.0.133 — 会话区布局修复（v0.0.131 遗留 4 问题）

> 引入版本：v0.0.133 · 类型：纯前端布局 bugfix（零 API / 数据 / testid / 功能契约变更，v0.0.131 全部沿用）· 测试范围：UT 全绿（现有 v0.0.131 minimap/float-menu/message-stream UT 不破坏）+ `bun run typecheck` 0 error；**AT/ET 豁免**（用户裁决，纯前端无接口/落库变更，口径对齐 `ui-only-ut-skip-at-et`）+ 用户实机验证 4 问题消失。
>
> **用户关键约束（2026-07-13 澄清）**：「右侧应该是悬浮的，这个没问题。但是不代表大家位置无法规划好。」→ **overlay 保持 absolute 悬浮**（不做实体 gutter 列），修复靠「规划位置」：消息区右侧预留空间让头像左移、消除横向滚动、minimap 居中、文字换行。

## 1. 背景

v0.0.131 引入聊天区右缘 overlay（悬浮菜单 + 历史 query minimap）后，用户实机发现 4 个布局问题：

| # | 问题 |
|---|------|
| 1 | minimap 堆在 overlay 顶部（与 float-menu 同 `gap-3`），应在消息区纵向中间 |
| 2 | 居中正文（`max-w-[820px] mx-auto`）右侧的「you」user 头像没左移让位，被悬浮 overlay 压 |
| 3 | 对话区出现横向滚动（长内容/min-w 链未贯通） |
| 4 | 长 token / URL 不换行，撑宽气泡 |

## 2. 修复（4 问题 → 4 修复）

| F | 问题 | 修复 |
|---|------|------|
| F1 | minimap 堆顶 | overlay 根 div 由 `absolute right-3 top-16 ... gap-3` → `absolute inset-y-0 right-3 z-20 flex flex-col items-end pointer-events-none`（纵向铺满定位上下文）；minimap 包裹改 `flex-1 flex items-center justify-end min-h-0`（纵向居中），float-menu 包裹加 `pt-3`（顶部留距） |
| F2 | 头像没让位 | `ComponentMessageStream` 根 scroll div `px-8` → `pl-8 pr-[80px]`（右侧 80px reserve 悬浮 overlay 区，居中内容左移、右侧 user 头像让位） |
| F3 | 横向滚动 | 三 root（`section-chat-detail` / `section-member-chat` / `section-squad-chat`）把 `{消息区} + {Overlay}` 包进一层 `<div className="flex-1 flex flex-col relative min-h-0 min-w-0 overflow-hidden">` wrapper——`overflow-hidden` 杀横向滚动 + `min-w-0/min-h-0` 贯通 flex 链；input-bar 留 wrapper 外 |
| F4 | 文字不换行 | `primitive-bubble` user/assistant 两态加 `break-words`；`primitive-markdown-view` root `<div>` 加 `break-words min-w-0` + 段落 `<p>` 加 `break-words` |

> **wrapper = overlay 的定位上下文**（`inset-y-0` 指 wrapper 高 = 消息区高度）——F1 与 F3 共用同一 wrapper：wrapper 既提供 overlay 的纵向铺满基准，又 `overflow-hidden` 杀横向滚动。

## 3. 不变项（明确排除）

- v0.0.131 所有功能 / 数据 hook / testid / 交互（minimap Dock 悬停、预览气泡、跳转、float-menu badge、弹层二级视图）——全部不动。
- `specs/api/`——不动（零后端变更）。
- input-bar 布局——不动（消息区 reserve 后输入区与消息区轻微错位属可接受已知点，验收由用户定）。
- 空态（empty-state）——除包进 wrapper 外不动其内容。

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

本版本为布局 bugfix，不新增用户路径；v0.0.131 的 8 条关键用户路径（minimap 定位 / 悬浮菜单 → 弹层 / 二级视图 / badge / 群聊收敛 / 旧 tab 废弃回归）全部沿用，由 UT + 用户实机验证覆盖（AT/ET 豁免）。

## 5. 对应 overall 同步（doc-modifier 阶段 5）

- `chat-page/_overview.md`：§1（右缘 overlay 定位）/ §3（组件清单 overlay 行）/ §4.3（消息区 wrapper）/ §4.5（message-list `pr-[80px]`）/ §4.7（bubble `break-words` + markdown-view）。
- `chat-page/component-chat-right-overlay.md`：§1 + §3（定位模型全面重写：`inset-y-0` + 内部纵向分配 + wrapper 定位上下文 + 消息区 reserve）。
- `chat-page/component-history-minimap.md`：§1（minimap 块纵向居中说明）。
- tech frontend KB `log.md`：追加 v0.0.133 布局修复条目。

## 6. 实现偏差记录

无（实现严格遵循 `specs/tech/version_logs/v0.0.133/change_plan.md`，8 列表 + 4 修复映射一一对应；typecheck 0 + UT 6931/0 全绿）。
