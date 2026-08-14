# section-preview-area（文件预览区 — 三栏布局中间栏 + 多 tab 预览 + 编辑 + 冲突检测）

> 层级: section（chat-page/，含 provider / hook / tab-bar / viewer / editor / modal / floating-actions / collapse-toggle / icons 子件）
> 文件: app/web/src/components/chat-page/section-preview-area.tsx + preview-area-provider.tsx + preview-area-context.ts + use-preview-tabs.ts + use-preview-collapsed.ts + preview-tabs-types.ts + preview-tabs-io.ts + component-preview-tab-bar.tsx + component-preview-viewer.tsx + component-preview-editor.tsx + component-preview-dirty-modal.tsx + component-preview-conflict-modal.tsx + component-preview-floating-actions.tsx + component-preview-collapse-toggle.tsx + preview-icons.tsx
> 技术权威: specs/tech/version_logs/v0.0.320/change_plan.md（D1-D15）+ specs/tech/version_logs/v0.0.320/change_log.md
> 数据契约: specs/api/overall/04-agent-session.md §2.6.7（GET file 带 version / POST save expectedVersion·force / 409 conflict）+ §2.6.8（GET search）
> since: v0.0.320

## 1. 定位 + 设计意图（一句话）

在 chat 与 ws-panel 之间新增**文件预览区**（独立中间栏，三栏布局 chat | 预览 | 工作区）：workspace 文件树与 chat 链接点文件都进预览区开 tab（多 tab 横滑 + × 关闭），支持内嵌查看/编辑 + dirty 守卫 + 409 冲突检测；**弹层退役**（chat 场景 component-ws-file-editor / component-chat-link-viewer 删除，component-modal-md-editor 仅保留 academy 场景）。

## 2. 架构（Provider 上移 — Task 3 偏离，leader 已确认）

```
page-chat / component-studio-chat-router（顶层包整行）
└─ <PreviewAreaProvider sessionId={activeSessionId}>   ← usePreviewTabs 单例 + Context.Provider（透明容器，不渲染 DOM）
   ├─ <SectionChatSession>          ← message-stream（兄弟，经 usePreviewArea 消费）
   ├─ <SectionPreviewArea>          ← 容器（受控渲染，从 context 取 tabs/回调）
   └─ <SectionWorkspacePanel>       ← 兄弟，handleOpen onEditor → preview.openTab
```

- **Provider 上移原因**：原 D3 把 Provider 挂 SectionPreviewArea 容器内，但 D7/D12 消费方（SectionWorkspacePanel / ComponentMessageStream）是容器的**兄弟节点**——React Context 只能向下传，兄弟节点 `usePreviewArea()` 永远返 null。上移到 page-chat / studio-chat-router 顶层包整行。
- **M-1 修复（sessionId 对齐）**：Provider 的 sessionId 用 `activeSessionId`（与 SectionPreviewArea/SectionWorkspacePanel 渲染面板对齐）——subagent 激活时（viewedSessionId=sub）右栏仍是 parent workspace 树，若 Provider 用 viewedSessionId 会读错 workspace（readWorkspaceFile(subagent) → 404 error pill）。
- **无 Provider 返 null**：`preview-area-context.ts` 的 `usePreviewArea()` 无 Provider 时返 null——academy section-version-chat 用 SectionWorkspacePanel 无预览区 → 降级 `component-ws-file-editor-fallback`（弹层路径保留，非死代码）。

## 3. 容器（SectionPreviewArea）

### 3.1 Props
```ts
interface SectionPreviewAreaProps {
  sessionId: string;
  renderWidth?: number;   // 父引擎钳制后的渲染宽（优先于内部 width state）
  dragMaxWidth?: number;  // 拖宽动态上限（dragDynMax4，缺省回退静态 PV_WIDTH_MAX）
  onLayoutChange?: (report: { settingWidth: number; collapsed: boolean }) => void;  // 上报设定宽（父回收）
  onDragModeChange?: (dragging: boolean) => void;  // 拖拽模式切换（父 setPreviewDragging）
}
```

