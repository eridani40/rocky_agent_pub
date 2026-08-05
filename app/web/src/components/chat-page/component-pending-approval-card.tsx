/**
 * component-pending-approval-card —— HITL 悬挂型危险操作审批卡（v0.0.122 工具权限系统）
 * 权威 spec: specs/ui/components/chat-page/component-pending-approval-card.md
 * 契约: specs/api/overall/04-agent-session.md §3.2（POST /messages toolReply, handleType='approval'）
 * 同构参照: component-pending-question-card.tsx（位置/驱动/可见性模式一致）
 *
 * 挂 chat-input-bar composer 上方（与提问卡同位互斥，subState='need_approval' 时挂本卡）。
 * 展示 toolName + command（等宽字体）+ 拦截原因；三按钮 allow/deny/allow_always → onSubmit。
 * key=toolCallId：切换不同 pending 时天然 remount（INV-4 多 pending 串行）。
 * 无取消按钮（INV-7）：composer 保持可用，用户可直接发 query 走 c 路径放弃。
 */
import { useTranslation } from 'react-i18next';
import type { PendingToolCallView } from './types';
import { isApprovalData } from './types';

/** 审批决策类型（对齐后端 PermissionDecision.behavior + toolReply payload） */
type ApprovalDecision = 'allow' | 'deny' | 'allow_always';

interface PendingApprovalCardProps {
  /** 队首悬挂 tool call（subState='need_approval'，data=ApprovalData） */
  pending: PendingToolCallView;
  /** 提交回填（b 路径）：toolCallId + handleType='approval' + { decision } payload */
  onSubmit: (toolCallId: string, handleType: 'approval', payload: { decision: ApprovalDecision }) => void;
}

/**
 * 审批卡组件。
 * 仅渲染 subState==='need_approval' 且 data 为 ApprovalData 的悬挂；
 * 其他情况（need_feedback / data 不是 ApprovalData）防御性返回 null。
 * key=toolCallId：由父层设置，切换不同 pending 时天然 remount。
 */
export function ComponentPendingApprovalCard({ pending, onSubmit }: PendingApprovalCardProps) {
  const { t } = useTranslation('chat');

  // 仅消费 need_approval + ApprovalData；其余防御性返回 null
  if (pending.subState !== 'need_approval' || !isApprovalData(pending.data)) return null;

  const data = pending.data;
  // bash 场景展示 arguments.command；其他工具展示 JSON.stringify(arguments)
  const commandText =
    typeof data.arguments.command === 'string'
      ? data.arguments.command
      : JSON.stringify(data.arguments);

  /** 按钮点击 → 构造 payload → 调 onSubmit */
  const handleDecision = (decision: ApprovalDecision) => {
    onSubmit(pending.toolCallId, 'approval', { decision });
  };

  return (
    <div

      className="bg-accent-light border border-[var(--color-accent)] rounded-xl px-3 py-2.5 flex flex-col gap-2 max-w-[820px] mx-auto w-full mb-2"
    >
      {/* 头部：工具名 + 标题 */}
      <div className="flex items-center gap-2 shrink-0">
        <span className="inline-flex items-center gap-1 text-[11px] font-mono text-accent bg-accent-light border border-[var(--color-accent)] px-1.5 py-0.5 rounded">
          {data.toolName}
        </span>
        <span className="text-[12px] font-medium text-fg-1">
          {t('pendingApproval.title', { defaultValue: '需要审批' })}
        </span>
      </div>

      {/* 拦截原因（如有） */}
      {data.reason && (
        <div

          className="text-[11px] text-[var(--color-accent)] leading-snug"
        >
          {data.reason}
        </div>
      )}

      {/* 命令展示区（等宽字体代码块） */}
      <pre

        className="font-mono text-[12px] bg-surface border border-border rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all text-fg-1 m-0"
      >
        {commandText}
      </pre>

      {/* 三按钮行（同意 / 拒绝 / 永远同意，无取消 INV-7） */}
      <div className="flex items-center gap-2 justify-end shrink-0">
        <button
          type="button"
          data-action-key="chat.approval.deny"
          onClick={() => handleDecision('deny')}
          className="px-3 py-1 rounded-md text-[12px] font-medium border border-border bg-surface text-[var(--danger)] hover:bg-[var(--danger-bg)] transition-colors cursor-pointer"
        >
          {t('pendingApproval.denyBtn', { defaultValue: '拒绝' })}
        </button>
        <button
          type="button"
          data-action-key="chat.approval.allow-always"
          onClick={() => handleDecision('allow_always')}
          className="px-3 py-1 rounded-md text-[12px] font-medium border border-border bg-surface text-fg-2 hover:border-[var(--color-accent)] transition-colors cursor-pointer"
        >
          {t('pendingApproval.allowAlwaysBtn', { defaultValue: '永远同意' })}
        </button>
        <button
          type="button"
          data-action-key="chat.approval.allow"
          onClick={() => handleDecision('allow')}
          className="px-3 py-1 rounded-md text-[12px] font-medium bg-[var(--color-accent)] text-surface hover:opacity-90 transition-colors cursor-pointer"
        >
          {t('pendingApproval.allowBtn', { defaultValue: '同意' })}
        </button>
      </div>
    </div>
  );
}

export default ComponentPendingApprovalCard;
