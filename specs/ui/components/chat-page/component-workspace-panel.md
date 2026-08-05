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
### 4.3 文件夹展开/收起（lazy 加载子目录）
- 点 `ws-item-{path}-expand`（twisty/箭头）→ toggle `expanded[path]`（前端 state，不持久化——刷新后折叠态重置）。
### 4.4 文件点击分流（`isBuiltinEditable` 拦截走内置 file editor / 其余系统打开）[v0.0.241]
- 点文件节点 → `handleOpen(node)`：
  - **内置 editor 命中**（`node.type==='file' && isBuiltinEditable(node.path)`，大小写不区分）→ 拦截，`setFileEditorTarget({ path: node.path, fileName: node.name, subtitle: node.path, format: getFileFormat(node.path) ?? 'md' })`；由挂载层 `component-ws-file-editor.tsx`（本目录，v0.0.241 改名自 `component-ws-md-editor.tsx`）渲染 `common/component-modal-md-editor`（view 按 format 分流 + edit + 保存 + 结构化格式按钮）。读走 `GET /workspace/file`、存走 `POST /workspace/file/save`（api §2.6.7），存成功 toast「已保存」。**不调** `openWorkspaceItem`。
  - 拦截范围（12 格式 = 11 新 + md）—— `isBuiltinEditable` 查 `lib/file-format.ts` EXT_TO_FORMAT 表 + `.env`/`.env.*` 特判：
    | 分类 | 格式 | 拦截后缀 |
    |------|------|---------|
    | 结构化（有 format/validate） | JSON / JSONL / YAML / XML / TOML / CSV / TSV | `.json` / `.jsonl` / `.yaml` / `.yml` / `.xml` / `.toml` / `.csv` / `.tsv` |
    | 纯文本（仅查看/编辑） | TXT / INI / ENV / LOG | `.txt` / `.ini` / `.env` / `.env.*`（如 `.env.local`）/ `.log` |
    | md（v0.0.227 既有） | Markdown | `.md` |
  - **其它扩展名 / 文件夹**（行为不变，回归保护）→ `openWorkspaceItem`（folder 展开/收起在外部已处理；file 走 `POST /workspace/open` 后端 spawn 系统默认应用）。**未支持**：编程语言（`.py`/`.js`/`.java` 等，用户铁律）、二进制 / 图片（`.png`/`.pdf` 等）。
- 挂载层独立文件 `component-ws-file-editor.tsx`（v0.0.241 改名，仿 `component-academy-modals.tsx` 模式）——modal/toast/onSave 接线不塞本组件（本组件已近 300 行上限）。三处复用（chat-page / academy section-version-chat / studio section-right-tabs）共用同一 `SectionWorkspacePanel`，拦一处全覆盖。
- `WsFileTarget`（v0.0.241 改名自 `WsMdTarget`）加 `format: FileFormat` 字段——modal 按 format 分流 view（md→PrimitiveMarkdownView / 其余→`<pre>`）+ edit 模式条件显示「格式化」「校验」按钮（仅 structured）。
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
- loading: boolean;                            // GET 顶层 tree loading（禁用刷新按钮）
