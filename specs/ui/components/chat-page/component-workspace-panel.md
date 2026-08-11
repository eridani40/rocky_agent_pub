# component-workspace-panel（右侧栏：工作区面板）

> 层级: section（含 tab-bar / path-bar / file-tree / resize-handle 子 component + primitive）
> 视觉契约: `reqs/v0.0.17/mqnbr367-easy-opc-chat-v9a.html` §209-242（CSS）+ §706-800（WorkspacePanel + WsTree 实现）
> 本文是 WorkspacePanel 的**概念权威源**：子组件分层 + 数据契约 + 交互 + 视觉基线 + testid。

## 1. 定位 + 设计意图（一句话）
在 chat-page 右侧新增第 3 栏 workspace 面板（可收起 / 可拖宽 / tab / 文件树 / 切换目录 / 刷新），让用户在对话中一眼看到当前 session 的工作目录文件，并直接打开文件/文件夹、切换目录；后端 chokidar 监听文件变化经 SSE 实时推送，手动刷新按钮兜底。

## 4. 交互
### 4.1 收起/展开
- 点 `ws-collapse-btn`（header 右侧 chevron-right）→ `collapsed = true`，面板折叠为 36px 窄栏（`.ws-rail`），仅显示 `ws-expand-btn`（chevron-left）。
### 4.2 拖宽（ws-resize-handle，delta 算法升级）
- **算法（重写）**：delta 算法无死区——`mousedown` 捕获 `startRef={startX, startWidth=currentWidth}`（mid-drag 不重捕获）；`mousemove` 算 `dx = e.clientX − startX`，`raw = startWidth − dx`（side='right'，鼠标左移 → 宽变大）；`clamp[min, max]` → onResize。到静态/动态边界后反向拖立即响应（无脱手死区）。实现复用 `component-col-resize-handle`（通用拖拽手柄）；本组件改薄 wrapper（保  + i18n `workspace.resize.*`）。
- **父注入 props**：`currentWidth = renderWidth ?? width`（父引擎钳制后的渲染宽优先，未传回退内部 state）、`maxWidth`（见上）、`onDragStart → onDragModeChange?.(true)`（场景 A 切换）、`onResize`、`onResizeEnd`（包 persistWidth + onDragModeChange?.(false)）。
- 持久化：`localStorage` per session（key: `ws-width-<sid>` = number）。
### 4.3 文件夹展开/收起（lazy 加载子目录 + 声明式 watch-set 重算）
- 点 `ws-item-{path}-expand`（twisty/箭头）→ toggle `expanded[path]`（前端 state，不持久化——刷新后折叠态重置）。
- **v0.0.271 起展开/收起只改 state**（不再在触点直接调 watch/unwatch API——防双发）：`handleExpand` = `toggle-expand force:true` +（缓存未命中）GET `tree?parent` 补 childrenCache；`handleCollapse` = `toggle-expand force:false`。**watch 由重算 effect 驱动**：`useEffect` 监听 `state.tree`/`state.expanded`/`state.childrenCache`/`state.stalePaths` 任一变化 → `computeWatchSet({ tree, expanded, childrenCache })` 全量重算关注集合 → `applyWatchSet(paths)`（POST `/session/:id/workspace/watch-set`，声明式替换该 tab 集合，后端 diff 增删）。纯函数 `computeWatchSet` 落 `workspace-watch-set.ts`（可 UT 直测）。
- **[v0.0.275] fs 事件驱动重算（R1）**：重算 effect 依赖数组**含 `state.stalePaths`**（fs 事件 `file_changed` → reducer 标 stalePaths → 依赖变化 → 触发重算；老板「无脑重算一次」不玩精细判断）。**本地 diff pre-check**：`lastWatchSetRef`（useRef）存上次 applyWatchSet 的集合，`computeWatchSet` 结果 `JSON.stringify` 与上次比较——**集合没变 → return 不发 POST**（防「每事件都发请求」）；首次 mount lastRef=null 必发；幂等（后端 diff no-op 兜底）。防无限循环成立：fs 事件 → 重算 → 集合没变 → 不发 POST → 无新订阅 → 无新事件。
- **关注集合语义**（v0.0.271 老板拍板）：根 `''` 恒含 + 根一级子文件夹（tree 筛 `type==='dir'`）+ 每个打开节点自身（`expandedPathsByDepth`）+ 各自一级子文件夹（childrenCache 筛 `type==='dir'`）；**含空文件夹**——空文件夹即使未展开也被其父级 watch，新增文件有事件（修 BUG-fs-watch-empty-folder-no-expand）。**本版 MUST NOT 改此定义**（271 语义保留）。
- **[v0.0.275] 结构刷新（R3，未展开目录 twisty）**：结构性事件（`kind ∈ {addDir, unlinkDir}`）→ reducer 额外把父目录 P 加入 `structuralStalePaths`（**双标**：与 stalePaths 并存不互斥——stalePaths 管已展开父目录渲染刷新，structuralStalePaths 管未展开目录 twisty 刷新）。新 effect hook `use-workspace-structural-refetch.ts` 监听 `structuralStalePaths` → **50ms 防抖合并**（批量目录增删不逐个 refetch）→ 对 `structuralRefetchTargets(structuralStalePaths)` 每个 target 调 `handleStaleRefetch(parentOf(P))`（P 所在层刷新：`''` → tree-loaded / 非空 → children-loaded，复用既有分派）→ 触发后立即清 structural。**关键洞察**：twisty 判定 = `node.hasChildren`（component-ws-tree-item.tsx L57 后端字段）——P 的 hasChildren 在 **parentOf(P) 的 children 数组**里（P node 的字段），refetch P 自己无用（P 未展开不渲染），refetch parentOf(P) 更新 P node → P.hasChildren 正确 → twisty 出现/消失。
- **两机制正交（老板口径）**：全量重算是**唯一中枢**（tree/expanded/childrenCache 变化 → 全量重算 → applyWatchSet）；「重算订阅」管增量（watch-set diff，集合变才 POST）+「结构刷新 refetch」管当前快照（parentOf(P) 真 GET tree 刷 P 所在层）——拆开两机制，P 展开时两者可能重叠 refetch（无脑都发，幂等 + 防抖合并可接受）。
- **时序幂等**：初始 rootTree 异步 → 先发 {根} 后补 {根一级}（两次 applyWatchSet）；展开后 childrenCache 未到先发 {自身}、GET 成功后补 {子一级}（幂等，后端 diff 全空即 no-op）。
- **切目录清 expanded**（v0.0.271）：`handleSwitchDir` 走 `dir-changed` 语义重置（`applyWorkspaceDirChanged` 清 expanded/tree/childrenCache/stalePaths/**structuralStalePaths**——旧相对路径相对新基准无效），watch-set 重算 effect 自动发新根集合；`handleRefresh` 同目录刷新保留 expanded（`reset` + 逐层补回 childrenCache，**同时清 structuralStalePaths**——刷新后结构新鲜，不受影响）。
### 4.4 文件点击分流（v0.0.269：五路前置分流 .url > image > text > 系统打开；v0.0.280：改调共享 openLocalPath lib；**v0.0.320：12 格式进预览区 tab，弹层退役**）
- 点文件节点 → `handleOpen(node)`（v0.0.280 改调共享分发 lib `openLocalPath`，五路分流语义原样保留——folder/.url/image/12 格式/系统打开，行为零变化）：
  - `openLocalPath(node.path, { sessionId, source:'workspace', kind: node.type==='dir'?'folder':'file', onEditor: (t)=>preview.openTab(t) ?? setFileEditorTarget(...), onImageViewer: (t)=>setWsImageTarget(...) })`——onEditor/onImageViewer 回调消费方按 target 分流渲染（chat 链接也走同一 lib，行为≡ 右侧）。
  - **文件夹**（`node.type === 'dir'`，含 symlink→dir）→ `openWorkspaceItem`（`POST /workspace/open` kind=folder 系统文件管理器打开目标目录；后端链式授权放行）。**v0.0.320 起文件夹 item 点击 = toggle 展开/收起**（与 twisty 同语义防双发）；「打开文件夹」hover 按钮 stopPropagation 保留。
  - **远程链接**（`.url` 快捷方式，`isRemoteLinkPath` 判定，大小写不敏感）→ `openRemoteLink(sessionId, path)`：读 `.url` 内容 → `parseUrlFileContent` 提取 http/https URL → 浏览器打开（Electron shell.openExternal / window.open fallback）；嗅探失败（无 URL）→ 降级 editor（`format: 'txt'` plain view）。实现 `app/web/src/lib/remote-link.ts`。
  - **图片**（`isImagePath` 判定，6 格式 png/jpg/jpeg/gif/webp/svg，大小写不敏感；非 6 格式 .bmp/.tiff 不加入——PRD §6 范围不扩大）→ `setWsImageTarget({ path, fileName, subtitle })` → 挂载层渲染 `component-ws-image-viewer`（只读图片查看，`GET /workspace/file?binary=1` base64 通道）。**图片不进预览区**（v0.0.320 保留弹层语义）。
  - **文本**（`getFileFormat(node.path) !== null`，12 格式 + code）→ **v0.0.320 起进预览区 tab**：`preview.openTab({ path, fileName, subtitle, format, source:'workspace' })`（`usePreviewArea()` 有 Provider 时）；**无 Provider**（academy section-version-chat）→ 降级 `setFileEditorTarget` → `component-ws-file-editor-fallback` 弹层（D13 退役后保留的降级路径，非死代码）。
  - **其余（系统打开）**：以上都不命中（未知扩展名 / 非 6 格式图片）→ `openWorkspaceItem(kind='file')` 系统文件管理器打开（**无占位 pill**——前置分流后进 editor 的都是文本，二进制 pill 仅 editor 内防御）。
- **共享分发 lib**（v0.0.280 `app/web/src/lib/open-local-path.ts`）：聊天链接与右侧文件区行为永远一致（老板铁律），openLocalPath 是唯一权威本地文件分发——5 分支 × 2 源（workspace/absolute）分流表详见 `specs/ui/components/chat-page/section-preview-area.md` + change_plan 行 25。右侧 handleOpen 传 `source:'workspace'` + `kind`；聊天链 link-target local 分支传 `source: toChatLinkTarget(target).source` + 不传 kind（kind=undefined 跳过文件夹分支，目录路径落 openPath 行为等价）。
- **`isBuiltinEditable` 保留原 12 格式语义**（v0.0.263 架构决策②）：workspace 文件树打开**不再用它判定**；它继续服务 `link-target.ts` 的 markdown 链接点击分发（12 格式进 viewer / 其它系统打开，v0.0.253 契约）。12 格式分类表（md + structured 7 + plain 4）仍用于 editor 内 `getFileFormat` 的 view 分流（md→markdown 渲染 / structured→pre + 格式化校验按钮 / 其它→txt plain view / **code→pre 无按钮**）。
- **looksBinary 保留为 editor 内防御**（v0.0.269 架构裁决②）：前置分流后进 editor 的都是 text；`.txt` 被改名成真二进制时 editor 读内容后 `looksBinary(content)`（NUL `\u0000` 或替换符 `\uFFFD` 占比 >5%）→ 占位 pill「二进制文件无法预览」（i18n `workspace.mdEditor.binaryUnsupported`），不渲染 editor modal；非二进制正常 editor。**不作主判定**（handleOpen 不再用 looksBinary 分流）。
- **弹层退役（v0.0.320 D13）**：`component-ws-file-editor.tsx` + `component-chat-link-viewer.tsx` 已删除（chat 场景）；`component-ws-file-editor-fallback.tsx` 为无 Provider 降级路径（1:1 复用原逻辑：readWorkspaceFile + ComponentModalMdEditor + last-write-wins + flash toast）。`component-modal-md-editor`（common/）保留（academy 场景）。
- `WsFileTarget`（fallback 用）加 `format: FileFormat` 字段——modal 按 format 分流 view（md→PrimitiveMarkdownView / 其余→`<pre>`）+ edit 模式条件显示「格式化」「校验」按钮（仅 structured）。

### 4.6 工作区搜索框（v0.0.320 D8，`component-ws-search-box.tsx`）
- **位置**：TabBar 与 PathBar 之间常驻输入框（`ws-search-input`）。
- **混合搜索（防抖 500ms + 回车立即搜）**：输入连续变化 → **500ms 防抖**（停下 500ms 才发请求，[v0.0.328] 从 300ms 调至 500ms）；输入中**按回车立即触发搜索**（清防抖定时器，不等 500ms）。搜索逻辑：前端过滤已加载树（tree + childrenCache 递归 `collectLoaded`，文件名 substring 大小写不敏感）+ 后端补全（`searchWorkspaceFiles(sessionId, {q})` 递归全量）→ 合并去重（后端 dirs/files 在前）。
- **搜索态与树态互斥**：query 非空 → 渲染结果列表（`ws-search-results`），父级隐藏 PathBar/FileTree；清空（× `ws-search-clear` 或删空）→ 恢复原树。
- **结果项点击**：文件 → onOpenFile（父级 handleOpen 五路分流 → preview.openTab / viewer / 系统打开）；文件夹 → onToggleDir（复用树 toggle）。
- **结果过多**：合并后 >200 或后端 truncated → `searchTooMany` 提示；后端失败 → 降级仅前端结果。
- 递增 reqId 屏蔽过期响应（快速输入旧请求不覆盖新值）；testid `ws-search-hit-{path}`（`/` `.` 替换为 `-`）。
### 4.5 文件排序（文件夹置顶 + 自然序 numeric-aware）[v0.0.239]
- **排序规则**：顶层 `state.tree` + 子目录 `state.childrenCache[path]` 的节点顺序由 **reducer ingest 时排序** 决定（`workspace-slice-reducer.ts` 的 `setTreeLoaded` / `setChildrenLoaded` 两 ingest 点），不在渲染层 `TreeLevel` 排序：
  - **先按节点类型分组**：文件夹（`type === 'dir'`）整体置顶，文件（`type === 'file'`）在后——对齐 VSCode 默认。
  - **同组内按自然序**：`compareNaturalNames` 拆交替「文字段 + 数字段」逐段比较——文字段大小写不敏感字符串序、数字段数值序（`90 < 100`）、**同值不同格式按原 digit 字符串兜底**（`'09' < '9'`，因 `'0' < '9'`）。实现见 `app/web/src/lib/natural-sort.ts`。
- **节点 `type` 枚举** = `'file' | 'dir'`（对齐 `specs/api/overall/04-agent-session.md` §2.6.1 WsTreeNode + `workspace-types.ts`）。
- **三条件（PRD §6.3 不变量）**：① 数据进渲染前必经排序（reducer 是 state 写入唯一入口）；② 缓存命中也有序（`childrenCache[path]` 写入时已排序，折叠再展开走缓存读直接有序，无需重排）；③ watch / SSE `file_changed` → `applyWorkspaceFileChanged` 标 stale → 组件 effect 监测到已展开父 stale → `onStaleRefetch` 重 GET → 又走同一 `setTreeLoaded` / `setChildrenLoaded` ingest → 自动有序（无额外分支）。
- **不变更项**：后端 `handleWorkspaceTree`（`readdirSync` 原样返 FS 顺序）、HTTP 客户端 `getWorkspaceTree`、渲染层 `TreeLevel`（`items.map`）零排序逻辑；本规则仅在前端 reducer ingest 落地。

## 视觉基线
### 6.1 展开态 `.ws-panel` ### 6.2 拖宽手柄 `.ws-resize` ### 6.3 header `.ws-header` + tabs + actions
> ：`.ws-tab` 加  + `flex-shrink: 0`；`.ws-tabs` 加 。修复窄宽度下 tab 文案换行 bug（PRD §3.1 UIFix1）。

### 6.5 文件树单条 item（`.ws-item` / `.ws-twisty` / `.ws-ico` / `.ws-name` / `.ws-act`）— v0.0.263 补 symlink 渲染基线

> 实现 `app/web/src/components/chat-page/component-ws-tree-item.tsx`；视觉权威 `reqs/v0.0.17/mqnbr367-easy-opc-chat-v9a.html §227-239`（CSS）。**无设计稿新增**（PRD §7 视觉保真门禁跳过 vision_check compare）——symlink 视觉复用既有 design system。

- **常规 item**：twisty（仅文件夹 + hasChildren=true，`ws-twisty`；文件/空目录 placeholder 保持对齐）；icon（文件夹 gold 展开变 folderOpen / 文件 muted，`ws-ico` 固定宽 13px）；name（12.5px ellipsis，`ws-name`）；hover「打开」按钮（`.ws-act` 默认 opacity 0 / item hover opacity 1，绝对空间预留不位移）；缩进 `paddingLeft = 6 + depth * 14`。
- **[v0.0.263] symlink 渲染基线**：
  - **link 角标**：`node.isSymlink === true` → 在 FileIcon/FolderIcon 基础上叠加小 link 角标（absolute 定位图标右上角，`data-testid="symlink-badge-{path}"`），**不占位不推动 name 位移**（布局稳定性 MANDATORY——图标槽位固定宽不变）。
  - **tooltip**：`node.isSymlink && node.linkTarget` → item name `title` 显示 `→ {linkTarget}`（i18n `workspace.tree.symlinkTooltip`，`→ {{target}}`；hover 显示目标绝对路径）。
  - **交互不变**：symlink→dir 有 twisty 可展开（isSymlink && type==='dir' && hasChildren）；hover 打开按钮照常（handleOpen 见 §4.4）。
  - **排序不变**：symlink 归属真实类型分组（type 枚举不变），不加排序分支。

## Props
- sessionId: string
- collapsed: boolean;                          // 收起态（localStorage 持久化 per sess...
- width: number;                               // 展开态宽度（clamp [232, 560]，默认 272...
- workspaceDir: string;                        // 当前 workspaceDir（GET tree 返回 +...
- tree: WsTreeNode[];                          // 顶层文件树（GET tree 无 parent；只一层）
- childrenCache: Record<string, WsTreeNode[]>; // 已加载的子目录缓存（key = 父 path，value ...
- expanded: Record<string, boolean>;           // 展开态 per path（前端 state，不持久化）
- loadingChildren: Record<string, boolean>;    // lazy GET 子目录 loading 态 per pa...
- stalePaths: Set<string>;                     // 被 watch event 标记 stale 的子目录 p...
- structuralStalePaths: Set<string>;           // [v0.0.275] 结构性事件（addDir/unlinkDir）父目录集合——结构刷新 effect 消费
- loading: boolean;                            // GET 顶层 tree loading（禁用刷新按钮）
