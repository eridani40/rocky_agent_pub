---
type: spec
title: Design System（设计 token 与组件词表）
priority: P0
status: active
updated: 2026-07-21
since: v0.0.1
related: [[P0]tech_stack.md, [P0]component_architecture.md, ../../../ui/regulation/01-tokens.md, ../../../ui/regulation/02-components.md, ../../../ui/regulation/03-principles.md]
---

# Design System（设计 token 与组件词表）

> **⚠️ v0.0.165 起，token/组件视觉规范权威源迁至 `specs/ui/regulation/`：**
> - **色板/字体/圆角/z 轴** 权威 = `specs/ui/regulation/01-tokens.md`（银灰体系，light-only，8 色 hue palette + presence 四态 + brand-grad）
> - **组件视觉规则**（按钮/badge/avatar/input/chat 气泡/model picker/坐席卡）权威 = `specs/ui/regulation/02-components.md`
> - **设计原则**（中性壳彩色身份/严肃基调/light-only/一致性守则）权威 = `specs/ui/regulation/03-principles.md`
>
> 本文件 §2 色表 / §5.1 暖色决策 / §5.3 主色语义为 **v0.0.164 之前的历史记录**，v0.0.165 起已被上述 regulation 目录整体替代（决策落 03-principles.md §7 新旧对照表）。本文件 §3（Tailwind v4 `@theme` 映射机制）+ §4 组件词表结构仍适用（承载 token 的方式无变）。

> 管什么：web/ 渲染层如何把 token 承载进 Tailwind theme（§3 映射机制），以及从视觉规范推导出的组件词表结构（§4 抽象方法）。**具体 token 值 / 组件视觉规则一律不看本文件，看 regulation/。**
> 不管什么：技术选型（→ `app/frontend/[P0]tech_stack.md`）；组件实现代码（JSX/函数体 → 代码层）；单组件 testid/props/视觉基线（→ `specs/ui/components/`）；IPC 契约（→ `app/protocols/`）；业务逻辑（→ `agent/` 与 `app/server/`）。
> 边界归属规则见 [docs_guide.md](../../../docs_guide.md) §4。

## 1. 概述

Design System 沉淀**视觉契约的承载方式**：设计 token（色彩/字体/圆角/间距）经 CSS 变量集中定义，Tailwind v4 `@theme` 块引用变量生成 utility，组件消费 utility——单一物理源 + 换主题零 JS 重渲染。组件词表把设计稿反复出现的 UI 结构（shell、消息行、tool card、按钮、badge）抽成契约，作为 `specs/ui/components/` 单组件 spec 的输入。

一句话：**设计稿是源头 → regulation/ 定义 token/组件视觉规则 → 本文件 §3 定义"token → Tailwind theme"承载机制 → 组件实现消费 Tailwind class + `var(--*)`**。

## 2. [归档 ≤v0.0.164] 暖色 token 总表

> **v0.0.165 已弃用**：本节 §2.1-§2.4 是 v0.0.164 及之前的暖色（terracotta/sage/gold/plum）体系；v0.0.165 起色板由 `specs/ui/regulation/01-tokens.md` 银灰体系整表替代（`--bg`/`--surface`/`--fg`/`--btn-primary-bg=#18181b` + 8 色 `--hue-*` palette + `--presence-*` 四态 + `--brand-grad`）。深色模式（`[data-theme=dark]` 变量集）下线（regulation 03 §4）；Playfair Display 衬线下线（brand 改 `--brand-grad`，regulation 01 §2）；`--color-*` 前缀 alias 保留但灌新中性值（决策 R-1，见 `specs/tech/version_logs/v0.0.165/change_plan.md §12`）。
> 保留本节仅供追溯"v0.0.164 之前是什么"，禁止作为实现依据。

### 2.1 色彩（v0.0.164 及之前，历史记录）

> **v0.0.164 之前**为 dark/light 双套暖色；v0.0.165 起单套银灰 light-only。下表仅供追溯，实现依据看 `specs/ui/regulation/01-tokens.md`。

