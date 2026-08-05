/**
 * component-ws-resize-handle —— WorkspacePanel 拖宽手柄（§4.2 + §6.2）
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §4.2（[v0.0.182] delta 算法升级）
 *       + §6.2（.ws-resize 视觉基线）
 *
 * [v0.0.182] 改薄 wrapper：复用 component-col-resize-handle（通用 delta 算法手柄），
 *   - side=right（右栏贴 panel 左缘）
 *   - min=WS_WIDTH_MIN(232) / max=min(WS_WIDTH_MAX, maxWidth??WS_WIDTH_MAX)（场景 A 动态上限由父注入）
 *   - testid=ws-resize（ET 锚点保留）+ i18n workspace.resize.*（父 useTranslation 注入）
 *   - currentWidth/maxWidth 由父注入（父 = 三栏引擎钳制后的 renderWidth + dragMaxWidth）
 *
 * MUST 保 testid `ws-resize` + i18n key 不变（ET 锚点）。
 */
import { useTranslation } from 'react-i18next';
import { WS_WIDTH_MAX, WS_WIDTH_MIN } from '../../lib/layout-width-engine';
import { ComponentColResizeHandle } from './component-col-resize-handle';

interface WsResizeHandleProps {
  /** 当前宽度（父注入 = renderWidth ?? width，drag 期间持续更新） */
  currentWidth: number;
  /** 拖动回调：传入 clamp 后新 width，父组件 setState */
  onResize: (width: number) => void;
  /** 拖宽结束回调（mouseup）：父组件 persistWidth + setDragging(null) */
  onResizeEnd?: () => void;
  /** mousedown 触发（父挂 setDragging('right') 进场景 A） */
  onDragStart?: () => void;
  /** 动态上限（dragMaxWidth = dragDynMax(available, leftCurrent)，缺省回退静态 560） */
  maxWidth?: number;
}

/**
 * ws 拖宽手柄薄 wrapper（保 testid ws-resize + i18n key）。算法 / 视觉复用 ComponentColResizeHandle。
 */
export function ComponentWsResizeHandle({
  currentWidth,
  onResize,
  onResizeEnd,
  onDragStart,
  maxWidth,
}: WsResizeHandleProps) {
  const { t } = useTranslation('chat');
  return (
    <ComponentColResizeHandle
      side="right"
      currentWidth={currentWidth}
      minWidth={WS_WIDTH_MIN}
      maxWidth={Math.min(WS_WIDTH_MAX, maxWidth ?? WS_WIDTH_MAX)}
      onResize={onResize}
      onDragStart={onDragStart}
      onResizeEnd={onResizeEnd}

      ariaLabel={t('workspace.resize.ariaLabel')}
      title={t('workspace.resize.title')}
    />
  );
}

export default ComponentWsResizeHandle;
