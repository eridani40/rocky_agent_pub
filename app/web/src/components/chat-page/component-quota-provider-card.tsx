/**
 * component-quota-provider-card — 余额查询双态卡（v0.0.356 T1）
 * 参考: specs/prd/squad-quota-entry-demo-v2.html §②
 *        specs/prd/version_logs/v0.0.356-squad-quota-entry/change_log.md §2.3/2.4
 *
 * 职责：
 *   - 收起态：窄行（状态点 + 头像 + provider/model 两行 + 双档双环 + chevron）
 *     双档：「5小时额度」「周额度」每组左右并列「用量环 + 时间环」，环上字下
 *   - 展开态：替换为细节层（主副标题交换、baseUrl mono、item 行、双柱/余额大字）
 *   - 点击卡片任意处切换；卡片间独立 toggle（非手风琴）
 *   - 余额型 provider 收起态无环，直接金额 +「充值余额」
 * 边界：默认收起；≤300 行。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CardVM } from './use-squad-quota';
import { QuotaRing } from './component-quota-ring';
import { ChevronIcon } from './icons';
import {
  computeTimeProgress,
  isUsageFast,
  formatResetTime,
  formatRemaining,
  formatSingleUnit,
  formatAmount,
  currencySymbol,
} from '../providers/quota-format';
import { fmtHours } from '../app-dev-config-page/component-hour-grid-picker';
import { TierBars } from '../providers/component-coding-plans-quota-footer';
import type { QuotaSnapshot } from '../../lib/api-client';

export interface ComponentQuotaProviderCardProps {
  card: CardVM;
  now: number;
}

interface Labels {
  fiveHour: string;
  weekly: string;
  day: string;
  hour: string;
  minute: string;
  zero: string;
  balance: string;
  plan: string;
  insufficient: string;
}

const DOT: Record<CardVM['state'], string> = {
  working: 'bg-sage shadow-[0_0_0_3px_var(--color-sage-bg)]',
  open: 'bg-danger shadow-[0_0_0_3px_var(--color-danger-bg)]',
  half: 'bg-gold shadow-[0_0_0_3px_var(--color-gold-bg)]',
  off: 'bg-muted-2 shadow-[0_0_0_3px_var(--color-bg)] border border-border',
};
const TEXT: Record<CardVM['stateKey'], string> = {
  working: 'text-sage',
  open: 'text-danger',
  half: 'text-gold',
  off: 'text-muted',
};

function StateDot({ state, label }: { state: CardVM['state']; label: string }) {
  return <span aria-label={label} className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[state]}`} />;
}
function Avatar({ label }: { label: string }) {
  return (
    <div aria-hidden className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-sage-bg text-[13px] font-bold leading-none text-sage">
      {(label || '?')[0]?.toUpperCase()}
    </div>
  );
}

function useCardLabels(): Labels {
  const { t } = useTranslation('chat');
  return {
    fiveHour: t('quotaModal.tierFiveHour'),
    weekly: t('quotaModal.tierWeekly'),
    day: t('quotaModal.singleUnitDay'),
    hour: t('quotaModal.singleUnitHour'),
    minute: t('quotaModal.singleUnitMinute'),
    zero: t('quotaModal.singleUnitZero'),
    balance: t('quotaModal.tierBalance'),
    plan: t('quotaModal.plan'),
    insufficient: t('quotaModal.insufficient'),
  };
}

function RingPair({ snapshot, tier, now, labels }: { snapshot: QuotaSnapshot; tier: NonNullable<QuotaSnapshot['tiers']>[number]; now: number; labels: Labels }) {
  const used = tier.usedPercent;
  const time = computeTimeProgress(tier, now);
  const fast = isUsageFast(used, time);
  const centerTime = tier.resetsAt ? formatSingleUnit(tier.resetsAt, now, labels) : labels.zero;
  const label = tier.window === 'five_hour' ? labels.fiveHour : labels.weekly;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="flex items-start gap-1">
        <QuotaRing
          kind="used"
          label=""
          percent={used}
          centerText={`${Math.round(used)}%`}
          fast={fast}
          ariaLabel={`${snapshot.providerLabel} ${label} ${Math.round(used)}%`}
        />
        <QuotaRing
          kind="time"
          label=""
          percent={(time ?? 0) * 100}
          centerText={centerTime}
          ariaLabel={`${snapshot.providerLabel} ${label} time ${centerTime}`}
        />
      </div>
      <span className="text-[10px] text-muted whitespace-nowrap">{label}</span>
    </div>
  );
}

export function ComponentQuotaProviderCard({ card, now }: ComponentQuotaProviderCardProps) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const labels = useCardLabels();
  const stateLabel = t(`quotaModal.legend${cap(card.stateKey)}`);
  const isBalance = card.snapshot?.kind === 'balance';

  return (
    <button
      type="button"
      data-testid={`quota-provider-card-${card.providerId}`}
      onClick={() => setExpanded((e) => !e)}
      aria-expanded={expanded}
      className="w-full rounded-[12px] border border-border bg-surface px-4 py-3 text-left transition-colors hover:bg-bg-warm"
    >
      {expanded ? (
        <Expanded card={card} now={now} labels={labels} stateLabel={stateLabel} isBalance={isBalance} />
      ) : (
        <Collapsed card={card} now={now} labels={labels} stateLabel={stateLabel} isBalance={isBalance} />
      )}
    </button>
  );
}

function Collapsed({ card, now, labels, stateLabel, isBalance }: { card: CardVM; now: number; labels: Labels; stateLabel: string; isBalance: boolean }) {
  const snap = card.snapshot;
  const balance = snap?.balance;
  return (
    <div className="flex items-center gap-3">
      <StateDot state={card.state} label={stateLabel} />
      <Avatar label={card.providerLabel} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-fg">{card.providerLabel}</div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <span className="font-mono">{card.modelId}</span>
          <span>·</span>
          <span className={TEXT[card.stateKey]}>{stateLabel}</span>
        </div>
      </div>

      {isBalance && balance ? (
        <div className="ml-auto flex flex-col items-end gap-0.5">
          <span className="text-[15px] font-semibold font-mono text-fg-2">{currencySymbol(balance.currency)}{formatAmount(balance.total)}</span>
          <span className="text-[9px] text-muted">{labels.balance}</span>
        </div>
      ) : (
        <div className="ml-auto flex items-start gap-3">
          {snap?.tiers?.map((tier) => <RingPair key={tier.window} snapshot={snap} tier={tier} now={now} labels={labels} />)}
        </div>
      )}
      <ChevronIcon size={14} className="shrink-0 text-muted" />
    </div>
  );
}

function Expanded({ card, now, labels, stateLabel, isBalance }: { card: CardVM; now: number; labels: Labels; stateLabel: string; isBalance: boolean }) {
  const snap = card.snapshot;
  const balance = snap?.balance;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <StateDot state={card.state} label={stateLabel} />
        <Avatar label={card.providerLabel} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-fg">
            <span className="truncate">{card.providerLabel}</span>
            <span className="font-mono text-[11px] font-normal text-muted-2">{card.modelId}</span>
            <span className="shrink-0 rounded border border-sage/40 bg-sage-bg px-1.5 py-0.5 text-[9px] font-mono text-sage">{isBalance ? labels.balance : labels.plan}</span>
          </div>
          {card.baseUrl && <div className="truncate text-[11px] font-mono text-muted">{card.baseUrl}</div>}
        </div>
        <ChevronIcon size={14} className="shrink-0 rotate-180 text-muted" />
      </div>

      <ItemRow card={card} labels={labels} />

      {isBalance && balance ? (
        <div className="flex items-baseline gap-2 px-1">
          <span className="text-[11px] text-muted">{labels.balance}</span>
          <span className="text-[22px] font-semibold font-mono text-fg-2">{currencySymbol(balance.currency)}{formatAmount(balance.total)}</span>
          {snap?.isAvailable === false && <span className="text-[10px] font-medium text-danger">{labels.insufficient}</span>}
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-1">
          {snap?.tiers?.map((tier) => <ExpandedTier key={tier.window} tier={tier} now={now} snapshot={snap} labels={labels} />)}
        </div>
      )}
    </div>
  );
}

function ItemRow({ card, labels }: { card: CardVM; labels: Labels }) {
  const { t } = useTranslation('chat');
  // v0.0.364：时间段展示引用应用配置侧同一份 fmtHours（禁第二套解读）；空数组 '' falsy 走「不限时」
  const range = fmtHours(card.hours ?? []);
  const timeText = range ? `${range} · ${t(`quotaModal.time${card.offWindow ? 'Miss' : 'Hit'}`)}` : t('quotaModal.timeAny');
  const word = t(`quotaModal.legend${cap(card.stateKey)}`);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-bg px-2 py-1.5 text-[11px]">
      <StateDot state={card.state} label={word} />
      <span className="font-mono text-muted-2">{card.modelId}</span>
      <span className="text-muted">{timeText}</span>
      <span className={TEXT[card.stateKey]}>{word}</span>
      {card.state === 'open' && card.remainingSeconds !== null && <span className="font-mono text-danger">{t('quotaModal.retryIn', { sec: Math.max(0, card.remainingSeconds) })}</span>}
      {card.state === 'half' && <span className="font-mono text-gold">{t('quotaModal.halfProbing')}</span>}
      {card.state === 'off' && <span className="font-mono text-muted">{t('quotaModal.notRouting')}</span>}
    </div>
  );
}

function ExpandedTier({ tier, now, snapshot, labels }: { tier: NonNullable<QuotaSnapshot['tiers']>[number]; now: number; snapshot: QuotaSnapshot; labels: Labels }) {
  const { t } = useTranslation('chat');
  const timeProgress = computeTimeProgress(tier, now);
  const fast = isUsageFast(tier.usedPercent, timeProgress);
  const resetText = tier.resetsAt ? formatResetTime(tier.resetsAt) : null;
  const remainingText = tier.resetsAt ? formatRemaining(tier.resetsAt, now) : null;
  return (
    <div data-testid={`quota-tier-${tier.window}`}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-[12px] font-semibold text-fg-2">
          {tier.window === 'five_hour' ? t('quotaModal.tierFiveHour') : t('quotaModal.tierWeekly')}
          {fast && <span className="shrink-0 rounded border border-gold/40 bg-gold-bg px-1.5 py-0.5 text-[9px] font-bold font-mono uppercase tracking-wide text-gold">⚠ {t('quotaModal.fast')}</span>}
        </span>
        {resetText && (
          <span className="text-[11px] font-mono text-muted">
            {t('quotaModal.resetAt', { time: resetText })}
            {remainingText && <span className="ml-1.5 text-muted-2">· {remainingText}</span>}
          </span>
        )}
      </div>
      <TierBars tier={tier} now={now} hideHeader />
    </div>
  );
}

function cap(s: string) {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}
