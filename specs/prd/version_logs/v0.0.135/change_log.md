# v0.0.135 — chat 页层次体系重构（根治 overlay / modal / popover 打地鼠）

> 引入版本：v0.0.135 · 类型：纯前端架构重构（零 API / 数据 / testid / 功能契约变更，v0.0.131/133 全部沿用）· 测试范围：UT 全绿（新增 3 UT 8 case 覆盖 `getOverlayRoot` idempotent + SSR 安全 + `<Portal>` null 安全）+ `bun run typecheck` 0 error；**AT/ET 豁免**（用户裁决，纯前端无接口/落库变更，口径对齐 `ui-only-ut-skip-at-et`）+ 用户实机验证 4 症状消失。
>
> **核心交付**：单一权威 spec `specs/ui/components/chat-page/_layering.md`（分类法 + z 标尺 + 两条 invariant），把层次决策从「逐个 ad-hoc」收敛为「按槽位映射」。

## 1. 背景（根因）

v0.0.131 引入右缘 overlay 后，chat 页暴露出**没有一套层次体系**的根本架构问题：每个浮层各挑 z-index（z-20 / z-50 / z-60 / z-[100] / z-[200] 散落魔法数字）、各挑 pointer-events 策略、modal 嵌在触发它的 DOM 子树里继承 `pointer-events:none`。结果：改一处必碰另一处（v0.0.133 反复修 wheel 穿透 ↔ modal 不可交互）。

## 2. 4 症状 → 体系结构性修复映射

| # | 症状 | 根因 | 体系修复 |
|---|------|------|---------|
| 1 | 滚轮悬停右缘空白→整会话不滚 | overlay minimap 插槽 `flex-1 pointer-events-auto` 透明墙吃 wheel | **Invariant B**：minimap 插槽改 `pointer-events-none`，仅 minimap 本体（w-8 列）auto |
| 2 | memory/cron modal 不可交互，点穿到模型选择 | modal DOM 嵌在 overlay 的 `pointer-events:none` 链里（`fixed z-[200]` 救不了 CSS 继承） | **Invariant A**：L3 modal 一律 `<Portal>` 到 overlay-root + 显式 `pointer-events-auto` |
| 3 | 模型选择 popover 层次乱 | z-50/60/100/200 散落、无单一标尺 | **§2 z-index token 化**（`--z-base/floating/popover/modal` = 0/10/50/1000） |
| 4 | 将来新 overlay 重蹈 | 缺槽位/规矩 | **§1 分类法 + 判别流程**：L0 base / L1 floating-chrome / L2 popover / L3 modal，看 spec 就归类 |

## 3. 两条架构 invariant（核心，写死，不可破）

- **Invariant A — L3 modal 一律 `createPortal` 到 overlay-root**：脱离一切祖先 stacking context + pointer-events gate，与触发者 DOM 位置无关。`app/web/src/lib/overlay-root.ts` 提供 `getOverlayRoot()`（idempotent 懒创建 + SSR 安全）单一获取点；`app/web/src/lib/portal.tsx` 极薄 wrapper。3 modal（memory / cron / clear-confirm）已迁。
- **Invariant B — L1/L2 pointer-events 只覆盖真实可交互 footprint**：容器 + 两插槽 `pointer-events-none`，仅 float-menu 本体 + minimap 本体（w-8 列）各自显式 `pointer-events-auto`，留白处穿透 wheel/click 到 message-stream。

## 4. 不变项（明确排除）

- v0.0.131 所有功能 / 数据 hook / testid / 交互（minimap Dock 悬停、预览气泡、跳转、float-menu badge、弹层二级视图）——全部不动。
- v0.0.133 4 布局修复（minimap 居中 / `pr-[80px]` reserve / `overflow-hidden` wrapper / `break-words`）——不回退。
- `specs/api/`——不动（零后端变更）。
- `cron-modal` 删除确认 sub-dialog 的 component 内局部 `z-10`——不动（component 内子层不归全局 token）。
- `ws-resize-handle` 的 `z-[8]` / `section-conv-panel` 右键 menu 的 `z-50`——不动（chat 页范围之外，后续可纳入）。
- HITL 卡 / `chat-run-spinner` / empty-state——不动（占排版流，归 L0 base，非浮层）。

## 5. 关键用户路径（MANDATORY — 测试最低覆盖）

本版本为层次架构重构，不新增用户路径；v0.0.131 的 8 条关键用户路径（minimap 定位 / 悬浮菜单 → 弹层 / 二级视图 / badge / 群聊收敛 / 旧 tab 废弃回归）全部沿用，由 UT + 用户实机验证覆盖（AT/ET 豁免）。

## 6. 对应 overall 同步（doc-modifier 阶段 5）

- **新建** `chat-page/_layering.md`（architect 产出，层次体系单一权威）。
- `chat-page/component-chat-right-overlay.md §4`：收敛为一句话指向 `_layering.md §3B`（coder 已改）。
- `chat-page/_overview.md` §1 / §3 组件清单：右缘 overlay 行的 `z-20` / `z-50/60` 旧描述归一指向 `_layering.md`。
- `chat-page/component-chat-right-overlay.md §3` / `component-chat-float-menu.md §8` / `component-input-model-picker.md §5` / `component-usage-panel.md §3.2/§4.5/§4.6`：字面 z 数字 → token 或指向 `_layering.md`。
- tech frontend KB `log.md`：追加 v0.0.135 条目。

## 7. 实现偏差记录

无（实现严格遵循 `specs/tech/version_logs/v0.0.135/change_plan.md`，typecheck 0 + UT 全绿）。
