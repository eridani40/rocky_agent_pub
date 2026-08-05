/**
 * spinner-ring —— 共享旋转环指示器（v0.0.101 #2 会话列表 running spinner）
 * 参考: specs/ui/components/chat-page/_overview.md §4.2（running spinner + suspended「?」）
 *       specs/ui/components/chat-page/component-subagent-tree.md（SubagentRow spinner，小 size）
 *       specs/ui/components/studio-page/studio-sidebar.md（studio 群聊/leader/mate spinner）
 *       reqs/[done] v0.0.101.ask_question_tool/2-running-indicator.md（#2 视觉 brief）
 *       specs/tech/version_logs/v0.0.101/change_plan.md 模块 I
 *
 * 视觉沿用 component-abort-btn.tsx 的旋转环（border-t-[var(--color-accent)] animate-spin），
 * 四处复用：conv-item (12×12 default) / subagent-tree SubagentRow (10×10 sm) / seat-row mate 行 (10×10 sm) / seat-card 队长卡 (10×10 sm)。
 * 占位固定入常规流（shrink-0），出现/消失不导致相邻元素位移（INV-9 与 unread 红点错位共存）。
 *
 * 用法：
 *   <SpinnerRing />                     // 默认 12×12
 *   <SpinnerRing size="sm" />           // 10×10（subagent / studio seat：mate 行 + 队长卡）
 *   <SpinnerRing />   // testid 透传到 span
 */

/** spinner 尺寸档：default=12px（conv-item）/ sm=10px（subagent + studio seat：mate 行 + 队长卡） */
export type SpinnerRingSize = 'default' | 'sm';

interface SpinnerRingProps {
  /** 尺寸档：default=12px（conv-item main）/ sm=10px（subagent + studio seat：mate 行 + 队长卡） */
  size?: SpinnerRingSize;
  /** 透传 testid（ET 锚点，由 caller 按位置命名，如 conv-item-{id}-running-spinner） */
  /** 透传其他 HTML span 属性（aria-hidden 等） */
  'aria-hidden'?: boolean;
}

/** 尺寸 → 像素映射（与 abort-btn 12px 同基线，sm 略小对齐 subagent identity dot 11px 视觉） */
const SIZE_PX: Record<SpinnerRingSize, number> = {
  default: 12,
  sm: 10,
};

/**
 * 旋转环（accent border + animate-spin）。pure presentational，无业务逻辑。
 * border 宽度按尺寸调整（default 1.5px / sm 1.2px）保持视觉比例。
 */
export function SpinnerRing({
  size = 'default',
  'aria-hidden': ariaHidden = true,
}: SpinnerRingProps) {
  const px = SIZE_PX[size];
  const borderW = size === 'sm' ? 1.2 : 1.5;
  return (
    <span

      aria-hidden={ariaHidden}
      className="inline-block shrink-0 rounded-full border-[var(--color-border-strong)] border-t-[var(--color-accent)] animate-spin"
      style={{ width: `${px}px`, height: `${px}px`, borderWidth: `${borderW}px` }}
    />
  );
}

export default SpinnerRing;
