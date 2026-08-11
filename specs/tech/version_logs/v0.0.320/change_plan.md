# v0.0.320 变更计划书 — 文件预览区（三栏布局 + 多 tab 预览 + 编辑 + 冲突检测）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD 权威：`specs/prd/version_logs/v0.0.320-file-preview.md`（已验收通过，老板授权全自动推进）。

## 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| 布局引擎 | **扩展为 4 槽**（left/chat/preview/right），preview 可选参数向后兼容 | `lib/layout-width-engine.ts` 现 3 槽（left/middle/right），`computeThreeColLayout` 输入加 `preview?`，preview=null 时旧逻辑不变（旧 UT 全绿） |
| 预览区挂载 | page-chat（playground）+ StudioChatRouter（studio 单聊/群聊） | `page-chat.tsx L74-119` 三栏挂载；`component-studio-chat-router.tsx L66-121` 中+右两槽；均需插入预览区 |
| 弹层退役 | `component-ws-file-editor.tsx`（143 行）+ `component-chat-link-viewer.tsx`（223 行）删除；`component-modal-md-editor`（common，266 行）保留 | ws-file-editor 由 SectionWorkspacePanel L277 挂载；chat-link-viewer 由 message-stream L34/350 挂载 + L189 Provider |
| ChatLinkHandlerContext | 保留改造，Provider 上移注入预览区上下文 | `chat-link-handler-context.ts` 32 行（Context + useChatLinkHandler）；`ChatLinkHandlerProvider` 组件在 component-chat-link-viewer.tsx L219（随删除迁移） |
| 降级弹层 | academy `section-version-chat.tsx L159` `<SectionWorkspacePanel sessionId/>` 无 Provider → 需降级路径 | academy 不用 ComponentMessageStream（grep 无引用），仅共享 SectionWorkspacePanel |
| file-format | `lib/file-format.ts` 194 行，FileFormat 12 形态 + EXT_TO_FORMAT + getCategory；**加 'code' 后 component-modal-md-editor 零改动自动支持** | modal L73 `getCategory` + L204 `category==='md'?md:pre` + L236 `category!=='structured'?invisible` —— 'code' 落 pre 分支 + 无格式按钮 ✅ |
| 路由 | `router-helpers.ts L101` workspace alternation 加 `search`；`session-routes.ts L134-166` workspace 分发组加分支 | matchSessionPath 正则 `/workspace\/(file\/save|tree|open|pick-directory|watch|watch-set|unwatch|save-image|file)$/` |
| 后端 file handler | `session-workspace-file.ts` 144 行（read L58 / save L103）——read 加 version、save 加 expectedVersion/force/409 | handler 已用 `whitelistResolve`；save 现 L138 `writeFileSync` last-write-wins |
| 搜索 handler | 新文件 `session-workspace-search.ts`（session-workspace.ts 已 282 行近 300 上限，参照 session-workspace-file.ts 拆文件先例） | IGNORED_NAMES（node_modules/.git）在 session-workspace.ts L40 定义需复用/迁移 |
| 拖拽手柄 | `component-col-resize-handle.tsx` 125 行——side 同时决定 delta 方向与贴缘；**预览左条需贴左缘但 delta 正比 → 加 posSide 可选 prop** | side='left'（贴右缘+正比）/ side='right'（贴左缘+反比）；预览左条=贴左缘+正比，预览右条=贴右缘+反比 |
| useThreeColLayout | `use-three-col-layout.ts` 179 行——加 preview 槽位（state + report + renderWidth + dragMax） | ws-panel 模式（rightReport/rightRenderWidth/rightDragMaxWidth）原样复制 preview 版 |

## 设计决策（D 编号）

### D1: 布局引擎 4 槽扩展 — layout-width-engine.ts

**文件**：`app/web/src/lib/layout-width-engine.ts`（修改）

**变更**：
- 常量新增：
  - `CHAT_WIDTH_MIN = 320`（chat 保底下限，PRD §2.1）
  - `PV_WIDTH_MIN = 240`（预览区展开下限，PRD §2.1）
  - `PV_WIDTH_MAX = 1600`（预览区静态上限 = 近全屏语义，动态由引擎钳制）
  - `PV_WIDTH_DEFAULT = 360`（预览区默认展开宽）
  - `WS_WIDTH_MAX: 560 → 1600`（工作区上限扩展「近全屏」，PRD §2.1 明确）
  - `MIDDLE_MIN = 480` / `MIDDLE_COMFORT = 932` 保留（preview=null 旧路径）
