# v0.0.324 变更计划书 — 文件树搜索交互升级：裁剪式结果树

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD 权威：`specs/prd/version_logs/v0.0.324-file-tree-search-filter-tree.md`

## 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| 搜索态模型 | **不隐藏 FileTree**，切换其数据源（原始树 ↔ 裁剪树）。裁剪树 = 一组 `WsTreeNode[]` 顶层 + `childrenCache` 补丁 + `expanded` 覆盖 | `section-workspace-panel.tsx` L264-288 当前 `!searching` 互斥隐藏 FileTree → 改为常驻 FileTree，数据源按 searching 切换 |
| 裁剪树构建 | **前端纯函数**从扁平搜索结果（`files[] + dirs[]`）构建。后端不改返回格式（仍 `{files, dirs, truncated}`） | PRD §6.1：「返回格式可保持扁平路径列表，前端负责构建裁剪树」 |
| 后端搜索语义 | 改 `walkSearch`：q 含 `/` 时按**完整相对路径**匹配（非 basename）；上限 200→100 | `session-workspace-search.ts` L27-82 现 basename-only 匹配；改法：q 含 `/` → `relChild.includes(qLower)` |
| 前端搜索框瘦身 | `ComponentWsSearchBox` 不再渲染结果列表（扁平列表整段删除），只保留输入框 + 防抖 + loading。结果渲染交回 `ComponentWsFileTree` | `component-ws-search-box.tsx` L177-204 结果列表 JSX 全删；搜索结果通过 callback 上报父级 |
| 数据流重构 | `SectionWorkspacePanel` 新增 `filteredTree` state：搜索时由 SearchBox 回调上报 `SearchResult`，panel 构建裁剪树 `WorkspaceState` 传入 FileTree | `section-workspace-panel.tsx` L145 `searching` state 保留但语义从「隐藏 FileTree」改为「切换数据源」 |
| 展开态覆盖 | 裁剪树自带 `expanded` 覆盖（所有祖先目录展开），注入 workspace state 覆盖原始 expanded | `workspace-types.ts` `WorkspaceState.expanded` 是 `Record<string, boolean>`，裁剪树构建时预填所有命中祖先 path=true |
| 继续展开 lazy | 裁剪树中目录节点手动展开 → 复用现有 `handleExpand`（GET `?parent=<path>` → `children-loaded` dispatch）。展开后 children 写入 childrenCache（与原始树共用同一 cache） | `section-workspace-panel.tsx` L104-118 `handleExpand` 完整复用；裁剪树和原始树共享 childrenCache |
| 缓存共享 | 裁剪树和原始树共享同一个 `childrenCache`。清空搜索时恢复原始 tree + 原始 expanded，childrenCache 不丢 | childrenCache 是按 path key 的 Record，两态共用互不影响（裁剪树只加 key 不删 key） |
| 限量 100 | 后端 `SEARCH_LIMIT` 200→100；前端 `tooMany` 阈值 200→100；i18n 文案更新 | `session-workspace-search.ts` L24 `SEARCH_LIMIT=200`；`component-ws-search-box.tsx` L130 `>200` |
| PathBar | 搜索态仍隐藏（不变），FileTree 常驻（数据源切换） | `section-workspace-panel.tsx` L273-278 `!searching && PathBar` 保持；`!searching && FileTree` → 去掉条件，FileTree 常驻 |

## 设计决策（D 编号）

### D1: 后端搜索语义升级 — session-workspace-search.ts（修改）

**文件**：`app/server/src/handlers/session-workspace-search.ts`（修改）

**变更**：
- `SEARCH_LIMIT`：200 → 100
- `walkSearch` 匹配逻辑分叉：
  - q **不含 `/`**（basename 匹配，现状不变）：`name.toLowerCase().includes(qLower)`
  - q **含 `/`**（完整相对路径匹配）：`relChild.toLowerCase().includes(qLower)` —— 同时覆盖文件和目录
