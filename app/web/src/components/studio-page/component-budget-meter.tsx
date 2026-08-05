/**
 * component-budget-meter —— 团队 token 预算仪表 + 预算配置
 * 参考: specs/ui/components/studio-page/budget-meter.md（testid 契约 + 状态/交互）
 *       specs/api/version_logs/v0.0.33.4/change_log.md §4（GET /budget/usage）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10/§3.11（useLifecycle 四方法契约）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.2（Snapshot 形）
 *
 * 职责：实时显示 squad 当前 daily 窗口 token 消耗。
 * [v0.0.116] 新增配置交互：budget-switch（off=不限量/on=限量）+ on 展开 budget-limit-input + budget-save。
 * 写走 onSaveBudget（PATCH /squad { budget }）；off→null/on→{limit,window:'daily',scope:'team'}。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getBudgetUsage } from '../../lib/squad-api';
import { useLifecycle } from '../../lib/use-lifecycle';
import type { Snapshot } from '../../lib/lifecycle-shapes';
import type { BudgetUsage } from './squad-types';
import { FIELD_LABEL } from './studio-styles';
import { Icon } from './studio-icons';

interface BudgetMeterProps {
  squadId: string;
  /** 当前 budget 配置（来自 squad detail；null=不限量） */
  budget?: { limit: number; window: 'daily'; scope: 'team' } | null;
  /** 保存 budget 配置（PATCH /squad { budget }；null=不限量） */
  onSaveBudget?: (budget: { limit: number; window: 'daily'; scope: 'team' } | null) => Promise<void>;
  /** 父级触发即时刷新；变化即 refetch */
  refreshKey?: string;
}

/** 30s 轮询间隔（squad 聚合预算无 SSE topic → poll 兜底） */
const POLL_INTERVAL_MS = 30_000;

/** 默认预算上限（budget switch on 时预填） */
const DEFAULT_LIMIT = 1_000_000;

/** token 预算仪表 + 配置 */
export function BudgetMeter({ squadId, budget, onSaveBudget, refreshKey }: BudgetMeterProps) {
  const { t } = useTranslation(['studio', 'common']);

  // 使用量数据（useLifecycle Snapshot 形）
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

  // 配置交互本地态
  const [budgetOn, setBudgetOn] = useState(budget != null);
  const [limitInput, setLimitInput] = useState<string>(budget?.limit != null ? String(budget.limit) : String(DEFAULT_LIMIT));
  const [savePending, setSavePending] = useState(false);

  // 外部 budget prop 变化时同步本地态（父级 refresh 后）
  useEffect(() => {
    setBudgetOn(budget != null);
    setLimitInput(budget?.limit != null ? String(budget.limit) : String(DEFAULT_LIMIT));
  }, [budget]);

  const handleSaveBudget = async () => {
    if (!onSaveBudget || savePending) return;
    setSavePending(true);
    try {
      if (budgetOn) {
        const limit = parseInt(limitInput, 10);
        await onSaveBudget({ limit: isNaN(limit) ? DEFAULT_LIMIT : limit, window: 'daily', scope: 'team' });
      } else {
        await onSaveBudget(null);
      }
    } finally {
      setSavePending(false);
    }
  };

  const unlimited = usage != null && usage.limit === -1;
  const pct = usage && usage.limit > 0 ? Math.min(100, (usage.consumed / usage.limit) * 100) : 0;
  const over = !unlimited && usage != null && usage.remaining < 0;

  return (
    <div data-squad-id={squadId} className="flex flex-col gap-2">
      <label className={FIELD_LABEL}>{t('studio:budget.label')}</label>

      {/* 配置区（仅当 onSaveBudget 提供时显示） */}
      {onSaveBudget && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2 p-3">
          <div className="flex items-center gap-2.5">
            {/* budget switch：off=不限量/on=限量 */}
            <button
              type="button"

              role="switch"
              aria-checked={budgetOn}
              disabled={savePending}
              onClick={() => setBudgetOn(!budgetOn)}
              className={
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ' +
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

          {/* 展开：budget-limit-input */}
          {budgetOn && (
            <div className="flex items-center gap-2 pl-2">
              <span className="text-[11px] text-muted-2">
                {t('studio:budget.limitInputLabel', { defaultValue: '上限 (tokens)' })}
              </span>
              <input
                type="number"

                min={1}
                value={limitInput}
                disabled={savePending}
                onChange={(e) => setLimitInput(e.target.value)}
                className="w-28 rounded-md border border-border-2 bg-surface px-2 py-1 font-mono text-[12px] text-fg disabled:opacity-50"
              />
            </div>
          )}

          <button
            type="button"

            disabled={savePending}
            onClick={() => void handleSaveBudget()}
            className="self-start rounded-md bg-accent px-3 py-1 text-[12px] font-semibold text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {savePending ? t('common:status.saving') : t('studio:budget.save', { defaultValue: '保存预算' })}
          </button>
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
