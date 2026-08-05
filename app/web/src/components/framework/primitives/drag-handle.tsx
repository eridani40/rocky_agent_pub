/**
 * primitive-drag-handle — 拖拽手柄 primitive
 * 参考: specs/ui/components/framework/primitive-drag-handle.md
 *
 * grip 图标视觉 + draggable 钩子，用于 ordered 列表项排序。
 * 只提供「可被拖拽」的视觉与交互入口；排序逻辑由父级 ordered 列表组件实现
 * （本组件不维护列表顺序）。
 */
import { useTranslation } from 'react-i18next';

/**
 * 拖拽手柄：grip 图标（2x3 圆点）+ draggable 属性 + cursor-grab/grabbing。
 * 真实拖拽排序由父级配合 HTML5 DnD 或 dnd-kit 实现。
 */
export function DragHandle() {
  // [v0.0.62 i18n] aria-label 走 framework ns
  const { t } = useTranslation('framework');
  return (
    <span

      draggable
      aria-label={t('dragHandle.ariaLabel')}
      className="inline-flex items-center justify-center w-6 h-6 cursor-grab active:cursor-grabbing text-muted hover:text-fg transition-colors"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
        {/* grip：2 列 x 3 行 圆点 */}
        <circle cx="5" cy="3" r="1.2" />
        <circle cx="5" cy="8" r="1.2" />
        <circle cx="5" cy="13" r="1.2" />
        <circle cx="11" cy="3" r="1.2" />
        <circle cx="11" cy="8" r="1.2" />
        <circle cx="11" cy="13" r="1.2" />
      </svg>
    </span>
  );
}

export default DragHandle;