- 目录命中后的递归策略（含 `/` query 时）：
  - 目录路径命中（`relChild` 含 q 子串）→ 推入 dirs，**不递归**（现状不变）
  - 目录路径未命中 → 递归下层（可能下层有路径命中的后代）
- `handleWorkspaceSearch`：q 含 `/` 时 qLower 仍是 `q.toLowerCase()`（不变），只是 walkSearch 内部按 q 是否含 `/` 切匹配目标

**约束**：MUST 上限 100；MUST q 不含 `/` 时 basename 匹配（现状不变）；MUST q 含 `/` 时完整相对路径匹配；MUST ignore node_modules/.git（不变）；MUST 返 `{files, dirs, truncated?}` 格式不变。

### D2: 裁剪树构建器 — ws-filter-tree.ts（新建）

**文件**：`app/web/src/components/chat-page/ws-filter-tree.ts`（新建）

**功能**：纯函数模块，从扁平搜索结果构建裁剪式结果树数据结构。

- `FilterTreeResult` 接口：
  ```ts
  interface FilterTreeResult {
    tree: WsTreeNode[];          // 裁剪树顶层节点
    childrenCache: Record<string, WsTreeNode[]>; // 每个祖先目录的直接子项（裁剪后）
    expandedPaths: string[];     // 需展开的祖先目录 path（预填 expanded）
    hitCount: number;            // 命中项总数（不含祖先容器）
  }
  ```
- `buildFilterTree(hits, opts: { limit: number; existingChildrenCache?: Record<string, WsTreeNode[]> }): FilterTreeResult`：
  1. **路径拆解**：对每个 hit path（如 `src/auth/login.ts`），拆出所有祖先路径段：`src`, `src/auth`, `src/auth/login.ts`
  2. **构建节点映射**：`Map<string, WsTreeNode>`，每段创建 `WsTreeNode`（祖先=dir + hasChildren=true；命中节点=原始 type）
  3. **构建 children 映射**：遍历所有路径段，按 parentOfPath 分组到 `Record<parentPath, WsTreeNode[]>`。同一 parent 下多 hit 合并（去重按 path）
  4. **目录命中子项补全**（PRD §3.1/§3.5）：若某命中目录 path 在 `existingChildrenCache` 中有子项 → **用缓存中的真实子项替换裁剪子项**（该目录展示全部子项，而非仅命中路径上的）。例如搜 "auth"，`src/auth/` 目录名命中 + childrenCache 有 → 展示 login.ts/register.ts/utils.ts 全部（而非仅命中文件）。缓存无 → 只展示裁剪路径上的子项（目录保持折叠可手动展开 lazy GET）。
  5. **顶层提取**：parentPath === '' 的节点 → tree[]
  6. **展开列表**：所有祖先路径 + 命中目录路径 → expandedPaths（全展开到命中层）
  7. **限量截断**：hits 超过 limit 时截断（调用方在合并后已截断，此函数只负责构建）
  - **同路径合并**：同一 parent 下的多个命中项自然归入同一 children 数组（Map 分组保证）
  - **裁剪**：只有「路径上有命中项的祖先」才出现在节点映射中（非命中兄弟不创建）

- `basename(path)`：取路径最后一段（已有同名函数在 search-box，迁移到此模块统一）

**约束**：MUST 纯函数（无副作用）；MUST 输出可直接喂给 ComponentWsFileTree（tree + childrenCache + expanded 格式一致）；MUST 同路径合并（Map 分组）；MUST 命中层全部祖先展开；MUST 目录命中且缓存有子项时展示全部子项（PRD §3.1/§3.5）。

### D3: 搜索框改造 — component-ws-search-box.tsx（修改）

**文件**：`app/web/src/components/chat-page/component-ws-search-box.tsx`（修改）

