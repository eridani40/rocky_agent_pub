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
 * [v0.0.320] posSide prop：side 决定 delta 方向，posSide 决定手柄贴 panel 哪侧缘（拆分语义）。
 *   预览区左分隔条 = side='left'（拖右变宽）+ posSide='left'（贴预览左缘）——旧调用方不传 posSide
 *   时行为不变（side='right' 贴左缘 / side='left' 贴右缘）。
 *
 * 视觉复用 .ws-resize 模式（§6.2）：6px 手柄贴栏缘 + hover accent 1px 竖线 + body cursor/userSelect 锁定。
 *
 * i18n 文案由调用方注入（本组件不 useTranslation——ws 手柄传 workspace.resize.* / conv 手柄传 convPanel.resize.*）。
 */
import { useCallback, useEffect, useRef } from 'react';

export interface ColResizeHandleProps {
  /** 拖哪一栏（决定 delta 方向 + 缺省 posSide：right 贴左缘 / left 贴右缘） */
  side: 'left' | 'right';
  /** [v0.0.320] 手柄贴 panel 哪侧缘（缺省 = 旧行为 side 决定） */
  posSide?: 'left' | 'right';
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
  /** [v0.0.320] data-testid（ET/UT 锚点；预览区双分隔条 pv-resize-left/right 用） */
  testid?: string;
}

/**
 * 通用拖拽手柄。挂载即绑 window mousemove/mouseup（仅 dragRef=true 时生效），卸载自动解绑。
 */
export function ComponentColResizeHandle({
  side,
  posSide,
  currentWidth,
  minWidth,
  maxWidth,
  onResize,
  onDragStart,
  onResizeEnd,
  ariaLabel,
  title,
  testid,
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

  // 手柄贴 panel 哪侧缘：[v0.0.320] posSide 显式指定（预览区左条 posSide='left'）；
  // 缺省 = 旧行为（side='right' 贴左缘 / side='left' 贴右缘）
  const effPos = posSide ?? (side === 'right' ? 'left' : 'right');
  const posClass = effPos === 'right' ? '-right-0.5' : '-left-0.5';
  const accentPosClass = effPos === 'right' ? 'right-[2px]' : 'left-[2px]';

  return (
    <div
      data-testid={testid}
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
