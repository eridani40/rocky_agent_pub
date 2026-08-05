/**
 * component-derive-academy-preview-panel —— derive_academy 继承预览面板（纯展示子组件）
 * 参考: specs/ui/components/academy-page/component-derive-academy-preview-panel.md
 *       specs/api/overall/11a-squad-endpoints.md §2.5（PreviewResult schema = 消费契约）
 *
 * 从 component-derive-academy-picker 拆出（保 picker ≤300 行）；纯展示，无自有数据生命周期。
 * 渲染「将带入」清单分组 + 同名 amber 标 + 覆盖 toggle；同名项默认 skip（toggle off），
 * 不同名项无 toggle（固定槽位 invisible 占位，不位移——对齐 _conventions §11）。
 */
import { useTranslation } from 'react-i18next';
import type { PreviewItem, PreviewResult } from '../../lib/squad-api';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';

interface Props {
  /** PreviewResult（11a §2.5） */
  data: PreviewResult;
  /** 同名项 toggle 状态（key=`${kind}:${name}`，kind='skill'|'memory'）；true=overwrite */
  toggles: Record<string, boolean>;
  /** toggle 翻转（key 同上） */
  onToggle: (key: string) => void;
}

/** status-badge：sage=新增/将带入，amber=同名·保留原 squad */
function StatusBadge({ kind }: { kind: 'new' | 'conflict' }) {
  const { t } = useTranslation('academy');
  const cls = kind === 'new' ? 'bg-sage-bg text-sage' : 'bg-gold-bg text-[#b45309]';
  const label = kind === 'new' ? t('derive.previewBadgeNew') : t('derive.previewBadgeConflict');
  return (
    <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded-sm ${cls}`}>{label}</span>
  );
}

/** 项行（skill/memory）：name + status-badge + 同名 toggle（不同名项 toggle 槽位 invisible 占位） */
function ItemRow({
  kind, item, on, onToggle,
}: {
  kind: 'skill' | 'memory';
  item: PreviewItem;
  on: boolean;
  onToggle: (key: string) => void;
}) {
  const { t } = useTranslation('academy');
  const key = `${kind}:${item.name}`;
  return (
    <div className="flex items-center gap-2.5 px-[14px] py-[9px] rounded-lg hover:bg-bg-warm">
      <div className="flex-1 min-w-0 text-[13px] font-medium text-fg truncate">{item.name}</div>
      <StatusBadge kind={item.sameNameConflict ? 'conflict' : 'new'} />
      {/* 固定 toggle 槽位（w-9 与 ToggleSwitch 同宽）：同名项渲染开关，不同名项 invisible 占位不位移 */}
      <div className="w-9 flex justify-end">
        {item.sameNameConflict ? (
          <ToggleSwitch
            value={on}
            onChange={() => onToggle(key)}
            label={t('derive.toggleOverwrite', { name: item.name })}
            actionKey="academy.derive.toggle-overwrite"
          />
        ) : (
          <span className="invisible inline-flex h-5 w-9" aria-hidden />
        )}
      </div>
    </div>
  );
}

/** 继承预览面板（纯展示） */
export function ComponentDeriveAcademyPreviewPanel({ data, toggles, onToggle }: Props) {
  const { t } = useTranslation('academy');
  const total = (data.agentsMd.exists ? 1 : 0) + data.skills.length + data.memory.length;
  const conflictCount =
    data.skills.filter((s) => s.sameNameConflict).length +
    data.memory.filter((m) => m.sameNameConflict).length;

  return (
    <div className="border-t border-border">
      {/* preview-summary */}
      <div className="px-[14px] py-[11px] text-[11px] font-semibold text-fg-2">
        {t('derive.previewSummary', { total, conflict: conflictCount })}
      </div>

      {/* group-agents（仅 exists 时渲染） */}
      {data.agentsMd.exists && (
        <div>
          <div className="px-[14px] pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-2">
            AGENTS.md
          </div>
          <div className="flex items-center gap-2.5 px-[14px] py-[9px] rounded-lg">
            <div className="flex-1 text-[13px] font-medium text-fg">AGENTS.md</div>
            <StatusBadge kind="new" />
            {/* AGENTS.md 无同名概念：固定占位与同名项对齐 */}
            <div className="w-9 flex justify-end">
              <span className="invisible inline-flex h-5 w-9" aria-hidden />
            </div>
          </div>
        </div>
      )}

      {/* group-skills */}
      {data.skills.length > 0 && (
        <div>
          <div className="px-[14px] pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-2">
            {t('derive.previewGroupSkills')}
          </div>
          {data.skills.map((s) => (
            <ItemRow
              key={`skill:${s.name}`}
              kind="skill"
              item={s}
              on={!!toggles[`skill:${s.name}`]}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}

      {/* group-memory */}
      {data.memory.length > 0 && (
        <div>
          <div className="px-[14px] pt-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-2">
            {t('derive.previewGroupMemory')}
          </div>
          {data.memory.map((m) => (
            <ItemRow
              key={`memory:${m.name}`}
              kind="memory"
              item={m}
              on={!!toggles[`memory:${m.name}`]}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default ComponentDeriveAcademyPreviewPanel;