**变更**：
- Props 新增：`onResult: (result: { hits: { path: string; type: 'file' | 'dir' }[]; truncated: boolean } | null) => void`（搜索结果上报父级；null = 清空搜索态）
- 删除 Props：`onOpenFile` / `onToggleDir`（不再渲染列表项，不需要这些回调）
- 删除：`collectLoaded` / `filterLoaded` / `remoteToNode` / `mergeHits` 函数（扁平列表构建逻辑退役）
- 防抖 effect 改造：
  - 前端过滤保留但简化：`collectLoaded` + `filterLoaded` → 合并为从已加载树收集 `{path, type}[]`（basename 匹配 q 不含 `/` 时；q 含 `/` 时 path 子串匹配）
  - 后端补全保留：`searchWorkspaceFiles(sessionId, {q})` → `{files, dirs, truncated}`
  - 合并：前端命中 `{path, type}[]` + 后端 `{files, dirs}` → 合并去重为 `{path, type}[]`（按 path 去重）
  - 截断：超过 100 条 → 截断 + truncated=true
  - 调 `onResult({hits, truncated})`
- 清空（query 空 / ×）：`onResult(null)` + `onSearchingChange(false)`
- **删除结果列表 JSX**（L177-204 全部 `<div data-testid="ws-search-results">` 块）
- loading spinner / × 清空按钮 / 输入交互：**不变**
- `tooMany` state 退役（改由 onResult 上报 truncated）

**约束**：MUST 空输入不请求后端（不变）；MUST 防抖 300ms（不变）；MUST 不渲染结果列表（瘦身）；MUST onResult 上报合并去重后的 hits；MUST q 含 `/` 时前端也按 path 匹配（与后端语义一致）。

### D4: 容器数据源切换 — section-workspace-panel.tsx（修改）

**文件**：`app/web/src/components/chat-page/section-workspace-panel.tsx`（修改）

**变更**：
- 新增 state：`filterResult: FilterTreeResult | null`（null = 非搜索态）
- `handleSearchResult` callback：
  - result=null → `setFilterResult(null)` + `setSearching(false)`
  - result 非 null → 构建 FilterTreeResult（调 `buildFilterTree(hits, { limit: 100, existingChildrenCache: state.childrenCache })`，传入当前 childrenCache 使目录命中时能展示已缓存子项）→ `setFilterResult(filtered)` + `setSearching(true)`
- 计算渲染态：
  ```ts
  const treeState: WorkspaceState = searching && filterResult
    ? { ...state, tree: filterResult.tree, childrenCache: { ...state.childrenCache, ...filterResult.childrenCache }, expanded: { ...filterExpandedOnly } }
    : state;
  ```
  - 搜索态：tree=裁剪树顶层；childrenCache 合并（原始 + 裁剪补丁）；expanded 只保留裁剪树需要展开的路径（`filterResult.expandedPaths` 全 true，其余重置——搜索态展开态独立于原始树）
  - 非搜索态：原始 state（tree/childrenCache/expanded 恢复）
- `ComponentWsSearchBox` 接线：
  - 删除 `onOpenFile` / `onToggleDir` props
  - 新增 `onResult={handleSearchResult}` prop
  - 保留 `tree` / `childrenCache` / `sessionId` / `onSearchingChange` props
- `ComponentWsFileTree` 接线：
  - `state={treeState}`（搜索态用裁剪树 state，非搜索态用原始 state）
  - `onExpand` / `onCollapse` / `onOpen` / `onStaleRefetch` **不变**（复用现有 handleExpand/handleCollapse/handleOpen/handleStaleRefetch）
  - **去掉 `!searching` 条件**：FileTree 常驻渲染（数据源切换而非隐藏）
- PathBar：保持 `!searching && PathBar`（搜索态仍隐藏，不变）
- 新增裁剪树底部提示：搜索态 + truncated → FileTree 下方渲染 `searchTooMany` 文案

**约束**：MUST FileTree 常驻（不隐藏）；MUST 搜索态 expanded 独立于原始态（清空后恢复）；MUST childrenCache 合并（裁剪树继续展开 lazy GET 写入同一 cache）；MUST handleExpand/handleCollapse/handleOpen 复用不改。