- 新类型 `PreviewSlotInput { setting: number; collapsed: boolean }`（同 RightSlotInput）
- `ThreeColLayoutInput` 加可选 `preview?: PreviewSlotInput | null`（缺省 null = 旧 3 槽路径）
- `DragSide` 扩展 `'left' | 'preview' | 'right' | null`
- `computeThreeColLayout`：
  - preview=null → **旧逻辑一字不动**（保留 cDefend/场景 A/B/横滚全语义，旧 UT 全绿）
  - preview 非 null → 4 槽解析：
    - 槽序：left(conv 可选) | chat(剩余) | preview(可选) | right(ws 可选)
    - 场景 B：先 right → preview → left，chat = available − 三者（chat 无设定宽，不持久化）
    - 场景 A（dragging）：被拖槽 clamp(setting, dynMax)，其余槽 hold 上一帧渲染宽
      - `dragging='left'`：hold previewCurrent + rightCurrent；dynLeft = available − preview − right − CHAT_WIDTH_MIN
      - `dragging='preview'`：hold leftCurrent + rightCurrent；dynPreview = available − left − right − CHAT_WIDTH_MIN
      - `dragging='right'`：hold leftCurrent + previewCurrent；dynRight = available − left − preview − CHAT_WIDTH_MIN
    - 保底链：preview 展开 ≥ PV_WIDTH_MIN，chat ≥ CHAT_WIDTH_MIN，right ≥ WS_WIDTH_MIN，left ≥ CONV_WIDTH_MIN
    - 全触底仍不足 → chat 守 CHAT_WIDTH_MIN + scrollX = true（横滚兜底，minRowWidth = left + CHAT_MIN + preview + right）
    - preview.collapsed=true → previewWidth = 0（完全隐藏，两侧自动扩展回收）
- 新增 `dragDynMax4(available, others: number[], minChat: number)` 纯函数（4 槽场景动态上限唯一公式，禁第二份）

**约束**：MUST preview=null 时输出与旧版逐字段相等（回归保护）；MUST chat 无设定宽（宽度=剩余，不持久化）；MUST 保底顺序 right→preview→left→chat；MUST WS_WIDTH_MAX 由 560 改 1600（PRD 明确近全屏）。

### D2: 布局 hook 扩展 — use-three-col-layout.ts

**文件**：`app/web/src/components/chat-page/use-three-col-layout.ts`（修改）

**变更**：
- 新增 `previewReport` state（`{settingWidth, collapsed} | null`，缺省 null 首帧用 PV_WIDTH_DEFAULT）
- 新增 `reportPreviewPanel`（SectionPreviewArea onLayoutChange 上报）、`previewRenderWidth`、`previewDragMaxWidth`、`setPreviewDragging`
- 新增 ref：`previewCurrentRef`（每帧回填 previewWidth）
- 返回 4 新字段（reportPreviewPanel / previewRenderWidth / previewDragMaxWidth / setPreviewDragging）

**约束**：MUST 复刻 ws-panel 4 可选 props 模式（renderWidth/dragMaxWidth/onLayoutChange/onDragModeChange）；MUST 用 dragDynMax4 同源公式。

### D3: 预览区容器 + Provider — section-preview-area.tsx + preview-area-context.ts

**文件**：`app/web/src/components/chat-page/section-preview-area.tsx`（新建）+ `preview-area-context.ts`（新建）

**section-preview-area.tsx 功能**：
- Props：`sessionId: string`、`renderWidth?: number`、`dragMaxWidth?: number`、`onLayoutChange?: (report:{settingWidth:number;collapsed:boolean})=>void`、`onDragModeChange?: (dragging:boolean)=>void`
- 内部 state：`collapsed`（readPvCollapsed）/ `width`（readPvWidth 默认 360）/ `tabs: PreviewTab[]` / `activeTabId: string | null` / `searchQuery` 无关
- localStorage per session：`pv-width-<sid>` / `pv-collapsed-<sid>`（writePvWidth/writePvCollapsed）
- 双分隔条：`.pv-resize-left`（ComponentColResizeHandle side='left' posSide='left'，贴预览左缘，拖拽=预览变宽）+ `.pv-resize-right`（side='right'，贴预览右缘，拖拽=预览变宽）
- 渲染：collapsed → 窄栏（36px rail，与 ws-rail 同款 chevron 展开按钮）；展开 → `<aside class="pv-panel">` 含 TabBar + 内容区（空态占位「打开文件以预览」/ viewer / editor）
- **PreviewAreaProvider 挂本容器内**：value = `{ openTab, closeTab, activateTab, tabs, activeTabId, sessionId }`（见 D4）
- 内容区按 activeTab.mode 分流：view → `<ComponentPreviewViewer tab>`；edit → `<ComponentPreviewEditor tab>`

