/**
 * use-chat-actions —— PageChat 列表/拓扑 action handler 收敛 hook
 * 参考: specs/tech/version_logs/v0.0.156/change_plan.md §2.5（A3 原始重组 + INV-A3-2 防 stale closure）
 *       specs/tech/app/frontend/[P0]chat_session_assembly.md（v0.0.216 会话内 handler 内置化）
 *
 * [v0.0.216] 裁剪：发送/HITL/picker/compact/clear/enqueue 类会话内 handler 已内置
 *   SectionChatSession（统一装配层），本 hook 只留页面级列表/拓扑 handler：
 *   openSession / handleCreate / handleDelete / handleRenameTitle / handleSelectSub
 *   / handleTogglePin（[v0.0.231] 置顶）。
 *   保留 handler 函数体零变化（useCallback deps 与原版字面一致，防 stale closure）。
 *
 * 边界：hook 不持 state，所有数据通过 deps 透传（store selectors/setters + error setter）。
 */
import { useCallback } from 'react';
import {
  createSession,
  deleteSession,
  listSessions,
  markSessionRead,
  updateSession,
} from '../../lib/chat-api';
import type { Session } from './types';

/**
 * hook 入参契约（闭环 deps 全列出 — 防 stale closure，INV-A3-2）。
 */
export interface UseChatActionsDeps {
  /** store selectors */
  activeSessionId: string | null;
  sessions: Session[];
  /** store setters */
  setSessions: (sessions: Session[]) => void;
  setActiveSession: (id: string | null) => void;
  setSessionUnread: (id: string, unread: boolean) => void;
  setActiveSubId: (id: string | null) => void;
  /** page-chat local error state setter（list/create/delete 错误 → conv-panel） */
  setError: (e: string | null) => void;
}

/**
 * hook 返回契约（列表/拓扑 handlers）。
 */
export interface UseChatActionsReturn {
  openSession: (sid: string) => Promise<void>;
  handleCreate: () => Promise<void>;
  handleDelete: (id: string) => Promise<void>;
  handleRenameTitle: (id: string, newTitle: string) => void;
  handleSelectSub: (subSessionId: string) => void;
  /** [v0.0.231] 置顶/取消置顶（fire-and-forget PUT {pinned}，无乐观更新） */
  handleTogglePin: (id: string, pinned: boolean) => void;
}

/**
 * useChatActions：PageChat 的列表/拓扑 handler 收敛。
 */
export function useChatActions(deps: UseChatActionsDeps): UseChatActionsReturn {
  const {
    activeSessionId,
    sessions,
    setSessions,
    setActiveSession,
    setSessionUnread,
    setActiveSubId,
    setError,
  } = deps;

  // 切会话：setActiveSession（SectionChatSession key remount 自动重订阅/重拉）+ mark-read（清未读红点）。
  // 切顶层会话清空 activeSubId：subagent 只读页（activeSubId 非空）→ 点顶层
  //   若不清 null，viewedSessionId = activeSubId ?? activeSessionId 因 ?? 短路不变 → 右侧卡死。
  //   查 sid derivation，非 subagent 才清 null（保护 handleSelectSub 先设的 subSid 不被冲）。
  //   handleDelete 不走 openSession，单独清 null。
  const openSession = useCallback(
    async (sid: string) => {
      const targetIsSubagent = sessions.find((s) => s.id === sid)?.derivation === 'subagent';
      if (!targetIsSubagent) {
        setActiveSubId(null);
      }
      setActiveSession(sid);
      // 显式标读（清未读红点，api §2.3.1）：失败 catch 不阻塞 UI。
      markSessionRead(sid)
        .then((r) => setSessionUnread(sid, r.session.unread === true))
        .catch((e) => console.warn('markSessionRead failed:', e));
    },
    [setActiveSession, setSessionUnread, setActiveSubId, sessions],
  );

  // 新建会话
  const handleCreate = useCallback(async () => {
    try {
      const s = await createSession();
      const list = await listSessions();
      setSessions(list);
      await openSession(s.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [setSessions, openSession]);

  // 删除会话。删当前 active → 回到空态：同步清 activeSubId（防 viewedSessionId 短路到旧 subagent）。
  //   旧版 setMessages([]) 清残留已不需要——messages 内置于 SectionChatSession，
  //   sessionId 变 null 即 key remount 到空态。
  const handleDelete = useCallback(
    async (id: string) => {
      try {
        await deleteSession(id);
        const list = await listSessions();
        setSessions(list);
        if (activeSessionId === id) {
          setActiveSubId(null);
          setActiveSession(null);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [setSessions, activeSessionId, setActiveSession, setActiveSubId],
  );

  // conv-item title 改名：PUT {title, titled:true}（titled:true 防后续 AI 名覆盖）→
  // 后端 updateSession + metaBroadcaster.broadcast(sid) → session_meta_update → 列表 reducer 整条替换。
  const handleRenameTitle = useCallback(
    (id: string, newTitle: string) => {
      updateSession(id, { title: newTitle, titled: true }).catch((e) =>
        console.warn('renameTitle failed:', e),
      );
    },
    [],
  );

  // 点 subagent 子项 → 切到该 subagent session
  const handleSelectSub = useCallback(
    (subSessionId: string) => {
      setActiveSubId(subSessionId);
      void openSession(subSessionId);
    },
    [setActiveSubId, openSession],
  );

  // [v0.0.231] 置顶/取消置顶：PUT {pinned} fire-and-forget（同 handleRenameTitle 先例）——
  // 无乐观本地更新，归位靠后端 metaBroadcaster.broadcast → session_meta 广播 +
  // chat-slice compareSessionsForList 统一比较器（spec _overview.md §4.1 统一排序契约）。
  const handleTogglePin = useCallback((id: string, pinned: boolean) => {
    updateSession(id, { pinned }).catch((e) =>
      console.warn('togglePin failed:', e),
    );
  }, []);

  return {
    openSession,
    handleCreate,
    handleDelete,
    handleRenameTitle,
    handleSelectSub,
    handleTogglePin,
  };
}
