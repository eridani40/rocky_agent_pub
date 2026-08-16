/**
 * component-coding-plans-quota-footer — 额度总览 footer（v0.0.352 T2 分组双柱）
 * 参考: specs/prd/quota-overview-demo-v2.html + specs/tech/version_logs/v0.0.350/change_plan.md 决策⑥
 *
 * 职责：providers group list 视图底部的 native 渠道额度/余额总览——
 *   按 kind 分组渲染：quota 组「套餐额度」、balance 组「充值余额」；
 *   quota 卡每档展示上柱（已用 %）+ 下柱（时间进度 %）+ 剩余时间 + 消耗偏快琥珀标；
 *   balance 卡右侧展示币种金额，isAvailable=false 时显示「余额不足」红标；
 *   快照失败 → 沿用 lastGood 值 + error 提示；
 *   取消 v0.0.350 的展开详情交互。
 * 边界：数据轮询在 use-quota-polling；本组件纯渲染。
 * 消费方: section-providers（list 视图底部，仅 native provider 非空时挂载）。
 */
import { useTranslation } from 'react-i18next';
import type { QuotaSnapshot, QuotaTier } from '../../lib/api-client';
import { useQuotaPolling } from './use-quota-polling';
import { formatResetTime, formatRemaining, computeTimeProgress, isUsageFast } from './quota-format';

/** footer 入参 providers 最小形状（section 传 native 子集） */
export interface CodingPlansQuotaFooterProps {
  providers: ReadonlyArray<{ id: string; label: string; baseUrl: string }>;
}

/** 渲染单元：最新快照（可能含 error）+ 降级展示快照（一定无 error） */
interface ProviderView {
  latest: QuotaSnapshot;
  view: QuotaSnapshot;
}

/** 余额币种符号（CNY/USD 常见映射；其余原码前缀） */
function currencySymbol(currency: string): string {
  if (currency === 'CNY') return '¥';
  if (currency === 'USD') return '$';
  return currency + ' ';
}

