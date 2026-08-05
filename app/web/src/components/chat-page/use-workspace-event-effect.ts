/**
 * use-workspace-event-effect —— chat-slice fan-out 的 workspace SSE 事件订阅 effect
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §4.3（SSE 事件处理 + §2.5 recycleSession 契约）
 *
 * 行为：
 *   - file_changed → dispatch file-changed（wsReducer 内部决定 stale/refresh）
 *   - dir_changed  → dispatch dir-changed + watchPath('') 重新 watch 新根（§2.5：后端 recycleSession 清光旧监听）+ 兜底 GET tree
 */
import { useEffect } from 'react';
import { useChatStore } from '../../store/chat-slice';
import { getWorkspaceTree } from '../../lib/chat-api';
import type { WsAction } from './workspace-reducer';

interface UseWorkspaceEventEffectOpts {
  /** 当前 active session id（事件按 sid 过滤） */
  sessionId: string;
  /** workspace reducer dispatch（panel 由 useReducer 提供） */
  dispatch: React.Dispatch<WsAction>;
  /** watch 新根用（§2.5：dir_changed 后端清光监听，前端须重新 POST watch(path:'')） */
  watchPath: (path: string) => void;
}

/**
 * WorkspacePanel 的 SSE 事件副作用 hook。
 *
 * @param opts sessionId/dispatch/watchPath 三件套
 *
 * 不变量（MUST NOT 破坏）：
 *   - lastWorkspaceEvent null 或 sid 不匹配 → 跳过（早期 return）
 *   - file_changed → 仅 dispatch（wsReducer 内部决定 stale/refresh）
 *   - dir_changed → dispatch + watchPath('') + 兜底 GET tree（不阻塞 dispatch）
 */
export function useWorkspaceEventEffect({ sessionId, dispatch, watchPath }: UseWorkspaceEventEffectOpts): void {
  const lastWorkspaceEvent = useChatStore((s) => s.lastWorkspaceEvent);
  useEffect(() => {
    if (!lastWorkspaceEvent) return;
    if (lastWorkspaceEvent.sessionId !== sessionId) return;
    if (lastWorkspaceEvent.type === 'session_workspace_file_changed') {
      dispatch({ type: 'file-changed', payload: lastWorkspaceEvent });
    } else if (lastWorkspaceEvent.type === 'session_workspace_dir_changed') {
      dispatch({ type: 'dir-changed', payload: lastWorkspaceEvent });
      // §2.5：后端 recycleSession 已清光该 session 全部监听、不自动重启；
      // 本 tab 都需重新 watch 新根（否则根级 SSE 停摆直到用户展开子目录）。
      watchPath('');
      // dir_changed 重置 tree 后兜底拉新顶层
      (async () => {
        try {
          const res = await getWorkspaceTree(sessionId);
          dispatch({ type: 'tree-loaded', payload: { dir: res.workspaceDir, tree: res.tree } });
        } catch (e) {
          console.warn('dir_changed tree fetch failed:', e);
        }
      })();
    }
  }, [lastWorkspaceEvent, sessionId, watchPath, dispatch]);
}
