/**
 * page-chat —— 会话区页根（v0.0.216 瘦身：主区改 SectionChatSession 统一装配层）
 * 参考: specs/ui/components/chat-page/_overview.md §1-§5
 *       specs/ui/components/chat-page/section-chat-session.md（消费方接入清单）
 *       specs/tech/app/frontend/[P0]chat_session_assembly.md（统一装配层契约）
 *
 * 职责：store 留列表/拓扑/workspace；挂载由 usePageChatMount 走 useLifecycle（GET /session +
 *   订阅 session_meta `_all`）；主区 = SectionChatSession（area-hooks/HITL/picker/usage/minimap
 *   全内置，playground kind 能力全开）。页面残留 = conv-panel + 三栏布局 + workspace-panel +
 *   空态欢迎 hero + topbarLeft 实时标题（store 列表标题 → AI 自动命名即时可见，chrome 是 GET-once 快照）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SectionConvPanel } from './section-conv-panel';
import { SectionChatSession, ChatSessionTopbarLeft } from './section-chat-session';
import { SectionWorkspacePanel } from './section-workspace-panel';
import { ComponentEmptyState } from './component-empty-state';
// [v0.0.182] 三栏响应式布局 hook
import { useThreeColLayout } from './use-three-col-layout';
// 挂载 effect（拉 sessions + 订阅 session_meta）；hook 内部走 getSseClient() 单例
import { usePageChatMount } from './use-page-chat-mount';
// 列表/拓扑 action handler（发送/HITL/picker 类 handler 已内置 SectionChatSession）
import { useChatActions } from './use-chat-actions';
import { useSubagentChildren } from './use-subagent-children';
import { useChatStore } from '../../store/chat-slice';

export function PageChat() {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const setSessions = useChatStore((s) => s.setSessions);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const setSessionUnread = useChatStore((s) => s.setSessionUnread);
  const childrenByParent = useChatStore((s) => s.childrenByParent);
  const activeSubId = useChatStore((s) => s.activeSubId);
  const setActiveSubId = useChatStore((s) => s.setActiveSubId);

  // viewedSessionId = activeSubId ?? activeSessionId（兼顾 subagent 只读页；
  //   subagent readOnly 由 chrome.readOnly=derivation==='subagent' 数据驱动）
  const viewedSessionId = activeSubId ?? activeSessionId ?? '';

  const [error, setError] = useState<string | null>(null);

  // subagent children 拉取 hook
  const { refreshChildren, fetchedRef: childrenFetchedRef } = useSubagentChildren();

  // 挂载 lifecycle（onInit 拉列表 + 订阅 session_meta `_all`；onEvent applyCrud upsert 投影 store）。
  //   subagent transcript 实时性由 SectionChatSession 内 useMessages 的 agent_loop 订阅承担，此处不接线。
  usePageChatMount({ setSessions, setError, refreshChildren, childrenFetchedRef });

  // 列表/拓扑 handler（openSession/create/delete/rename/selectSub/togglePin）
  const actions = useChatActions({
    activeSessionId,
    sessions,
    setSessions,
    setActiveSession,
    setSessionUnread,
    setActiveSubId,
    setError,
  });

  // 顶层 sessions 列表过滤掉 subagent（按 derivation）
  const topSessions = sessions.filter((s) => s.derivation !== 'subagent');
  // 实时标题：store 列表（session_meta SSE 驱动）→ AI 自动命名/改名即时可见。
  // titled===false → defaultTitle 占位；titled===true → 直展 title（用户命名硬边界）。
  const viewedSession = sessions.find((s) => s.id === viewedSessionId);
  const { t } = useTranslation('chat');
  const viewedTitle = viewedSession?.titled === true
    ? viewedSession.title
    : (viewedSession?.title ?? t('session.defaultTitle'));

  // [v0.0.182] 三栏响应式布局 hook
  const threeCol = useThreeColLayout({ hasLeft: true, rightPresent: !!activeSessionId });

  return (
    <div ref={threeCol.containerRef} className="h-full min-h-0 overflow-x-auto">
      <div className="flex h-full min-h-0 w-full" style={{ minWidth: threeCol.rowMinWidth }}>
        <SectionConvPanel
          sessions={topSessions}
          activeId={activeSessionId}
          childrenByParent={childrenByParent}
          activeSubId={activeSubId ?? undefined}
          error={error}
          onSelect={(id) => void actions.openSession(id)}
          onSelectSub={actions.handleSelectSub}
          onCreate={() => void actions.handleCreate()}
          onDelete={(id) => void actions.handleDelete(id)}
          onRefreshChildren={(pid) => void refreshChildren(pid)}
          onRenameTitle={actions.handleRenameTitle}
          onTogglePin={actions.handleTogglePin}
          renderWidth={threeCol.layout.leftWidth}
          dragMaxWidth={threeCol.convDragMaxWidth}
          onConvResize={threeCol.handleConvResize}
          onConvDragStart={() => threeCol.setDragging('left')}
          onConvResizeEnd={() => {
            threeCol.handleConvResizeEnd();
            threeCol.setDragging(null);
          }}
        />
        {/* 主区：统一装配层（key remount 保证切会话零残留帧）。
            emptyStateSlot = 欢迎 hero（无会话 / active 空会话都渲，onNewConversation 复用 handleCreate） */}
        <SectionChatSession
          key={viewedSessionId}
          sessionId={viewedSessionId || null}
          rootTag="section"
          topbarLeft={(chrome) => (
            <ChatSessionTopbarLeft chrome={chrome} readOnly={chrome.readOnly} titleOverride={viewedTitle} />
          )}
          emptyStateSlot={<ComponentEmptyState onNewConversation={() => void actions.handleCreate()} />}
        />
        {activeSessionId && (
          <SectionWorkspacePanel
            sessionId={activeSessionId}
            renderWidth={threeCol.rightRenderWidth}
            dragMaxWidth={threeCol.rightDragMaxWidth}
            onLayoutChange={threeCol.reportRightPanel}
            onDragModeChange={(d) => threeCol.setDragging(d ? 'right' : null)}
          />
        )}
      </div>
    </div>
  );
}

export default PageChat;
