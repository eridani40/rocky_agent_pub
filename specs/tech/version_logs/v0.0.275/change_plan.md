# v0.0.275 变更计划书 — fs watch 事件驱动重算 + 结构刷新（271 后续修复）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **背景**：271 关注集合模型（watch-set 声明式 + 全量 diff）已落地，但**重算触发源不全**——重算 effect 只依赖 `[tree, expanded, childrenCache]`，fs 事件（stalePaths）不在依赖里 → fs 内容变化不触发重算；stale refetch 只对**已展开**父目录 → 未展开目录结构变化（t1 里建 t2）永不刷新 → `node.hasChildren` 旧值 → **展开按钮（twisty）不出现**。老板拍板（08-07 11:03）：① fs 事件到达 → **无脑重算一次**（不玩精细判断）② 关注集合 = 所有展开文件夹 + 下一级 ③ 面板维护 expanded + watch set 两列表，diff 有变化才针对性订阅。**零后端改动**（事件 payload 已有 kind/isDir）。测试全 UT（不新增 AT/ET 持久 case）。

## 架构裁决（req 关键裁决点落实）

| # | 裁决点 | 结论 | 理由 |
|---|--------|------|------|
| R1 | **fs 事件驱动重算实现** | 重算 effect 依赖加 `state.stalePaths`（file_changed → stalePaths 变化 → 触发重算）+ **本地 diff pre-check**（lastWatchSetRef 存上次集合，`computeWatchSet` 结果与上次比较，**变了才 applyWatchSet**） | 老板「无脑重算一次」= 每次 fs 事件都跑一次 computeWatchSet（O(小)纯函数）；发请求只在集合变时（diff pre-check 防「每事件都 POST」——老板「diff 有变化才针对性订阅」）；幂等（后端 diff no-op 兜底） |
| R2 | **防抖/节流** | 不做前端额外防抖（重算侧）：后端 emitter 已 100ms debounce 聚合（workspace-change-emitter.ts）+ 同 parent 事件 Set 去重（applyWorkspaceFileChanged 已标过即 return）+ React 批处理合并同 render → 重算次数 ≈ 事件批次；**结构刷新侧 50ms 防抖合并**（批量目录增删不逐个 refetch） | 老板「连改多个文件不该每事件都全量重算+发请求」——diff pre-check 已保证「集合没变不发请求」，重算本身 O(小) 可接受；结构刷新是真网络请求（GET tree），需防抖合并 |
| R3 | **结构刷新机制（未展开目录 twisty）** | 新增 `structuralStalePaths`（结构性事件父目录集合）。事件 `kind ∈ {addDir, unlinkDir}` → 父目录 P 额外标 structural；新 effect 监听 → 50ms 防抖 → 对每个 P 调 `handleStaleRefetch(parentOf(P))`（**P 所在层**刷新）→ 触发后清 structural | **关键洞察：twisty 判定 = `node.hasChildren`（component-ws-tree-item.tsx L57，后端返回字段）**——P 的 hasChildren 在 **parentOf(P) 的 children 数组**里（P node 的字段），refetch P 的 children 只更新 P 的子级（P 未展开不渲染，无用）；refetch parentOf(P) 更新 P node → P.hasChildren 正确 → twisty 出现/消失。parentOf('')=根 → GET tree 无 parent（tree-loaded）复用 handleStaleRefetch 既有 '' vs 非空分派 |
| R4 | **已展开父目录渲染刷新** | 既有 stale refetch 保留（component-ws-file-tree.tsx L52 展开父目录 refetch children）——**file-tree 零改动**；结构刷新与之互补（结构刷新管 P twisty，stale refetch 管展开 P 的 children 渲染） | 展开 P 的 children 变化（新子目录出现）由既有路径处理；未展开 P 的 twisty 由结构刷新处理；两机制正交不重叠 |
| R5 | **后端改动评估** | **零后端改动**。事件 payload 已有 `kind`（add/change/unlink/addDir/unlinkDir）+ `isDir`（workspace-change-emitter.ts L89 emit；workspace-types.ts WorkspaceFileChangedEvent.data.kind/isDir）——前端直接消费，无需加字段 | req 架构要点 3：「若现有 file_changed 事件不含此信息，评估是否需要加」——**已含**，无需改后端。普通文件内容改（change/add/unlink）只走既有 stale 路径（展开父目录渲染刷新），不触发结构刷新（不浪费 refetch） |

## 变更清单

