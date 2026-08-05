/**
 * component-obs-item — 可观测性列表单项（provider-card）
 * 参考: specs/ui/components/app-dev-config-page/observability-config/component-obs-item.md
 *       设计稿视觉基线: reqs/v0.0.11/easy-opc-config-v10.html L409-428（provider-card）
 *
 * 职责：logo + 名称行（状态点 + 名称 + 启停 badge）+ desc 行 + 启停 toggle + 删除按钮。
 * 点击整卡进详情；toggle 与删除独立（stopPropagation，布局稳定性：始终可见，预留固定空间）。
 * 边界：不展示编辑表单（→ section-observability-detail）。
 */
import { useTranslation } from 'react-i18next';
import { ToggleSwitch } from '../../framework/primitives/toggle-switch';
import type { ObservabilityConfig } from './types';

interface ComponentObsItemProps {
  /** 该项配置（见 _overview §2） */
  config: ObservabilityConfig;
  /** 点击整卡 → 进 detail */
  onSelect: (id: string) => void;
  /** toggle 即时翻转（不计 dirty） */
  onToggle: (id: string, enabled: boolean) => void;
  /** 点删除按钮 → 触发父级打开 modal */
  onDeleteRequest: (config: ObservabilityConfig) => void;
}

/** 可观测性列表单项 */
export function ComponentObsItem({ config, onSelect, onToggle, onDeleteRequest }: ComponentObsItemProps) {
  const { id, name, type, baseUrl, desc, enabled } = config;
  // [v0.0.62 i18n] observability 列表项文案走 app-dev-config ns
  const { t } = useTranslation('app-dev-config');
  return (
    <div
      data-action-key="settings.observability.open-detail"
      onClick={() => onSelect(id)}
      className="bg-surface-2 border border-border rounded-[10px] px-5 py-4 mb-2 flex items-center gap-3.5 cursor-pointer transition-colors hover:border-border-strong hover:shadow-sm"
    >
      {/* logo：sage 实底 + activity icon（40×40 rounded-[10px]） */}
      <div

        className="w-10 h-10 rounded-[10px] bg-[var(--color-sage)] flex items-center justify-center shrink-0"
      >
        {/* 简易 activity 波形图标（SVG inline，避免引第三方 icon 库） */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 12h3l3 8 4-16 3 8h5" />
        </svg>
      </div>

      {/* 中：name 行（状态点 + 名称 + badge）+ desc 行 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {/* 状态点：enabled=sage / disabled=muted，始终渲染（布局稳定） */}
          <span

            aria-hidden
            className={'inline-block w-[7px] h-[7px] rounded-full shrink-0 ' + (enabled ? 'bg-[var(--color-sage)]' : 'bg-muted')}
          />
          <span

            className="text-[14px] font-semibold text-fg truncate"
          >
            {name || t('observability.unnamed')}
          </span>
          {/* 启用/禁用 badge */}
          <span

            className={
              'text-[10px] font-semibold font-mono px-1.5 py-0.5 rounded shrink-0 ' +
              (enabled
                ? 'bg-[var(--color-sage-bg)] text-[var(--color-sage)]'
                : 'bg-bg-warm text-muted')
            }
          >
            {enabled ? t('observability.enabled') : t('observability.disabled')}
          </span>
        </div>
        {/* desc 行：{type} · {baseUrl} · {desc}，11px mono muted */}
        <div

          className="text-[11px] font-mono text-muted mt-1 truncate"
        >
          {type} · {baseUrl || t('observability.emptyBaseUrl')}
          {desc ? ` · ${desc}` : ''}
        </div>
      </div>

      {/* 右：toggle + 删除按钮（始终可见，预留固定空间；stopPropagation 独立） */}
      <div className="flex items-center gap-2 shrink-0">
        <div onClick={(e) => e.stopPropagation()} className="flex items-center">
          <ToggleSwitch
            value={enabled}
            onChange={(next) => onToggle(id, next)}
            label={t('observability.toggleAria', { name: name || t('observability.breadcrumbRoot') })}
            actionKey="settings.observability.toggle"
          />
        </div>
        <button
          type="button"
          data-action-key="settings.observability.delete"
          aria-label={t('observability.deleteAria', { name: name || t('observability.deleteTitle') })}
          onClick={(e) => {
            e.stopPropagation();
            onDeleteRequest(config);
          }}
          className="w-7 h-7 rounded-md border border-border-2 text-muted-2 flex items-center justify-center transition-colors hover:border-red-400 hover:text-red-600 hover:bg-red-50"
        >
          {/* trash icon */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default ComponentObsItem;
