/**
 * component-scroll-guide-bubble —— 聊天滚动引导气泡（v0.0.262）
 * 参考: specs/prd/version_logs/v0.0.262.scroll_guide_bubble/prd.md §2.2/§2.3/§2.4/§3.1
 *       specs/tech/version_logs/v0.0.262/change_plan.md 行 4
 *
 * 职责：用户不在消息流底部（nearBottom=false）且会话非空（hasMessages）时，
 *   在消息区底部（输入框上方）浮动显示引导气泡——生成中「新消息」/ 空闲「回到底部」，
 *   点击平滑滚到底部。
 *
 * 显示条件（PRD §2.2）：visible = !nearBottom && hasMessages；runActive 只决定文案，不决定显隐。
 * 定位（PRD §2.3）：absolute 浮动不占文档流（出现/消失不得致任何元素位移——布局稳定性）。
 * 过渡（PRD §2.4）：opacity + pointer-events + translate-y（fade + 轻微上移 ≤200ms），**不 unmount**
 *   （保动画平滑，隐藏态仅 opacity-0 + pointer-events-none，按钮始终在 DOM）。
 * 样式基线：参照 tool-batch / run-state 胶囊——surface 底 + border + 阴影 + 主色文字/图标。
 */
import { useTranslation } from 'react-i18next';
import { ChevronIcon } from './icons';

interface ScrollGuideBubbleProps {
  /** 是否在底部附近（false = 用户翻走，气泡显示） */
  nearBottom: boolean;
  /** run 进行中（决定文案：新消息 vs 回到底部；不决定显隐） */
  runActive: boolean;
  /** 会话是否有消息（空会话不显示气泡，走既有空态分支） */
  hasMessages: boolean;
  /** 点击滚底回调（装配层传 scrollToBottom('smooth')） */
  onScrollToBottom: () => void;
}

/**
 * 滚动引导气泡：absolute 浮动在消息区底部（不占文档流），visible 用 opacity/pointer-events
 * 过渡控制（不 unmount）。文案 = runActive 二元；aria-label 对应更完整的可访问语义。
 */
export function ScrollGuideBubble({
  nearBottom,
  runActive,
  hasMessages,
  onScrollToBottom,
}: ScrollGuideBubbleProps) {
  const { t } = useTranslation('chat');
  const visible = !nearBottom && hasMessages;
  const label = runActive ? t('scrollGuide.newMessage') : t('scrollGuide.backToBottom');
  // aria-label 比可见文案更完整（PRD §3.1.6：「查看新消息」/「回到底部」语义）
  const ariaLabel = runActive ? t('scrollGuide.ariaLabel.newMessage') : t('scrollGuide.ariaLabel.backToBottom');

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onScrollToBottom}
      className={
        'absolute left-1/2 -translate-x-1/2 bottom-3 z-20 ' +
        'inline-flex items-center gap-1.5 border border-border rounded-full px-3 py-1.5 ' +
        'text-[11px] font-mono font-medium text-accent select-none cursor-pointer ' +
        'bg-surface-2 shadow-md hover:bg-surface-2 hover:border-[var(--color-muted)] ' +
        'transition-all duration-200 ease-out ' +
        (visible
          ? 'opacity-100 pointer-events-auto translate-y-0'
          : 'opacity-0 pointer-events-none translate-y-1')
      }
    >
      {/* 向下箭头 = 「下方有内容」语义（回到底部/查看新消息） */}
      <ChevronIcon size={10} className="shrink-0" />
      <span>{label}</span>
    </button>
  );
}

export default ScrollGuideBubble;