**preview-area-context.ts 功能**：
- `PreviewAreaContext = createContext<PreviewAreaContextValue | null>(null)`
- `PreviewAreaContextValue { openTab(target: OpenLocalTarget): void; closeTab(id: string): void; activateTab(id: string): void; tabs: PreviewTab[]; activeTabId: string | null; sessionId: string }`
- `usePreviewArea()` hook（无 Provider 返 null）

**约束**：MUST 预览区独立渲染容器（非 chat/ws 子模块）；MUST 空态占位栏不消失（布局稳定）；MUST 收起态 36px rail 复用 ws-rail 范式。

### D4: 预览 tab 状态机 + 数据加载 — use-preview-tabs.ts（新建）

**文件**：`app/web/src/components/chat-page/use-preview-tabs.ts`（新建）

**功能**：
- `PreviewTab` 接口（对齐 PRD §3.1）：
  ```ts
  interface PreviewTab {
    id: string;            // `${source}:${path}`
    path: string;
    fileName: string;
    subtitle: string;
    source: 'workspace' | 'absolute';
    format: FileFormat;
    version: string;       // workspace 源后端 version；absolute 源 ''
    mode: 'view' | 'edit';
    dirty: boolean;
    content: string;
    draft: string;
    loadState: 'idle' | 'loading' | 'loaded' | 'error';
    errorMsg?: string;
  }
  ```
- `openTab(target: OpenLocalTarget)`：同 path 已存在 → activate；不存在 → 新建 + activate + 异步 load（workspace→readWorkspaceFile 带 version；absolute→rockyShell.readFileText）
- `closeTab(id)`：dirty 守卫（dirty → 走确认 modal 三选：保存并切换 / 放弃修改 / 取消）；焦点左移（相邻左优先，无相邻 → 空态）
- `activateTab(id)`：dirty 守卫（同 closeTab）
- `saveTab(id)`：workspace → saveWorkspaceFile 带 expectedVersion（409 → 冲突 modal 取消/覆盖）；absolute → writeFileText（last-write-wins）
- `setDraft(id, draft)` / `setMode(id, mode)` / `setDirty(id, dirty)`：编辑态操作
- 冲突处理：保存 409 → `conflictState = { tabId, currentVersion }` → 冲突 modal → 取消=reload / 覆盖=force 重发

**约束**：MUST tab id = `${source}:${path}` 唯一；MUST dirty 守卫拦截所有切/关；MUST 保存成功更新 version + 回 view + dirty=false；MUST 读失败 tab 保留 error pill 可重试；MUST absolute 源 version='' 跳过冲突检测。

### D5: 预览 TabBar — component-preview-tab-bar.tsx（新建）

**文件**：`app/web/src/components/chat-page/component-preview-tab-bar.tsx`（新建）

**功能**：
- 渲染 tabs 横排（fileName + dirty ● + × 关闭）
- 横滑容器（overflow-x-auto + scroll-smooth）；左右 chevron 按钮（有剩余内容显示，点击 scrollBy 一屏，无剩余 opacity/visibility 隐藏不位移）
- active 高亮；点击 tab → activateTab；× → closeTab

**约束**：MUST 按钮显隐用 opacity/visibility 切换（布局稳定不位移，对齐 ws-act 范式）；MUST dirty 圆点 ● 仅 dirty=true 显示。

### D6: 预览 viewer/editor — component-preview-viewer.tsx + component-preview-editor.tsx（新建）

**文件**：`app/web/src/components/chat-page/component-preview-viewer.tsx` + `component-preview-editor.tsx`（新建）

**component-preview-viewer.tsx 功能**：
- Props：`tab: PreviewTab`、`onEdit: ()=>void`
- view 分流（复用 component-modal-md-editor 同款逻辑但**非弹层**内嵌渲染）：
  - category 'md' → `<PrimitiveMarkdownView source={content} baseDir={deriveBaseDir(path)} sessionId={sessionId}/>`
  - 'structured'/'plain'/'code' → `<pre>` 朴素渲染（无高亮无行号）
- 顶部「编辑」按钮（view 模式）+ 文件路径副标题

**component-preview-editor.tsx 功能**：
- Props：`tab: PreviewTab`、`onSave: ()=>void`、`onCancel: ()=>void`
- textarea 全宽编辑（mono 13px）+ 保存 / 取消按钮 + 保存错误显示（textarea 保留供重试）
- 复用 component-modal-md-editor 的 textarea 自适应高度逻辑（useLayoutEffect scrollHeight）

**约束**：MUST code 分类 = plain 行为（pre 渲染 + 无格式/校验按钮）；MUST 编辑模式 = textarea；MUST 保存失败留在 edit 显示错误；MUST NOT 复用 modal（非弹层内嵌）。

