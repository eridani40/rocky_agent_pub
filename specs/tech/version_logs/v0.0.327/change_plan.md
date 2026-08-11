# v0.0.327 变更计划书 — 文件树搜索结果可交互性增强

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD 权威：`specs/prd/version_logs/v0.0.327-search-tree-interactive.md`

## 方案选型：A（effect merge + state.expanded 权威）

PRD 留了两种方案给 architect 选，分析后选 **方案 A**：

| 维度 | 方案 A（effect merge）✅ | 方案 B（本地 overlay state） |
|------|------------------------|---------------------------|
| expanded 源 | `state.expanded` 单一权威（reducer 管） | `state.expanded` + overlay `useState` 双源 |
| handleExpand/handleCollapse | 既有 dispatch toggle-expand 不改 | dispatch 写 state.expanded，overlay 还要另接回调更新（双写） |
| render 时 | 删 expanded 覆盖行，直接用 `state.expanded` | tree/childrenCache 用 filterResult，expanded 用 overlay |
| reducer 改动 | +1 action（merge-expanded）+ 1 纯函数 | 不改 reducer，但组件多一个 useState + effect |
| watch-set effect | 自然受益（state.expanded 变化自动触发重算） | overlay 不在 watch-set deps，需额外同步 |
| 改动量 | 小（3 文件，方案集中） | 中（双 expanded 源维护复杂度高） |

**结论**：方案 A 与既有 reducer 架构一致（toggle-expand 已是 state.expanded 权威），只加 `merge-expanded` action 做初始合并，render 删覆盖逻辑最简洁。

## 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| 问题①根因 | `ws-filter-tree.ts` L134-138 命中目录加入 expandedSet → 命中文件夹被自动展开 | `ws-filter-tree.ts` L133-138 `for (hit of truncated) if dir → expandedSet.add(hit.path)` |
| 问题①修法 | 删 L134-138 循环（5 行）。祖先路径在 L106 `expandedSet.add(currentPath)` 已加入（路径可见性必需），命中目录本身不需要展开 | `ws-filter-tree.ts` L106 祖先路径 expandedSet.add 保留 |
| 问题②根因 | `section-workspace-panel.tsx` L308 `expanded: Object.fromEntries(filterResult.expandedPaths.map(...))` 每次 render 覆盖 state.expanded | `section-workspace-panel.tsx` L302-310 搜索态 state 计算 |
| 问题②修法（方案 A） | filterResult 变化时 effect dispatch `merge-expanded`（filterResult.expandedPaths 合并入 state.expanded）；render 删 expanded 覆盖行，搜索态直接用 `...state`（tree/childrenCache 仍覆盖为 filterResult 数据） | `workspace-reducer.ts` L22-31 WsAction 联合（需加 merge-expanded）；`workspace-slice-reducer.ts` toggleExpanded 纯函数模式参考 |
| WorkspaceState.expanded 类型 | `Record<string, boolean>` | `workspace-types.ts` L46 |
| handleExpand/handleCollapse 不改 | dispatch toggle-expand 写 state.expanded，方案 A 后 render 不覆盖 → 手动操作自然生效 | `section-workspace-panel.tsx` L105-123 handleExpand/handleCollapse |
| childrenCache 补全不变 | L111-128 命中目录缓存补全保留（数据是「能力」，展开是「选择」） | `ws-filter-tree.ts` L111-128 |
| watch-set effect 自然受益 | state.expanded 变化 → L238-244 watch-set 重算 effect 自动触发 | `section-workspace-panel.tsx` L238-244 deps 含 `state.expanded` |

## 设计决策（D 编号）

### D1: 命中文件夹不自动展开 — ws-filter-tree.ts（修改）

**文件**：`app/web/src/components/chat-page/ws-filter-tree.ts`（修改）

**变更**：
- 删 L134-138 命中目录加入 expandedSet 的循环（5 行）：
  ```ts
  // 删除：
  for (const hit of truncated) {
    if (hit.type === 'dir') {
      expandedSet.add(hit.path);
    }
  }
  ```