### 3.2 状态（localStorage per session）
- `pv-door-<sid>`：**门三态**（v0.0.329，缺省 `'center'`）；`pv-collapsed-<sid>`：旧收起态（兼容保留，迁移/桥接用）；`pv-width-<sid>`：展开宽（clamp [240,1600]，缺省 360）——`readPvDoor` / `writePvDoor` / `readPvCollapsed` / `writePvCollapsed` / `readPvWidth` / `writePvWidth` 导出（对齐 ws-* 模式）。
- **门三态语义**（`use-preview-collapsed.ts` hook 管理，`use-preview-tabs` 一行接入 `{ collapsed, setCollapsed, door, setDoor }`）：
  - `center`（默认）：2/3 共存（chat flex + preview 各自宽）；
  - `right`：门滑最右，preview 被遮、chat 占满门框（= 旧 collapsed=true 路径）；
  - `left`：门滑最左，chat 被遮、preview 占满门框（chatCollapsed 引擎分支）。
- **旧 collapsed 兼容（迁移/桥接，用户无感）**：`collapsed` 派生 = `door !== 'center'`；`setCollapsed(v)` 桥接 `setDoor(v ? 'right' : 'center')`——旧消费方零改。持久化：`pv-door` 缺省时读旧 `pv-collapsed`（`'1'` → `'right'`，坏值兜底 center）；写 door 时同步旧 key（`door !== 'center'` → `'1'`）。
- **sessionId 变化重读门态**（v0.0.329 blocking 修复）：root 挂载 `sid=''` → 点进会话 sid 变化，`usePreviewCollapsed` 内 `useEffect([sessionId])` 重读对应会话持久化门态——切会话恢复各自门位置，不固化为 root 的 center。
- **非居中态打开/切换文件自动回居中**：`openTab`/`activateTab` 成功后 `setCollapsed(false)`（= `setDoor('center')`）。
- **门三态渲染**（`SectionPreviewArea` 从 context 读 `preview.door`）：
  - `right`：预览区完全隐藏（aside 宽=0），仅渲染 `ComponentPreviewCollapseToggle`（`floating={false}`，粗线 rail `pv-collapsed-rail` + ◀ 贴左，点击回居中）——现状收起路径原样；
  - `left`：门框左缘粗线 rail（形态零改，仅摆放左缘）+ ▶ 贴粗线右（`direction="right"`，点击回居中）+ aside 占满门框（无 resizer，不可拖拽调宽——与 right 态 collapsed 行为一致）；
  - `center`：aside 内双把手——细线左 ◀（→ `setDoor('left')`）+ 细线右 ▶（→ `handleCollapseClick` 走 edit 守卫）。
- **onLayoutChange 上报**：`collapsed: door === 'right'`（left/center 均 false——left 态 preview 实际显示，preview 槽显隐由引擎 chatCollapsed 决定）。
- 展开态 → `<aside class="pv-panel">`：
  - **单分隔条 `.pv-resize-left`**（[老板第三批] 删 `pv-resize-right`——与工作区手柄争同一条缝导致拖拽 bug，预览宽度只由左缘控制；`posSide='left'` 贴预览左缘，拖右变宽）。复用 `component-col-resize-handle`（v0.0.320 加 `posSide` prop）。
  - **收起手柄** `ComponentPreviewCollapseToggle`（`floating={true}`，贴 aside 左缘竖线垂直居中 → 向右收掉）。
  - onResizeEnd → `writePvWidth` + `onDragModeChange?.(false)`。

