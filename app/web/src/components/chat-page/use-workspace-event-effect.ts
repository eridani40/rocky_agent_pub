/**
 * use-workspace-event-effect —— chat-slice fan-out 的 workspace SSE 事件订阅 effect
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §4.3（SSE 事件处理 + §2.5 recycleSession 契约）
 *       specs/tech/version_logs/v0.0.271/change_plan.md（R1：watch 由 useEffect 重算触发，事件不直接调 watch API）
 *
 * 行为：
 *   - file_changed → dispatch file-changed（wsReducer 内部决定 stale/refresh）
 *   - dir_changed  → dispatch dir-changed（applyWorkspaceDirChanged 清空 tree/childrenCache/expanded →
 *     panel 的 watch-set 重算 effect 自动发新根，无需本 hook 显式 watch）
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
}

/**
 * WorkspacePanel 的 SSE 事件副作用 hook。
 *
 * @param opts sessionId/dispatch
 *
 * 不变量（MUST NOT 破坏）：
 *   - lastWorkspaceEvent null 或 sid 不匹配 → 跳过（早期 return）
 *   - file_changed → 仅 dispatch（wsReducer 内部决定 stale/refresh）
 *   - dir_changed → dispatch + 兜底 GET tree（不阻塞 dispatch）；watch 由 panel watch-set 重算 effect 处理
 */
export function useWorkspaceEventEffect({ sessionId, dispatch }: UseWorkspaceEventEffectOpts): void {
  const lastWorkspaceEvent = useChatStore((s) => s.lastWorkspaceEvent);
  useEffect(() => {
    if (!lastWorkspaceEvent) return;
    if (lastWorkspaceEvent.sessionId !== sessionId) return;
    if (lastWorkspaceEvent.type === 'session_workspace_file_changed') {
      dispatch({ type: 'file-changed', payload: lastWorkspaceEvent });
    } else if (lastWorkspaceEvent.type === 'session_workspace_dir_changed') {
      dispatch({ type: 'dir-changed', payload: lastWorkspaceEvent });
      // dir_changed 重置 tree 后兜底拉新顶层（§2.5 契约）；watch 新根由 panel watch-set 重算 effect 发
      (async () => {
        try {
          const res = await getWorkspaceTree(sessionId);
          dispatch({ type: 'tree-loaded', payload: { dir: res.workspaceDir, tree: res.tree } });
        } catch (e) {
          console.warn('dir_changed tree fetch failed:', e);
        }
      })();
    }
  }, [lastWorkspaceEvent, sessionId, dispatch]);
}