### D7: workspace 文件树改造 — section-workspace-panel.tsx + component-ws-file-tree.tsx + component-ws-tree-item.tsx

**文件**：`app/web/src/components/chat-page/section-workspace-panel.tsx` + `component-ws-file-tree.tsx` + `component-ws-tree-item.tsx`（修改）

**变更**：
- `SectionWorkspacePanel.handleOpen`：
  - `usePreviewArea()` 有 Provider → `onEditor: (t) => preview.openTab(t)`；无 Provider → 降级 `setFileEditorTarget`（既有弹层）
  - `onImageViewer` 不变（image 不进预览区，保留 WsImageViewer 弹层）
  - 删除 `ComponentWsFileEditor` 挂载（L277）+ import（退役死代码）
- `ComponentWsFileTree` / `ComponentWsTreeItem`：
  - 文件夹 item 点击 → toggle 展开/收起（与 twisty 同语义，防双发：item onClick 与 twisty onClick 合并处理）
  - 「打开文件夹」hover 按钮保留（onOpen kind=folder → 系统打开，stopPropagation 不触发展开）
  - 文件 item 点击 → onOpen（五路分流不变，消费端已改预览区）

**约束**：MUST 文件夹 item 点击 = toggle 展开（不再系统打开）；MUST「打开文件夹」按钮 stopPropagation + 保留；MUST 无 Provider 降级弹层（academy/studio 兼容）。

### D8: 搜索框 — component-ws-search-box.tsx（新建）+ section-workspace-panel 接线

**文件**：`app/web/src/components/chat-page/component-ws-search-box.tsx`（新建）+ `section-workspace-panel.tsx`（修改）

**功能**：
- 文件树上方搜索框（TabBar 与 PathBar 之间）
- 输入防抖 300ms：
  - 前端过滤：已加载树（tree + childrenCache）文件名 substring 匹配（大小写不敏感）→ 匹配文件全路径
  - 后端补全：`searchWorkspaceFiles(sessionId, {q})` → files[] + dirs[]（递归全量）
  - 合并去重渲染
- 结果项点击：文件 → openTab；文件夹 → 展开/收起（复用 tree toggle）
- 清空（× 或删空）→ 恢复原树

**约束**：MUST 空输入不请求后端；MUST 防抖 300ms；MUST 结果超 200 提示「结果过多」；MUST 搜索态与树态互斥（搜索时渲染结果列表）。

### D9: 后端 file version + save 冲突 — session-workspace-file.ts

**文件**：`app/server/src/handlers/session-workspace-file.ts`（修改）

**变更**：
- `computeFileVersion(absPath)`：`${statSync(absPath).mtimeMs}:${statSync(absPath).size}`（mtimeMs+size 组合）
- `handleWorkspaceFileRead`：响应加 `version: computeFileVersion(absPath)`（binary 分支不加——image 无冲突语义）
- `handleWorkspaceFileSave`：
  - body 解析加 `expectedVersion?: string` + `force?: boolean`
  - 写前：若 `expectedVersion` 存在且非 force → 读当前 version（statSync 后 compute）→ 不匹配 → `409 { error: 'conflict', currentVersion }`
  - 匹配 / force=true / 无 expectedVersion → writeFileSync（last-write-wins 兼容旧调用方）→ `200 { ok: true, version: computeFileVersion(absPath) }`（写后重 stat）

**约束**：MUST 409 响应体 `{error:'conflict', currentVersion}`；MUST 无 expectedVersion 或 force=true 时不校验（向后兼容）；MUST version 格式 `${mtimeMs}:${size}`（PRD §3.3）；MUST binary 分支不加 version。

### D10: 后端搜索端点 — session-workspace-search.ts（新建）+ 路由注册

**文件**：`app/server/src/handlers/session-workspace-search.ts`（新建）+ `app/server/src/routes/router-helpers.ts`（修改）+ `app/server/src/routes/session-routes.ts`（修改）

**功能**：
- `handleWorkspaceSearch(req, method, id, deps)`：
  - GET /session/:id/workspace/search?q=
  - q 缺失/空串 → 400 `{error:'q required'}`
  - 递归遍历 workspaceDir：ignore node_modules/.git（复用 IGNORED_NAMES 语义——从 session-workspace.ts 迁移/导出）
  - 文件名 substring 匹配（大小写不敏感）→ files[]（全路径，相对 workspaceDir）
  - 文件夹名 substring 匹配 → dirs[]（全路径）
  - 上限 200 条（files+dirs 合计），超限截断 + `truncated: true`
  - 白名单校验同 tree（realpath + whitelistResolve 根校验）