### 3.3 内容区（pv-content，空态/loading/error/viewer/editor 五态 + 悬浮按钮）
- 无 activeTab → 空态占位 `pv-empty`（「打开文件以预览」类文案，布局稳定不消失）。
- `loadState==='loading'` → spinner `pv-loading`。
- `loadState==='error'` → error 文案 + 重试按钮 `pv-error-retry`（调 retryLoad）。
- `mode==='edit'` → ComponentPreviewEditor；否则 → ComponentPreviewViewer。
- **悬浮操作按钮**（[老板第三批②] + [v0.0.323 胶囊化] `ComponentPreviewFloatingActions`）：`activeTab && loadState==='loaded'` 时渲染在正文区右侧偏上（`absolute right-3 top-4`）；**常驻显示**（胶囊容器自带背景/边框/阴影，不再依赖 hover 显隐）。
- dirty modal / conflict modal 从 context pending 渲染（`pv-dirty-modal` / `pv-conflict-modal`）。

## 4. tab 状态机（use-preview-tabs + preview-tabs-types + preview-tabs-io）

> **tabs 纯内存、跨会话共享、不持久化**（老板确认语义）：打开的文件 tabs 在 Provider 生命周期内跨会话共享（切会话不重建）；**刷新/重启后清空**——与门态 `pv-door-<sid>`（持久化，刷新恢复）形成对比。sessionId 仅用于 workspace 源 HTTP 读写。

### 4.1 PreviewTab
```ts
interface PreviewTab {
  id: string;              // `${source}:${path}` 唯一
  path: string; fileName: string; subtitle: string;
  source: 'workspace' | 'absolute';
  format: FileFormat;      // makeTab 缺省 'txt'
  version: string;         // workspace 源后端 version；absolute 源 ''（v1 无冲突检测）
  mode: 'view' | 'edit'; dirty: boolean;
  content: string; draft: string;
  loadState: 'idle' | 'loading' | 'loaded' | 'error';
  errorMsg?: string;
}
```

### 4.2 打开（openTab）
- 同 id 已存在 → activate；不存在 → 新建 + activate + 异步 load（`readFileContent`：workspace → HTTP `readWorkspaceFile` 带 version / absolute → IPC `readFileText` version=''）。
- **dirty 守卫（ET-fix 修复3 覆盖 open）**：当前 tab dirty 且目标不同 → `dirtyPending { action:'open', pendingOpen: target }`（确认后执行完整 openTab 语义：新建+load）。
- 递增 reqId 屏蔽过期响应（快速切换时旧请求不覆盖新值）。

### 4.3 切换/关闭（activateTab / closeTab）
- activateTab：当前 dirty 且目标不同 → dirtyPending（action='activate'）；否则直切。
- closeTab：目标 dirty → dirtyPending（action='close'）；否则 `closeTabDirect`（焦点左移 `neighborId`：左邻居优先，无左 → 右邻居，无相邻 → null 空态）。

### 4.4 保存（saveTab / saveTabContent）
- workspace 源：body 带 `expectedVersion`（tab.version 非空时）→ 409 → `conflictPending { tabId, currentVersion }`（不切/关）；成功 → 更新 content/draft/version + 回 view + dirty=false（**ET-fix BLOCKING2：draft 同步为已保存内容**，防旧草稿残留）。
- absolute 源：`writeFileText` IPC（last-write-wins，无版本校验）。

### 4.5 dirty 守卫确认（resolveDirty 三选）
- `save-switch`：保存成功才执行原操作（409 → 冲突 modal 挂起不切换）；`discard`：放弃 → 回 view + **draft 重置为 content**（文件最新内容，ET-fix BLOCKING2）+ 执行原操作；`cancel`：取消（pending 清空，停留原 tab）。

### 4.6 冲突确认（resolveConflict 两选）
- `reload`：以服务端 currentVersion 重读（loadTab 丢弃 draft）；`overwrite`：force 重发（跳过冲突检测，last-write-wins 覆盖）。

## 5. 子组件

