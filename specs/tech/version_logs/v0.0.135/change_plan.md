# v0.0.135 变更计划书 — chat 页层次体系重构（根治 overlay/modal/popover 打地鼠）

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离，事后偏差写进 `change_log.md`。
>
> **纯前端层次重构版本**：零 API / 数据 / testid / 功能契约变更（v0.0.131/133 全部沿用）。仅改：z-index token 化 / pointer-events gate 收紧 / L3 modal 改 createPortal。
>
> **核心架构**：单一权威 spec `_layering.md`（分类法 + z 标尺 + 两条 invariant）。详见 `specs/ui/components/chat-page/_layering.md`。

## 4 症状 → 体系结构性修复映射

| # | 症状 | 根因 | 体系修复 |
|---|------|------|---------|
| 1 | 滚轮悬停右缘空白→整会话不滚 | overlay minimap 插槽 `flex-1 pointer-events-auto` 透明墙吃 wheel | Invariant B：minimap 插槽改 `pointer-events-none`，仅 minimap 本体 auto |
| 2 | memory/cron modal 不可交互，点穿到模型选择 | modal DOM 嵌在 overlay 的 `pointer-events:none` 链里（fixed 救不了继承） | Invariant A：L3 modal 一律 createPortal 到 overlay-root + 显式 auto |
| 3 | 模型选择 popover 层次乱 | z-50/60/100/200 散落、无单一标尺 | §2 z-index token 化（`--z-base/floating/popover/modal`） |
| 4 | 将来新 overlay 重蹈 | 缺槽位/规矩 | §1 分类法 + 判别流程，看 spec 就归类 |

## 列定义（8 列，行 = 一个组件/符号）

| 列 | 说明 |
|----|------|
| 模块 | 子系统（chat-page / styles / lib / studio-page） |
| 文件 | 完整相对路径 |
| 函数·符号 | 组件 / 函数 / className 锚点 |
| 类型 | 新增 / 修改 / 结构 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT（钉死边界） |
| 参考 | spec / 原则依据 |
| 影响行 | +N / -M（coder 按实际） |