- `router-helpers.ts`：workspace alternation 加 `search`
- `session-routes.ts`：加 `workspace_search` 分发分支

**约束**：MUST ignore node_modules/.git；MUST 上限 200 条；MUST q 空 → 400；MUST 返 `{files: string[], dirs: string[], truncated?: boolean}`；MUST 复用 whitelistResolve 安全面。

### D11: file-format 'code' 分类 — lib/file-format.ts

**文件**：`app/web/src/lib/file-format.ts`（修改）

**变更**：
- `FileFormat` union 加 `'code'`
- `FileFormatCategory` 加 `'code'`
- `EXT_TO_FORMAT` 并入编程语言后缀（全部映射 'code'）：py/js/ts/jsx/tsx/java/go/rs/c/cpp/h/hpp/cs/rb/php/swift/kt/sh/vue/svelte/dart/lua/r/pl/scala/groovy/zig/erl/ex/hs/clj + 其它常见语言
- `getCategory('code')` → `'code'`（行为 = plain：pre 渲染无格式按钮）

**约束**：MUST NOT 改 getFileFormat 算法（扩展名查表不变）；MUST `.env` 特殊处理保留；MUST 既有 12 格式映射不变；MUST getCategory default 兜底保留。

### D12: chat 链接 Provider 迁移 — chat-link-handler-context.ts + component-message-stream.tsx

**文件**：`app/web/src/components/chat-page/chat-link-handler-context.ts`（修改）+ `component-message-stream.tsx`（修改）

**变更**：
- `chat-link-handler-context.ts`：
  - `ChatLinkHandlerContextValue.onLocalViewer` 语义改造——保留签名（chat 链接点击回调），但实现改为 `openLocalPath(target, { onEditor: preview.openTab, onImageViewer: 降级 image viewer })`
  - 移除 `ChatLinkHandlerProvider` 组件（迁移到 preview-area-context 或保留薄 wrapper）
- `component-message-stream.tsx`：
  - 删除 `ComponentChatLinkViewer` 挂载（L350）+ import
  - ChatLinkHandlerProvider value 改为注入预览区上下文（`usePreviewArea()` 非 null → openTab；null → 降级弹层保持兼容）

**约束**：MUST 保留 ChatLinkHandlerContext（primitive-markdown-view 依赖，循环依赖断开结构不变）；MUST 无 Provider 降级（openPath 系统打开）；MUST 删除 component-chat-link-viewer.tsx 文件。

### D13: 弹层退役死代码清理

**文件**：`app/web/src/components/chat-page/component-ws-file-editor.tsx`（删除）+ `app/web/src/components/chat-page/component-chat-link-viewer.tsx`（删除）+ 测试清理

**变更**：
- 删除 `component-ws-file-editor.tsx`、`component-chat-link-viewer.tsx`
- grep 全量清理引用：`__tests__/component-chat-link-viewer.test.tsx`（删除）、`__tests__/section-workspace-panel-md.test.tsx`（改断言）、`__tests__/section-workspace-panel.test.tsx`（改断言）、`__tests__/page-chat-*.test.tsx`（如有引用）
- `component-modal-md-editor`（common/）**保留**（academy 场景仍用）

**约束**：MUST 删除后 grep 无残留引用（import/测试断言）；MUST NOT 删 component-modal-md-editor / component-ws-image-viewer；MUST NOT 改 open-local-path.ts lib 本身。

### D14: 前端 API 客户端 — workspace-api.ts

**文件**：`app/web/src/lib/chat-api/workspace-api.ts`（修改）

**变更**：
- `readWorkspaceFile` 返回类型加 `version?: string`（`{content: string; version?: string}`，旧响应缺省 undefined）
- `saveWorkspaceFile` body 加 `expectedVersion?: string` + `force?: boolean`；返回类型 `{ok: true; version?: string}`
- 新增 `searchWorkspaceFiles(sessionId, {q})` → GET /session/:id/workspace/search?q= → `{files: string[]; dirs: string[]; truncated?: boolean}`
- 409 错误：req helper 已 throw `Error & {status}`，前端 catch `err.status === 409` 读 body.error

**约束**：MUST 409 时保留 status 供前端判定；MUST version 可选（旧后端降级）；MUST 复用 req helper。

### D15: i18n 文案

**文件**：`app/web/src/i18n/locales/zh-CN/chat.json` + `app/web/src/i18n/locales/en/chat.json`（修改）