- 替换为注释说明（保持代码可读）：
  ```ts
  // [v0.0.327] 命中文件夹不自动展开——只显示命中（出现在裁剪树），不暴露子内容；
  //   用户想看内容手动展开。祖先路径在 L106 路径拆解时已加入 expandedSet（路径可见性必需）。
  ```
- L45 JSDoc 第 6 步更新：`6. 展开列表：所有祖先路径（命中目录本身不加入）`

**约束**：MUST 删 L134-138 循环；MUST 保留 L106 祖先路径 expandedSet.add（路径可见性必需）；MUST NOT 改 L111-128 childrenCache 补全逻辑；MUST NOT 改 getOrCreateNode/addChild/路径拆解逻辑。

### D2: reducer 加 merge-expanded action — workspace-reducer.ts + workspace-slice-reducer.ts（修改）

**文件**：
- `app/web/src/store/workspace-slice-reducer.ts`（修改）
- `app/web/src/components/chat-page/workspace-reducer.ts`（修改）

**变更**：

**① workspace-slice-reducer.ts 新增纯函数 `mergeExpanded`**：
```ts
/**
 * 合并展开路径入 state.expanded（MERGE 不覆盖——保留用户已有的手动展开/收起）。
 * 搜索结果到达时初始展开建议用：filterResult.expandedPaths → mergeExpanded。
 * 已展开的路径保留 true；新路径设 true；不删除任何已有 key。
 */
export function mergeExpanded(s: WorkspaceState, paths: string[]): WorkspaceState {
  const expanded = { ...s.expanded };
  for (const p of paths) {
    expanded[p] = true;
  }
  return { ...s, expanded };
}
```

**② workspace-reducer.ts WsAction 联合加 merge-expanded**：
```ts
export type WsAction =
  | ...
  | { type: 'merge-expanded'; payload: { paths: string[] } }
```

**③ workspace-reducer.ts wsReducer switch 加 case**：
```ts
case 'merge-expanded':
  return mergeExpanded(s, action.payload.paths);
```

**④ workspace-reducer.ts import 加 mergeExpanded**：
```ts
import { ..., mergeExpanded } from '../../store/workspace-slice-reducer';
```

**约束**：MUST mergeExpanded 是纯函数（MERGE 不覆盖）；MUST 不删除已有 expanded key（只加 true，不改 false）；MUST NOT 改 toggleExpanded 或其他既有纯函数。

### D3: 搜索态 expanded 改 effect merge + render 删覆盖 — section-workspace-panel.tsx（修改）

**文件**：`app/web/src/components/chat-page/section-workspace-panel.tsx`（修改）

**变更**：

**① 加 effect：filterResult 变化时 dispatch merge-expanded**（在 handleSearchResult 之后）：
```ts
// [v0.0.327] 搜索结果到达 → filterResult.expandedPaths 作为初始展开建议合并入 state.expanded
useEffect(() => {
  if (filterResult) {
    dispatch({ type: 'merge-expanded', payload: { paths: filterResult.expandedPaths } });
  }
}, [filterResult]);
```

**② render 删 expanded 覆盖行**（L302-310 ComponentWsFileTree state prop）：
```tsx
// 改前（L302-310）：
state={searching && filterResult
  ? {
      ...state,
      tree: filterResult.tree,
      childrenCache: { ...state.childrenCache, ...filterResult.childrenCache },
      expanded: Object.fromEntries(filterResult.expandedPaths.map((p) => [p, true])),  // ← 删此行
    }
  : state}

// 改后：
state={searching && filterResult
  ? {
      ...state,
      tree: filterResult.tree,
      childrenCache: { ...state.childrenCache, ...filterResult.childrenCache },
      // [v0.0.327] expanded 不覆盖——state.expanded 权威（merge-expanded effect 初始合并 + toggle-expand 用户操作）
    }
  : state}
```

