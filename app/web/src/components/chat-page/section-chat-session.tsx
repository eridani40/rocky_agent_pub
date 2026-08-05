/**
 * section-chat-session —— 统一 chat 会话区（自给型：sessionId 唯一必填，能力按 capabilities 门控）
 * 参考: specs/ui/components/chat-page/section-chat-session.md（组件契约权威）
 *       specs/tech/app/frontend/[P0]chat_session_assembly.md（6 条设计原则）
 *       specs/api/overall/04a-session-chrome.md（chrome 接口契约）
 *
 * 核心不变量：
 *   1. 零 kind 字面分支——渲染差异只依 chrome.capabilities / members / readOnly 数据驱动。
 *   2. 内部自挂全部数据 hooks + handlers；HITL/enqueue 走 useMessages 真值（禁哑值）。
 *   3. readOnly = prop ∪ chrome.readOnly（badge + model-tag + usage + Compact 保留；Clear/输入区隐藏）。
 *   4. minimap/usage 全内置；onMessagesChange 仅供 training-observe 任务刷新，禁止回收 messages 建 UI。
 *   5. chrome 可经 prop 注入防双拉（studio router）；缺省内部自拉。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { postMessage, postCompact, postClear, cancelEnqueue } from '../../lib/chat-api';
import type { SessionChromeView } from '../../lib/chat-api';
import type { MentionAttrs } from './chat-composer-extension';
import type { Message } from './types';
import { BaseChatPage } from './base-chat-page';
import { ComponentMessageStream } from './component-message-stream';
import { ComponentChatRightOverlay } from './component-chat-right-overlay';
import { ComponentChatFloatMenu } from './component-chat-float-menu';
import { ComponentUsagePanel, CompactBtn, ClearBtn } from './component-usage-panel';
import { ChatTopbarBackBtn } from './component-chat-topbar-back-btn';
import { ComponentChatSessionInput } from './component-chat-session-input';
import { ChatSessionTopbarLeft } from './component-chat-session-topbar-left';
import { emptyUsage } from './empty-usage';
import { useFlattenedView } from './use-flattened-view';
import { deriveMinimapBars } from './minimap-bars';
import { useChatChrome } from './use-chat-chrome';
import { useMessages } from './use-messages';
import { useRunState } from './use-run-state';
import { useUsage } from './use-usage';
import { useSummary } from './use-summary';
import { useSessionPanelFanout } from './use-session-panel-fanout';
import { useLoadMore } from './use-load-more';
import { deriveRenderStrategy } from './chat-actor-strategy';

/** SectionChatSession props（契约见 ui spec section-chat-session.md §Props） */
export interface SectionChatSessionProps {
  /** 唯一必填口子；null = 无会话（渲 emptyStateSlot，不拉 chrome） */
  sessionId: string | null;
  /** 已装配 chrome 注入（宿主已拉过防双拉，如 studio router）；缺省内部自拉 */
  chrome?: SessionChromeView;
  /** 身份 header render-prop；缺省渲 chrome.title(+tag) + readOnly badge + model-tag */
  topbarLeft?: (chrome: SessionChromeView) => ReactNode;
  /** 存在即渲返回键 */
  onBack?: () => void;
  backActionKey?: string;
  /** 前端强制只读；实效 readOnly = prop ∪ chrome.readOnly */
  readOnly?: boolean;
  placeholder?: string;
  /** 空态内容（无会话 / messages 空且无 run 时）；缺省渲通用空文案 */
  emptyStateSlot?: ReactNode;
  /** 初始内容预填（mention pill 数组 / 纯文本字符串，mount-time 注入；studio 看板 @ / 业务全景引导入口） */
  prefill?: MentionAttrs[] | string;
  fadeIn?: boolean;
  rootTag?: 'section' | 'main';
  /** 消息流变化回调（training-observe 任务刷新残留）；禁止用于回收 messages 自建 minimap */
  onMessagesChange?: (messages: Message[]) => void;
}

/** 通用空态（消费方未注入 emptyStateSlot 时的缺省文案） */
function DefaultEmptyState() {
  const { t } = useTranslation('chat');
  return (
    <div className="flex-1 overflow-y-auto px-8 py-6">
      <div className="py-10 text-center text-[12.5px] text-muted">{t('session.emptyHint')}</div>
    </div>
  );
}

// 缺省身份 header 组件拆至 component-chat-session-topbar-left.tsx（单文件单组件）；
// 此处 re-export 保持消费方 import 路径统一（page-chat 等经本模块取用）。
export { ChatSessionTopbarLeft };

