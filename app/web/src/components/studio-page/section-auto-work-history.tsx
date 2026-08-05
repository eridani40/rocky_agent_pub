/**
 * section-auto-work-history —— 自动工作历史 tab（心跳唤醒记录）
 * 参考: specs/ui/components/studio-page/auto-work-history.md（testid 契约 + 状态/交互）
 *       specs/api/version_logs/v0.0.33.4/change_log.md §5（GET /scheduler/history）
 *
 * 职责：展示 squad 自动工作历史（时间倒序）。每条 = 谁（role）/ 何时（at）/ 为何醒（reason）/
 *   结果（fired/skipped_*）。纯只读，无 SSE（进 tab/切回时 GET）。
 *   嵌入 component-autowork-tab 作历史块（与自主性 toggle + budget 仪表同 tab）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getSchedulerHistory } from '../../lib/squad-api';
import type { SchedulerHistoryEntry } from './squad-types';
import { Icon } from './studio-icons';
import { camelCaseCode } from '../../i18n/code-key';

interface AutoWorkHistoryProps {
  squadId: string;
  /** 缺省 50（与后端一致） */
  limit?: number;
}

/** result → tailwind cls（视觉态机，非 i18n 文案） */
const RESULT_CLS: Record<SchedulerHistoryEntry['result'], string> = {
  fired: 'bg-sage/10 text-sage',
  skipped_busy: 'bg-bg-warm text-muted-2',
  skipped_budget: 'bg-bg-warm text-muted-2',
  skipped_window: 'bg-bg-warm text-muted-2',
  skipped_killswitch: 'bg-bg-warm text-muted-2',
};

/** 自动工作历史 section */
export function AutoWorkHistory({ squadId, limit }: AutoWorkHistoryProps) {
  const { t } = useTranslation(['studio', 'common']);
  const [items, setItems] = useState<SchedulerHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getSchedulerHistory(squadId, limit != null ? { limit } : undefined);
      setItems(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('studio:autoWork.loadFail'));
      setItems(null);
    } finally {
      setLoading(false);
    }
  }, [squadId, limit]);

  // 进入 tab / squadId 变 → 拉（无 SSE，操作后 refetch 由本组件 reload 按钮承担）
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-fg">{t('studio:autoWork.title')}</div>
        <button
          type="button"

          onClick={() => void reload()}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-muted-2 transition-colors hover:bg-bg-warm hover:text-fg-2 disabled:opacity-40"
        >
          <Icon name="refresh" size={12} /> {t('common:action.refresh')}
        </button>
      </div>

      {loading && !items && <div className="py-8 text-center text-xs text-muted">{t('common:status.loading')}</div>}
      {error && (
        <div

          className="flex flex-col items-center gap-3 rounded-lg border border-danger/40 bg-danger/5 px-6 py-8 text-center"
        >
          <div className="text-[13px] font-semibold text-danger">{t('studio:autoWork.errorTitle')}</div>
          <div className="text-[11.5px] text-muted">{error}</div>
          <button type="button" onClick={() => void reload()} className="rounded-md border border-border-2 bg-surface-2 px-3 py-1.5 text-xs font-medium text-fg-3 hover:border-accent hover:text-accent">
            {t('common:action.retry')}
          </button>
        </div>
      )}

      {!loading && !error && items && items.length === 0 && (
        <div

          className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface px-6 py-10 text-center"
        >
          <Icon name="list" size={24} />
          <div className="text-[13px] font-semibold text-fg-2">{t('studio:autoWork.emptyTitle')}</div>
          <div className="text-[11.5px] text-muted">{t('studio:autoWork.emptyHint')}</div>
        </div>
      )}

      {!loading && !error && items && items.length > 0 && (
        <div className="flex flex-col gap-2">
          {items.map((it) => {
            const cls = RESULT_CLS[it.result];
            return (
              <div
                key={it.id}

                className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface px-3 py-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-fg">
                      {it.roleName}
                    </span>
                    <span

                      className="rounded-xs bg-bg-warm px-1.5 py-0.5 font-mono text-[10px] text-muted-2"
                    >
                      {t(`studio:autoWorkReason.${camelCaseCode(it.reason)}`)}
                    </span>
                    <span

                      className={'rounded-xs px-1.5 py-0.5 font-mono text-[10px] ' + cls}
                    >
                      {t(`studio:autoWorkResult.${camelCaseCode(it.result)}`)}
                    </span>
                  </div>
                  <span className="font-mono text-[11px] text-muted">
                    {formatAt(it.at)}
                  </span>
                </div>
                {it.actionSummary && <div className="text-[11.5px] text-muted">{it.actionSummary}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** ISO → 本地时刻字符串 */
function formatAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default AutoWorkHistory;
