---
type: spec
title: UI Regulation · 设计原则（v0.0.165 银灰体系）
status: active
updated: 2026-07-17
since: v0.0.165
related: [01-tokens.md, 02-components.md]
---

# UI Regulation · 设计原则

> 参考基准：macOS App Store（银灰壳 + 彩色内容）+ Multica/Linear（极简白灰 + 身份点缀）。
> 本文件是「为什么这么设计」的裁决记录；违反下列原则的实现 = 视觉 bug。

## 1. 中性壳，彩色身份（核心原则）

**结论**：界面 chrome（背景/面板/边框/按钮/tab/focus）一律黑白灰；高饱和色**只**承载身份识别。
**理由**：agent 工具型产品信息密度大，中性壳把视觉焦点让给内容；彩色只在「谁」上（头像/图标），扫一眼即区分成员/skill/模型。
**反例**：橙色主 CTA、彩色 tab 下划线、彩色 focus 光晕（v0.0.164 前的 terracotta 体系，已废止）。

## 2. 彩虹 palette 使用边界（白名单制）

**允许**（仅此四类）：
1. 成员/用户头像底色（hash-by-id）
2. skill / plugin / model / 团队入口的 icon-box
3. brand R logo + playground idle hero orb（`--brand-grad`）
4. presence / 状态语义点（固定语义色，不 hash）

**禁止**：按钮、边框、tab、focus、链接、大面积底色、装饰性色块。新增彩色使用场景须先改本规范再实现。

## 3. 严肃基调（用户裁决 2026-07-17）

- **无动画**：禁 floaty / wave / pulse / 入场动效（现 tokens.css 的 keyframes 随改版删除）。仅保留 ≤150ms 的 hover/按压过渡。
- **无装饰性 emoji**：界面文案不带 👋🎉 类 emoji（消息内容里用户/agent 自己发的不管）。
- 文案陈述式、短句，不用感叹号营销腔。

## 4. light-only

深色模式下线（用户裁决 2026-07-17）：设置页无主题项；tokens 无 dark 变量集；组件不写 `dark:` 分支。未来若恢复需重新走规范变更。

## 5. 一致性守则

1. **同一控件全站一个长相**：模型选择面板、toggle、badge、avatar 等在任何页面（含 app config 内嵌页）必须同一实现/同一 token——发现两处长得不一样即 bug（用户裁决：app config 内外模型面板必须统一）。
2. **hex 零散写禁止**：组件代码只允许引用 token（Tailwind utility 或 `var(--*)`），出现字面 hex = code review FAILED 项。
3. **新概念先落本规范**：新组件视觉规则先进 02-components.md，再实现。

## 6. 信息层级公式

- 页面标题 20px/700；区块标题 11px/600 大写字距 0.08em `--muted-2`；正文 14px；说明 12.5px `--muted`；metadata/时间一律 mono 10.5-12px。
- 每视图**至多一个** primary 按钮；同排按钮 primary 在右。

## 7. 与旧体系的关系

| 旧（≤v0.0.164） | 新（v0.0.165+） |
|---|---|
| `design_system.md` §2 暖橙 token 表 | 本目录 01-tokens.md（design_system.md §2/§5 改写指向此处） |
| terracotta accent 语义 | 黑白灰 CTA + presence/语义色分工 |
| sage/gold/plum 三辅助色 | 8 色 palette（身份）+ 4 语义色（状态） |
| dark/light 双套 | light-only |
| Playfair Display brand 衬线 | 渐变 R 色块 |