### 5.1 component-preview-tab-bar（TabBar）
- tabs 横排（fileName + dirty ● + × 关闭）；横滑容器（overflow-x-auto + scroll-smooth + 隐藏滚动条）。
- 左右 chevron（`pv-tabbar-left` / `pv-tabbar-right`，仅溢出才渲染；默认 opacity-0 hover TabBar 显 opacity-100——布局稳定不位移）。
- **[老板第三批] Tab 键循环切换**：焦点在 tab 区（`pv-tabbar-scroll`，`tabIndex={0}`）时按 Tab = 循环切下一个 / Shift+Tab = 反向；首尾循环 `(curIdx + dir + len) % len`；`e.preventDefault()` 阻止焦点移走；复用 `onActivate` 走编辑态守卫（mode='edit' 弹守卫 modal）；<2 个 tab 时不响应。
- **[老板第三批视觉] tab 分隔感**：tab 区 `border-b border-border` + 每个tab `border border-border rounded-md`（active `border-accent`）。
- testid：`pv-tab-{id}` / `pv-tab-dirty-{id}` / `pv-tab-close-{id}` / `pv-tabbar-scroll`（id 非字母数字替换为 `-`）。

### 5.2 component-preview-viewer（view 模式，内嵌非弹层）
- **[老板第三批] 顶栏退役**：旧「文件路径副标题 + 编辑按钮」顶栏行删除（信息由 tab subtitle 提供，编辑操作移到悬浮按钮）。
- view 分流（复用 modal-md-editor 同款逻辑但非弹层内嵌）：`getCategory(tab.format)`：
  - `md` → PrimitiveMarkdownView（baseDir=deriveBaseDir(tab.path) + sessionId，相对图片 resolve）；
  - `structured` / `plain` / `code` → `<pre>` 朴素渲染（无高亮无行号，**code 分类 = plain 行为**，无格式/校验按钮）。
- testid：`pv-viewer`。

### 5.3 component-preview-editor（edit 模式，内嵌非弹层）
- textarea 全宽（mono 13px，内容自适应高度复用 modal-md-editor useLayoutEffect 逻辑）。
- **[老板第三批] 旧保存/取消按钮行退役**→ 操作移到悬浮按钮（`ComponentPreviewFloatingActions`），通过 `useImperativeHandle` + `forwardRef` 暴露 `save()` / `format()` / `validate()` 给容器（容器组装悬浮按钮回调）。
- **格式化/校验**（structured 格式）：`formatText(tab.format, draft)` → 格式化 draft；`validateText(tab.format, draft)` → 校验结果显示（`validateOk` / `validateFailLine` / `validateFail`）。
- 保存失败 → 错误条 `pv-editor-error`（textarea 保留供重试，留在 edit）。
- testid：`pv-editor` / `pv-editor-textarea`。

### 5.4 component-preview-dirty-modal（dirty 守卫 L3 modal）
- 三选：保存并切换（`pv-dirty-save`）/ 放弃修改（`pv-dirty-discard`）/ 取消（`pv-dirty-cancel`）；遮罩点击 = 取消。
- **ET-fix BLOCKING1：标题 + aria-label 带 {{name}} 插值**（`t('workspace.preview.dirtyTitle', { name: fileName })`，原实现漏传参渲染字面量）。
- testid：`pv-dirty-modal`。

### 5.5 component-preview-conflict-modal（409 冲突 L3 modal）
- 两选：取消=reload（`pv-conflict-reload`）/ 覆盖=force（`pv-conflict-overwrite`）；遮罩点击 = reload（取消语义）。
- testid：`pv-conflict-modal`。

### 5.6 component-preview-floating-actions（正文区悬浮操作胶囊容器，[老板第三批②] + [v0.0.323 胶囊化]）

**文件**：`component-preview-floating-actions.tsx`（受控组件，props 由 `SectionPreviewArea` 传入）。

