# v0.0.306 change_log — markdown 有序列表修复 + playground pin 按钮对齐

## T1: markdown 有序列表编号重置/跳变检测

**文件**: `app/web/src/components/common/primitive-markdown-view.tsx`

**问题**: `PrimitiveMarkdownView` 有序列表解析 while 循环不检测编号重置——同一段 markdown 中多个独立的 `1.` 列表会被连续累加编号（如两段 `1.` `2.` 列表渲染为 `1.` `2.` `3.` `4.`），而非各自从 1 开始。

**修复**: while 循环加两项检测：
1. **编号重置检测**：非首项再次出现 `1.` → 断开当前 `<ol>`，该行交外层循环开新 `<ol>`
2. **编号跳变检测**：非连续编号（如 `1.` → `3.`，`prevNum + 1 !== n`）→ 断开当前 `<ol>`

用 `prevNum` 跟踪前一项编号，首项（`items.length === 0`）不检测。

## T2: playground conv-item hover pin 按钮（对齐 SquadRow）

**文件**: `app/web/src/components/chat-page/component-conversation-item.tsx` + `section-conv-panel.tsx`

**问题**: conv-item 此前置顶只有只读 `PinIcon`（v0.0.231）+ 右键菜单操作，没有直接 hover pin 按钮，与 studio sidebar SquadRow 的 pin 按钮交互不一致。

**修复**:
- conv-item：把只读 `PinIcon` 替换为可交互 `<button>`（`onTogglePin` prop 注入时渲染）。hover 显隐（`opacity-0 group-hover:opacity-100`）+ pinned 常驻（`opacity-100 text-accent`）；`visibility:visible` 恒占位零 reflow；点击 `stopPropagation` 后调 `onTogglePin(s.id, !isPinned)`。
- conv-panel：透传 `onTogglePin` 到每个 conv-item（已有右键菜单也走同一回调）。
- 未注入 `onTogglePin` 时按钮不渲染（旧消费方零破坏）。
