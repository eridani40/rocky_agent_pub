/**
 * component-market-item — 市场搜索结果卡（受控组件）。
 * 参考: specs/ui/components/skill-page/component-market-item.md
 *       设计稿 reqs/[working] v0.0.167.skill_market_ui/design/skill-market.html .mkt-card
 *
 * 展示：icon-box(hash 色) + name + ref(mono) + installs(能力门控) + 右下状态区。
 * 状态区列表三态：可安装按钮 / 安装中 disabled / 已安装 badge。
 * 点卡 → onOpenDetail(ref)；点安装按钮 stopPropagation → onInstall(ref)。
 * 状态区尺寸固定（布局稳定性 _conventions §11：切换不位移）。
 */
import { useTranslation } from 'react-i18next';
import { IconBox } from '../common/component-icon-box';
import type { MarketItem } from '../../lib/api-client';

export interface ComponentMarketItemProps {
  item: MarketItem;
  /** 父用 deriveMarketStatus 算好传入（列表仅三态） */
  status: 'installable' | 'installing' | 'installed';
  /** 能力门控：capabilities.stats 含 'installs' 才 true */
  showInstalls: boolean;
  onOpenDetail: (ref: string) => void;
  onInstall: (ref: string) => void;
}

/**
 * 格式化安装量数字为简写（如 1200 → 1.2k）。
 */
function fmtInstalls(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}

export function ComponentMarketItem({
  item,
  status,
  showInstalls,
  onOpenDetail,
  onInstall,
}: ComponentMarketItemProps) {
  const { t } = useTranslation('skill');
  const ref = item.ref;

  return (
    <div
      data-action-key="skill.market.open-detail"
      onClick={() => onOpenDetail(ref)}
      className="flex flex-col gap-[10px] p-[14px] rounded-lg border border-[var(--border)] cursor-pointer transition-all hover:border-[var(--border-2)] hover:shadow-sm hover:-translate-y-px"
      style={{ background: 'var(--surface)' }}
    >
      {/* 头部：icon-box + name/ref 两行 */}
      <div className="flex items-center gap-[10px]">
        <IconBox hueBy={ref} size={32} icon={<SkillStarIcon />} />
        <div className="flex-1 min-w-0">
          <div

            className="text-[13.5px] font-semibold truncate"
            style={{ color: 'var(--fg)' }}
          >
            {item.name}
          </div>
          <div

            className="text-[11px] font-mono mt-px truncate"
            style={{ color: 'var(--muted-2)' }}
          >
            {ref}
          </div>
        </div>
      </div>

      {/* 底部：installs(门控) + 状态区（固定高度保布局稳定） */}
      <div
        className="flex items-center justify-between pt-[10px]"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        {/* 左：安装量（能力门控，无则空占位） */}
        <div className="flex items-center gap-[10px]">
          {showInstalls && item.stats?.installs != null && (
            <span

              className="text-[11px] font-mono"
              style={{ color: 'var(--muted-2)' }}
            >
              {fmtInstalls(item.stats.installs)} {t('market.installsLabel')}
            </span>
          )}
        </div>

        {/* 右：状态区（固定 min-w 保稳定） */}
        <div className="flex items-center min-w-[72px] justify-end">
          {status === 'installable' && (
            <button
              type="button"
              data-action-key="skill.market.install"
              onClick={(e) => { e.stopPropagation(); onInstall(ref); }}
              className="inline-flex items-center gap-1 px-[10px] py-[4px] rounded-md text-[12px] font-semibold border-none cursor-pointer transition-opacity hover:opacity-80"
              style={{ background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)' }}
            >
              {t('market.btn.install')}
            </button>
          )}
          {status === 'installing' && (
            <button
              type="button"

              disabled
              className="inline-flex items-center gap-1 px-[10px] py-[4px] rounded-md text-[12px] font-semibold border-none opacity-50 cursor-not-allowed"
              style={{ background: 'var(--btn-primary-bg)', color: 'var(--btn-primary-fg)' }}
            >
              {t('market.btn.installing')}
            </button>
          )}
          {status === 'installed' && (
            <span

              className="inline-flex items-center gap-1 px-2 py-[2px] rounded-full text-[11px] font-medium"
              style={{ background: 'var(--success-bg)', color: 'var(--success)' }}
            >
              <span className="w-[6px] h-[6px] rounded-full" style={{ background: 'currentColor' }} />
              {t('market.status.installed')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 四角星 skill icon（复用 component-skill-item 相同 path） */
function SkillStarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2L14 10 22 12 14 14 12 22 10 14 2 12 10 10Z" />
    </svg>
  );
}

export default ComponentMarketItem;
