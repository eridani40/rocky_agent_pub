/**
 * primitive-bubble —— user/assistant 气泡原子组件（common，跨页可复用）
 * 参考: specs/ui/components/chat-page/_overview.md §4.7 / §8 视觉基线
 *       设计稿: reqs/[working] v0.0.165.ui_upgrade/design/_shell.css .bubble.user/.bubble.answer
 *       regulation 02-components §6（气泡尖角方向：user 右上、assistant 左上）
 *
 * user 深底气泡：bg-fg-2/text-surface-2, radius 12 4 12 12（右上尖角）
 * assistant accent-surface 气泡：bg-accent-surface/border-accent-light, radius 4 12 12 12（左上尖角）
 * 子内容自由（answer 走 markdown-view）。
 */

interface BubbleProps {
  /** 角色 */
  variant: 'user' | 'assistant';
  /** 子节点（user=纯文本；assistant=markdown-view 等） */
  children: React.ReactNode;
  /** 附加 className（如 answer 顶部 testid 包裹） */
  className?: string;
  /** testid 锚点（如 msg-{messageId}-text-{index}） */
  testId?: string;
}

/**
 * 气泡原子组件。user 右深底，assistant 左 accent-surface。
 * 视觉基线对齐设计稿 .bubble-user / .bubble-answer。
 */
export function PrimitiveBubble({ variant, children, className, testId }: BubbleProps) {
  if (variant === 'user') {
    return (
      <div

        className={
          'bg-fg-2 text-surface-2 px-3.5 py-2.5 rounded-[12px_4px_12px_12px] text-[13.5px] leading-relaxed max-w-full break-words ' +
          (className ?? '')
        }
      >
        {children}
      </div>
    );
  }
  return (
    <div

      className={
        'bg-accent-surface border border-accent-light text-fg px-4 py-3 rounded-[4px_12px_12px_12px] text-[13.5px] leading-[1.7] max-w-full break-words ' +
        (className ?? '')
      }
    >
      {children}
    </div>
  );
}

export default PrimitiveBubble;
