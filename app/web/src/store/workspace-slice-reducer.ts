/**
 * workspace-slice-reducer —— v0.0.17 WorkspacePanel state 纯函数 reducer（lazy 加载）
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §3（数据契约）+ §8（state）
 *       specs/tech/agent/session/[P0]session_event.md §2（workspace event payload）
 *
 * 纯函数（便于单测）：
 *   - applyWorkspaceFileChanged(state, evt): 已展开父目录 → 标记该父 re-fetch
 *     （这里只标 stale，真正 re-fetch 由组件 effect 拉起）；未展开 → 标 stale（不立即拉）。
 *   - applyWorkspaceDirChanged(state, evt): 重置 tree state（清 cache + expanded + stale）+
 *     更新 workspaceDir；后续 GET 顶层由组件 effect 触发。
 *   - setChildrenLoaded / setLoadingChildren / toggleExpanded / setTreeLoaded / markStale:
 *     组件拉数据后直接调用的状态更新。
 *
 * 分流策略（spec §3.2）：
 *   - watch event 不按子目录动态管理（chokidar 永远 watch 整个 workspaceDir）。
 *   - 前端按「父目录是否展开」决定立即 re-fetch（标记 stale 让组件 effect 触发）还是只标 stale
 *     （下次展开时清缓存重拉）。
 */
import type {
  WorkspaceDirChangedEvent,
  WorkspaceFileChangedEvent,
  WorkspaceState,
  WsTreeNode,
} from '../components/chat-page/workspace-types';
import { parentOfPath } from '../components/chat-page/workspace-types';
import { compareWorkspaceNodes } from '../lib/natural-sort';

/** 初始 workspace state（未拉数据） */
export function initialWorkspaceState(): WorkspaceState {
  return {
    workspaceDir: '',
    tree: [],
    childrenCache: {},
    expanded: {},
    loadingChildren: {},
    stalePaths: new Set<string>(),
    loading: false,
  };
}

/**
 * 应用一条 session_workspace_file_changed event 到 workspace state（§3.2）。
 *
 * 分流逻辑（spec §3.2）：
 *   1. 计算变化文件的父目录 parentPath（顶层时 = ''）
 *   2. 父目录已展开（expanded[parentPath] === true）→ 把 parentPath 加入 stalePaths
 *      （组件 effect 监听 stalePaths 变化 → re-fetch 该层子节点；100ms debounce 由后端聚合）
 *   3. 父目录未展开 → 仅标记父目录 stale（下次展开时清缓存重拉，不立即拉）
 *
 * 无论父展开与否都标 stale（区分仅在于组件是否触发 re-fetch）；re-fetch 由组件层观察 stalePaths。
 */
export function applyWorkspaceFileChanged(
  state: WorkspaceState,
  evt: WorkspaceFileChangedEvent,
): WorkspaceState {
  const relPath = evt.data?.path ?? '';
  if (!relPath) return state;
  const parentPath = parentOfPath(relPath);
  // 已经标过 stale 就不重建 Set（避免无谓 render）
  if (state.stalePaths.has(parentPath)) return state;
  const next = new Set(state.stalePaths);
  next.add(parentPath);
  return { ...state, stalePaths: next };
}

/**
 * 应用一条 session_workspace_dir_changed event 到 workspace state（§3.2）。
 *
 * 行为（spec §3.2）：
 *   - 路径栏 workspaceDir 更新为 data.workspaceDir
 *   - 重置 tree：清掉所有已加载子目录缓存（childrenCache）+ expanded + stalePaths + loadingChildren
 *   - tree 清空（顶层 GET 由组件 effect 重新触发）
 *   - loading=true（等组件拉新顶层 tree）
 */
export function applyWorkspaceDirChanged(
  state: WorkspaceState,
  evt: WorkspaceDirChangedEvent,
): WorkspaceState {
  // 后端通常发送非空 workspaceDir；缺字段或空串时兜底保留原值
  const newDir = evt.data?.workspaceDir;
  return {
    workspaceDir: newDir && newDir.length > 0 ? newDir : state.workspaceDir,
    tree: [],
    childrenCache: {},
    expanded: {},
    loadingChildren: {},
    stalePaths: new Set<string>(),
    loading: true,
  };
}