## 变更表

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|----------|------|---------|------|------|--------|
| styles | app/web/src/styles/tokens.css | `:root` CSS 变量 | 新增 | 加 4 个 z-index token：`--z-base: 0` / `--z-floating: 10` / `--z-popover: 50` / `--z-modal: 1000` | MUST 放在 `:root` 块内、紧跟现有 tokens；MUST NOT 改其他变量；数值按 `_layering.md §2` 不可调 | `_layering.md §2` | +6 |
| lib | app/web/src/lib/overlay-root.ts | `getOverlayRoot()` | 新增 | idempotent 获取 / 懒创建 `document.body` 下 `<div id="overlay-root">`（`position:absolute; top:0; left:0; pointer-events:none; width:100%; height:100%; z-index:var(--z-modal)`），多 modal 共用 | MUST idempotent（重复调用返回同一节点，不重复创建）；MUST NOT 给 overlay-root 加视觉样式（透明容器）；首次调用 document.body 存在即可（web 渲染层入口已 mount）；MUST 在 SSR 安全（typeof document 检查） | `_layering.md §3 Invariant A` | +25 |
| lib | app/web/src/lib/portal.tsx | `<Portal>` 组件 | 新增 | 极薄 wrapper：`createPortal(children, getOverlayRoot())`；children 直接挂 overlay-root 下。供所有 L3 modal 复用（避免每个 modal 重复 import react-dom/client） | MUST 一律走 getOverlayRoot（不许直接 document.body）；MUST NOT 自带 className/包装层（保持透明）；children 必填 | `_layering.md §3 Invariant A` | +15 |
| chat-page | app/web/src/components/chat-page/component-chat-right-overlay.tsx | `ComponentChatRightOverlay` 根 div className | 修改 | `z-20` → `z-[var(--z-floating)]`；保留 `pointer-events-none` 容器 gate | MUST 保留 absolute inset-y-0 right-3 + flex flex-col items-end + pointer-events-none（Invariant B）；MUST NOT 改定位/几何（v0.0.133 4 布局修复不回退） | `_layering.md §2/§3B` | +1/-1 |
| chat-page | app/web/src/components/chat-page/component-chat-right-overlay.tsx | float-menu 插槽 div（`children` 包裹） | 修改 | `pt-3 pointer-events-auto` → `pt-3`（**去掉 pointer-events-auto**） | MUST 去掉 auto（Invariant B：仅 footprint auto，由 float-menu 自身继承）；float-menu 本体已是 div（默认 auto 从 none 容器继承会变 none，需 float-menu 组件根加显式 auto，见下行） | `_layering.md §3B` | +0/-1 |
| chat-page | app/web/src/components/chat-page/component-chat-right-overlay.tsx | minimap 插槽 div | 修改 | `flex-1 flex items-center justify-end min-h-0 pointer-events-auto` → `flex-1 flex items-center justify-end min-h-0`（**去掉 pointer-events-auto**，结构性修症状 1） | MUST 去掉 auto（Invariant B：留白处必穿透 wheel 到 message-stream）；MUST 保留 flex-1/items-center/justify-end/min-h-0（v0.0.133 居中 + flex 链）；minimap 本体（w-8 列）需显式 auto（见下行） | `_layering.md §3B`；症状 1 | +0/-1 |
| chat-page | app/web/src/components/chat-page/component-history-minimap.tsx | `ComponentHistoryMinimap` 根 div className | 修改 | `flex flex-col items-end gap-2 w-8` 末尾加 `pointer-events-auto`（minimap footprint = w-8 列，可交互；hover/click 都在此 footprint 内） | MUST 显式 auto（minimap 插槽父 div 改 none 后，本体需 auto 才可交互）；MUST NOT 改 w-8 / items-end / gap-2 视觉；保留 onMouseLeave 在根 div（hover 状态管理不变） | `_layering.md §3B`；`_overview §4`（minimap spec） | +1 |
| chat-page | app/web/src/components/chat-page/component-chat-float-menu.tsx | `ComponentChatFloatMenu` 根 `<div data-testid="chat-float-menu">` className | 修改 | className 末尾加 `pointer-events-auto`（菜单本体 footprint = 整个 menu 框，可交互） | MUST 显式 auto（overlay 插槽 div 改 none 后，菜单本体需自己 auto）；MUST NOT 改 testid/视觉/badge 数据契约 | `_layering.md §3B` | +1 |
| chat-page | app/web/src/components/chat-page/component-memory-modal.tsx | `ComponentMemoryModal` 顶层 return JSX | 结构 | 整个 modal JSX（`<div data-testid="memory-modal" fixed inset-0 ...>`）包进 `<Portal>...</Portal>`；`z-[200]` → `z-[var(--z-modal)]`；根 div 末尾 className 加 `pointer-events-auto`（双保险，虽然 portal 后默认 auto） | MUST createPortal 到 overlay-root（Invariant A：脱离 overlay pointer-events 链，结构性修症状 2）；MUST NOT 改 modal 内部 list/editor 视图 / crud 数据流 / testid；保留 onClick=handleClose 在根 div（背景点一下关） | `_layering.md §3 Invariant A`；症状 2 | +2/-1 |
| chat-page | app/web/src/components/chat-page/component-cron-modal.tsx | `ComponentCronModal` 顶层 return JSX | 结构 | 同 memory-modal：包 `<Portal>`；`z-[200]` → `z-[var(--z-modal)]`；根 div 加 `pointer-events-auto` | MUST 同 memory-modal；MUST NOT 改 list/editor 视图 / confirmDel sub-dialog 局部 z-10（component 内子层保留）/ testid | `_layering.md §3 Invariant A`；症状 2 | +2/-1 |
| chat-page | app/web/src/components/chat-page/component-clear-confirm-modal.tsx | `ComponentClearConfirmModal` return JSX | 结构 | 包 `<Portal>`；`z-[100]` → `z-[var(--z-modal)]`；根 div 加 `pointer-events-auto` | MUST 同其他 modal（统一规矩，不靠 caller 不在 none 链的侥幸）；MUST NOT 改 open/onConfirm/onCancel 契约 / testid；open=false 时仍 return null（在 Portal 内 return null 安全，Portal 容许 children 为 null） | `_layering.md §3 Invariant A` | +2/-1 |
| chat-page | app/web/src/components/chat-page/component-usage-panel.tsx | `usage-tip`（hover tooltip）className | 修改 | `z-50` → `z-[var(--z-popover)]`；保留 `pointer-events-none` | MUST token 化（L2 同层不挑差异）；MUST NOT 改 group-hover opacity 切换 / 视觉 | `_layering.md §2` | +1/-1 |
| chat-page | app/web/src/components/chat-page/component-usage-panel.tsx | `usage-panel` 展开浮层 className | 修改 | `z-60` → `z-[var(--z-popover)]`（与 tip 同层，不再 z-60） | MUST token 化；MUST NOT 改 panel 视觉 / 数据 / onDocClick 关闭逻辑 | `_layering.md §2`；症状 3 | +1/-1 |
| chat-page | app/web/src/components/chat-page/component-input-model-picker.tsx | `PICKER_PANEL_CLS` 常量 | 修改 | `z-50` → `z-[var(--z-popover)]` | MUST token 化；MUST NOT 改 absolute bottom-full right-0 mb-1 / w-max / max-w-[480px] / max-h / overflow-y-auto / bg / border / rounded / shadow / py-1 | `_layering.md §2` | +1/-1 |
| chat-page | app/web/src/components/chat-page/component-input-model-picker.tsx | `InputModelPicker` 根 `<div ref={wrapRef}>` className | 修改 | `relative shrink-0 z-50` → `relative shrink-0 z-[var(--z-popover)]` | MUST token 化；MUST NOT 改 ref/hover 监听（hover 预览逻辑不变） | `_layering.md §2` | +1/-1 |
| chat-page | app/web/src/components/chat-page/component-mention-popover.tsx | `MentionPopover` 根 `<div ref={rootRef}>` className | 修改 | `z-50` → `z-[var(--z-popover)]` | MUST token 化；MUST NOT 改 search/tab/键盘导航 / debounce / abort 逻辑 | `_layering.md §2` | +1/-1 |
| chat-page | app/web/src/components/chat-page/component-history-minimap.tsx | `history-minimap-preview` 气泡 className | 修改 | 加 `z-[var(--z-popover)]`（之前无显式 z，靠 DOM 顺序浮在 minimap 上） | MUST 归 L2（hover preview 是 popover 性质）；MUST NOT 改 pointer-events-none（hover only）；保留 absolute right-full mr-2 top-1/2 -translate-y-1/2 / w-[220px] | `_layering.md §2` | +1 |
| chat-page | app/web/src/components/chat-page/component-chat-right-overlay.md | §4 z-index/pointer-events | 修改 | 内容收敛为一句话指向 `_layering.md §2/§3`：「z-index = `--z-floating`、pointer-events gate 见 `_layering.md`」；保留 testid 表 | MUST 收敛单一权威（避免双源漂移）；MUST NOT 删本文（保留为入口 + 组合关系说明）；保留 §1/§3（定位/几何）/§5（testid）/§7（实现偏离） | `_layering.md §6` | +2/-8 |

