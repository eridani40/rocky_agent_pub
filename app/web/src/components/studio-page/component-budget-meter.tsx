/**
 * component-budget-meter —— 团队 token 预算仪表 + 预算配置
 * 参考: specs/ui/components/studio-page/budget-meter.md（testid 契约 + 状态/交互）
 *       specs/api/version_logs/v0.0.33.4/change_log.md §4（GET /budget/usage）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10/§3.11（useLifecycle 四方法契约）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.2（Snapshot 形）
 *
 * 职责：实时显示 squad 当前 daily 窗口 token 消耗。
 * [v0.0.116] 新增配置交互：budget-switch（off=不限量/on=限量）+ on 展开 budget-limit-input + budget-save。
 *
 * [v0.0.316 P1] 受控化：从「自管 budgetOn/limitInput/savePending + onSaveBudget PATCH」改为「受控 + onChange 上报」。
 *   budgetOn 从 useState 改为派生 budget != null；toggle off → onChange(null)；
 *   toggle on → onChange(默认值)；limit 变 → onChange(更新 limit)；去掉 save 按钮 + savePending。
 *   usage 展示（useLifecycle 轮询）不变（只读展示，与 save 无关）。
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getBudgetUsage } from '../../lib/squad-api';
import { useLifecycle } from '../../lib/use-lifecycle';
import type { Snapshot } from '../../lib/lifecycle-shapes';
import type { BudgetUsage } from './squad-types';
import { FIELD_LABEL } from './studio-styles';
import { Icon } from './studio-icons';

/** budget 配置形（受控 prop + onChange 值形） */
type BudgetConfig = { limit: number; window: 'daily'; scope: 'team' } | null;

interface BudgetMeterProps {
  squadId: string;
  /** 当前 budget 配置（受控：来自父级 draft；null=不限量） */
  budget?: BudgetConfig;
  /** 上报变更（toggle/limit 改动）→ 父级 dirty（不再自管 PATCH） */
  onChange?: (budget: BudgetConfig) => void;
  /** 父级触发即时刷新；变化即 refetch */
  refreshKey?: string;
}

/** 30s 轮询间隔（squad 聚合预算无 SSE topic → poll 兜底） */
const POLL_INTERVAL_MS = 30_000;

/** 默认预算上限（budget switch on 时预填） */
const DEFAULT_LIMIT = 1_000_000;