### D5: FileTree 底部提示 — component-ws-file-tree.tsx（修改）

**文件**：`app/web/src/components/chat-page/component-ws-file-tree.tsx`（修改）

**变更**：
- Props 新增：`tooMany?: boolean`（搜索态截断提示）
- 渲染底部：`tooMany` 为 true 时在 TreeLevel 下方加提示 div（复用 searchTooMany i18n key + 样式：`px-2 py-3 text-[12px] text-muted text-center`）

**约束**：MUST 非 tooMany 时不渲染提示（零影响）；MUST 样式与原 search-box tooMany 一致。

### D6: 前端 API 客户端 — workspace-api.ts（修改）

**文件**：`app/web/src/lib/chat-api/workspace-api.ts`（修改）

**变更**：
- `searchWorkspaceFiles` JSDoc：上限说明 200→100；路径匹配语义补充（q 含 `/` 匹配完整相对路径）
- 返回类型 `{files: string[]; dirs: string[]; truncated?: boolean}` **不变**

**约束**：MUST 返回类型不变（向后兼容）；MUST JSDoc 更新。

### D7: i18n 文案更新

**文件**：`app/web/src/i18n/locales/zh-CN/chat.json` + `app/web/src/i18n/locales/en/chat.json`（修改）

**变更**：
- `workspace.preview.searchTooMany`：「结果过多，请细化关键词」→「结果超过 100 条，请进一步输入以缩小范围」 / "Over 100 results, narrow your search"
- 其余 search key 不变

**约束**：MUST 双语；MUST 只改 searchTooMany 文案。

## 文件级变更清单

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---------|---------|----------|------|---------|------|------|-----------|
| 1 | server | `app/server/src/handlers/session-workspace-search.ts` | `SEARCH_LIMIT` | 修改 | 200→100 | MUST | D1 | 1 |
| 2 | server | 同上 | `walkSearch` | 修改 | q 含 `/` 时匹配完整 relChild 路径（非 basename） | MUST q 不含 `/` 时不变 | D1 | +8 |
| 3 | filter-tree | `app/web/src/components/chat-page/ws-filter-tree.ts` | `FilterTreeResult` | 新增 | 裁剪树结果接口 | MUST | D2 | +6 |
| 4 | filter-tree | 同上 | `buildFilterTree` | 新增 | 扁平命中→裁剪树纯函数（路径拆解+祖先补全+同路径合并+展开列表） | MUST 纯函数 | D2 | ~65 |
| 5 | filter-tree | 同上 | `basename` | 新增 | 迁移自 search-box | MUST | D2 | +3 |
| 6 | search-box | `app/web/src/components/chat-page/component-ws-search-box.tsx` | `WsSearchBoxProps` | 修改 | 删 onOpenFile/onToggleDir；加 onResult | MUST | D3 | +2/-4 |
| 7 | search-box | 同上 | `collectLoaded`+`filterLoaded` | 修改 | 合并为 path+type 输出；q 含 `/` 时 path 匹配 | MUST | D3 | ~15 |
| 8 | search-box | 同上 | `mergeHits` | 修改 | 输出 `{path,type}[]` 去重合并 | MUST | D3 | ~12 |
| 9 | search-box | 同上 | 结果列表 JSX | 删除 | L177-204 扁平列表渲染全删 | MUST 瘦身 | D3 | -28 |
| 10 | search-box | 同上 | 防抖 effect | 修改 | 合并结果→onResult 上报（不再 setHits 渲染） | MUST | D3 | ~10 |
| 11 | search-box | 同上 | `hits`/`tooMany` state | 删除 | 不再内部渲染 | MUST | D3 | -3 |
| 12 | ws-panel | `app/web/src/components/chat-page/section-workspace-panel.tsx` | `filterResult` state | 新增 | 裁剪树状态 | MUST | D4 | +3 |
| 13 | ws-panel | 同上 | `handleSearchResult` | 新增 | onResult 回调→buildFilterTree→setFilterResult | MUST | D4 | ~12 |
| 14 | ws-panel | 同上 | `treeState` 计算 | 新增 | 搜索态裁剪树 state vs 原始 state 切换 | MUST expanded 独立 | D4 | ~8 |
| 15 | ws-panel | 同上 | `ComponentWsSearchBox` 接线 | 修改 | 删 onOpenFile/onToggleDir；加 onResult | MUST | D4 | +1/-2 |
| 16 | ws-panel | 同上 | `ComponentWsFileTree` 条件 | 修改 | 去掉 `!searching` → 常驻；state 改 treeState | MUST 常驻 | D4 | ~3 |
| 17 | ws-panel | 同上 | PathBar 条件 | 不变 | `!searching && PathBar` 保持 | MUST | D4 | 0 |
| 18 | file-tree | `app/web/src/components/chat-page/component-ws-file-tree.tsx` | `WsFileTreeProps.tooMany` | 新增 | 截断提示 prop | MUST | D5 | +1 |
| 19 | file-tree | 同上 | 底部提示渲染 | 新增 | tooMany=true → searchTooMany 文案 | MUST 样式一致 | D5 | +3 |
| 20 | api-client | `app/web/src/lib/chat-api/workspace-api.ts` | `searchWorkspaceFiles` JSDoc | 修改 | 上限 200→100；路径匹配语义 | MUST 类型不变 | D6 | ~3 |
| 21 | i18n | `app/web/src/i18n/locales/zh-CN/chat.json` | `workspace.preview.searchTooMany` | 修改 | 文案更新 | MUST | D7 | 1 |
| 22 | i18n | `app/web/src/i18n/locales/en/chat.json` | `workspace.preview.searchTooMany` | 修改 | 文案更新 | MUST | D7 | 1 |

