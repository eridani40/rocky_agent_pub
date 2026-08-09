# v0.0.275 tech change log — fs watch 事件驱动重算 + 结构刷新（271 后续修复）

> 对应需求：`reqs/[working] v0.0.275/req.md`（老板 08-07 11:03 拍板：fs 事件无脑重算 + 结构刷新）。
> 权威契约：`specs/tech/version_logs/v0.0.275/change_plan.md`（5 裁决 R1-R5，frozen）。

## 变更摘要

### 需求与动机

271 关注集合模型（watch-set 声明式 + 全量 diff）已落地，但**重算触发源不全**——重算 effect 只依赖 `[tree, expanded, childrenCache]`，fs 事件（stalePaths）不在依赖 → fs 内容变化不触发重算；stale refetch 只对**已展开**父目录 → 未展开目录结构变化（t1 里建 t2）永不刷新 → `node.hasChildren` 旧值 → **展开按钮（twisty）不出现**。老板拍板：① fs 事件到达 → 无脑重算一次（不玩精细判断）② 关注集合 = 所有展开文件夹 + 下一级（271 语义保留）③ 面板维护 expanded + watch set 两列表，diff 有变化才针对性订阅。**零后端改动**（事件 payload 已有 kind/isDir）。

### 方案（5 架构裁决 R1-R5，详见 change_plan「架构期裁决」）

1. **R1 fs 事件驱动重算**：重算 effect 依赖加 `state.stalePaths`（file_changed → stalePaths 变 → 触发重算）+ **本地 diff pre-check**（lastWatchSetRef 存上次集合，`computeWatchSet` 结果 `JSON.stringify` 比较，**变了才 applyWatchSet**）。
2. **R2 防抖/节流**：重算侧不额外防抖（后端 emitter 100ms 聚合 + Set 去重 + React 批处理 + diff pre-check 足够）；**结构刷新侧 50ms 防抖合并**（批量目录增删不逐个 refetch）。
3. **R3 结构刷新（核心）**：新增 `structuralStalePaths: Set<string>`（结构性事件父目录 P 集合）；事件 `kind ∈ {addDir, unlinkDir}` → 父目录 P 额外标 structural（与 stalePaths 双标不互斥）；新 effect hook 50ms 防抖 → 对 `structuralRefetchTargets(P)`（每个 P 的 `parentOfPath(P)` 去重排序，'' 保留）调 `handleStaleRefetch(parentOf(P))`（P 所在层刷新）→ 触发后清 structural。
4. **R4 已展开父目录渲染刷新**：既有 stale refetch 保留（component-ws-file-tree.tsx **零改动**）——展开 P 的 children 变化由既有路径处理，未展开 P 的 twisty 由结构刷新处理，两机制正交。
5. **R5 后端零改动**：事件 payload 已含 `kind`（add/change/unlink/addDir/unlinkDir）+ `isDir`（workspace-change-emitter.ts L89 emit；workspace-types.ts WorkspaceFileChangedEvent.data.kind/isDir）——前端直接消费判断结构性，无需加字段。

### T1 — 前端机制全做（commit a7bc0364c）

- **`workspace-types.ts`**：`WorkspaceState` 加 `structuralStalePaths: Set<string>`（结构性变化父目录集合——组件结构刷新 effect 消费；与 stalePaths 语义独立并存）。
- **`workspace-slice-reducer.ts`**：`initialWorkspaceState` 加空 Set；`applyWorkspaceFileChanged` 对 `kind ∈ {addDir, unlinkDir}` 额外把 parentPath 加入 structuralStalePaths（**双标**：同时标 stalePaths 既有逻辑 + structuralStalePaths；文件事件只标 stalePaths；幂等去重——双标都已有 → 返回同引用不重建）；`applyWorkspaceDirChanged` / `resetForRefresh` 清 structuralStalePaths（与 stalePaths 同步清空）；新增 `clearStructuralStalePaths` 纯函数（size===0 return state 防无谓 render）。
- **`workspace-watch-set.ts`**：新增 `structuralRefetchTargets(structuralStalePaths)` 纯函数——每个 P 的 `parentOfPath(P)` 去重 + 排序，'' 保留代表 refetch root tree（供结构刷新 effect 消费）。
- **`use-workspace-structural-refetch.ts`（表外新 hook，73 行）**：监听 `structuralStalePaths` → 50ms 防抖（pendingRef 存 timer，新事件重置）→ 到期 dispatch clear-structural + 对 `structuralRefetchTargets` 每个 target 调 `onRefetch(parentOf(P))`（fire-and-forget，失败由 panel 层 console.warn）→ cleanup 清 timer。
- **`section-workspace-panel.tsx`**：重算 effect 依赖加 `state.stalePaths` + `lastWatchSetRef` diff pre-check（集合没变不发 POST，防每事件都发请求；首次 mount lastRef=null 必发）；挂结构刷新 hook（`useWorkspaceStructuralRefetch({ state, dispatch, onRefetch: handleStaleRefetch })` 复用既有 '' vs 非空分派）。
- **`workspace-reducer.ts`（表外最小适配，6 行）**：加 `clear-structural` action（委托 clearStructuralStalePaths 纯函数）——结构刷新 effect 触发后清 structural 的必要动作。
- **`component-ws-file-tree.tsx`**：**零改动**（R4 明确声明：既有展开父目录 stale refetch 保留，与结构刷新正交）。

