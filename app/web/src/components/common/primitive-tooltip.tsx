/**
 * primitive-tooltip —— hover/focus 触发的轻量 tooltip 浮层（primitive，跨页可复用）
 * 参考: specs/ui/components/common/primitive-tooltip.md
 *       specs/ui/components/_conventions.md §2/§5/§9（CSS 变量口径）
 *       specs/ui/components/chat-page/_overview.md §4.13（component-run-finish error detail 首用方）
 *
 * 职责：包裹 trigger（子节点），hover/focus 时弹一层 content slot；离开/失焦/Esc 隐藏。
 * 仅展示型（不承载按钮），不抢焦点，不占排版流（absolute 定位），不影响相邻布局。
 *
 * 不复用 primitive-bubble：bubble 是消息气泡容器（user/assistant 语义 + variant），
 * tooltip 是临时浮层（定位/防溢出/a11y 兜底），职责正交，强行复用会污染语义。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface TooltipProps {
  /** tooltip 内容（slot，文本或简单节点；复杂内容走 popover） */
  content: React.ReactNode;
  /** trigger 节点（被包裹，hover/focus 触发显示） */
  children: React.ReactNode;
  /** 相对 trigger 的 preferred 方位，默认 'top'；上方空间不足时自动翻转到下方 */
  side?: 'top' | 'bottom';
  /** 是否显示小箭头（默认 false，视觉克制） */
  arrow?: boolean;
  /** 触发方式，默认 ['hover', 'focus']（hover=鼠标进/出；focus=键盘 Tab 聚焦 trigger） */
  triggers?: Array<'hover' | 'focus'>;
  /** 最大宽度（px，默认 360——避免遮挡消息列，对齐 chat-page max-w-820 口径） */
  maxWidth?: number;
  /** 自定义容器 className（透传给浮层根） */
  className?: string;
  /** testid 前缀（生成 `{prefix}` 容器 + `{prefix}-content` 内容节点；默认 'tooltip'） */
  testId?: string;
}

/**
 * 轻量 tooltip。包裹 trigger，hover/focus 显示 content 浮层（absolute，不占排版流）。
 * 溢出自动翻转（top↔bottom），Esc 关闭，HTML title 兜底 a11y。
 */
export function PrimitiveTooltip({
  content,
  children,
  side = 'top',
  arrow = false,
  triggers = ['hover', 'focus'],
  maxWidth = 360,
  className,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  // 实际渲染方位（溢出时从 side 翻转）
  const [actualSide, setActualSide] = useState(side);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);

  const allowHover = triggers.includes('hover');
  const allowFocus = triggers.includes('focus');

  // 溢出检测：上方空间不足时翻转到下方（仅 visible 时计算，避免无谓 reflow）
  useLayoutEffect(() => {
    if (!visible || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    // 浮层预估高度（已 mount 时取真实值，否则用保守估值 80px）
    const tipH = tipRef.current?.offsetHeight ?? 80;
    setActualSide(r.top < tipH + 8 ? 'bottom' : side);
  }, [visible, side]);

  // Esc 关闭（键盘用户兜底，避免被困）
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVisible(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible]);

  // trigger 事件：hover 进/出 + focus 进/出（focus 走 tabIndex=0 让 span 可聚焦）
  const triggerProps: React.HTMLAttributes<HTMLSpanElement> & { ref: React.Ref<HTMLSpanElement> } = {
    ref: triggerRef,
    tabIndex: allowFocus ? 0 : undefined,
  };
  if (allowHover) {
    triggerProps.onMouseEnter = () => setVisible(true);
    triggerProps.onMouseLeave = () => setVisible(false);
  }
  if (allowFocus) {
    triggerProps.onFocus = () => setVisible(true);
    triggerProps.onBlur = () => setVisible(false);
  }
  // a11y 兜底：纯文本 content 设 HTML title，hover tooltip 失效时浏览器原生 title 仍可感知
  if (typeof content === 'string') {
    triggerProps.title = content;
  }

  return (
    <span className="relative inline-flex">
      <span {...triggerProps} className="inline-flex outline-none">
        {children}
      </span>
      {visible && (
        <span
          ref={tipRef}

          role="tooltip"
          style={{
            maxWidth,
            // 浮层宽度按内容算（max-content），不受窄 trigger 的 containing block
            // shrink-to-fit 挤压（否则小开关上的 tooltip 会被压成一列一字）；超 maxWidth 才换行
            width: 'max-content',
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            // actualSide=top 时浮层挂在 trigger 上方（bottom: 100%+gap），反之挂下方
            [actualSide === 'top' ? 'bottom' : 'top']: 'calc(100% + 6px)',
          }}
          className={
            'z-50 whitespace-pre-wrap break-words rounded-md border bg-[var(--color-surface)] ' +
            'border-[var(--color-border)] text-[var(--color-fg)] px-2.5 py-1.5 ' +
            'font-mono text-[11px] leading-snug shadow-md transition-opacity duration-150 ' +
            'pointer-events-none ' + (className ?? '')
          }
        >
          {arrow && (
            <span
              className={
                'absolute left-1/2 -translate-x-1/2 w-0 h-0 ' +
                "border-l-[5px] border-r-[5px] border-l-transparent border-r-transparent " +
                (actualSide === 'top'
                  ? 'top-full border-t-[5px] border-t-[var(--color-surface)]'
                  : 'bottom-full border-b-[5px] border-b-[var(--color-surface)]')
              }
              aria-hidden
            />
          )}
          <span>{content}</span>
        </span>
      )}
    </span>
  );
}

export default PrimitiveTooltip;