## 范式归属（逐控件）

| 控件/操作 | 范式 | 理由 |
|-----------|------|------|
| 搜索框输入 | **直接输入 + 防抖**（不变） | 无配置提交语义 |
| 搜索结果渲染 | **数据源切换**（非隐藏/显示） | FileTree 常驻，搜索态切换数据源为裁剪树 |
| 裁剪树目录展开/折叠 | **即时操作**（toggle，复用 lazy GET） | 与正常文件树展开完全一致 |
| 裁剪树文件点击 | **即时操作**（onOpen） | 复用 handleOpen 五路分流 |
| 清空搜索恢复原树 | **即时操作**（filterResult=null） | 数据源切回原始 state |
| 限量提示 | **静态文案** | 底部居中文案，非交互 |

**结论**：所有控件走「即时操作 / 数据源切换」，不引入新范式，不引入 SaveBar。

## 影响面评估

- **跨模块**：server search handler（上限+路径匹配）/ 前端 filter-tree 新模块 / search-box 瘦身 / ws-panel 数据源切换 / file-tree 提示 / api-client JSDoc / i18n
- **破坏性变更**：`ComponentWsSearchBox` Props 变更（删 onOpenFile/onToggleDir、加 onResult）—— 唯一消费方是 section-workspace-panel，同版本同步改；搜索结果上限 200→100（行为变化，PRD 约束）；`walkSearch` 匹配逻辑分叉（q 含 `/` 时行为变化，PRD 约束）
- **依赖顺序**：D1（后端）独立可并行；D2（filter-tree）独立可并行；D3（search-box）依赖 D2 类型；D4（ws-panel）依赖 D2+D3；D5 独立可并行；D6+D7 独立可并行
- **UT 覆盖面**：
  - 后端：`session-workspace-search.test.ts` 加 q 含 `/` 路径匹配用例 + 100 上限用例
  - 前端：`ws-filter-tree.test.ts`（新建）—— buildFilterTree 纯函数单测（裁剪/合并/展开/同路径）
  - 前端：`component-ws-search-box.test.tsx`（新建/改）—— onResult 上报断言（不再断言列表 DOM）
  - 前端：`section-workspace-panel.test.tsx`（改）—— 搜索态 FileTree 常驻断言
