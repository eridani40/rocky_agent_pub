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
import { SectionPreviewArea } from './section-preview-area';
import { PreviewAreaProvider } from './preview-area-provider';
import { usePreviewArea } from './preview-area-context';
import { ComponentEmptyState } from './component-empty-state';
// [v0.0.182] 三栏响应式布局 hook
import { useThreeColLayout } from './use-three-col-layout';
// 挂载 effect（拉 sessions + 订阅 session_meta）；hook 内部走 getSseClient() 单例
import { usePageChatMount } from './use-page-chat-mount';
// 列表/拓扑 action handler（发送/HITL/picker 类 handler 已内置 SectionChatSession）
import { useChatActions, type UseChatActionsReturn } from './use-chat-actions';
import { useSubagentChildren } from './use-subagent-children';
import { useChatStore } from '../../store/chat-slice';
import type { Session, ChildrenView } from './types';

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

  // [v0.0.182] 三栏响应式布局 hook；[v0.0.320] previewPresent=true → 4 槽引擎（预览区）
  //   布局 + door 读取在 Provider 内的 PageChatRow（door 来自 PreviewAreaContext，需在 Provider 内消费）
  return (
    // [Task 3 偏离] PreviewAreaProvider 顶层包整行：workspace-panel / message-stream（兄弟节点）
    //   需消费预览区 context（React Context 只能向下传），透明容器不改 flex 布局
    // [M-1 修复] sessionId 用 activeSessionId（与 SectionPreviewArea/SectionWorkspacePanel 渲染面板对齐）：
    //   subagent 激活时（viewedSessionId=sub）右栏仍是 parent workspace 树，若 Provider 用 viewedSessionId
    //   会读错 workspace（readWorkspaceFile(subagent) → 404 error pill）
    <PreviewAreaProvider sessionId={activeSessionId ?? ''}>
      <PageChatRow
        sessions={topSessions}
        activeSessionId={activeSessionId}
        viewedSessionId={viewedSessionId}
        viewedTitle={viewedTitle}
        childrenByParent={childrenByParent}
        activeSubId={activeSubId}
        error={error}
        actions={actions}
        refreshChildren={refreshChildren}
      />
    </PreviewAreaProvider>
  );
}

/**
 * 四槽布局行（Provider 内消费 PreviewAreaContext）。
 * [v0.0.329 门模型] 读 context door：chatCollapsed=door==='left' 传引擎；
 *   door==='left' 时 SectionChatSession 不渲染（chat 宽 0、preview 占满门框）。
 */
function PageChatRow({ sessions, activeSessionId, viewedSessionId, viewedTitle, childrenByParent, activeSubId, error, actions, refreshChildren }: {
  sessions: Session[];
  activeSessionId: string | null;
  viewedSessionId: string;
  viewedTitle: string;
  childrenByParent: Record<string, ChildrenView>;
  activeSubId: string | null;
  error: string | null;
  actions: UseChatActionsReturn;
  refreshChildren: (pid: string) => Promise<void> | void;
}) {
  // [v0.0.329 门模型] 读 context door（无 Provider/tabs 时缺省 center → 不影响布局）
  const preview = usePreviewArea();
  const door = preview?.door ?? 'center';
  const chatCollapsed = door === 'left';

  // [v0.0.182] 三栏响应式布局 hook；[v0.0.320] previewPresent=true → 4 槽引擎（预览区）
  // [v0.0.329] chatCollapsed 透传（door=left → chat 宽 0、preview 吞并门框）
  const threeCol = useThreeColLayout({ hasLeft: true, rightPresent: !!activeSessionId, previewPresent: !!activeSessionId, chatCollapsed });

  return (
    <div ref={threeCol.containerRef} className="h-full min-h-0 overflow-x-auto">
      <div className="flex h-full min-h-0 w-full" style={{ minWidth: threeCol.rowMinWidth }}>
        <SectionConvPanel
          sessions={sessions}
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
            emptyStateSlot = 欢迎 hero（无会话 / active 空会话都渲，onNewConversation 复用 handleCreate）。
            [v0.0.329] door==='left' → chat 槽隐藏（条件不渲染；middleWidth=0 preview 占满门框） */}
        {!chatCollapsed && (
          <SectionChatSession
            key={viewedSessionId}
            sessionId={viewedSessionId || null}
            rootTag="section"
            topbarLeft={(chrome) => (
              <ChatSessionTopbarLeft chrome={chrome} readOnly={chrome.readOnly} titleOverride={viewedTitle} />
            )}
            emptyStateSlot={<ComponentEmptyState onNewConversation={() => void actions.handleCreate()} />}
          />
        )}
        {/* [v0.0.320] 预览区（三栏 chat|preview|ws；SectionChatSession 后插） */}
        {activeSessionId && (
          <SectionPreviewArea
            sessionId={activeSessionId}
            renderWidth={threeCol.previewRenderWidth}
            dragMaxWidth={threeCol.previewDragMaxWidth}
            onLayoutChange={threeCol.reportPreviewPanel}
            onDragModeChange={threeCol.setPreviewDragging}
          />
        )}
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