/** 金额千分位 + 两位小数（如 9,118.81） */
function formatAmount(total: number): string {
  return total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 按 view.kind 将渲染单元分组 */
function groupByKind(views: ProviderView[]): { quota: ProviderView[]; balance: ProviderView[] } {
  const quota: ProviderView[] = [];
  const balance: ProviderView[] = [];
  for (const v of views) {
    if (v.view.kind === 'balance') balance.push(v);
    else quota.push(v);
  }
  return { quota, balance };
}

export function CodingPlansQuotaFooter({ providers }: CodingPlansQuotaFooterProps) {
  const { t } = useTranslation(['providers', 'common']);
  const { byProvider, lastGood, lastFetchedAt } = useQuotaPolling(providers);
  const now = Date.now();

  const views: ProviderView[] = providers
    .map((p) => {
      const latest = byProvider.get(p.id) ?? null;
      if (!latest) return null;
      const view = latest.error ? lastGood.get(p.id) ?? latest : latest;
      return { latest, view };
    })
    .filter((v): v is ProviderView => v !== null);

  const { quota, balance } = groupByKind(views);

  return (
    <div data-testid="quota-footer" className="mt-6">
      {/* 标题行：额度总览 + 全局上次拉取 */}
      <div className="mb-3 flex items-baseline justify-between">
        <span className="text-[13px] font-semibold text-fg-2">{t('quota.title')}</span>
        {lastFetchedAt !== null && (
          <span className="text-[11px] text-muted font-mono">{t('quota.lastUpdated', { time: formatResetTime(lastFetchedAt) })}</span>
        )}
      </div>

      {quota.length > 0 && (
        <div className="mb-3">
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-fg-2">{t('quota.groupQuota')}</span>
            <span className="text-[11px] text-muted">{t('quota.providerCount', { count: quota.length })}</span>
          </div>
          {quota.map(({ latest, view }) => (
            <QuotaCard key={latest.providerId} latest={latest} view={view} now={now} />
          ))}
        </div>
      )}

      {balance.length > 0 && (
        <div>
          <div className="mb-2 flex items-baseline gap-2">
            <span className="text-[13px] font-semibold text-fg-2">{t('quota.groupBalance')}</span>
            <span className="text-[11px] text-muted">{t('quota.providerCount', { count: balance.length })}</span>
          </div>
          {balance.map(({ latest, view }) => (
            <BalanceCard key={latest.providerId} latest={latest} view={view} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 额度卡：渠道头 + 每档双柱 */
function QuotaCard({ latest, view, now }: { latest: QuotaSnapshot; view: QuotaSnapshot; now: number }) {
  const { t } = useTranslation('providers');
  const error = latest.error;

  return (
    <div
      data-testid={`quota-card-${latest.providerId}`}
      className="border border-border rounded-[10px] py-[16px] px-[20px] mb-2 bg-surface-2"
    >
      <div className="flex items-center gap-3">
        <div
          aria-hidden
          className="w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 bg-sage-bg text-sage font-sans font-bold text-[15px] leading-none"
        >
          {(view.providerLabel || view.providerId || '?')[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-fg truncate">{view.providerLabel || view.providerId}</span>
            {view.membership && (
              <span className="shrink-0 text-[10px] font-mono text-sage border border-sage/40 rounded px-1.5 py-0.5 bg-sage-bg">
                {view.membership}
              </span>
            )}
          </div>
          {view.implId && (
            <div className="text-[11px] text-muted font-mono truncate">{view.implId}</div>
          )}
        </div>
      </div>

      {error ? (
        <div className="mt-3 text-[12px] text-danger">
          {error.kind === 'auth' ? t('quota.errorAuth') : error.message}
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {(view.tiers ?? []).map((tier) => (
            <TierBars key={tier.window} tier={tier} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 单档双柱（v0.0.356 D8 导出复用：356 余额查询弹层展开态同款视觉，仅改名导出不改渲染）
 * @param tier 档位快照
 * @param now 当前时间（ms，驱动时间进度/剩余文案）
 */
export function TierBars({ tier, now, hideHeader }: { tier: QuotaTier; now: number; hideHeader?: boolean }) {
  const { t } = useTranslation('providers');
  const timeProgress = computeTimeProgress(tier, now);
  const fast = isUsageFast(tier.usedPercent, timeProgress);
  const resetText = tier.resetsAt ? formatResetTime(tier.resetsAt) : null;
  const remainingText = tier.resetsAt ? formatRemaining(tier.resetsAt, now) : null;

  return (
    <div data-testid={`quota-tier-${tier.window}`}>
      {!hideHeader && (
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <span className="text-[12px] font-semibold text-fg-2 flex items-center gap-2">
            {tier.window === 'five_hour' ? t('quota.fiveHour') : t('quota.weekly')}
            {fast && (
              <span className="shrink-0 text-[9px] font-bold font-mono uppercase tracking-wide bg-gold-bg text-gold border border-gold/40 rounded px-1.5 py-0.5">
                ⚠ {t('quota.fast')}
              </span>
            )}
          </span>
          {resetText && (
            <span className="text-[11px] text-muted font-mono">
              {t('quota.resetSuffix')} {resetText}
              {remainingText && <span className="ml-1.5 text-muted">· {remainingText}</span>}
            </span>
          )}
        </div>
      )}

      {/* 已用柱 */}
      <div className="grid grid-cols-[32px_1fr_44px] items-center gap-2 mb-1">
        <span className="text-[11px] text-muted">{t('quota.used')}</span>
        <div className="h-1.5 rounded-full bg-bg-warm overflow-hidden">
          <div
            className={`h-full rounded-full ${fast ? 'bg-gold' : 'bg-fg'}`}
            style={{ width: `${Math.min(100, Math.max(0, tier.usedPercent))}%` }}
          />
        </div>
        <span className={`text-[11px] text-right font-mono ${fast ? 'text-gold font-semibold' : 'text-fg-2'}`}>
          {Math.round(tier.usedPercent)}%
        </span>
      </div>

      {/* 时间进度柱 */}
      <div className="grid grid-cols-[32px_1fr_44px] items-center gap-2">
        <span className="text-[11px] text-muted">{t('quota.time')}</span>
        <div className="h-1.5 rounded-full bg-bg-warm overflow-hidden">
          <div
            className="h-full rounded-full bg-muted"
            style={{ width: `${Math.min(100, Math.max(0, (timeProgress ?? 0) * 100))}%` }}
          />
        </div>
        <span className="text-[11px] text-right font-mono text-fg-2">
          {timeProgress === null ? '—' : `${Math.round(timeProgress * 100)}%`}
        </span>
      </div>
    </div>
  );
}

/** 余额卡：渠道头 + 右侧金额 */
function BalanceCard({ latest, view }: { latest: QuotaSnapshot; view: QuotaSnapshot }) {
  const { t } = useTranslation('providers');
  const error = latest.error;

  return (
    <div
      data-testid={`quota-card-${latest.providerId}`}
      className="border border-border rounded-[10px] py-[16px] px-[20px] mb-2 bg-surface-2"
    >
      <div className="flex items-center gap-3">
        <div
          aria-hidden
          className="w-8 h-8 rounded-[8px] flex items-center justify-center shrink-0 bg-sage-bg text-sage font-sans font-bold text-[15px] leading-none"
        >
          {(view.providerLabel || view.providerId || '?')[0]?.toUpperCase()}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-fg truncate">{view.providerLabel || view.providerId}</span>
            {view.isAvailable === false && (
              <span className="shrink-0 text-[10px] font-medium text-danger border border-danger/40 rounded px-1.5 py-0.5">
                {t('quota.insufficient')}
              </span>
            )}
          </div>
          {view.implId && (
            <div className="text-[11px] text-muted font-mono truncate">{view.implId}</div>
          )}
        </div>
        {view.balance && (
          <span className="text-[16px] font-semibold font-mono text-fg-2">
            {currencySymbol(view.balance.currency)}
            {formatAmount(view.balance.total)}
          </span>
        )}
      </div>

      {error && (
        <div className="mt-3 text-[12px] text-danger">
          {error.kind === 'auth' ? t('quota.errorAuth') : error.message}
        </div>
      )}
    </div>
  );
}

export default CodingPlansQuotaFooter;