- **位置/显隐**：正文区（pv-content）最右侧偏上（`absolute right-3 top-4 z-[5]`）；**常驻显示**（v0.0.323 起不再 group-hover 显隐）。
- **容器样式**：悬浮胶囊——`flex flex-col gap-1 rounded-xl border border-border bg-surface p-1 shadow-sm`（对齐 component-chat-float-menu 容器）。
- **只读态（mode='view'）**：2 个按钮——①「编辑」（`pv-float-edit`，PencilIcon=feather edit-2，常驻）→ 进编辑态；②「浏览器打开」（`pv-float-open-browser`，GlobeIcon，**仅 isHtml prop 为 true 时渲染**，[v0.0.325]）→ `onOpenInBrowser` 用系统浏览器打开当前 html 文件。
- **编辑态（mode='edit'）**：按钮顺序 ①保存（`pv-float-save`，SaveIcon，primary 色 `bg-accent`，`saving` disabled + title=保存中…）→ ②撤销（`pv-float-undo`，UndoIcon，放弃修改回只读）→ ③格式化（`pv-float-format`，AlignIcon，仅 structured）→ ④校验（`pv-float-validate`，CheckSquareIcon=feather check-circle，仅 structured）。
- **按钮样式**：容器内图标按钮（`h-8 w-8 rounded-lg text-muted hover:bg-bg-warm hover:text-fg`，对齐 chat-float-menu 按钮）；图标 size 统一 16；每按钮 `title` + `aria-label` tooltip（i18n `workspace.preview.*`）。
- **回调来源**：`onEdit`/`onSave`/`onUndo`/`onFormat`/`onValidate` 由容器组装——save/format/validate 走 editor ref（`useImperativeHandle` 暴露）。
- testid：`pv-floating-actions`。

### 5.7 component-preview-collapse-toggle（收起/展开竖条手柄，[老板第三批③] + [v0.0.329 门模型]）

**文件**：`component-preview-collapse-toggle.tsx`。

- **VSCode 风格竖长条手柄**（`w-[8px] h-[44px] rounded-full`——v0.0.329 视觉微调水平加粗 20%：7→8px），垂直居中（`top-1/2 -translate-y-1/2`），贴分隔线边缘（`-left-[8px]`，偏移=handle 宽同步）；hover `bg-accent text-white`。
- **两种形态**：
  - `floating={false}`（收起态/门非居中态）：独立粗条（`pv-collapsed-rail`）作为预览区唯一渲染物（aside 隐藏）——**[v0.0.329 视觉修复·方案 A 老板验收] 完整粗条：本体 `bg-bg-warm`（深一档，与 preview bg-surface 拉开，不再被吞）+ 左右双 border（`border-l-[2px] border-r-[2px]`），hover 升 `surface-3`**；`w-[7px]`（v0.0.329 视觉微调 6→7px）；手柄保持 `bg-surface` 白底（对比深色 rail 更清晰）。
  - `floating={true}`（展开态/门居中态）：悬浮在 aside 左缘竖线上，手柄 → 向右收掉（`pv-collapse-collapse`）。
- **箭头方向**（commit 41bb36296 修正）：展开态 → 收起（ChevronRight）/ 收起态 ← 展开（ChevronLeft）。
- **[v0.0.329 门模型可选 prop]**（形态零改，仅 chevron 方向 + 贴线侧 + tooltip/testid 覆盖；缺省 undefined = 现行为）：
  - `direction?: 'left' | 'right'`：'right' → chevron ▶、贴线右侧（floating→`left-0` / rail→`-right-[8px]`）；'left' → chevron ◀、贴线左侧（`-left-[8px]`）。center 态需「细线左◀」+「细线右▶」、left 态需「粗线右▶」——现有 floating/collapsed 组合凑不出，故加 prop 显式覆盖。
  - `tooltipKey?: string`：door 三态 tooltip（doorLeft/doorRight/doorCenter）覆盖，缺省按 collapsed 用 expand/collapse。
  - `testid?: string`：center 态双把手锚点区分（door 三态渲染用 `pv-door-center` 等），缺省现行为。