**变更**（`workspace.preview.*` 命名空间）：
- `tab.workspace`（预览区 tab 名）？—— 独立：`preview.empty`（「打开文件以预览」）、`preview.edit`（「编辑」）、`preview.save`（「保存」）、`preview.cancel`（「取消」）、`preview.saved`（「已保存」）、`preview.dirtyTitle`（「文件「{name}」有未保存的修改」）、`preview.dirtySaveSwitch`（「保存并切换」）、`preview.dirtyDiscard`（「放弃修改」）、`preview.dirtyCancel`（「取消」）、`preview.conflictTitle`（「文件已被外部修改」）、`preview.conflictReload`（「取消」）、`preview.conflictOverwrite`（「覆盖」）、`preview.fileNotFound`（「文件未找到」）、`preview.openFail`（「打开失败」）、`preview.saveFail`（「保存失败」）、`preview.fileGone`（「文件已不存在」）、`preview.searchPlaceholder`（「搜索文件…」）、`preview.searchTooMany`（「结果过多，请细化关键词」）、`preview.collapse` / `preview.expand`、`preview.resize.*`

**约束**：MUST zh-CN + en 双语；MUST key 前缀 `workspace.preview.*`（既有 workspace 命名空间下）。

## 文件级变更清单

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---------|---------|----------|------|---------|------|------|-----------|
| 1 | layout | `app/web/src/lib/layout-width-engine.ts` | `CHAT_WIDTH_MIN` | 新增 | chat 保底下限 320 | MUST | D1/PRD§2.1 | +1 |
| 2 | layout | 同上 | `PV_WIDTH_MIN/MAX/DEFAULT` | 新增 | 预览区 240/1600/360 | MUST | D1/PRD§2.1 | +3 |
| 3 | layout | 同上 | `WS_WIDTH_MAX` | 修改 | 560→1600（近全屏） | MUST | D1/PRD§2.1 | 1 |
| 4 | layout | 同上 | `PreviewSlotInput` | 新增 | `{setting, collapsed}` | MUST | D1 | +3 |
| 5 | layout | 同上 | `DragSide` | 修改 | 加 'preview' | MUST | D1 | 1 |
| 6 | layout | 同上 | `ThreeColLayoutInput.preview?` | 修改 | 可选预览槽 | MUST preview=null 旧逻辑不变 | D1 | +1 |
| 7 | layout | 同上 | `computeThreeColLayout` | 修改 | 4 槽分支（preview=null 旧路径不动） | MUST 保底 right→preview→left→chat | D1 | +40 |
| 8 | layout | 同上 | `dragDynMax4` | 新增 | 4 槽动态上限唯一公式 | MUST 禁第二份 | D1 | +6 |
| 9 | layout-hook | `app/web/src/components/chat-page/use-three-col-layout.ts` | `previewReport` | 新增 | preview 上报 state | MUST | D2 | +3 |
| 10 | layout-hook | 同上 | `reportPreviewPanel/previewRenderWidth/previewDragMaxWidth/setPreviewDragging` | 新增 | 返回 4 字段 | MUST 复刻 ws 模式 | D2 | +10 |
| 11 | layout-hook | 同上 | `previewCurrentRef` | 新增 | 每帧回填 | MUST | D2 | +3 |
| 12 | preview | `app/web/src/components/chat-page/section-preview-area.tsx` | `SectionPreviewArea` | 新增 | 预览区容器（collapsed/width/tabs/双分隔条/Provider） | MUST 独立渲染容器 | D3 | ~150 |
| 13 | preview | `app/web/src/components/chat-page/preview-area-context.ts` | `PreviewAreaContext/usePreviewArea` | 新增 | 预览区 Context + hook | MUST 无 Provider 返 null | D3 | +30 |
| 14 | preview | `app/web/src/components/chat-page/use-preview-tabs.ts` | `PreviewTab` | 新增 | tab 数据结构 | MUST id=`${source}:${path}` | D4/PRD§3.1 | +12 |
| 15 | preview | 同上 | `usePreviewTabs` | 新增 | tab 状态机（open/close/activate/save/dirty/conflict） | MUST dirty 守卫 | D4 | ~140 |
| 16 | preview | `app/web/src/components/chat-page/component-preview-tab-bar.tsx` | `ComponentPreviewTabBar` | 新增 | tab 横滑 + chevron + × | MUST opacity 显隐不位移 | D5 | ~80 |
| 17 | preview | `app/web/src/components/chat-page/component-preview-viewer.tsx` | `ComponentPreviewViewer` | 新增 | 内嵌 view（md pre 分流 + edit 按钮） | MUST code=plain | D6 | ~60 |
| 18 | preview | `app/web/src/components/chat-page/component-preview-editor.tsx` | `ComponentPreviewEditor` | 新增 | textarea 编辑 + 保存/取消 | MUST 失败留 edit | D6 | ~60 |
| 19 | preview | `app/web/src/components/chat-page/component-preview-dirty-modal.tsx` | `ComponentPreviewDirtyModal` | 新增 | dirty 确认 modal（保存并切换/放弃/取消） | MUST L3 Portal | D4 | ~40 |
| 20 | preview | `app/web/src/components/chat-page/component-preview-conflict-modal.tsx` | `ComponentPreviewConflictModal` | 新增 | 冲突 modal（取消=reload/覆盖=force） | MUST 409 驱动 | D4 | ~40 |
| 21 | ws-panel | `app/web/src/components/chat-page/section-workspace-panel.tsx` | `handleOpen` | 修改 | onEditor → preview.openTab（有 Provider）/ 降级弹层（无） | MUST 消费端改 | D7 | +5 |
| 22 | ws-panel | 同上 | `ComponentWsFileEditor 挂载` | 删除 | L277 弹层挂载移除 | MUST | D7 | -2 |
| 23 | ws-tree | `app/web/src/components/chat-page/component-ws-tree-item.tsx` | `ComponentWsTreeItem` | 修改 | 文件夹 item 点击 → toggle；打开文件夹按钮 stopPropagation | MUST 双入口同一 toggle | D7 | +8 |
| 24 | ws-search | `app/web/src/components/chat-page/component-ws-search-box.tsx` | `ComponentWsSearchBox` | 新增 | 搜索框（防抖 300ms 前端过滤+后端补全） | MUST 空输入不请求 | D8 | ~90 |
| 25 | ws-search | `app/web/src/components/chat-page/section-workspace-panel.tsx` | 搜索接线 | 修改 | TabBar 与 PathBar 之间挂搜索框 + 结果渲染 | MUST 搜索/树互斥 | D8 | +15 |
| 26 | server | `app/server/src/handlers/session-workspace-file.ts` | `computeFileVersion` | 新增 | mtimeMs:size 组合 | MUST | D9/PRD§3.3 | +5 |
| 27 | server | 同上 | `handleWorkspaceFileRead` | 修改 | 响应加 version | MUST binary 不加 | D9 | +2 |
| 28 | server | 同上 | `handleWorkspaceFileSave` | 修改 | expectedVersion/force/409 | MUST 409 body 契约 | D9 | +20 |
| 29 | server | `app/server/src/handlers/session-workspace-search.ts` | `handleWorkspaceSearch` | 新增 | 递归全量搜索 | MUST ignore node_modules/.git + 200 上限 | D10 | ~90 |
| 30 | server | `app/server/src/routes/router-helpers.ts` | `matchSessionPath` | 修改 | alternation 加 search | MUST | D10 | 1 |
| 31 | server | `app/server/src/routes/session-routes.ts` | `dispatchSessionRoutes` | 修改 | 加 workspace_search 分支 | MUST | D10 | +4 |
| 32 | format | `app/web/src/lib/file-format.ts` | `FileFormat` | 修改 | 加 'code' | MUST | D11/PRD§2.3 | 1 |
| 33 | format | 同上 | `FileFormatCategory` | 修改 | 加 'code' | MUST | D11 | 1 |
| 34 | format | 同上 | `EXT_TO_FORMAT` | 修改 | 并入编程语言后缀→'code' | MUST 既有映射不变 | D11 | +30 |
| 35 | format | 同上 | `getCategory` | 修改 | code case | MUST code=plain | D11 | +2 |
| 36 | chat-link | `app/web/src/components/chat-page/chat-link-handler-context.ts` | `ChatLinkHandlerContextValue` | 修改 | onLocalViewer 语义 → 预览区 openTab | MUST 保留 Context | D12 | +4 |
| 37 | chat-link | `app/web/src/components/chat-page/component-message-stream.tsx` | `ChatLinkHandlerProvider value` | 修改 | 注入预览区上下文（无 Provider 降级） | MUST | D12 | +6 |
| 38 | chat-link | 同上 | `ComponentChatLinkViewer 挂载` | 删除 | L350 移除 | MUST | D12 | -2 |
| 39 | cleanup | `app/web/src/components/chat-page/component-ws-file-editor.tsx` | 整个文件 | 删除 | 退役 | MUST grep 无残留 | D13 | -143 |
| 40 | cleanup | `app/web/src/components/chat-page/component-chat-link-viewer.tsx` | 整个文件 | 删除 | 退役 | MUST grep 无残留 | D13 | -223 |
| 41 | api-client | `app/web/src/lib/chat-api/workspace-api.ts` | `readWorkspaceFile` | 修改 | 返回加 version? | MUST 可选 | D14 | +2 |
| 42 | api-client | 同上 | `saveWorkspaceFile` | 修改 | body 加 expectedVersion/force；返回 version? | MUST 409 status 保留 | D14 | +4 |
| 43 | api-client | 同上 | `searchWorkspaceFiles` | 新增 | GET search | MUST | D14 | +15 |
| 44 | i18n | `app/web/src/i18n/locales/zh-CN/chat.json` | workspace.preview.* | 新增 | 19 key | MUST 双语 | D15 | +19 |
| 45 | i18n | `app/web/src/i18n/locales/en/chat.json` | workspace.preview.* | 新增 | 19 key | MUST 双语 | D15 | +19 |
| 46 | mount | `app/web/src/components/chat-page/page-chat.tsx` | PageChat | 修改 | SectionChatSession 后插 SectionPreviewArea | MUST | D3 | +6 |
| 47 | mount | `app/web/src/components/studio-page/component-studio-chat-router.tsx` | StudioChatRouterImpl | 修改 | SectionStudioChat 后插 SectionPreviewArea | MUST | D3 | +6 |

