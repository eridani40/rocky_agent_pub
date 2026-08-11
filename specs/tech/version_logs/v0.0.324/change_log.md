# v0.0.324 Tech Change Log — 文件树搜索交互升级：裁剪式结果树

> 对应 PRD：`specs/prd/version_logs/v0.0.324-file-tree-search-filter-tree.md`
> 对应 change_plan：`specs/tech/version_logs/v0.0.324/change_plan.md`

## 新增模块

### ws-filter-tree.ts（D2）
裁剪树构建纯函数模块。`buildFilterTree(hits, limit)` 从扁平 `{path, type}[]` 命中列表构建裁剪式结果树：
- 路径拆解：每个 hit 拆出所有祖先路径段
- 祖先补全：创建 dir 容器节点（hasChildren=true）
- 同路径合并：Map 分组按 parentOfPath，同 parent 下多 hit 归入同一 children
- 展开列表：所有祖先 + 命中目录 path → expandedPaths（预填 expanded）
- 输出 `{tree, childrenCache, expandedPaths, hitCount}` 可直接喂给 ComponentWsFileTree

## 变更模块

### session-workspace-search.ts（D1）
- `SEARCH_LIMIT` 200→100
- `walkSearch` 匹配分叉：q 含 `/` → 完整相对路径匹配（relChild.includes）；q 不含 `/` → basename 不变

### component-ws-search-box.tsx（D3）
- 瘦身：删除结果列表 JSX（扁平列表渲染退役）
- Props 变更：删 `onOpenFile`/`onToggleDir`，加 `onResult` callback
- 防抖 effect 改为上报 `{hits: {path,type}[], truncated}` 给父级

### section-workspace-panel.tsx（D4）
- 新增 `filterResult` state + `handleSearchResult` callback
- FileTree 常驻（去掉 `!searching` 条件），数据源按搜索态切换（treeState）
- 搜索态 expanded 独立于原始态（清空恢复）
- childrenCache 合并共享（裁剪树 lazy GET 写入同一 cache）

### component-ws-file-tree.tsx（D5）
- Props 加 `tooMany?: boolean` → 底部截断提示

### workspace-api.ts（D6）
- JSDoc 更新（上限+路径匹配语义）；返回类型不变

### i18n（D7）
- `workspace.preview.searchTooMany` 文案更新（双语）