### 测试

`workspace-slice-reducer.test.ts`（structural 标定/去重/重置清 + clearStructuralStalePaths）+ `workspace-watch-set.test.ts`（structuralRefetchTargets 根一级/深层/同层去重/排序/空集 + computeWatchSet 回归）+ `section-workspace-panel.test.tsx`（复现场景集成：t1 里建 t2 → addDir → 50ms 防抖 → refetch root → t1 twisty 出现 → 无重复 refetch）。

## 代码↔spec 核实（doc-modifier 阶段 5，4 项）

| # | 契约点 | 核实结果 |
|---|--------|----------|
| 1 | 重算 effect 依赖含 stalePaths + lastWatchSetRef diff pre-check | ✅ section-workspace-panel.tsx L230-241：依赖 `[state.tree, state.expanded, state.childrenCache, state.stalePaths, applyWatchSet]`；`JSON.stringify` 比较 lastWatchSetRef，相同 return 不发 POST；首次 mount null 必发 |
| 2 | 结构刷新链路：双标 → 50ms 防抖 → structuralRefetchTargets → refetch parentOf(P) → 清 structural | ✅ reducer `isStructural = kind==='addDir' \|\| 'unlinkDir'` 双标（L63-77）；hook 50ms 防抖 + dispatch clear-structural + 对 targets 调 onRefetch（use-workspace-structural-refetch.ts L48-73）；structuralRefetchTargets 纯函数 parentOfPath 去重排序（workspace-watch-set.ts L60-65）；handleStaleRefetch '' vs 非空分派（section-workspace-panel.tsx L135-153） |
| 3 | twisty 判定 = node.hasChildren 未变 | ✅ component-ws-tree-item.tsx L57 `const hasTwisty = isDir && node.hasChildren`（后端字段，本版未动） |
| 4 | 老板口径：全量重算唯一中枢 + 两机制正交 | ✅ computeWatchSet 仍是唯一重算入口（tree/expanded/childrenCache 变化 → 全量重算 → applyWatchSet）；「重算订阅」管增量（diff）+「结构刷新 refetch」管当前快照（parentOf(P) 真 GET）拆开正交 |

## 偏离记录

1. **结构刷新 effect 拆独立 hook（coder 偏离，已报 leader）**：change_plan 写「section-workspace-panel.tsx 新增结构刷新 effect」，但主容器原 299 行压线（文件 ≤300 强制）——拆出 `use-workspace-structural-refetch.ts`（73 行新 hook）+ 主容器 300 行达标。**必要等价**：功能语义与 R3 完全一致（50ms 防抖 + structuralRefetchTargets + refetch parentOf(P) + 清 structural），仅文件组织差异。
2. **workspace-reducer.ts 加 clear-structural action（coder 偏离，已报 leader）**：change_plan 未列 reducer action 变更，但「触发后清 structural」需 action 类型——`clear-structural` 委托 clearStructuralStalePaths 纯函数（coversFiles 内）。**必要最小适配**：不加则结构刷新 effect 无法清 structural（防重复 refetch 语义缺失），不破既有 action。

## 文档同步（doc-modifier T2）

- `specs/ui/components/chat-page/component-workspace-panel.md`：§4.3 补「fs 事件驱动重算」（重算 effect 依赖含 stalePaths + diff pre-check）+「结构刷新」（结构性事件 → structuralStalePaths → 50ms 防抖 → refetch parentOf(P)，twisty = node.hasChildren 刷新语义）+ 两机制正交口径 + Props 表补 structuralStalePaths。**关注集合定义未改**（271 语义保留）。
- `specs/tech/version_logs/v0.0.275/change_log.md`：本文件（5 裁决摘要 + T1 变更详情 + 核实表 + 偏离记录）。
