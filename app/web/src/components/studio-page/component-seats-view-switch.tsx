/**
 * component-seats-view-switch —— seats roster「在岗 / 全部」视图筛选 segmented 开关（v0.0.244 新增）
 * 参考: specs/ui/components/studio-page/component-seats-view-switch.md
 *       component-panorama-archive-switch.tsx（视觉/交互同构参考，不泛化——其 i18n/actionKey 为 panorama 专属）
 *
 * 职责：两段「在岗 / 全部」单选互斥；切换 → onChange(view) 通知父级。
 * 边界：受控不持状态（view 由 SeatsPanel state 注入）；不 fetch、不过滤 rows
 *       （过滤单点 = SeatsPanel 的 deriveViewRows）；恒渲染（不条件于存在 benched）。
 */
import { useTranslation } from 'react-i18next';
import type { SeatsView } from './use-seats-data';

export interface SeatsViewSwitchProps {
  view: SeatsView;
  onChange: (view: SeatsView) => void;
}

/** 单 segmented 按钮（active 高亮，inactive hover 揭示）——与 ArchiveSwitch 同构 */
function Segment({
  active,
  label,
  actionKey,
  onClick,
}: {
  active: boolean;
  label: string;
  actionKey: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-action-key={actionKey}
      data-active={active ? 'true' : 'false'}
      onClick={onClick}
      className={
        'rounded px-2 py-0.5 transition-colors ' +
        (active ? 'bg-surface-2 font-semibold text-fg' : 'hover:text-fg-2')
      }
    >
      {label}
    </button>
  );
}

/** 「在岗 / 全部」视图筛选开关（roster 头恒渲染；受控） */
export function SeatsViewSwitch({ view, onChange }: SeatsViewSwitchProps) {
  const { t } = useTranslation('studio');
  return (
    <div className="flex h-7 items-center gap-1 text-[11.5px] text-muted">
      <Segment
        active={view === 'active'}
        label={t('seats.viewSwitch.active')}
        actionKey="studio.seats.view-active"
        onClick={() => onChange('active')}
      />
      <span className="text-muted-2">/</span>
      <Segment
        active={view === 'all'}
        label={t('seats.viewSwitch.all')}
        actionKey="studio.seats.view-all"
        onClick={() => onChange('all')}
      />
    </div>
  );
}

export default SeatsViewSwitch;