/**
 * wrapper：sessionId/chrome 门控（hooks 不在门控后挂——Loaded 内无条件执行）。
 * - sessionId null → 空态骨架（不拉 chrome、无输入区）
 * - chrome loading → BaseChatPage loading 占位（切 session 时旧 model 无一帧残留）
 * - chrome error → 空态 + console.warn（装饰数据失败不阻塞页面骨架）
 */
export function SectionChatSession(props: SectionChatSessionProps) {
  const { sessionId, chrome: injected, rootTag = 'section', fadeIn, emptyStateSlot } = props;
  const chromeHook = useChatChrome(sessionId, { injected: injected ?? null });

  if (!sessionId) {
    return (
      <BaseChatPage
        sessionId={null}
        rootTag={rootTag}
        fadeIn={fadeIn}
        messagesSlot={emptyStateSlot ?? <DefaultEmptyState />}
        hideInputBar
      />
    );
  }
  if (chromeHook.error) {
    console.warn('[SectionChatSession] chrome load failed:', chromeHook.error);
    return (
      <BaseChatPage
        sessionId={sessionId}
        rootTag={rootTag}
        fadeIn={fadeIn}
        messagesSlot={emptyStateSlot ?? <DefaultEmptyState />}
        hideInputBar
      />
    );
  }
  if (chromeHook.loading || !chromeHook.chrome) {
    return <BaseChatPage sessionId={sessionId} loading rootTag={rootTag} fadeIn={fadeIn} messagesSlot={<></>} />;
  }
  return <SectionChatSessionLoaded {...props} sessionId={sessionId} chromeHook={chromeHook} />;
}

