# v0.0.320 — UI Change Log（文件预览区 · 第三批及后续全部改动）

> 增量变更。全量权威：`specs/ui/components/chat-page/section-preview-area.md`（组件契约）。
> 对应 PRD：`specs/prd/version_logs/v0.0.320-file-preview.md`。
> 范围：老板第三批试玩反馈——悬浮操作按钮 + 收起竖条手柄 + tab 分隔感 + Tab 键循环 + 图标族 + 拖拽 bug 修复 + 自动展开 + 视觉打磨。纯前端零 API 变更。

## §1 组件 spec 更新/新增

### `section-preview-area.md`（修改）

- §3.2 状态：collapsed 从 context 消费（hook 层管理，openTab/activateTab 自动展开）；收起态渲染竖条手柄（替代旧 chevron rail）；单分隔条 `.pv-resize-left`（删 `pv-resize-right` 拖拽 bug）
- §3.3 内容区：补悬浮操作按钮（`ComponentPreviewFloatingActions`，group-hover 显隐）
- §5.1 TabBar：补 Tab 键循环切换（Tab/Shift+Tab 首尾循环，复用 activateTab 走守卫）+ tab 分隔感（border + rounded-md）
- §5.2 viewer：顶栏退役（副标题+编辑按钮行删除）
- §5.3 editor：按钮行退役 → 操作移到悬浮按钮（useImperativeHandle 暴露 save/format/validate）+ 格式化/校验（structured）
- §5.6-§5.8：新增 3 段（悬浮按钮 / 收起手柄 / 图标族）
- §6/§8/§9：范式 + i18n + 视觉基线同步更新

### 新增组件（specs/ui/components/chat-page/ 下无独立 spec，内嵌在 section-preview-area.md §5.6-§5.8）

按 doc-specs 规范，第三批新增 3 组件 + 1 hook + 1 图标集，spec 内嵌 section-preview-area.md（同层 section 级权威），不独立拆文件（避免碎片化）。

## §2 第三批全部 commit 记录

| commit | 说明 |
|--------|------|
| b1696c90a | 删顶栏文件名行 + 悬浮操作按钮（编辑/保存/撤销/格式化/校验）+ 收起/展开箭头 + 拖拽 bug 修复（删 pv-resize-right） |
| 41bb36296 | 收起/展开箭头方向修正（展开态→收起 / 收起态←展开） |
| 98f596d2f | 悬浮按钮「撤销」文案（cancel→undo） |
| f7270d093 | 收起按钮竖条样式（VSCode 风格竖长条手柄） |
| 53516d1c5 | 收起态打开文件自动展开（collapsed 下移到 hook 层 use-preview-collapsed.ts） |
| 508a42192 | use-preview-tabs 超行抽离（collapsed → use-preview-collapsed.ts） |
| 7d4d36bf8 | 视觉打磨：tab 分隔感 + 悬浮按钮方形圆角竖排图标 |
| b9f05385a | tab 区 Tab 键循环切换（Tab 下一个/Shift+Tab 上一个/守卫拦截） |
| 4049fa672 | 悬浮按钮图标修正（feather stroke：Pencil/Save/Undo/Align/CheckSquare，新增 preview-icons.tsx） |

## §3 实现核对（doc-modifier 阶段 5）

| 实现文件 | 与 spec 一致性 |
|---|---|
| `component-preview-floating-actions.tsx`（新建 134 行） | ✅ 4 态按钮（只读 1 个 / 编辑 4 个）+ group-hover 显隐 + 方形圆角竖排 |
| `component-preview-collapse-toggle.tsx`（新建 80 行） | ✅ VSCode 风格竖长条手柄 + 两形态（floating true/false）+ 箭头方向正确 |
| `preview-icons.tsx`（新建 75 行） | ✅ 5 个 feather stroke 图标（Pencil/Save/Undo/Align/CheckSquare）|
| `use-preview-collapsed.ts`（新建 44 行） | ✅ collapsed hook + per session localStorage + openTab/activateTab 自动展开 |
| `section-preview-area.tsx`（修改） | ✅ 删顶栏 + 悬浮按钮挂载 + collapsed 从 context + 单分隔条 + 收起守卫 modal |
| `component-preview-tab-bar.tsx`（修改） | ✅ Tab 键循环 + tab 分隔感 border + chevron 溢出才渲染 |
| `component-preview-editor.tsx`（修改） | ✅ forwardRef + useImperativeHandle（save/format/validate）+ 按钮行退役 |
| `component-preview-viewer.tsx`（修改） | ✅ 顶栏退役 |
| `use-preview-tabs.ts`（修改） | ✅ collapsed 从 use-preview-collapsed 接入 |

## §4 退役组件清单

| 组件/元素 | 退役原因 | 处理 |
|-----------|----------|------|
| `pv-resize-right` | 与工作区手柄争同一条缝导致拖拽 bug | 删除（单分隔条 pv-resize-left only） |
| viewer/editor 顶栏按钮行 | 悬浮按钮替代 | 删除（操作移到 component-preview-floating-actions） |
| 旧 chevron rail（`.pv-rail` 36px） | VSCode 风格竖条手柄替代 | 删除（改 component-preview-collapse-toggle） |
| TabBar 内 `pv-collapse` 按钮 | 收起手柄独立组件 | 删除（收起操作移到 collapse-toggle） |

## §5 i18n 同步

第三批新增 key（zh-CN + en）：
- `workspace.preview.undo`（撤销）
- `workspace.preview.format`（格式化）/ `validate`（校验）/ `formatFail` / `validateFail` / `validateFailLine` / `validateOk`