## 范式归属（逐控件）

| 控件/操作 | 范式 | 理由 |
|-----------|------|------|
| 预览区 tab 打开/切换/关闭 | **即时操作**（无 SaveBar） | 预览区是浏览工具，非配置面板；dirty 守卫是 modal 确认（非保存栏） |
| 编辑模式保存 | **即时操作**（按钮直接落盘） | PRD §2.6 状态机：保存成功→回 view；无 autosave；不引入 SaveBar |
| dirty 守卫（切 tab/关 tab） | **确认 modal**（L3） | 三选：保存并切换/放弃/取消；非 SaveBar（无全局保存语境） |
| 冲突检测（409） | **确认 modal**（L3） | 两选：取消(重载)/覆盖(force)；非 SaveBar |
| 预览区显示/隐藏（collapsed） | **即时操作**（chevron 窄栏） | 对齐 ws-panel 收起交互（现有范式） |
| 预览区宽度拖拽 | **拖拽手柄**（component-col-resize-handle） | 复用既有 delta 算法组件 |
| 搜索框输入 | **直接输入 + 防抖** | 无配置提交语义；结果即时渲染 |
| 文件夹点击展开/收起 | **即时操作**（toggle） | 树导航语义，无提交 |
| 「打开文件夹」按钮 | **即时操作**（系统打开） | 保留既有行为 |
| 文件树文件点击 | **即时操作**（开预览 tab） | 消费端回调改造，无提交语义 |