- **把手位置铁律**（v0.0.329 PRD §2.3，MANDATORY）：左把手永远贴线左侧、右把手永远贴线右侧；任何状态下不允许把手跑到线的异侧。
- testid：`pv-collapsed-rail` / `pv-collapse-expand` / `pv-collapse-collapse` / `pv-door-center`。

### 5.8 preview-icons（预览区图标族，commit 4049fa672）

**文件**：`preview-icons.tsx`（从 `icons.tsx` 抽离控行数）。

feather stroke 风格（`strokeWidth=2, strokeLinecap='round'`），6 个图标供悬浮按钮使用：

| 图标组件 | 语义 | 悬浮按钮 | feather 原型 |
|----------|------|----------|-------------|
| `PencilIcon` | 编辑 | pv-float-edit | edit-2（方框笔，v0.0.323 起替换 pencil，组件名不改） |
| `SaveIcon` | 保存 | pv-float-save | save（软盘） |
| `UndoIcon` | 撤销 | pv-float-undo | corner-up-left（回旋箭头） |
| `AlignIcon` | 格式化 | pv-float-format | align-left |
| `CheckSquareIcon` | 校验 | pv-float-validate | check-circle（圆勾，v0.0.323 起替换 check-square，组件名不改） |
| `GlobeIcon` | 浏览器打开 | pv-float-open-browser | globe（[v0.0.325] 新增） |

## 6. 范式归属（老板铁律：逐控件过范式）

| 控件/操作 | 范式 |
|-----------|------|
| 预览区 tab 打开/切换/关闭 | 即时操作（无 SaveBar） |
| Tab 键循环切换 tab | 即时操作（复用 activateTab 走守卫，[老板第三批]） |
| 编辑保存 / 格式化 / 校验 / 撤销 | 即时操作（悬浮按钮直接落盘/操作，无 autosave，[老板第三批]） |
| dirty 守卫（切/关/开新 tab / 收起） | L3 确认 modal（保存并切换/放弃/取消） |
| 冲突检测（409） | L3 确认 modal（取消=重载/覆盖=force） |
| 预览区显隐 + 宽度 | 即时操作（竖条手柄 + 拖拽手柄）+ 收起态打开文件自动展开 |
| 搜索框 | 直接输入 + 防抖（无提交语义） |

**结论**：预览区所有控件走「即时操作 / 确认 modal / 拖拽手柄」三类范式，**不引入 SaveBar**（预览区不是配置面板；dirty 守卫已有 modal 确认闭环）。

## 7. 消费方

- `page-chat.tsx`（playground）：`<PreviewAreaProvider sessionId={activeSessionId ?? ''}>` 顶层包整行；`<SectionPreviewArea>` 在 SectionChatSession 之后、SectionWorkspacePanel 之前。
- `component-studio-chat-router.tsx`（studio 单聊/群聊）：同模式挂载。
- 消费 preview 上下文的兄弟节点：`section-workspace-panel.tsx`（onEditor → preview.openTab）、`component-message-stream.tsx`（chat 链接 onLocalViewer → openLocalPath → preview.openTab）。
- **无 Provider 降级**：academy section-version-chat（SectionWorkspacePanel 无预览区）→ onEditor 降级 `component-ws-file-editor-fallback`（弹层）；chat 链接无 Provider → 系统打开（openWorkspaceItem / openPath）。

## 8. i18n