| 分组 | token 名 | light（hex） | dark（hex） | 用途 |
|---|---|---|---|---|
| **背景层** | `bg-base` | `#faf6f0` | `#1f1a17` | 应用底色（页面底） |
| | `bg-warm` | `#f3ebe0` | `#332a24` | thinking 折叠面板、tool card、二级区块底 |
| | `bg-surface` | `#fffdf8` | `#2a2420` | 卡片/bubble 表面 |
| | `surface-2` | `#FFFFFF` | `#3a322c` | 浮层/输入区/最亮表面 |
| **文字** | `fg-1` | `#2a2420` | `#f5ede0` | 主文字 |
| | `fg-2` | `#5a4f44` | `#c9bfb0` | 次文本 / user bubble 底 |
| | `fg-3` | `#5c5a52` | `#a89e8e` | 次级文字 |
| | `muted` | `#87867f` | `#8a8074` | 辅助说明、metadata |
| | `muted-2` | `#6b6a63` | `#746a5e` | 比 muted 略深 |
| **边框** | `border` | `#e3e1da` | `#3d3530` | 常规分隔线 |
| | `border-2` | `#d9d6ce` | `#473e38` | 二级分隔线 |
| | `border-strong` | `#c7c4bb` | `#5a4f44` | 强调分隔（active、focus 外圈） |
| **主色 accent（terracotta）** | `accent` | `#b85c3a` | `#c8704d` | 主 CTA、链接、focus 边框 |
| | `accent-hover` | `#a04d2e` | `#d98563` | 主 CTA hover |
| | `accent-light` | `#f4e5de` | `#3d2e26` | default badge 底、focus 光晕 |
| | `accent-surface` | `#fbf1ed` | `#2f2620` | accent 极浅表面 |
| **辅助色** | `sage` | `#5b7a6b` | `#7a9b8a` | active 状态圆点 / active badge 文字 |
| | `gold` | `#b89160` | `#cba578` | beta badge 文字 |
| | `plum` | `#7c5b6b` | `#9a7585` | 预留（强调次级状态） |
| **辅助底色（badge/底纹）** | `sage-bg` | `#e3f0e8` | `#2a3530` | active badge 底 |
| | `gold-bg` | `#f5e8d5` | `#3a322a` | beta badge 底、model icon 底（gold 系） |
| **代码** | `code-bg` | `#2b2a27` | `#161311` | 代码块底 |
| | `code-fg` | `#e3e1da` | `#e3e1da` | 代码块文字（浅色，配深底） |

> light 原值与线框 1:1（线框即 light 形态）；dark 列为归纳的暖色 dark 对照，保持暖色系不切中性灰（与 §5.1 决策一致）。未来若线框或设计师迭代 dark 配色，本表先改、tokens.css 与组件 Tailwind class 跟着变量走。

### 2.2 字体（v0.0.164 及之前：三族；v0.0.165 起：两族）

> **v0.0.165 起 Playfair Display 下线**（§5.2 修订）：字体从三族（Inter + JetBrains Mono + Playfair Display）精简为两族（Inter + JetBrains Mono），brand mark 改 `--brand-grad` 渐变色块。本小节表格保留 v0.0.164 及之前的三族历史，仅作追溯；v0.0.165+ 实现依据 §5.2 + `specs/ui/regulation/01-tokens.md §2`。
>
> **v0.0.184 字体内置**（doc-sync）：Inter + JetBrains Mono 走 `@fontsource/{inter,jetbrains-mono}` 本地打包（app/web workspace deps），按重 import（与原 Google Fonts link 字重一致），dist 产物全本地 woff2、零远程 url；Playfair Display 产品代码零引用、`@fontsource/playfair-display` dep 移除（8 woff2 死重 ~150KB 下线）。详见 `specs/tech/version_logs/v0.0.184.student_training/change_plan.md` 末「字体内置 + Playfair Display 下线」。

| token 名 | 字体族 | 用途 |
|---|---|---|
| `font-sans` | **Inter**（300/400/500/600/700） | 正文、UI 文案 |
| `font-mono` | **JetBrains Mono**（400/500） | 代码、标签、metadata、计数、时间戳、breadcrumb 当前项 |
| `font-serif` | **Playfair Display**（400/700） | brand mark、品牌标识 |

- **base font-size**：14px
- **base line-height**：1.5
- 字体引入：`@import url(...Inter...JetBrains+Mono...Playfair+Display...)`（线框第 9 行的 Google Fonts 链接）；web/ 内通过 CSS `@import` 或 `index.html` `<link>` 引入。

### 2.3 圆角

| token 名 | 值 | 典型用途（归纳自线框） |
|---|---|---|
| `rounded-xs` | 4px | 气泡内侧角（agent 气泡左上、user 气泡右上） |
| `rounded-sm` | 6px | 小按钮、tag |
| `rounded-md` | 8px | 卡片、model icon、avatar 方形 |
| `rounded-lg` | 10px | 大卡片、input 容器 |
| `rounded-xl` | 12px | 浮层、modal |

> 圆角档位与 Tailwind 默认数值不完全一致，需在 theme.extend 显式覆盖（见 §3）。