**结论**：预览区所有控件走「即时操作 / 确认 modal / 拖拽手柄」三类范式，**不引入 SaveBar**（预览区不是配置面板；dirty 守卫已有 modal 确认闭环）。弹层退役后 academy 场景仍用 component-modal-md-editor（保留）。

## 影响面评估

- **跨模块**：layout-engine（4 槽）/ use-three-col-layout / chat-page（page-chat + StudioChatRouter 挂载）/ workspace panel（file-tree + search）/ preview 新组件族 / chat-link context / server（file handler + search handler + 路由）/ file-format / i18n / tests
- **破坏性变更**：`component-ws-file-editor.tsx` + `component-chat-link-viewer.tsx` 删除（grep 清理）；`WS_WIDTH_MAX` 560→1600（既有 ws-panel 拖宽上限变化，语义扩展不破坏）；`saveWorkspaceFile` 返回类型加 version（向后兼容）；`readWorkspaceFile` 加 version（向后兼容）
- **依赖顺序**：file-format（'code'）→ preview 组件族 → workspace panel 改造 → chat-link 迁移 → 挂载点接线；后端：file handler → search handler → 路由
- **风险点**：
  1. layout-engine 4 槽改造回归风险 → preview=null 旧路径零改动 + 旧 UT 全绿门禁
  2. academy/studio 无 Provider 降级 → 保留弹层路径（component-modal-md-editor 不删）
  3. 删除组件残留引用 → grep 全量门禁
  4. 搜索性能（大目录递归）→ ignore node_modules/.git + 200 上限
  5. conflict 竞态（保存后立刻再改）→ last-write-wins 兜底语义（PRD §5.3）
  6. i18n key 遗漏 → 预览区所有文案走 workspace.preview.* 前缀

## 验证方式（每任务）

| Task | 验证 |
|------|------|
| Task 1（后端） | UT（bun run test）+ AT（3 处：file version / save 409 / search） |
| Task 2（前端布局+预览区） | UT（layout-engine 4 槽新用例 + 组件）+ ET（EC-1/2/8/10/11/12） |
| Task 3（前端改造+清理） | UT（file-format code + workspace panel 改造）+ ET（EC-3/4/5/6/7/9） |

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