<!-- 每行一个函数/符号；相关方法的行放在一起（同模块/同文件相邻） -->

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| workspace-watch(前端) | app/web/src/components/chat-page/workspace-types.ts | WorkspaceState | 修改 | 加 `structuralStalePaths: Set<string>`（结构性变化父目录集合——组件结构刷新 effect 消费；与 stalePaths 语义独立：stalePaths=展开父目录渲染刷新，structuralStalePaths=未展开父目录 twisty 刷新） | MUST 与 stalePaths 并存不互斥；MUST 初始空 Set（initialWorkspaceState 同步加） | req §修复要点2；本 change_plan R3 | +2/-0 |
| workspace-watch(前端) | app/web/src/store/workspace-slice-reducer.ts | initialWorkspaceState() | 修改 | 初始 state 加 `structuralStalePaths: new Set()` | MUST 空 Set | 本 change_plan | +1/-0 |
| workspace-watch(前端) | app/web/src/store/workspace-slice-reducer.ts | applyWorkspaceFileChanged() | 修改 | 事件 `evt.data.kind ∈ {addDir, unlinkDir}`（结构性目录增删）→ 额外把 parentPath 加入 structuralStalePaths（去重，已标过即 return 既有逻辑复用）；非结构性（add/change/unlink 文件）只标 stalePaths（既有行为不变） | MUST 用 `evt.data.kind` 判断结构性（payload 已有，零后端改动）；MUST 结构性事件**同时**标 stalePaths（父目录渲染刷新，既有逻辑）+ structuralStalePaths（twisty 刷新）；MUST NOT 对文件事件（change/add/unlink）标 structural | req §修复要点2；workspace-types.ts WorkspaceFileChangedEvent.data.kind | +8/-0 |
| workspace-watch(前端) | app/web/src/store/workspace-slice-reducer.ts | applyWorkspaceDirChanged() | 修改 | 重置时清 structuralStalePaths（切目录后旧相对路径结构标记失效，同 stalePaths 清理语义） | MUST 与 stalePaths 同步清空（new Set） | 本 change_plan | +1/-0 |
| workspace-watch(前端) | app/web/src/store/workspace-slice-reducer.ts | resetForRefresh() | 修改 | 手动刷新重置时清 structuralStalePaths（刷新后结构新鲜） | MUST 与 stalePaths 同步清空 | 本 change_plan | +1/-0 |
| workspace-watch(前端) | app/web/src/components/chat-page/workspace-watch-set.ts | structuralRefetchTargets() | 新增 | 纯函数：输入 structuralStalePaths（Set<string>，父目录 P 集合）→ `string[]`（每个 P 的 `parentOfPath(P)`，去重 + 排序；'' 保留代表 refetch root tree）——供结构刷新 effect 消费 | MUST 纯函数零副作用可 UT；MUST 复用 parentOfPath（workspace-types 既有）；MUST 去重（同层多个 P → 一次 refetch） | 本 change_plan R3 | +12/-0 |
| workspace-watch(前端) | app/web/src/components/chat-page/section-workspace-panel.tsx | （watch-set 重算 effect，L237-239） | 修改 | 依赖数组加 `state.stalePaths`（fs 事件驱动重算）+ 本地 diff pre-check：`lastWatchSetRef`（useRef）存上次 applyWatchSet 的集合，`computeWatchSet` 结果与上次 `JSON.stringify` 比较，**变了才 applyWatchSet**（集合未变不发 POST） | MUST 依赖含 stalePaths（fs 事件触发源）；MUST 集合未变不发 POST（diff pre-check，防每事件都发请求）；MUST 幂等（后端 diff no-op 兜底）；MUST 首次 mount 也发（lastRef 初始 null） | req §修复要点1；271 change_plan R1；本 change_plan R1/R2 | +10/-2 |
| workspace-watch(前端) | app/web/src/components/chat-page/section-workspace-panel.tsx | （结构刷新 effect，新增） | 新增 | 监听 `state.structuralStalePaths` → 50ms 防抖合并（setTimeout + ref 存 pending）→ 到期对 `structuralRefetchTargets(structuralStalePaths)` 每个 target 调 `handleStaleRefetch(target)`（P 所在层刷新：'' → tree-loaded / 非空 → children-loaded，复用既有分派）→ 触发后立即 dispatch clear structuralStalePaths（防重复 refetch；refetch fire-and-forget，失败 console.warn） | MUST 50ms 防抖（批量目录增删不逐个请求）；MUST 复用 handleStaleRefetch（不改其 '' vs 非空分派）；MUST 触发后清 structural（新 action 或复用 dispatch）；MUST 零后端改动 | req §修复要点2；本 change_plan R3/R4 | +25/-0 |
| workspace-watch(前端) | app/web/src/components/chat-page/component-ws-file-tree.tsx | （stale refetch effect） | 修改 | **零改动**（明确声明：既有展开父目录 stale refetch 保留，与结构刷新正交） | MUST NOT 改 isExpanded 判断（R4 裁决：展开父目录渲染刷新走既有路径） | 本 change_plan R4 | +0 |
| test | app/web/src/store/__tests__/workspace-slice-reducer.test.ts | applyWorkspaceFileChanged 用例 | 修改 | 新增：① addDir 事件 → stalePaths + structuralStalePaths 都标父目录；② unlinkDir 同；③ change/add/unlink 文件事件 → 只标 stalePaths（不标 structural）；④ 同 parent 重复事件去重（已标过不重复标）；⑤ applyWorkspaceDirChanged / resetForRefresh 清 structuralStalePaths | MUST 纯函数直测（构造 WorkspaceFileChangedEvent 含 kind/isDir） | req 验收（UT）；本 change_plan | +35/-0 |
| test | app/web/src/components/chat-page/__tests__/workspace-watch-set.test.ts | structuralRefetchTargets 单测 + computeWatchSet 回归 | 修改 | 新增 structuralRefetchTargets：根一级（'' 保留）/ 深层（parentOf 非空）/ 同层去重 / 空集 → []；computeWatchSet 既有用例全绿（逻辑不变回归） | MUST 纯函数直测零 mock | 本 change_plan R3 | +25/-0 |
| spec-sync(T3) | specs/ui/components/chat-page/component-workspace-panel.md | §4.3 | 修改 | 补「fs 事件驱动重算」：重算 effect 依赖含 stalePaths（fs 事件触发）+ 本地 diff pre-check（集合没变不发 POST）；补「结构刷新」：结构性事件（addDir/unlinkDir）→ structuralStalePaths → 50ms 防抖 → refetch parentOf(P)（未展开目录 twisty 正确，twisty 判定 = node.hasChildren 的刷新语义） | MUST 与实现一致；MUST NOT 改关注集合定义（271 语义保留）；MUST 验证代码实现 == spec 契约 | 本 change_plan R1/R3；271 spec §4.3 | +20/-0 |

