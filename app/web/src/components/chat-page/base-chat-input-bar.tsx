/**
 * base-chat-input-bar —— 输入区组件级 base（骨架 + HITL 分流 + slot 注入）
 * 参考: specs/ui/components/chat-page/base-chat-input-bar.md
 *       specs/tech/version_logs/v0.0.155/change_plan.md 段 E（INV-E2 只含骨架）
 *
 * 进 base（共用）：
 *   - 输入区容器（border-t + bg-surface-2 + max-w-*）+ ChatComposer wrapper（textarea 上）+ 按钮行容器（下）
 *   - ComponentRunStateBar（enqueue 排队区，running spinner 由 message-stream 渲染）
 *   - HITL 卡 subState 分流（need_approval / need_feedback 两卡同位互斥；镜像原三页逻辑）
 *   - 发送错误行（sendError/error 红字提示）
 *
 * 保留独立（slot 注入）：
 *   - composerSlot：ChatComposer 实例（消费方持有 ref + 配置 biz/role/resolver/initialContent）
 *   - buttonRowSlot：按钮行内容（picker 组合 + send + 可选 stop）
 *
 * 边界：base 不持 store / chrome / 状态机；所有数据通过 props 透传。
 * 单文件 ≤300 行。
 */
import type { ReactNode } from 'react';
import { ComponentRunStateBar } from './component-run-state-bar';
import { ComponentPendingQuestionCard } from './component-pending-question-card';
import { ComponentPendingApprovalCard } from './component-pending-approval-card';
import type { EnqueueItem, FeedbackAnswer, PendingToolCallView, SessionState } from './types';

interface BaseChatInputBarProps {
  /**
   * 当前 session id（base 内不直接消费——enqueue cancel 回调由消费方闭包捕获；
   * 保留入参仅为稳定调用契约：消费方装配时显式提供，便于审阅时一眼锁定作用域）。
   */
  sessionId: string;
  /** session running（GET /session + SSE 派生，决定 run-state-bar 可见性） */
  sessionRunning: boolean;
  /** session 状态机子集（'running' | 'interrupting'），slot 内 stop 按钮减速用；base 不直接消费 */
  sessionState?: SessionState | null;
  /** enqueue 排队项 */
  enqueueItems: EnqueueItem[];
  /**
   * [v0.0.101/v0.0.122] HITL 悬挂 tool call（ask-question / approval）。
   * 非空 + subState 分流 → 对应卡 mount（composer 上方）；可见性主判定 = pendingToolCall !== null。
   */
  pendingToolCall?: PendingToolCallView | null;
  /** HITL 回填路径（b 路径）：toolCallId + handleType + payload */
  onSubmitReply?: (toolCallId: string, handleType: 'direct_result' | 'approval' | 'callback', payload: FeedbackAnswer | unknown) => void;
  /** 取消排队（仅 cancelEnqueue POST；队列移项靠 SSE） */
  onEnqueueCancel: (enqueueId: string) => void;
  /**
   * 发送/操作错误（postMessage / patchMember 等失败）—— 红字渲染在 input 下方。
   * null = 无错误。
   */
  error?: string | null;
  /** ChatComposer 实例 slot（消费方持 ref + 配置 biz/role/resolver/initialContent） */
  composerSlot: ReactNode;
  /** 按钮行 slot（picker 组合 + send + 可选 stop；消费方按 chat 类型组装） */
  buttonRowSlot: ReactNode;
  /**
   * 容器 testid（三页不同：playground=chat-input-bar / studio=squad-chat-input-*）。
   * 缺省 = 'chat-input-bar'（playground 兼容）。
   */
  containerTestid?: string;
  /** max-width 类（三页微调：playground=820px / studio=760px）；缺省用 playground 值 */
  maxWidthClass?: string;
}

/**
 * BaseChatInputBar：输入区骨架。
 *
 * 渲染结构：
 *   <div border-t> (container)
 *     <ComponentRunStateBar> (enqueue 排队区)
 *     <ComponentPendingApprovalCard | ComponentPendingQuestionCard> (HITL 分流)
 *     <div input-bar> (max-w + border + bg)
 *       <composerSlot> (textarea 上段)
 *       <buttonRowSlot> (按钮行下段)
 *     </div>
 *     {error && <div error 红字>} (错误行)
 *   </div>
 */
export function BaseChatInputBar({
  sessionId,
  sessionRunning,
  enqueueItems,
  pendingToolCall,
  onSubmitReply,
  onEnqueueCancel,
  error,
  composerSlot,
  buttonRowSlot,
  maxWidthClass = 'max-w-[820px]',
}: BaseChatInputBarProps) {
  // HITL subState 分流（两卡互斥）：need_approval → 审批卡；need_feedback → 提问卡。
  //   composer 不禁用（INV-7）：用户仍可发 query 触发 c 路径放弃。
  const showApproval = pendingToolCall && onSubmitReply && pendingToolCall.subState === 'need_approval';
  const showQuestion = pendingToolCall && onSubmitReply && pendingToolCall.subState === 'need_feedback';

  return (
    <div className="shrink-0 border-t border-border bg-surface-2 px-8 py-3">
      <ComponentRunStateBar
        sessionRunning={sessionRunning}
        enqueueItems={enqueueItems}
        onEnqueueCancel={onEnqueueCancel}
      />
      {showApproval && pendingToolCall && onSubmitReply && (
        <ComponentPendingApprovalCard
          key={pendingToolCall.toolCallId}
          pending={pendingToolCall}
          onSubmit={(id, ht, payload) => onSubmitReply(id, ht, payload)}
        />
      )}
      {showQuestion && pendingToolCall && onSubmitReply && (
        <ComponentPendingQuestionCard
          key={pendingToolCall.toolCallId}
          pending={pendingToolCall}
          onSubmit={onSubmitReply}
        />
      )}
      <div

        className={`bg-surface border border-border rounded-xl px-3 py-2.5 flex flex-col gap-2 mx-auto focus-within:border-[var(--color-accent)] focus-within:ring-[3px] focus-within:ring-[var(--color-accent-light)] transition-all relative ${maxWidthClass}`}
      >
        <div className="min-w-0">{composerSlot}</div>
        <div className="flex justify-end items-center gap-2 shrink-0">{buttonRowSlot}</div>
      </div>
      {error && (
        <div className={`mx-auto mt-1.5 font-mono text-[10.5px] text-[var(--danger)] ${maxWidthClass}`}>
          {error}
        </div>
      )}
    </div>
  );
}

export default BaseChatInputBar;