### 2.4 间距（从线框 padding 规律归纳，作为参考刻度）

| 场景 | 归纳值 |
|---|---|
| 气泡内边距 | 12px（水平） / 10px（垂直） |
| 卡片内边距 | 12px–16px |
| sidebar-nav 宽 | 56px |
| conv-panel 宽 | 224px |
| func-panel 宽 | 280px |
| settings submenu 宽 | 208px |
| avatar 直径 | 32px |
| 组件间垂直间距（消息行间） | 16px |

> 间距为线框归纳值，作为组件实现的参考刻度；不强制成 Tailwind spacing 扩展（沿用 Tailwind 默认 spacing scale 即可命中 4/8/12/16 等刻度）。

## 3. Tailwind theme 映射

**结论**：token 经 **CSS 变量定义**（`app/web/src/styles/tokens.css`），Tailwind v4 的 `@theme` 块引用这些变量生成 utility（`bg-surface`、`text-fg-2`、`rounded-md`...）；不直接把 hex 硬编码进 Tailwind config。
**理由**：CSS 变量是 token 的唯一物理源，未来要做暗色/主题切换只需替换变量值，Tailwind utility 名不变、组件代码不动；与线框"CSS 变量定义 + utility 引用"的形态完全一致。
**反例**：若直接把 hex 散写进 `theme.extend.colors`，则主题切换要再写一套覆盖逻辑或维护两份 theme，token 双源、易漂移。

### 3.1 完整 `@theme` 映射示例（Tailwind v4 形态，关键字段不省略）

> tokens.css 用 `[data-theme="dark"]` / `[data-theme="light"]` 两套作用域覆盖 `@theme` 默认变量值（utility 名不变，切 data-theme 即换色板）。下例展示 dark 作用域与 @theme 默认（light）；light 作用域与 @theme 默认一致可省略。完整 dark/light hex 见 §2.1。

```css
/* app/web/src/styles/tokens.css — 由 design_system.md §2.1 派生，不得手改 hex */
@import "tailwindcss";

@theme {
  /* —— 默认（= light）变量值，照抄 §2.1 light 列 —— */
  --color-bg-base:        #faf6f0;
  --color-bg-warm:        #f3ebe0;
  --color-bg-surface:     #fffdf8;
  --color-fg-1:           #2a2420;
  --color-fg-2:           #5a4f44;
  --color-accent:         #b85c3a;
  /* ...其余变量同 §2.1 light 列... */

  --font-sans:  'Inter', system-ui, sans-serif;
  --font-mono:  'JetBrains Mono', ui-monospace, monospace;
  --font-serif: 'Playfair Display', Georgia, serif;
  --radius-xs: 4px; --radius-sm: 6px; --radius-md: 8px;
  --radius-lg: 10px; --radius-xl: 12px;
  --text-base-size: 14px;
}

/* dark 主题作用域：照抄 §2.1 dark 列覆盖默认 */
[data-theme="dark"] {
  --color-bg-base:   #1f1a17;
  --color-bg-warm:   #332a24;
  --color-bg-surface:#2a2420;
  --color-fg-1:      #f5ede0;
  --color-fg-2:      #c9bfb0;
  --color-accent:    #c8704d;
  /* ...其余变量同 §2.1 dark 列... */
}
```

> Tailwind v4 的 `@theme` 块内每个 `--color-*` / `--font-*` / `--radius-*` 变量自动生成对应 utility（`bg-surface`、`font-mono`、`rounded-md`...），无需在 `tailwind.config.ts` 再声明同名键。主题切换通过 `<html data-theme="dark|light">` 触发作用域覆盖，**无 JS 重渲染色值**（与 ui §7 决策一致）。

### 3.2 关键 boxShadow（focus 光晕，归纳自线框）

```css
@theme {
  --shadow-focus: 0 0 0 3px var(--color-accent-light);
}
```

> 线框中 input focus、active 项都使用 `box-shadow: 0 0 0 3px var(--accent-light)` 这一形态；统一成 `shadow-focus` utility。

## 4. 组件词表（契约，不写实现）

下表是从线框归纳的组件契约，作为 `specs/ui/`（未来组件实现文档）的输入。每行列「组件名 / 线框来源 / 关键 token / 职责」，不写 JSX。

