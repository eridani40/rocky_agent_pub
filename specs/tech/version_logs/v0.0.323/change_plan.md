# v0.0.323 变更计划书 — 预览区操作按钮 → 悬浮胶囊容器

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **v2 修订**（2026-08-11 老板变更）：格式化/校验不移编辑器，5 个按钮全留胶囊；props 不变；编辑态顺序 保存→撤销→格式化→校验；加 tooltip；2 个图标替换（edit-2 + check-circle）。

## 需求摘要

预览区正文区悬浮按钮从「散落按钮 hover 才现」改成「带背景边框的竖排胶囊容器，常驻显示」。5 个按钮全留胶囊（编辑/保存/撤销/格式化/校验），props 不变。编辑态按钮顺序改为 保存→撤销→格式化→校验。每个按钮加 title tooltip。2 个图标替换：编辑 PencilIcon→edit-2（方框笔）/ 校验 CheckSquareIcon→check-circle（圆勾）。

**不改**：编辑守卫/撤销/保存/dirty/409 任何业务逻辑；chat-float-menu 本体；editor ref 接口；预览区其他部分（tab/收起手柄/分隔条）；props；editor；section-preview-area 调用处。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径（相对项目根） |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 / 不变 |
| 变更内容 | 具体做什么（禁模糊描述） |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 |
| 预计影响行 | +N / -M |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-preview | app/web/src/components/chat-page/component-preview-floating-actions.tsx | ICON_BTN 常量 | 修改 | 去掉按钮自带 `bg-surface border border-border shadow-sm`，改为 chat-float-menu 同款：`flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-bg-warm hover:text-fg shrink-0` | MUST：参照 chat-float-menu L96；MUST NOT：不留按钮自带 border/bg | PRD §5.2; chat-float-menu L96 | ±3 |
| ui-preview | app/web/src/components/chat-page/component-preview-floating-actions.tsx | ICON_BTN_PRIMARY 常量 | 修改 | 保存按钮改为：`flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white transition-colors hover:bg-accent-hover shrink-0 disabled:opacity-50 disabled:cursor-not-allowed`（去 border/shadow，保留 primary 色） | MUST：primary 色嵌入容器 gap 不破坏容器边界 | PRD §5.2 | ±3 |
| ui-preview | app/web/src/components/chat-page/component-preview-floating-actions.tsx | 外层容器 div className | 修改 | ①加容器背景：`flex flex-col gap-1 rounded-xl border border-border bg-surface p-1 shadow-sm pointer-events-auto`（参照 chat-float-menu L88）；②删 `opacity-0 group-hover/pv-content:opacity-100 transition-opacity`（改为常驻）；③保留 `absolute right-3 top-4 z-[5]` | MUST：参照 chat-float-menu L88；MUST NOT：不依赖 group-hover | PRD §2.1+§2.4; chat-float-menu L88 | ±2 |
| ui-preview | app/web/src/components/chat-page/component-preview-floating-actions.tsx | 编辑态按钮顺序 JSX | 修改 | 编辑态（mode==='edit'）按钮顺序改为：①保存（pv-float-save）→ ②撤销（pv-float-undo）→ ③格式化（pv-float-format，isStructured 条件）→ ④校验（pv-float-validate，isStructured 条件）。当前代码顺序是 格式化→校验→撤销→保存，需重排为 保存→撤销→格式化→校验 | MUST：保存置顶→撤销→格式化/校验；MUST：格式化/校验条件渲染不变（isStructured && 包裹） | PRD §2.3 | ±10 |
| ui-preview | app/web/src/components/chat-page/component-preview-floating-actions.tsx | 按钮图标 size | 修改 | 全部按钮图标 size 统一改 16（当前 edit=15/save=15/undo=15/format=14/validate=14 混用） | MUST：对齐 chat-float-menu size=16 | PRD §5.2 | ±5 |
| ui-preview | app/web/src/components/chat-page/component-preview-floating-actions.tsx | tooltip（title+aria-label） | 不变 | 确认每个按钮已有 `title` + `aria-label` = `t('workspace.preview.xxx')`（当前代码已有）；保存中 title 改 `t('workspace.preview.saving')`（当前已有三元） | MUST：保留现有 title/aria-label 不删；MUST NOT：不加额外 tooltip 组件 | PRD §2.5 | 0 |
| ui-preview | app/web/src/components/chat-page/component-preview-floating-actions.tsx | FloatingActionsProps | 不变 | Props 完全不变（mode/saving/isStructured/onEdit/onSave/onUndo/onFormat/onValidate），与 v0.0.320 一致 | MUST NOT：不改 props | PRD §6.1 | 0 |
| ui-icons | app/web/src/components/chat-page/preview-icons.tsx | PencilIcon | 修改 | 编辑图标 SVG path 替换为 feather **edit-2**（方框笔）：`<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>`。组件名保留 `PencilIcon` 不改（消费方不改），仅替换 SVG path 内容；注释更新为「edit-2 方框笔」 | MUST：新 path = feather edit-2；MUST NOT：不改组件名（避免连锁改 import）；MUST：保持 base() stroke 风格不变 | PRD §2.6; feather edit-2 | ±4 |
| ui-icons | app/web/src/components/chat-page/preview-icons.tsx | CheckSquareIcon | 修改 | 校验图标 SVG path 替换为 feather **check-circle**（圆勾）：`<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/>`。组件名保留 `CheckSquareIcon` 不改（消费方不改），仅替换 SVG path 内容；注释更新为「check-circle 圆勾」 | MUST：新 path = feather check-circle；MUST NOT：不改组件名；MUST：保持 base() stroke 风格不变 | PRD §2.6; feather check-circle | ±3 |
| ui-preview | app/web/src/components/chat-page/component-preview-editor.tsx | （无变更） | 不变 | editor 不改。格式化/校验留胶囊容器（通过 ref 调 editorRef.format()/validate()），editor 内部 useImperativeHandle 不变 | MUST NOT：不改 editor | PRD §6+§11 | 0 |
| ui-preview | app/web/src/components/chat-page/section-preview-area.tsx | ComponentPreviewFloatingActions 调用处 | 不变 | props 传参完全不变（mode/saving/isStructured/onEdit/onSave/onUndo/onFormat/onValidate 全保留） | MUST NOT：不改传参 | PRD §6.2 | 0 |

## 影响面评估

### 跨模块影响
- **仅 2 个文件**有实际代码变更：
  - `component-preview-floating-actions.tsx` — 容器化 + 常驻 + 按钮顺序重排 + 图标 size 统一
  - `preview-icons.tsx` — 2 个图标 path 替换（edit-2 + check-circle）
- `component-preview-editor.tsx` — **不改**（格式化/校验留胶囊）
- `section-preview-area.tsx` — **不改**（props 不变）

### 无破坏性变更
- Props 接口完全不变（FloatingActionsProps 与 v0.0.320 一致）
- editor ref 接口不变（PreviewEditorHandle 不动）
- 组件名不变（PencilIcon/CheckSquareIcon 只换 SVG path，不改 export 名 → 零消费方连锁）
- 无新增 i18n key
- 业务逻辑零改（编辑/保存/撤销/dirty/409 全不动）

### 依赖顺序
- preview-icons.tsx（底层图标）和 floating-actions.tsx（上层消费）无编译依赖（组件名不变），可同 task 一起改

### 风险点
- **低风险**：纯 UI 视觉 + 按钮顺序调整 + 2 个 SVG path 替换
- 注意：按钮顺序重排时不要误删格式化/校验的 `isStructured &&` 条件包裹

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
