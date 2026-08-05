/**
 * component-chat-session-input —— 统一 chat 输入区（BaseChatInputBar 消费方，capabilities 门控）
 * 参考: specs/ui/components/chat-page/section-chat-session.md（门控矩阵权威）
 *       specs/ui/components/chat-page/base-chat-input-bar.md（base 契约）
 *       specs/prd/overall/10-tool-permission.md §10.3（卡片/按钮出现消失不得致输入区位移）
 *
 * 职责：SectionChatSession 的输入区组合——ChatComposer（身份由 chrome 派生）+
 *   按钮行（审批 picker → effort picker → model picker → send → stop，逐项按 capabilities 门控）。
 *   HITL 卡/enqueue 排队区由 BaseChatInputBar 骨架承载，本组件按 capabilities 过滤透传
 *   （能力关闭 = 数据置空；能力开启时 MUST 透传 useMessages 真值，禁哑值）。
 *
 * kind → composer 身份映射：静态查表（KIND_COMPOSER_IDENTITY，与后端 CAPABILITIES 同为
 *   「kind→数据」映射表，非渲染分支）；studio_member 的 role 由 chrome.members 对端精化。
 */
import { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveMentionProviders, type BizType, type Role } from '@app/shared';
import { BaseChatInputBar } from './base-chat-input-bar';
import { ChatComposer, type ChatComposerHandle } from './component-chat-composer';
import type { MentionAttrs } from './chat-composer-extension';
import { SendIcon } from './icons';
import { CHAT_ACTION_BTN_CLS } from './action-button-styles';
import { InputModelPicker } from './component-input-model-picker';
import { InputEffortPicker, type EffortLevel } from './component-input-effort-picker';
import { InputApprovalModePicker, type ApprovalMode } from './component-input-approval-mode-picker';
import { ComponentRunStateAbortSlot } from './component-run-state-bar';
import type { ModelSelection } from '../../lib/providers';
import type { SessionChromeView } from '../../lib/chat-api';
import type { EnqueueItem, FeedbackAnswer, PendingToolCallView, SessionState } from './types';

/** kind → ChatComposer/mention 身份（studio_member 的 role 由对端 member 精化） */
const KIND_COMPOSER_IDENTITY: Record<SessionChromeView['kind'], { biz: BizType; role: Role }> = {
  playground: { biz: 'playground', role: 'rocky' },
  studio_member: { biz: 'studio', role: 'mate' },
  studio_group: { biz: 'studio', role: 'squad' },
  academy_head: { biz: 'academy', role: 'head_teacher' },
  academy_coach: { biz: 'academy', role: 'coach' },
  academy_student: { biz: 'academy', role: 'student' },
};

interface ChatSessionInputProps {
  sessionId: string;
  /** 装饰数据（kind/capabilities/两 picker 值/model/members） */
  chrome: SessionChromeView;
  sessionRunning: boolean;
  sessionState: SessionState | null;
  /** useMessages 真值（能力过滤在本组件内做，消费方禁传哑值） */
  enqueueItems: EnqueueItem[];
  pendingToolCall: PendingToolCallView | null;
  onSubmitReply: (
    toolCallId: string,
    handleType: 'direct_result' | 'approval' | 'callback',
    payload: FeedbackAnswer | unknown,
  ) => void;
  onEnqueueCancel: (enqueueId: string) => void;
  onSend: (content: string) => void;
  onAbort: () => void;
  /** chrome setter 三件套（乐观 + fire-and-forget PUT） */
  onModelChange: (sel: ModelSelection) => void;
  onEffortChange: (level: EffortLevel) => void;
  onApprovalModeChange: (mode: ApprovalMode) => void;
  /** 发送失败红字（父级 state） */
  sendError: string | null;
  prefill?: MentionAttrs[] | string;
  placeholder?: string;
}

/**
 * 统一输入区：capabilities 逐项门控。
 * - approvalPicker/effortPicker/runState(stop) 关闭时对应控件不渲染（群聊形态，v0.0.152 裁决）
 * - hitl/enqueue 关闭时对应数据置空（卡片/排队区不 mount）；开启时透传真值
 * - model picker 恒有；「默认模型」项数据源 = chrome.defaultModel（defaultModelId 复合路径，
 *   providerId 缺失时 picker 内部跨 provider 反查兜底）
 */