## 不变项（明确排除，防越界）

- **v0.0.131 所有功能 / 数据 hook / testid / 交互**（minimap Dock 悬停曲线 / 预览气泡 / 跳转、float-menu badge、modal 二级视图、HITL 卡、enqueue-view）—— **全部不动**。
- **v0.0.133 4 布局修复**（minimap 居中 / `pr-[80px]` reserve / `overflow-hidden` wrapper / `break-words`）—— 不回退。
- `deriveMinimapBars` / `useFlattenedView` / `useCronCrud` / `useMemoryCrud` —— 不动。
- `specs/api/` —— 不动（零后端变更）。
- `cron-modal` 删除确认 sub-dialog 的 component 内局部 `z-10` —— 不动（component 内子层不归全局 token 管）。
- `ws-resize-handle` 的 `z-[8]` —— 不动（chat 页之外的 ws 边界手柄，不进 chat 页体系；如要纳入另立版本）。
- `section-conv-panel` 的右键 context menu（`fixed z-50`）—— 不动（在 conv-panel 不在 chat 页范围；后续可归 L2 popover 同 token 化，但本版本聚焦 chat 页 3 root）。
- HITL 卡 / `chat-run-spinner` / empty-state / readonly-badge —— 不动（占排版流，非浮层，归 L0）。

## 验证

- **无 AT/ET**（用户裁决，纯前端层次重构零 API/数据变更）。
- UT 全绿（现有 chat-page UT 不破坏；新增 `<Portal>` / `getOverlayRoot` 加最小 UT 覆盖 idempotent + null SSR 安全）。
- `bun run typecheck` 0 error。
- **用户实机验证 4 症状消失**：
  1. 滚轮悬停右缘空白 → 会话可滚（不再被透明墙卡）。
  2. memory-modal / cron-modal 打开 → 完全可交互（背景点击关闭、按钮点击、列表滚动、editor 切换都正常），不再穿透到下层。
  3. clear-confirm-modal / 模型选择 popover / usage-panel 展开 —— 层次正确，无串层。
  4. （回归）v0.0.133 4 布局修复仍生效（minimap 居中 / reserve / overflow-hidden / break-words）。

## 影响面 / 风险

- **3 chat root 共享 ComponentChatRightOverlay**：3 root（playground + studio 单聊 + studio 群聊）的 overlay gate 同步收紧（pointer-events-auto 仅 footprint），一致无分歧。
- **L3 modal portal 化后 caller ref 不变**：modal 组件契约（props / testid / onClose 回调）零变化，仅内部 JSX 包 Portal；caller（float-menu / section-chat-detail）调用方式不变。
- **overlay-root 容器 pointer-events:none**：modal 自身必须显式 auto（已在表中三 modal 行约束）。如果将来加新 modal，**必须**遵循同款（看 `_layering.md §3A`）。
- **z-index token 替换的视觉等价性**：z-20 → 10（floating）、z-50/60 → 50（popover）、z-[100]/z-[200] → 1000（modal）。除 modal 大幅提高（1000，留余量）外，其余视觉前后关系不变（同层或更高）。
- **Tailwind 任意值消费 CSS 变量**：`z-[var(--z-popover)]` 在 Tailwind JIT 下正常工作（已在 v0.0.x 多处使用同款语法）。
