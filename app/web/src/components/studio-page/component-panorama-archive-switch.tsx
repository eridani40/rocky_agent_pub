/**
 * component-panorama-archive-switch —— 任务 kanban「活跃 / 含归档」segmented 开关
 * 参考: specs/ui/components/studio-page/component-panorama-view.md（toolbar archive 开关槽位）
 *       reqs/[working] v0.0.240.squad_task/demo-home.html（.kbar-switch，视觉契约）
 *
 * 职责：view.filter.archived 存在时显示；切「含归档」→ 父级 override filter 看全部。
 * 边界：纯展示 + 单 onChange 回调；不持状态（受控）。
 */
import { useTranslation } from 'react-i18next';

export type ArchiveMode = 'active' | 'with_archived';

export interface ArchiveSwitchProps {
  mode: ArchiveMode;
  onChange: (mode: ArchiveMode) => void;
}

/** 单 segmented 按钮（active 高亮，inactive hover 揭示） */
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

/** 「活跃 / 含归档」segmented 开关（仅 view 声明 filter.archived 时由父级条件渲染） */
export function ArchiveSwitch({ mode, onChange }: ArchiveSwitchProps) {
  const { t } = useTranslation('studio');
  return (
    <div className="flex h-7 items-center gap-1 text-[11.5px] text-muted">
      <Segment
        active={mode === 'active'}
        label={t('panorama.archive.active')}
        actionKey="studio.panorama.archive-active"
        onClick={() => onChange('active')}
      />
      <span className="text-muted-2">/</span>
      <Segment
        active={mode === 'with_archived'}
        label={t('panorama.archive.withArchived')}
        actionKey="studio.panorama.archive-with-archived"
        onClick={() => onChange('with_archived')}
      />
    </div>
  );
}

export default ArchiveSwitch;
