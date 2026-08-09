/**
 * use-workspace-structural-refetch —— [v0.0.275] 结构刷新 effect hook
 * 参考: specs/tech/version_logs/v0.0.275/change_plan.md（R3 结构刷新机制）
 *
 * 背景：未展开目录结构变化（t1 里建 t2）→ 展开按钮（twisty）不出现。根因 =
 * twisty 判定 = node.hasChildren（后端字段），P 的 hasChildren 在 parentOf(P) 的
 * children 数组里——refetch P 自己无用（P 未展开不渲染），必须 refetch parentOf(P)
 * 刷新 P node 才能让 twisty 出现/消失。
 *
 * 行为：
 *   - 监听 state.structuralStalePaths（结构性事件 addDir/unlinkDir 的父目录 P 集合）
 *   - 50ms 防抖合并（批量目录增删不逐个 refetch；ref 存 pending timer）
 *   - 到期对 structuralRefetchTargets(structuralStalePaths) 每个 target 调 onRefetch(target)
 *     （'' → tree-loaded / 非空 → children-loaded，复用 panel 既有 handleStaleRefetch 分派）
 *   - 触发后立即 dispatch clear structural（防重复 refetch；refetch fire-and-forget，失败 console.warn）
 *
 * 与既有 stale refetch 正交：stale refetch（component-ws-file-tree.tsx）管已展开父目录
 * children 渲染刷新；本 hook 管未展开目录 twisty 刷新（R4 两机制互补）。
 */
import { useEffect, useRef } from 'react';
import type { WorkspaceState } from './workspace-types';
import { structuralRefetchTargets } from './workspace-watch-set';
import type { WsAction } from './workspace-reducer';

interface UseWorkspaceStructuralRefetchOpts {
  /** workspace state（读 structuralStalePaths） */
  state: WorkspaceState;
  /** workspace reducer dispatch（清 structural + 触发后置位） */
  dispatch: React.Dispatch<WsAction>;
  /** refetch 回调（复用 panel handleStaleRefetch：'' → tree-loaded / 非空 → children-loaded） */
  onRefetch: (parentPath: string) => void;
}

/** 结构刷新防抖窗口（ms）——批量目录增删合并为一次 refetch */
const STRUCTURAL_DEBOUNCE_MS = 50;

/**
 * WorkspacePanel 结构刷新副作用 hook（v0.0.275 R3）。
 *
 * @param opts state/dispatch/onRefetch
 *
 * 不变量（MUST NOT 破坏）：
 *   - structuralStalePaths 空 → 不设 timer、零请求
 *   - 50ms 内新事件合并（只保留最近一次 timer，pending ref 兜底）
 *   - 触发后立即清 structural（dispatch clear-structural）——防重复 refetch；失败由 panel 层 console.warn
 *   - refetch fire-and-forget（不 await；不阻塞 UI）
 */
export function useWorkspaceStructuralRefetch({ state, dispatch, onRefetch }: UseWorkspaceStructuralRefetchOpts): void {
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (state.structuralStalePaths.size === 0) return;

    // 防抖合并：每次新事件重置 timer（50ms 内批量目录增删只 refetch 一次）
    if (pendingRef.current) clearTimeout(pendingRef.current);
    pendingRef.current = setTimeout(() => {
      pendingRef.current = null;
      // 触发后立即清 structural（防重复 refetch；refetch fire-and-forget）
      dispatch({ type: 'clear-structural' });
      for (const target of structuralRefetchTargets(state.structuralStalePaths)) {
        onRefetch(target);
      }
    }, STRUCTURAL_DEBOUNCE_MS);

    // cleanup：卸载/依赖变化时清 pending timer（防泄漏）
    return () => {
      if (pendingRef.current) {
        clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
    };
  }, [state.structuralStalePaths, dispatch, onRefetch]);
}
