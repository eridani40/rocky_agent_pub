/**
 * useWorkspaceWatch —— ws-panel 懒监听 tab 身份 + watch/unwatch 接线（v0.0.139 新增）
 * 参考: specs/api/overall/04-agent-session.md §2.6.5（watch/unwatch 请求契约）
 *       specs/ui/components/chat-page/component-workspace-panel.md §4.3.1（接线小节）
 *       specs/tech/agent/session/[P0]session_workspace_manager.md（懒监听权威模型）
 *
 * 从 section-workspace-panel.tsx 抽出（该文件已接近 300 行上限）：coder 决策，
 * 属合理偏离——change_plan 未预先拆此 hook 文件，已汇报 orchestrator。
 *
 * 职责：
 *   - clientId（tab 身份）：useRef 生成一次 ULID，跨 render/展开/收起/切 session 稳定不变
 *     （后端按 (sessionId, clientId) 记账目录集；换 clientId 会致旧监听孤儿滞留至兜底回收）。
 *   - 根监听：useEffect([sessionId]) 挂载/切 session 时 watch 根（path:''）；
 *     cleanup 闭包捕获**本次 effect 的 sessionId**（旧值，非最新 ref），release-all 发给正确的旧 session
 *     ——避免切 session 时把 release-all 误发给新 session。
 *   - watchPath/unwatchPath：供 section-workspace-panel 的 handleExpand/handleCollapse 调用。
 *
 * 均 best-effort：失败仅 console.warn，不抛、不阻塞 UI（对齐既有 handleOpen 容错风格）。
 */
import { useCallback, useEffect, useRef } from 'react';
import { ulid } from '../../lib/ulid';
import { watchWorkspaceDir, unwatchWorkspaceDir } from '../../lib/chat-api';

export interface WorkspaceWatchHandle {
  /** 展开目录时调用：watch(path)（幂等，重复调用后端不叠加） */
  watchPath: (path: string) => void;
  /** 收起目录时调用：unwatch(path)（该 tab 未持有时后端静默 no-op） */
  unwatchPath: (path: string) => void;
}

export function useWorkspaceWatch(sessionId: string): WorkspaceWatchHandle {
  const clientIdRef = useRef<string | null>(null);
  if (clientIdRef.current === null) clientIdRef.current = ulid();
  const clientId = clientIdRef.current;

  // 根监听 + release-all：挂载/切 session 时 watch 新根，cleanup release-all 旧 session（闭包捕获旧 sessionId）
  useEffect(() => {
    watchWorkspaceDir(sessionId, { clientId, path: '' }).catch((e) =>
      console.warn('watchWorkspaceDir root failed:', e),
    );
    return () => {
      unwatchWorkspaceDir(sessionId, { clientId }).catch((e) =>
        console.warn('unwatchWorkspaceDir release-all failed:', e),
      );
    };
  }, [sessionId, clientId]);

  const watchPath = useCallback(
    (path: string) => {
      watchWorkspaceDir(sessionId, { clientId, path }).catch((e) =>
        console.warn('watchWorkspaceDir failed:', path, e),
      );
    },
    [sessionId, clientId],
  );

  const unwatchPath = useCallback(
    (path: string) => {
      unwatchWorkspaceDir(sessionId, { clientId, path }).catch((e) =>
        console.warn('unwatchWorkspaceDir failed:', path, e),
      );
    },
    [sessionId, clientId],
  );

  return { watchPath, unwatchPath };
}
