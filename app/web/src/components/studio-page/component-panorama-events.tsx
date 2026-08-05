/**
 * component-panorama-events —— 全景事件流面板（底部可折叠）
 * 参考: specs/ui/components/studio-page/component-panorama-view.md（事件流面板契约）
 *       specs/api/overall/14-panorama-endpoints.md §3.1（PanoramaEvent shape）
 *
 * 每行：seq + summary + type 标记；折叠态只留标题栏。
 * 边界：纯展示；事件数据由父 view 注入（GET events + SSE 乐观追加）。
 */
import { useTranslation } from 'react-i18next';
import type { PanoramaEvent } from './panorama-types';
import { Icon } from './studio-icons';

export interface PanoramaEventsProps {
  events: PanoramaEvent[];
  collapsed: boolean;
  onToggle: () => void;
}

export function PanoramaEvents({ events, collapsed, onToggle }: PanoramaEventsProps) {
  const { t } = useTranslation('studio');
  return (
    <div className="shrink-0 rounded-xl border border-border bg-surface">
      <button
        type="button"

        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12px] font-semibold text-fg-2 transition-colors hover:bg-surface-2"
      >
        <span className={collapsed ? 'inline-flex' : 'inline-flex rotate-90'}>
          <Icon name="chevron-right" size={12} />
        </span>
        {t('panorama.events.title')}
        <span className="ml-auto font-mono text-[11px] font-normal text-muted">{events.length}</span>
      </button>
      {!collapsed && (
        <div className="max-h-[160px] overflow-y-auto border-t border-border">
          {events.length === 0 && <div className="px-3 py-4 text-center text-[12px] text-muted">—</div>}
          {events.map((ev) => (
            <div
              key={ev.seq}

              className="flex items-baseline gap-2 border-b border-border/50 px-3 py-1.5 last:border-b-0"
            >
              <span className="shrink-0 font-mono text-[10.5px] text-muted">#{ev.seq}</span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-fg-2">{ev.summary}</span>
              <span className="shrink-0 rounded border border-border-2 px-1 py-0.5 font-mono text-[10px] text-muted">
                {ev.type}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default PanoramaEvents;