| 组件名 | 线框来源（节/区域） | 关键 token | 职责（一句话契约） |
|---|---|---|---|
| `app-shell` | 整体三栏 | — | 装配 sidebar-nav(56px) + conv-panel(224px) + chat-area + func-panel(280px) 的栅格容器 |
| `sidebar-nav` | 左侧导航 | bg / accent / muted | 窄图标导航，active 项 accent 高亮 |
| `conv-panel` | 会话列表面板 | surface / border | 会话列表，每项标题 + 时间 + metadata(mono) |
| `chat-area` | 中央聊天区 | bg | 承载消息流 + chat-input 的垂直容器 |
| `message-row` | 单条消息行 | — | agent 左对齐 / user 右对齐(row-reverse) + avatar(32px) + chat-bubble |
| `chat-bubble`（agent） | agent 气泡 | surface + border | 背景 surface、边框 border、左上角 `rounded-xs`(4px) |
| `chat-bubble`（user） | user 气泡 | fg-2 + surface 文字 | 背景 fg-2、文字 surface、右上角 `rounded-xs`(4px) |
| `tool-card` | 工具调用卡片 | bg-warm + border | 可折叠 header + status 圆点(sage)；折叠/展开内部细节 |
| `chat-input` | 输入区 | surface-2 + accent | focus 时 accent 边框 + `shadow-focus`；textarea 自适应高度 |
| `func-panel` | 右侧功能面板 | surface + border | 上下文/设置等功能区，宽 280px |
| `settings-shell` | 设置页 | surface + border | submenu(208px) + content 两栏 |
| `settings-submenu` | 设置左侧菜单 | muted + accent(当前项) | 当前项 accent，breadcrumb 上方显示路径 |
| `provider-card` | Provider 卡片 | surface + border + accent | logo + name + badge + desc 的卡片布局 |
| `model-item` | 模型行 | accent-surface + sage(gold) icon | icon(32px, rounded-md) + 名称 + metadata + toggle |
| `breadcrumb` | 面包屑 | muted + accent(当前) | 当前项 mono 字体 + accent 色 |
| `badge` | 各种状态标 | 见下 | 四态：active(sage-bg+sage) / soon(muted) / default(accent-light+accent) / beta(gold-bg+gold) |
| `button-primary` | 主按钮 | accent / accent-hover / surface(文字) | 主 CTA |
| `button-secondary` | 次按钮 | surface + border-strong | 次级操作 |
| `button-ghost` | 幽灵按钮 | transparent + muted | 不显眼操作 |
| `avatar` | 头像 | fg-2 / accent | 32px 圆角方块（`rounded-md`），agent 默认 / user 备选 |
| `code-block` | 代码块 | code-bg + code-fg + font-mono | 深底浅字代码渲染 |

### 4.1 状态语义（badge 四态，归纳自线框）

