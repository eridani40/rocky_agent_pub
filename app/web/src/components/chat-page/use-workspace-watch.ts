/**
 * useWorkspaceWatch —— ws-panel 懒监听 tab 身份 + watch-set 接线（v0.0.271 重构）
 * 参考: specs/api/overall/04-agent-session.md §2.6.5（watch-set 请求契约）
 *       specs/ui/components/chat-page/component-workspace-panel.md §4.3.1（接线小节）
 *       specs/tech/agent/session/[P0]session_workspace_manager.md（懒监听权威模型）
 *
 * 从 section-workspace-panel.tsx 抽出（该文件已接近 300 行上限）：coder 决策，
 * 属合理偏离——change_plan 未预先拆此 hook 文件，已汇报 orchestrator。
 *
 * 职责：
 *   - clientId（tab 身份）：useRef 生成一次 ULID，跨 render/展开/收起/切 session 稳定不变
 *     （后端按 (sessionId, clientId) 记账目录集；换 clientId 会致旧监听孤儿滞留至兜底回收）。
 *   - applyWatchSet(paths)：全量声明式替换该 tab 关注集合（POST watch-set）。
 *     每次调用发**完整集合**（非增量）；后端与上次 diff 增删 + 不在新集合一律 close（对账兜底）。
 *   - cleanup：卸载/切 session 时 release-all（unwatch 无 path），闭包捕获本次 effect 的 sessionId
 *     （旧值，非最新 ref）——避免切 session 时把 release-all 误发给新 session。
 *
 * 均 best-effort：失败仅 console.warn，不抛、不阻塞 UI（对齐既有 handleOpen 容错风格）。
 */
import { useCallback, useEffect, useRef } from 'react';
import { ulid } from '../../lib/ulid';
import { watchWorkspaceSet, unwatchWorkspaceDir } from '../../lib/chat-api';

export interface WorkspaceWatchHandle {
  /** 全量声明式替换该 tab 的关注集合（POST watch-set；后端 diff 增删；调用方每次传完整集合） */
  applyWatchSet: (paths: string[]) => void;
}

export function useWorkspaceWatch(sessionId: string): WorkspaceWatchHandle {
  const clientIdRef = useRef<string | null>(null);
  if (clientIdRef.current === null) clientIdRef.current = ulid();
  const clientId = clientIdRef.current;

  // cleanup：卸载/切 session 时 release-all（闭包捕获旧 sessionId，发给正确的旧 session）
  useEffect(() => {
    return () => {
      unwatchWorkspaceDir(sessionId, { clientId }).catch((e) =>
        console.warn('unwatchWorkspaceDir release-all failed:', e),
      );
    };
  }, [sessionId, clientId]);

  const applyWatchSet = useCallback(
    (paths: string[]) => {
      watchWorkspaceSet(sessionId, { clientId, paths }).catch((e) =>
        console.warn('watchWorkspaceSet failed:', e),
      );
    },
    [sessionId, clientId],
  );

  return { applyWatchSet };
}