/** token 预算仪表 + 配置。[v0.0.316] 受控模式：配置区纯上报，无自管 PATCH/savePending。 */
export function BudgetMeter({ squadId, budget, onChange, refreshKey }: BudgetMeterProps) {
  const { t } = useTranslation(['studio', 'common']);

  // 使用量数据（useLifecycle Snapshot 形）—— 只读展示，与配置 save 无关
  const { ctx: usage, loading, error, reload } = useLifecycle<Snapshot<BudgetUsage>>({
    onInit: async ({ signal, startTimer }) => {
      startTimer({
        intervalMs: POLL_INTERVAL_MS,
        justification:
          'squad 聚合预算无 SSE topic(session_usage_update 是 per-session SessionUsageView 非 squad budget)',
      });
      const u = await getBudgetUsage(squadId);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return u;
    },
    onTick: async () => {
      return await getBudgetUsage(squadId);
    },
    deps: [squadId],
  });

  const lastRefresh = useRef(refreshKey);
  useEffect(() => {
    if (lastRefresh.current !== refreshKey) {
      lastRefresh.current = refreshKey;
      void reload();
    }
  }, [refreshKey, reload]);

  // [v0.0.316] 受控派生：budgetOn 从 useState 改为派生 budget != null（D2 设计）
  const budgetOn = budget != null;
  // limitInput 派生自 budget draft（非独立 useState）：budget.limit ?? DEFAULT_LIMIT
  const limitValue = budget?.limit ?? DEFAULT_LIMIT;

  const unlimited = usage != null && usage.limit === -1;
  const pct = usage && usage.limit > 0 ? Math.min(100, (usage.consumed / usage.limit) * 100) : 0;
  const over = !unlimited && usage != null && usage.remaining < 0;

  return (
    <div data-squad-id={squadId} className="flex flex-col gap-2">
      <label className={FIELD_LABEL}>{t('studio:budget.label')}</label>

      {/* 配置区（仅当 onChange 提供时显示）—— [v0.0.316] 受控：纯上报，无 save 按钮 */}
      {onChange && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
          <div className="flex items-center gap-2.5">
            {/* budget switch：off=不限量/on=限量；toggle off → onChange(null)，on → onChange(默认值) */}
            <button
              type="button"

              role="switch"
              aria-checked={budgetOn}
              onClick={() =>
                onChange(budgetOn ? null : { limit: limitValue, window: 'daily', scope: 'team' })
              }
              className={
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ' +
                (budgetOn ? 'bg-accent' : 'bg-border-strong')
              }
            >
              <span
                className={
                  'inline-block h-4 w-4 transform rounded-full bg-white transition-transform ' +
                  (budgetOn ? 'translate-x-4' : 'translate-x-0.5')
                }
              />
            </button>
            <span className="font-mono text-[11px] text-muted">
              {budgetOn
                ? t('studio:budget.switchOn', { defaultValue: '限量（设置上限）' })
                : t('studio:budget.switchOff', { defaultValue: '不限量' })}
            </span>
          </div>

          {/* 展开：budget-limit-input；limit 变 → onChange(更新 limit) */}
          {budgetOn && (
            <div className="flex items-center gap-2 pl-2">
              <span className="text-[11px] text-muted-2">
                {t('studio:budget.limitInputLabel', { defaultValue: '上限 (tokens)' })}
              </span>
              <input
                type="number"

                min={1}
                value={limitValue}
                onChange={(e) => {
                  const limit = parseInt(e.target.value, 10);
                  onChange({ limit: isNaN(limit) ? DEFAULT_LIMIT : limit, window: 'daily', scope: 'team' });
                }}
                className="w-28 rounded-md border border-border-2 bg-surface px-2 py-1 font-mono text-[12px] text-fg"
              />
            </div>
          )}
        </div>
      )}

      {/* 使用量仪表（仪表展示部分不变） */}
      {loading && !usage && <div className="text-[11.5px] text-muted">{t('common:status.loading')}</div>}
      {error && !usage && (
        <div

          className="flex items-center justify-between rounded-md border border-danger/40 bg-danger/5 px-2.5 py-1.5 text-[11.5px] text-danger"
        >
          <span>{t('studio:budget.errorPrefix')}{error.message || t('studio:budget.loadFail')}</span>
          <button type="button" onClick={() => void reload()} className="underline">
            {t('common:action.retry')}
          </button>
        </div>
      )}
      {usage && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
          <div className="flex items-center gap-4 font-mono text-[12px]">
            <span className="text-fg-2">
              {t('studio:budget.consumedPrefix')} <span className="font-semibold text-fg">{usage.consumed.toLocaleString()}</span>
            </span>
            <span className="text-muted-2">
              {t('studio:budget.limitPrefix')}{' '}
              <span className="text-fg-3">
                {unlimited ? t('studio:budget.unlimited') : usage.limit.toLocaleString()}
              </span>
            </span>
            <span className="text-muted-2">
              {t('studio:budget.remainingPrefix')}{' '}
              <span className={over ? 'text-danger' : 'text-fg-3'}>
                {unlimited ? '∞' : usage.remaining.toLocaleString()}
              </span>
            </span>
            {unlimited && (
              <span className="rounded-xs bg-bg-warm px-1.5 py-0.5 text-[10px] text-muted">
                unlimited
              </span>
            )}
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-warm">
            <div
              className={'h-full transition-all ' + (over ? 'bg-danger' : pct > 80 ? 'bg-gold' : 'bg-accent')}
              style={{ width: `${unlimited ? 0 : Math.max(2, pct)}%` }}
            />
          </div>
          <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
            <Icon name="refresh" size={11} />
            {t('studio:budget.windowEndLabel')} <span>{formatWindowEnd(usage.windowEnd, usage.timezone)}</span>
            {over && <span className="ml-2 text-danger">{t('studio:budget.overLimitHint')}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

/** 格式化回血时刻（次日 tz 0 点 → 本地时刻显示） */
function formatWindowEnd(iso: string, _tz: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export default BudgetMeter;