| 状态 | 底色 | 文字色 | 用途 |
|---|---|---|---|
| `active` | `sage-bg` (#E3F0E8) | `sage` (#5B7A6B) | 已启用/在线 |
| `soon` | 透明/`bg-warm` | `muted` (#87867F) | 即将上线 |
| `default` | `accent-light` (#F4E5DE) | `accent` (#D97757) | 默认/普通 |
| `beta` | `gold-bg` (#F5E8D5) | `gold` (#B89160) | 测试版 |

### 4.2 动效（归纳自线框）

| 动效 | 用途 |
|---|---|
| `fadeIn`（0.3s） | 气泡/卡片入场 |
| `blink`（光标） | 流式 token 渲染时的输入光标 |
| `spin` | 工具执行中、LLM 思考中的加载圈 |

> 动效 token（时长/缓动）暂不进 Tailwind，由组件实现用 Tailwind 的 `animate-*` + keyframes 表达；若日后动效增多，再单独沉淀动效 token 表。

## 5. 设计决策

### 5.1 [已推翻 v0.0.165] 色系：暖色（米/陶/沙绿/金）

> **决策已在 v0.0.165 被推翻**。当前色系决策见 `specs/ui/regulation/03-principles.md §1「中性壳，彩色身份」`：chrome（背景/面板/边框/按钮/tab/focus）一律黑白灰；高饱和色**只**承载身份识别（头像/图标 8 色 palette + presence 四态语义色）。
> 历史记录（≤v0.0.164）：采用暖色系（米色背景 + terracotta 主色 + sage/gold/plum 辅助）——传达「可亲近、长期陪伴」调性；v0.0.165 因信息密度诉求 + macOS App Store/Multica/Linear 参考基准，重新裁决为中性壳彩色身份（用户裁决 2026-07-17，落 regulation 03 §1）。

### 5.2 三种字体的分工（v0.0.165 修订：Playfair 下线；v0.0.184 字体内置）

> **v0.0.165 修订**：Playfair Display 衬线**下线**——brand mark 改用 `--brand-grad` 渐变色块 R（regulation 01 §2）。当前字体分工 = Inter（正文/UI 文案）+ JetBrains Mono（代码/模型名/token 计数/时间戳/metadata），两族分工。
> **理由**：Inter 是 UI 正文事实标准；JetBrains Mono 让「机器产出」内容一眼可辨。**Playfair 下线原因**：严肃基调（regulation 03 §3）不需要装饰性衬线；brand 用渐变色块表达更贴合银灰壳的视觉重量。
> **反例**：若全用 Inter，代码与 metadata 失去视觉区分。
>
> **v0.0.184 字体内置**（doc-sync 收尾）：两族字体走 `@fontsource/inter` + `@fontsource/jetbrains-mono` 本地打包（app/web workspace deps），按重 import（300/400/500/600/700 + 400/500），与原 Google Fonts link 字重一致；dist 产物全本地 woff2、零远程 url（用户裁决：Google Fonts 远程依赖因 ERR_NETWORK_CHANGED 不稳定）。Playfair Display `@fontsource` dep 同版移除（产品零引用 + 8 woff2 死重 ~150KB）。

### 5.3 [已推翻 v0.0.165] 主色 terracotta（#D97757）的语义

> **决策已在 v0.0.165 被推翻**。当前语义分工见 `specs/ui/regulation/03-principles.md §1 + §2 + 01-tokens §1.4/§1.5/§1.6/§1.7`：
> - **CTA/操作焦点** = `--btn-primary-bg = #18181b`（黑主 CTA，不再是彩色）
> - **status/在线** = `--success/--warning/--danger/--info` 四语义色（regulation 01 §1.5）
> - **presence** = `--presence-online/busy/idle/offline` 四态点（regulation 01 §1.6）
> - **身份识别** = 8 色 `--hue-*` palette（hash-by-id，regulation 01 §1.7）——**唯一使用彩色的白名单场景**（regulation 03 §2）
>
> 历史记录（≤v0.0.164）：terracotta 承载所有「可交互/需要注意」语义；v0.0.165 拆散为「黑 CTA + 语义 4 色 + presence 4 色 + hue 8 色」四层，语义更明确。R-1 风险：`--color-accent-*` alias 保留但灌黑色值（`#18181b`），全站 `bg-accent`/`text-accent` 视觉等同「黑 CTA」，本版接受，v0.0.166+ 逐步清 alias（详 change_plan §12 R-1）。

### 5.4 token 经 CSS 变量定义，Tailwind theme 引用变量（v0.0.165 沿用）

**结论**：token 物理源是 CSS 变量（`@theme` 块），Tailwind utility 引用变量；不把 hex 硬编码进 `tailwind.config.ts`。**v0.0.165 加护栏**：非 tokens.css / 非 tests 文件出现字面 hex = code review FAILED（INV-2 硬门禁，见 change_plan §12）。
**理由**：见 §3——单一物理源 + 未来主题切换零成本（变量值替换即可）。v0.0.165 换肤实证 = 只替 tokens.css 变量值 + 组件走 `var(--*)`/tailwind utility，56 处硬编码 hex 一次清零。

## 6. 边界

| 零件 | 归属 |
|---|---|
| **[v0.0.165]** 色板 hex 值 / 字体族 / 圆角档 / z 轴 / brand-grad | `specs/ui/regulation/01-tokens.md` |
| **[v0.0.165]** 组件视觉规则（按钮/badge/avatar/input/chat 气泡/model picker/坐席卡） | `specs/ui/regulation/02-components.md` |
| **[v0.0.165]** 设计原则（中性壳彩色身份/严肃基调/light-only/一致性守则/8 色 palette 使用边界） | `specs/ui/regulation/03-principles.md` |
| token → Tailwind theme 承载机制（§3）+ 组件词表抽象结构（§4） | 本文件 ✅（承载方式无变） |
| web/ 渲染层技术选型（React/Tailwind/Zustand/TanStack Query） | `app/frontend/[P0]tech_stack.md` |
| 单组件 spec（testid/props/视觉基线） | `specs/ui/components/<page>/<component>.md` |
| 组件实现代码（JSX、props、hook 行为） | 代码层 `app/web/src/components/` |
| 设计稿本体 | `reqs/[working] v0.0.165.ui_upgrade/design/*` (v0.0.165 银灰) / `reqs/v0.0.1/easy-opc-wireframe-v2.html`（v0.0.1 暖橙，历史） |
| Tailwind / Vite 配置归属、`bun run test` 红线 | `app/package/[P0]tool_chain.md` |
| 跨模块零件通用归属规则 | [docs_guide.md](../../../docs_guide.md) §4 |