export function ComponentChatSessionInput({
  sessionId,
  chrome,
  sessionRunning,
  sessionState,
  enqueueItems,
  pendingToolCall,
  onSubmitReply,
  onEnqueueCancel,
  onSend,
  onAbort,
  onModelChange,
  onEffortChange,
  onApprovalModeChange,
  sendError,
  prefill,
  placeholder,
}: ChatSessionInputProps) {
  const { t } = useTranslation('chat');
  const composerRef = useRef<ChatComposerHandle>(null);
  const caps = chrome.capabilities;

  /**
   * 统一中断动作（PRD §3.2，ESC 与红钮同 handler，UC-A4 语义统一）：
   *   1. snapshot enqueueItems（防 SSE 移项中段丢 content）
   *   2. 逐条 cancelEnqueue（fire-and-forget，移项靠 SSE enqueued_message_canceled）
   *   3. composerRef.applyInterrupt（注入排队内容到输入区开头 + 焦点管理）
   *   4. onAbort（既有 section 传入的 abort 原语 = POST /abort）
   */
  const handleInterrupt = useCallback(() => {
    const items = enqueueItems; // snapshot 入参前
    items.forEach((it) => onEnqueueCancel(it.enqueueId));
    composerRef.current?.applyInterrupt(items.map((it) => ({ content: it.content })));
    onAbort();
  }, [enqueueItems, onEnqueueCancel, onAbort]);

  /**
   * ESC window capture-phase listener（PRD §3.1 焦点门控）。
   * 焦点门控 4 分支 short-circuit：
   *   - !isFocused → noop（焦点不在输入区，ESC 不中断；modal/body/消息流各自 ESC handler 照常）
   *   - isPopoverOpen → noop（@ popover 开，让 composer 自管关 popover）
   *   - pendingToolCall → noop（HITL 卡自管）
   *   - sessionRunning → preventDefault + handleInterrupt
   * capture 阶段（第三参 true）先于 bubble handler，确保 ESC 在 composer 之前判定中断语义。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!composerRef.current?.isFocused()) return;
      if (composerRef.current?.isPopoverOpen()) return;
      if (pendingToolCall) return;
      if (sessionRunning) {
        e.preventDefault();
        handleInterrupt();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [sessionRunning, pendingToolCall, handleInterrupt]);

  // composer 身份：静态表 + studio_member 对端 role 精化（leader/mate）
  const base = KIND_COMPOSER_IDENTITY[chrome.kind];
  const peer = chrome.memberId ? chrome.members.find((m) => m.id === chrome.memberId) : undefined;
  const role: Role = peer?.role === 'leader' ? 'leader' : base.role;

  // composer slot：身份三元组派生 mention providers（输入区仅非只读时挂载，derivation 恒 parent）
  const composerSlot = (
    <ChatComposer
      ref={composerRef}
      biz={base.biz}
      sessionRole={role}
      sessionId={sessionId}
      enabledProviders={resolveMentionProviders({ biz: base.biz, role, derivation: 'parent' })}
      onSend={onSend}
      initialContent={prefill}
      placeholder={placeholder}
    />
  );

  // 按钮行：[审批模式][effort][模型选择][发送][停止]，前两者与停止按 capabilities 门控。
  // 布局稳定性：门控是 mount 级（能力静态，会话期不变），不存在运行时按钮跳动。
  const buttonRowSlot = (
    <>
      {caps.approvalPicker && (
        <InputApprovalModePicker
          approvalMode={chrome.approvalMode}
          disabled={sessionRunning}
          onChange={onApprovalModeChange}
        />
      )}
      {caps.effortPicker && (
        <InputEffortPicker effort={chrome.effort} disabled={sessionRunning} onChange={onEffortChange} />
      )}
      <InputModelPicker
        model={chrome.sessionModel ?? { providerId: '', modelId: 'default' }}
        defaultModelId={chrome.defaultModel?.modelId ?? ''}
        defaultModelProviderId={chrome.defaultModel?.providerId}
        disabled={sessionRunning}
        onChange={onModelChange}
      />
      <button
        type="button"
        data-action-key="chat.message.send"
        onClick={() => composerRef.current?.send()}
        aria-label={t('composer.send.ariaLabel')}
        title={t('composer.send.title')}
        className={CHAT_ACTION_BTN_CLS + ' bg-[var(--color-accent)] rounded-lg cursor-pointer hover:opacity-90 transition-opacity'}
      >
        <SendIcon size={11} className="text-surface" />
      </button>
      {caps.runState && (
        <ComponentRunStateAbortSlot
          sessionRunning={sessionRunning}
          sessionId={sessionId}
          sessionState={sessionState === 'interrupting' ? 'interrupting' : 'running'}
          onAbort={() => handleInterrupt()}
        />
      )}
    </>
  );

  return (
    <BaseChatInputBar
      sessionId={sessionId}
      sessionRunning={sessionRunning}
      /* 能力关闭 = 数据置空（排队区/HITL 卡不 mount）；开启时透传 useMessages 真值 */
      enqueueItems={caps.enqueue ? enqueueItems : []}
      pendingToolCall={caps.hitl ? pendingToolCall : null}
      onSubmitReply={onSubmitReply}
      onEnqueueCancel={onEnqueueCancel}
      error={sendError}
      composerSlot={composerSlot}
      buttonRowSlot={buttonRowSlot}
      /* 群聊窄输入区（v0.0.152 形态保持）；其余沿用 playground 缺省 820 */
      maxWidthClass={caps.groupRender ? 'max-w-[760px]' : 'max-w-[820px]'}
    />
  );
}

export default ComponentChatSessionInput;
