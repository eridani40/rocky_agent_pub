/**
 * component-provider-list-card — 列表层单个 provider 卡（v0.0.7）
 * 参考: specs/ui/components/providers/_overview.md §5
 *       视觉: key-card 同款（surface-2 + border + radius 10px + hover border-strong）
 *
 * 职责：展示 provider 外显字段；整卡点击 → 进二级页。
 * 边界：不调后端、不持本地状态；点击上抛父级。
 *
 * 外显：首字母 logo（label[0]，font-sans bold 700，40×40 圆角；启用 sage 底 / 未启用 bg-warm）
 *       + label(14/600) + enabled 徽章 + 副标 mono（baseUrl · N 个模型）+ 右 chevron。
 * testid: provider-card-{id}
 */
import { useTranslation } from 'react-i18next';
import type { ProviderInstance } from '../../lib/api-client';

export interface ComponentProviderListCardProps {
  /** 要展示的 provider */
  provider: ProviderInstance;
  /** 整卡点击 → 父级进入二级页 */
  onClick: () => void;
}

/** provider 卡：横向布局——左 [logo + label + 副标]，右 [徽章 + chevron] */
export function ComponentProviderListCard({ provider, onClick }: ComponentProviderListCardProps) {
  // [v0.0.62 i18n] 副标 modelCount + 徽章文案走 providers ns
  const { t } = useTranslation('providers');
  return (
    <div
      data-action-key="providers.provider.open-detail"
      data-testid={`provider-card-${provider.id}`}
      onClick={onClick}
      className="border border-border rounded-[10px] py-[16px] px-[20px] mb-2 bg-surface-2 transition-colors hover:border-border-strong cursor-pointer flex items-center gap-3"
    >
      {/* 首字母 logo：启用 sage / 未启用 bg-warm */}
      <div
        aria-hidden
        className={
          'w-10 h-10 rounded-[10px] flex items-center justify-center shrink-0 ' +
          (provider.enabled ? 'bg-sage-bg text-sage' : 'bg-bg-warm text-muted')
        }
      >
        <span className="font-sans font-bold text-[20px] leading-none">
          {(provider.label || provider.id || '?')[0]?.toUpperCase()}
        </span>
      </div>

      {/* 中：label + 副标 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-fg truncate">{provider.label || provider.id}</span>
          <Badge enabled={provider.enabled} />
        </div>
        <div className="text-[11px] text-muted font-mono mt-0.5 truncate">
          {provider.baseUrl || '—'}<span className="mx-1.5 text-border-strong">·</span>{t('list.modelCount', { count: provider.models.length })}
        </div>
      </div>

      {/* 右：chevron */}
      <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted shrink-0"><path d="M9 6l6 6-6 6" /></svg>
    </div>
  );
}

/** enabled 徽章：启用 sage / 禁用 muted */
function Badge({ enabled }: { enabled: boolean }) {
  // [v0.0.62 i18n] 徽章文案查 providers.list.{enabled,disabled}
  const { t } = useTranslation('providers');
  return enabled ? (
    <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-bold font-mono uppercase tracking-wide bg-sage-bg text-sage">{t('list.enabled')}</span>
  ) : (
    <span className="inline-block px-1.5 py-[1px] rounded text-[9px] font-bold font-mono uppercase tracking-wide bg-bg-warm text-muted">{t('list.disabled')}</span>
  );
}

export default ComponentProviderListCard;
