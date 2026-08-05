/**
 * component-col-resize-handle —— 通用拖拽手柄（左/右栏共用，delta 算法无死区）
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §4.2 + §6.2（.ws-resize 视觉基线）
 *       specs/tech/version_logs/v0.0.182/change_plan.md §3（resize-handle 模块契约）
 *
 * delta 算法（PRD §3.1/§3.2 无死区核心）：
 *   - mousedown：捕获 startRef = { startX: e.clientX, startWidth: currentWidth }
 *     （mid-drag 不重捕获 → 到边界后反向拖动立即响应，无脱手死区）
 *   - mousemove：dx = e.clientX − startX；
 *     raw = side==='right' ? startWidth−dx : startWidth+dx
 *     （右栏贴左缘 → 鼠标左移 dx<0 → 宽变大；左栏贴右缘 → 鼠标右移 dx>0 → 宽变大）
 *     clamped = max(min, min(max, raw)) → onResize(clamped)
 *   - mouseup：恢复 body cursor/userSelect + onResizeEnd
 *
 * 视觉复用 .ws-resize 模式（§6.2）：6px 手柄贴栏缘 + hover accent 1px 竖线 + body cursor/userSelect 锁定。
 *
 * i18n 文案由调用方注入（本组件不 useTranslation——ws 手柄传 workspace.resize.* / conv 手柄传 convPanel.resize.*）。
 */
import { useCallback, useEffect, useRef } from 'react';

export interface ColResizeHandleProps {
  /** 拖哪一栏（决定 delta 方向 + 手柄贴 panel 哪侧缘） */
  side: 'left' | 'right';
  /** 当前宽度（mousedown 时捕获为 startWidth；mid-drag 不重捕获） */
  currentWidth: number;
  /** 静态/动态下限（调用方决定，如 180 / 232） */
  minWidth: number;
  /** 上限（调用方已 min(静态max, 动态max=dragDynMax) 后传入） */
  maxWidth: number;
  /** 拖动回调（每 mousemove 一次，传入 clamp 后的新宽度） */
  onResize: (width: number) => void;
  /** mousedown 触发（调用方挂 setDragging(side)） */
  onDragStart?: () => void;
  /** mouseup 触发（调用方挂 persist + setDragging(null)） */
  onResizeEnd?: () => void;
  /** aria-label（调用方注入 i18n 文案） */
  ariaLabel?: string;
  /** title（调用方注入 i18n 文案） */
  title?: string;
}

/**
 * 通用拖拽手柄。挂载即绑 window mousemove/mouseup（仅 dragRef=true 时生效），卸载自动解绑。
 */
export function ComponentColResizeHandle({
  side,
  currentWidth,
  minWidth,
  maxWidth,
  onResize,
  onDragStart,
  onResizeEnd,
  ariaLabel,
  title,
}: ColResizeHandleProps) {
  // startRef 仅 mousedown 捕获一次：mid-drag 不重捕获，到边界后反向拖动立即响应（无死区）
  const startRef = useRef({ startX: 0, startWidth: currentWidth });
  const dragRef = useRef(false);
  // ref 持有最新回调，避免 useEffect 依赖变化重新绑监听
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeRef.current = onResize;
  onResizeEndRef.current = onResizeEnd;

  useEffect(() => {
    function handleMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const { startX, startWidth } = startRef.current;
      const dx = e.clientX - startX;
      const raw = side === 'right' ? startWidth - dx : startWidth + dx;
      const clamped = Math.max(minWidth, Math.min(maxWidth, raw));
      onResizeRef.current(clamped);
    }
    function handleUp() {
      if (!dragRef.current) return;
      dragRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onResizeEndRef.current?.();
    }
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [side, minWidth, maxWidth]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // 仅 mousedown 时捕获起点 + 当前宽（mid-drag 不重捕获，无死区）
      startRef.current = { startX: e.clientX, startWidth: currentWidth };
      dragRef.current = true;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      onDragStart?.();
    },
    [currentWidth, onDragStart],
  );

  // side=right（右栏）→ 手柄贴 panel 左缘；side=left（左栏）→ 手柄贴 panel 右缘
  const posClass = side === 'right' ? '-left-0.5' : '-right-0.5';
  const accentPosClass = side === 'right' ? 'left-[2px]' : 'right-[2px]';

  return (
    <div

      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      title={title}
      onMouseDown={handleMouseDown}
      className={`ws-resize group absolute ${posClass} top-0 bottom-0 w-1.5 cursor-col-resize z-[8]`}
    >
      {/* hover 时 accent 竖线（§6.2 ::after 用 span 模拟） */}
      <span
        className={`absolute ${accentPosClass} top-0 bottom-0 w-px bg-transparent group-hover:bg-accent transition-colors`}
        aria-hidden
      />
    </div>
  );
}

export default ComponentColResizeHandle;