> 删 `expanded: Object.fromEntries(...)` 行后，搜索态 state 的 expanded 自然继承 `...state.expanded`（spread 展开），用户手动 toggle 和 merge-expanded effect 的结果都在里面。

**约束**：MUST effect deps=[filterResult]（只在新搜索结果到达时触发 merge）；MUST render 删 expanded 覆盖行（state.expanded 权威）；MUST NOT 改 handleExpand/handleCollapse/handleOpen/handleStaleRefetch；MUST NOT 改 tree/childrenCache 覆盖（搜索态仍用 filterResult 数据）；MUST NOT 改非搜索态渲染。

## 文件级变更清单

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---------|---------|----------|------|---------|------|------|-----------|
| 1 | filter-tree | `app/web/src/components/chat-page/ws-filter-tree.ts` | `buildFilterTree` L134-138 | 删除 | 删命中目录加入 expandedSet 循环 | MUST 保留 L106 祖先 | D1 | -5/+2 |
| 2 | filter-tree | 同上 | L45 JSDoc 第6步 | 修改 | 更新说明（命中目录不加入） | MUST | D1 | 1 |
| 3 | slice-reducer | `app/web/src/store/workspace-slice-reducer.ts` | `mergeExpanded` | 新增 | 纯函数：MERGE paths 入 expanded | MUST 不删 key | D2① | +10 |
| 4 | ws-reducer | `app/web/src/components/chat-page/workspace-reducer.ts` | `WsAction` | 修改 | +`merge-expanded` action 类型 | MUST | D2② | +1 |
| 5 | ws-reducer | 同上 | `wsReducer` switch | 修改 | +case 'merge-expanded' | MUST | D2③ | +2 |
| 6 | ws-reducer | 同上 | `import` | 修改 | 加 mergeExpanded | MUST | D2④ | 1 |
| 7 | ws-panel | `app/web/src/components/chat-page/section-workspace-panel.tsx` | filterResult merge effect | 新增 | filterResult 变化时 dispatch merge-expanded | MUST deps=[filterResult] | D3① | +5 |
| 8 | ws-panel | 同上 | ComponentWsFileTree state prop L308 | 修改 | 删 expanded 覆盖行 | MUST state.expanded 权威 | D3② | -1 |

## 范式归属（逐控件）

| 控件/操作 | 范式 | 理由 |
|-----------|------|------|
| 搜索结果文件夹展开/收起 | **即时操作**（toggle-expand，既有） | 与正常文件树一致，dispatch 写 state.expanded |
| 搜索结果文件/文件夹打开 | **即时操作**（onOpen 五路分流，既有） | 324 已全接线 |
| 搜索结果到达初始展开 | **effect 合并**（merge-expanded） | filterResult 变化时 effect 触发，非用户直接操作 |

**结论**：不引入新范式，修复 expanded 状态管理策略。

## 影响面评估

- **跨模块**：ws-filter-tree（删5行）/ workspace-slice-reducer（+纯函数）/ workspace-reducer（+action）/ section-workspace-panel（+effect/-覆盖行）—— 全前端
- **破坏性变更**：无——纯 bug 修复（expanded 管理策略改进），无 props 变更，无 API 变更
- **零后端 / 零 IPC / 零组件 props 改动**
- **依赖顺序**：D1（filter-tree）独立；D2（reducer）独立；D3（ws-panel）依赖 D2（需 merge-expanded action）；D1+D2 可并行，D3 在后
- **UT 覆盖面**：
  - `ws-filter-tree.test.ts`（改）—— 命中目录不在 expandedPaths 断言 + 祖先路径仍展开断言
  - `workspace-slice-reducer.test.ts`（改）—— mergeExpanded 纯函数单测（MERGE 不覆盖 + 不删 key）
  - `section-workspace-panel.test.tsx`（改）—— 搜索态手动展开生效断言（可选，集成层）
- **ET 建议**：搜索→命中文件夹收起→手动展开→收起→改搜索词（交互验证为主）