/** chrome 到位后的装配渲染（所有 hooks 无条件执行） */
function SectionChatSessionLoaded({
  sessionId,
  chromeHook,
  topbarLeft,
  onBack,
  backActionKey,
  readOnly: readOnlyProp,
  placeholder,
  emptyStateSlot,
  prefill,
  fadeIn,
  rootTag = 'section',
  onMessagesChange,
}: SectionChatSessionProps & { sessionId: string; chromeHook: ReturnType<typeof useChatChrome> }) {
  const chrome = chromeHook.chrome!;
  const caps = chrome.capabilities;
  // readOnly 实效 = 前端 prop ∪ chrome.readOnly（chrome 侧唯一判定源 = derivation==='subagent'）
  const readOnly = readOnlyProp === true || chrome.readOnly;

  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // area-hooks 全内置（能力关闭走 enabled 门：零订阅零网络，React hooks 恒挂）
  const messagesHook = useMessages(sessionId);
  const runState = useRunState(sessionId, { enabled: caps.runState });
  const usageHook = useUsage(sessionId);
  const summaryHook = useSummary(sessionId, { enabled: caps.runState });
  useSessionPanelFanout(sessionId);
  const { isLoadingMore, loadMore } = useLoadMore(sessionId, messagesHook);

  const { messages, runActive, loadingPhase, runningToolNames, retryStatus, lastRunFinish } = messagesHook;
  const { sessionRunning } = runState;

  // onMessagesChange 残留扇出（training-observe 消息驱动任务刷新；ref 取最新防 stale closure）
  const onMessagesChangeRef = useRef(onMessagesChange);
  onMessagesChangeRef.current = onMessagesChange;
  useEffect(() => {
    onMessagesChangeRef.current?.(messages);
  }, [messages]);

  // 渲染策略：chrome 数据驱动（groupRender→群聊白名单+a2a actor；memberId→单聊对端 actor）
  const strategy = useMemo(() => deriveRenderStrategy(chrome), [chrome]);
  const fv = useFlattenedView(messages, strategy.messageFilter ? { messageFilter: strategy.messageFilter } : {});
  const bars = useMemo(
    () =>
      deriveMinimapBars(
        fv.elements,
        messages,
        strategy.sideResolver ? (msg) => (msg ? strategy.sideResolver!(msg) : 'assistant') : undefined,
      ),
    [fv, messages, strategy],
  );

  // handlers 全内置（fire-and-forget，状态由 SSE 推送）
  const handleSend = async (content: string) => {
    setSendError(null);
    // c 路径放弃：pendingToolCall 非空时发普通 query → 同步清本地卡片（后端清 pendingToolCalls）
    if (messagesHook.pendingToolCall) messagesHook.clearPendingToolCall();
    try {
      await postMessage(sessionId, { content });
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    }
  };
  const handleCompact = () => void postCompact(sessionId).catch((e) => console.warn('postCompact failed:', e));
  const handleClear = () => void postClear(sessionId).catch((e) => console.warn('postClear failed:', e));
  const handleEnqueueCancel = (enqueueId: string) =>
    void cancelEnqueue(sessionId, enqueueId).catch((e) => console.warn('cancelEnqueue failed:', e));

  // 缺省 topbarLeft：title(+tag) + readOnly 时 badge + model-tag（组件化，宿主可复用）
  const defaultTopbarLeft = <ChatSessionTopbarLeft chrome={chrome} readOnly={readOnly} />;

  // topbar 右侧：usage/compact 按 capabilities；Clear 另叠 readOnly 隐藏（readOnly 保留 usage+Compact）
  const topbarRight = (caps.usage || caps.compact || caps.clear) && (
    <div className="flex items-center gap-2 relative">
      {caps.usage && <ComponentUsagePanel usage={usageHook.usage ?? emptyUsage} />}
      {caps.usage && caps.compact && <div className="w-px h-[18px] bg-border mx-1 shrink-0" />}
      {caps.compact && (
        <CompactBtn summaryTask={summaryHook.summaryTask} sessionBusy={sessionRunning} onClick={handleCompact} />
      )}
      {caps.clear && !readOnly && <ClearBtn onClick={() => setClearModalOpen(true)} />}
    </div>
  );

  // 消息区：空态（无消息且无 run）→ emptyStateSlot；否则共享内核 + 渲染策略
  const isEmpty = messages.length === 0 && !runActive && !lastRunFinish;
  const messagesSlot = isEmpty ? (
    emptyStateSlot ?? <DefaultEmptyState />
  ) : (
    <ComponentMessageStream
      sessionId={sessionId}
      messages={messages}
      flattened={fv}
      runActive={runActive}
      sessionRunning={sessionRunning}
      lastRunFinish={lastRunFinish}
      loadingPhase={loadingPhase}
      runningToolNames={runningToolNames}
      retryStatus={retryStatus}
      messageFilter={strategy.messageFilter}
      resolveActor={strategy.resolveActor}
      sideResolver={strategy.sideResolver}
      hasMore={messagesHook.hasMore}
      onLoadMore={() => void loadMore()}
      isLoadingMore={isLoadingMore}
    />
  );

  // 右缘 overlay：minimap/floatMenu 按 capabilities；cron=false → hideCron
  const rightOverlaySlot = (caps.minimap || caps.floatMenu) && (
    <ComponentChatRightOverlay sessionId={sessionId} hideCron={!caps.cron} bars={caps.minimap ? bars : []}>
      {caps.floatMenu && <ComponentChatFloatMenu sessionId={sessionId} hideCron={!caps.cron} />}
    </ComponentChatRightOverlay>
  );

  return (
    <BaseChatPage
      sessionId={sessionId}
      rootTag={rootTag}
      fadeIn={fadeIn}
      topbarLeft={
        <>
          {onBack && <ChatTopbarBackBtn onClick={onBack} actionKey={backActionKey ?? 'chat.session.back'} />}
          {topbarLeft ? topbarLeft(chrome) : defaultTopbarLeft}
        </>
      }
      topbarRight={topbarRight}
      messagesSlot={messagesSlot}
      rightOverlaySlot={rightOverlaySlot}
      inputSlot={
        <ComponentChatSessionInput
          sessionId={sessionId}
          chrome={chrome}
          sessionRunning={sessionRunning}
          sessionState={runState.sessionState}
          enqueueItems={messagesHook.enqueueItems}
          pendingToolCall={messagesHook.pendingToolCall}
          onSubmitReply={messagesHook.submitReply}
          onEnqueueCancel={handleEnqueueCancel}
          onSend={(c) => void handleSend(c)}
          onAbort={() => runState.abort()}
          onModelChange={chromeHook.setModel}
          onEffortChange={chromeHook.setEffort}
          onApprovalModeChange={chromeHook.setApprovalMode}
          sendError={sendError}
          prefill={prefill}
          placeholder={placeholder}
        />
      }
      /* readOnly 时输入区整体隐藏（sessionId 已非空） */
      hideInputBar={readOnly}
      onClear={handleClear}
      clearModalOpen={clearModalOpen}
      onClearModalChange={setClearModalOpen}
    />
  );
}

export default SectionChatSession;