## 影响面评估

- **跨模块**：纯前端（workspace-types + workspace-slice-reducer + workspace-watch-set + section-workspace-panel）+ spec 文档（component-workspace-panel.md §4.3）
- **破坏性变更**：无。后端零改动（事件 payload 已含 kind/isDir）；关注集合定义不变（271 语义保留）；watch-set API 契约不变；既有 stale refetch 路径保留（file-tree 零改动）
- **依赖顺序**：T1（前端机制全做）→ T2（spec 同步）。前端文件耦合（reducer + panel + watch-set 同属机制），单 task 串行
- **风险点**：
  1. **结构刷新 refetch parentOf(P) 与既有 stale refetch 重叠**（P 展开时两者都可能 refetch）——无脑都发（老板「禁止精细判断」），幂等 + 防抖合并，重复请求可接受
  2. **structuralStalePaths 清理时机**：effect 触发后立即清（fire-and-forget），refetch 失败（console.warn）后同事件不再重试——失败场景手动刷新兜底（可接受）
  3. **重算 effect 依赖 stalePaths 后每次 fs 事件都跑 computeWatchSet**——O(小) 纯函数 + diff pre-check 不发无谓 POST；密集文件保存（change 事件）触发重算但集合不变 no-op
  4. **深层未展开目录 twisty**（t1 展开、t1/t2 未展开、t1/t2 里建 t3 → P='t1/t2' → refetch parentOf='t1' → childrenCache['t1'] 刷新 → t1/t2.hasChildren 正确）——refetch parentOf(P) 覆盖所有层（不止 root 一级），R3 通用
  5. **空目录（hasChildren=false）与 twisty 的 271 语义**：271 修复「空文件夹被 watch（父级 watch 一级子文件夹）→ 新增文件有事件」——本版结构刷新让空目录变非空后 twisty 出现（t1 空 → 建 t2 → twisty 出现 → 可展开）✅ 完整闭环

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