`workspace.preview.*` 命名空间双语（zh-CN + en）：empty / edit / save / saving / cancel / **undo（[老板第三批] 撤销）** / closeTab / collapse / expand / tabLeft / tabRight / dirtyTitle / dirtyBody / dirtySaveSwitch / dirtyDiscard / dirtyCancel / conflictTitle / conflictBody / conflictReload / conflictOverwrite / loading / openFail / retry / saveFail / **format（格式化）/ validate（校验）/ formatFail / validateFail / validateFailLine / validateOk（[老板第三批] structured 格式化校验）** / searchPlaceholder / searchTooMany / searchNoResults / searchClear / resize.ariaLabel / resize.title / **openInBrowser（浏览器打开 / Open in Browser，[v0.0.325] html 预览态浏览器打开按钮）** / **doorLeft（文档区占满·门滑至左）/ doorRight（对话区占满·门滑至右）/ doorCenter（恢复分栏·门回居中）（[v0.0.329] 门三态 tooltip）**。

## 9. 视觉基线

- 面板：`bg-surface + border-l border-border`（与 ws-panel 同款）；内容区 flex-col。
- TabBar：tab 12px `border rounded-md`（[老板第三批] 分隔感）；active `bg-accent text-white border-accent` / 非 active `text-muted border-border hover:bg-bg-warm`；dirty ● 6px 圆点（`w-1.5 h-1.5`）；fileName max-w 160px ellipsis。
- viewer：**[老板第三批] 无顶栏**（旧副标题+编辑按钮行删除）；md 内容 13.5px/1.75；pre 内容 mono 13px/1.7。
- editor：textarea mono 13px/1.7 `bg-surface`；**[老板第三批] 无按钮行**（操作移到悬浮按钮）。
- **悬浮按钮**（[v0.0.323 胶囊化]）：悬浮胶囊容器常驻显示（`rounded-xl border bg-surface p-1 shadow-sm`），容器内图标按钮 `h-8 w-8 rounded-lg`，图标 size 统一 16（§5.6）；feather stroke 图标（§5.8）。
- **收起手柄 / 门把手**（[老板第三批视觉] + [v0.0.329 视觉微调老板验收]）：VSCode 风格竖长条胶囊（`w-[8px] h-[44px] rounded-full`），垂直居中贴分隔线；贴线偏移 8px（`-left-[8px]` / `-right-[8px]`，= handle 宽同步，消除 1px 重叠）。
- **粗线 rail**（[v0.0.329 视觉修复·方案 A 老板验收]）：`w-[7px] bg-bg-warm`（深一档，与 preview bg-surface 拉开）+ 左右双 border（`border-l-[2px] border-r-[2px]`），hover `bg-surface-3`；handle 保持 `bg-surface` 白底（对比深色 rail 更清晰）。
- modal：440px / max-w 92vw / rounded-xl / shadow-lg（对齐 modal-md-editor 壳）；遮罩 `rgba(10,10,10,.4)`。
- **[老板第三批] 退役**：旧 36px chevron rail（`pv-rail`）→ 竖条手柄（§5.7）；`pv-resize-right` 删除（拖拽 bug 修复，单分隔条 `pv-resize-left` only）。

## 10. 边界

- **image 不进预览区**：6 格式图片仍走 `component-ws-image-viewer` 弹层（openLocalPath onImageViewer 分支，v0.0.269 语义保留）。
- **[v0.0.339] csv/tsv 与 >5MB 文本不进预览区**：`openLocalPath` 分流升级——`csv`/`tsv` **无条件系统打开**（不 stat、不内置，任何大小）；其余内置文本（12 格式 + code）stat 大小判定（workspace→`GET /workspace/stat?path=` / absolute→`rockyShell.stat`，`TEXT_OVER_SIZE_BYTES = 5MB`，`>5MB` → 系统打开 / `≤5MB` → 内置 tab；stat 失败 undefined 降级内置）；**图片不 stat**（无大小限制）。系统打开复用 openWorkspaceItem/openPath（无新机制）。
- **absolute IPC 源 v1 无冲突检测**（version=''，last-write-wins；IPC 层零改）。
- **code 分类无高亮**：编程语言后缀 → 'code' → 行为 = plain（pre 渲染，无格式化/校验按钮）。