/** GET 顶层 tree 成功后调用：填 tree + workspaceDir + 清 loading + 顶层从 stale 移除。
 *  ingest 时复制后排序（文件夹置顶 + 自然序），不突变 caller 入参（§4.X）。 */
export function setTreeLoaded(
  state: WorkspaceState,
  workspaceDir: string,
  tree: WsTreeNode[],
): WorkspaceState {
  const sortedTree = [...tree].sort(compareWorkspaceNodes);
  const next = new Set(state.stalePaths);
  next.delete(''); // 顶层 stale 清掉
  return {
    ...state,
    workspaceDir,
    tree: sortedTree,
    loading: false,
    stalePaths: next,
  };
}

/** 展开文件夹时拉子目录成功后调用：填 childrenCache[path] + 清 loading[path] + path 从 stale 移除。
 *  ingest 时复制后排序（文件夹置顶 + 自然序），不突变 caller 入参（§4.X）。 */
export function setChildrenLoaded(
  state: WorkspaceState,
  parentPath: string,
  children: WsTreeNode[],
): WorkspaceState {
  const sortedChildren = [...children].sort(compareWorkspaceNodes);
  const next = new Set(state.stalePaths);
  next.delete(parentPath);
  return {
    ...state,
    childrenCache: { ...state.childrenCache, [parentPath]: sortedChildren },
    loadingChildren: { ...state.loadingChildren, [parentPath]: false },
    stalePaths: next,
  };
}

/** 标记某 path 子目录 loading（显示 ws-tree-loading spinner） */
export function setLoadingChildren(
  state: WorkspaceState,
  parentPath: string,
  loading: boolean,
): WorkspaceState {
  const loadingChildren = { ...state.loadingChildren };
  if (loading) {
    loadingChildren[parentPath] = true;
  } else {
    delete loadingChildren[parentPath];
  }
  return { ...state, loadingChildren };
}

/** toggle 文件夹展开态（§4.3）；force 可指定展开/收起（展开拉子目录由组件层判断） */
export function toggleExpanded(
  state: WorkspaceState,
  path: string,
  force?: boolean,
): WorkspaceState {
  const next = force === undefined ? !state.expanded[path] : force;
  return { ...state, expanded: { ...state.expanded, [path]: next } };
}

/** 手动刷新（§3.3）：重置 tree + 清 cache/stale，loading=true，组件重新 GET 顶层。
 *  保留 expanded（由组件层按展开层逐层补回 childrenCache，见 expandedPathsByDepth）。
 */
export function resetForRefresh(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    tree: [],
    childrenCache: {},
    loadingChildren: {},
    stalePaths: new Set<string>(),
    loading: true,
  };
}

/**
 * 收集当前已展开的目录 path，按路径深度（'/' 个数）升序排序（§3.3 逐层补回）。
 *
 * 用途（spec §3.3）：手动刷新 resetForRefresh 清掉 childrenCache 后，组件需按
 * expanded 集合**逐层 GET ?parent=<path>** 补回 childrenCache；父目录必须先于子目录
 * 补回（组件渲染时父层先有 children 才会向下一层递归）。
 *
 * 排序依据：路径深度（'/' 个数）。例如 ['src', 'src/utils', 'docs'] →
 * ['src', 'docs', 'src/utils']（深度 0 的先、深度 1 的后；同深度顺序无关）。
 *
 * @param expanded 展开态 per path（spec §8 state.expanded）
 * @returns 已展开 path 数组（深度升序）；不含顶层占位（顶层由 GET tree 无 parent 拉取）
 */
export function expandedPathsByDepth(expanded: Record<string, boolean>): string[] {
  return Object.keys(expanded)
    .filter((p) => expanded[p] === true && p.length > 0)
    .sort((a, b) => {
      const da = (a.match(/\//g) ?? []).length;
      const db = (b.match(/\//g) ?? []).length;
      return da - db;
    });
}
