/**
 * component-quota-entry-modal — 余额查询弹层（v0.0.356 T1）
 * 参考: specs/prd/version_logs/v0.0.356-squad-quota-entry/change_log.md §2.2
 *        specs/prd/squad-quota-entry-demo-v2.html
 *
 * 职责：
 *   - L3 modal 壳（与 component-todo-modal 同款）
 *   - 顶部方案信息栏：方案名 + 四色状态图例
 *   - 四源 hook useSquadQuota 在 modal 内挂载：开即拉/关即停
 *   - provider 卡列表（默认收起）+ 底部脚注（上次更新/刷新策略）
 *   - loading / error / 空态 对齐 todo-modal 模式
 * 边界：planId 非空；关闭按钮 + 点击 overlay 关闭。
 */
import { useTranslation } from 'react-i18next';
import { Portal } from '../../lib/portal';
import { CloseIcon } from './icons';
import { ComponentQuotaProviderCard } from './component-quota-provider-card';
import { useSquadQuota } from './use-squad-quota';
import { formatResetTime } from '../providers/quota-format';

export interface ComponentQuotaEntryModalProps {
  /** 当前 squad 挂载的模型方案 id（来自 SquadStatusContext.detail） */
  planId: string;
  /** 关闭弹层 */
  onClose: () => void;
}

export function ComponentQuotaEntryModal({ planId, onClose }: ComponentQuotaEntryModalProps) {
  const { t } = useTranslation('chat');
  const { cards, planName, lastUpdatedAt, loading, error } = useSquadQuota(planId);

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[rgba(30,25,20,0.45)] backdrop-blur-sm pointer-events-auto"
        onClick={onClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="relative flex max-h-[88vh] w-[720px] max-w-[92vw] flex-col rounded-[14px] border border-border-2 bg-surface shadow-2xl"
        >
          {/* head：标题 + 关闭 */}
          <div className="flex shrink-0 items-center gap-2 px-[22px] pb-3 pt-[18px]">
            <span className="flex-1 text-[15px] font-bold text-fg">{t('quotaModal.title')}</span>
            <button
              type="button"
              data-action-key="chat.quota.close"
              aria-label={t('common:modal.close')}
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-warm hover:text-fg"
            >
              <CloseIcon size={16} />
            </button>
          </div>

          {/* body */}
          <div className="flex flex-col gap-3 overflow-y-auto px-[22px] pb-5">
            <PlanInfoBar planName={planName ?? planId} />
            <Legend />

            {loading && cards.length === 0 ? (
              <div className="py-6 text-center font-mono text-[11px] text-muted">{t('common:status.loading')}</div>
            ) : error ? (
              <div role="alert" className="py-4 text-center text-[12px] text-danger">{error}</div>
            ) : cards.length === 0 ? (
              <div className="px-6 py-12 text-center text-muted">
                <div className="mb-1 text-[24px]" aria-hidden>✓</div>
                <b className="block text-[13px] text-muted-2">{t('quotaModal.empty')}</b>
              </div>
            ) : (
              cards.map((card) => <ComponentQuotaProviderCard key={card.providerId} card={card} now={Date.now()} />)
            )}

            <Footer lastUpdatedAt={lastUpdatedAt} />
          </div>
        </div>
      </div>
    </Portal>
  );
}

/** 顶部方案信息栏 */
function PlanInfoBar({ planName }: { planName: string }) {
  const { t } = useTranslation('chat');
  return (
    <div data-testid="quota-plan-info" className="flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-[12px]">
      <span className="font-mono text-muted-2">{t('quotaModal.plan')}:</span>
      <span className="font-medium text-fg">{planName}</span>
    </div>
  );
}

/** 四色图例 */
function Legend() {
  const { t } = useTranslation('chat');
  return (
    <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted">
      <LegendItem color="bg-sage" label={t('quotaModal.legendWorking')} />
      <LegendItem color="bg-danger" label={t('quotaModal.legendOpen')} />
      <LegendItem color="bg-gold" label={t('quotaModal.legendHalf')} />
      <LegendItem color="bg-muted-2" label={t('quotaModal.legendOff')} border />
    </div>
  );
}

function LegendItem({ color, label, border }: { color: string; label: string; border?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color} ${border ? 'border border-border' : ''}`} aria-hidden />
      {label}
    </span>
  );
}

/** 底部脚注 */
function Footer({ lastUpdatedAt }: { lastUpdatedAt: number | null }) {
  const { t } = useTranslation('chat');
  const time = lastUpdatedAt ? formatResetTime(lastUpdatedAt) : '--:--';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[10px] text-muted-2">
      <span>{t('quotaModal.lastUpdated', { time })}</span>
      <span>{t('quotaModal.refreshHint')}</span>
    </div>
  );
}
