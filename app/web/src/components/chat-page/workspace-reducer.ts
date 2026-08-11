/**
 * workspace-reducer —— WorkspacePanel useReducer 的 action 类型 + reducer 函数
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §8（state 转换）
 *
 * 从 section-workspace-panel.tsx 拆出控行数（保持主容器 ≤300 行）。
 * 委托 workspace-slice-reducer 的纯函数（便于单测）。
 */
import type { WsTreeNode, WorkspaceState } from './workspace-types';
import {
  applyWorkspaceDirChanged,
  applyWorkspaceFileChanged,
  clearStructuralStalePaths,
  initialWorkspaceState,
  mergeExpanded,
  resetForRefresh,
  setChildrenLoaded,
  setLoadingChildren,
  setTreeLoaded,
  toggleExpanded,
} from '../../store/workspace-slice-reducer';

/** workspace reducer action 联合（dispatch 用） */
export type WsAction =
  | { type: 'tree-loaded'; payload: { dir: string; tree: WsTreeNode[] } }
  | { type: 'children-loaded'; payload: { path: string; children: WsTreeNode[] } }
  | { type: 'loading-children'; payload: { path: string; loading: boolean } }
  | { type: 'toggle-expand'; payload: { path: string; force?: boolean } }
  | { type: 'reset' }
  | { type: 'fresh' }
  | { type: 'file-changed'; payload: Parameters<typeof applyWorkspaceFileChanged>[1] }
  | { type: 'dir-changed'; payload: Parameters<typeof applyWorkspaceDirChanged>[1] }
  | { type: 'clear-structural' }
  | { type: 'merge-expanded'; payload: { paths: string[] } };

/** workspace reducer（委托 workspace-slice-reducer 纯函数） */
export function wsReducer(s: WorkspaceState, action: WsAction): WorkspaceState {
  switch (action.type) {
    case 'tree-loaded':
      return setTreeLoaded(s, action.payload.dir, action.payload.tree);
    case 'children-loaded':
      return setChildrenLoaded(s, action.payload.path, action.payload.children);
    case 'loading-children':
      return setLoadingChildren(s, action.payload.path, action.payload.loading);
    case 'toggle-expand':
      return toggleExpanded(s, action.payload.path, action.payload.force);
    case 'reset':
      return resetForRefresh(s);
    case 'fresh':
      return { ...initialWorkspaceState(), loading: true };
    case 'file-changed':
      return applyWorkspaceFileChanged(s, action.payload);
    case 'dir-changed':
      return applyWorkspaceDirChanged(s, action.payload);
    case 'clear-structural':
      return clearStructuralStalePaths(s);
    case 'merge-expanded':
      return mergeExpanded(s, action.payload.paths);
    default:
      return s;
  }
}

/** useReducer 初始化函数（切 session 重置） */
export function initWorkspaceState(_: string): WorkspaceState {
  return { ...initialWorkspaceState(), loading: true };
}
