/**
 * component-token-widget —— 首页左列 Token 用量图文小组件（整卡点击进 token-stats）
 * 参考: specs/ui/components/studio-page/component-token-widget.md
 *       reqs/[working] v0.0.240.squad_task/demo-home.html（.card.token 块，视觉契约）
 *
 * 职责：今日总量 / 60 天总量两数据并排 + 7 日迷你柱 + 整卡点击 → token-stats。
 * 数据源：useSquadTokenStats（与详情 panel 共用一套 fetch，口径对齐详情——不再自己查一套）：
 *   - 查询 scope='team' + 近 60 天 day（=详情 panel defaultRange）
 *   - 今日 = series 末点（bucket === 今日本地 key）；7 日柱 = series 末 7 点；累计 = Σ series（=详情合计）
 * 复用：component-token-stats-helpers（formatTokens / formatDateShort）+ types（pointToBreakdown / totalOf）。
 * 边界：纯展示 + 单回调；不调 mutation API；hover 整卡 box-shadow 反馈（无位移——布局稳定）。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { SquadDetail } from './squad-types';
import type { TokenUsageStatPoint, UsageBreakdown } from './component-token-stats-types';
import { pointToBreakdown, totalOf } from './component-token-stats-types';
import { formatDateShort, formatTokens } from './component-token-stats-helpers';
import { useSquadTokenStats } from './use-squad-token-stats';

interface TokenWidgetProps {
  squadId: string;
  /** 保留接口（SeatsBody 传入）；当前 widget 复用详情统计，不直接读 detail 字段 */
  detail: SquadDetail;
  onOpenTokenStats: (squadId: string) => void;
}

interface WidgetData {
  today: UsageBreakdown | null;
  daily7: { label: string; total: number }[];
  cumulative: number;
}

/** 近 60 天 day 粒度 from/to（本地时区 YYYY-MM-DD，=详情 panel defaultRange 同口径） */
function last60DayRange(): { from: string; to: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 59);
  return { from: fmt(from), to: fmt(to) };
}

/** hook series → widget 数据（今日末点 + 末 7 点 + Σ 全量累计） */
function deriveWidgetData(series: TokenUsageStatPoint[] | undefined, todayKey: string): WidgetData {
  const points = (series ?? []).map((p) => ({
    bucket: p.bucket,
    label: formatDateShort(p.bucket),
    breakdown: pointToBreakdown(p),
  }));
  const last = points[points.length - 1];
  const today = last && last.bucket === todayKey ? last.breakdown : null;
  const daily7 = points.slice(-7).map((p) => ({ label: p.label, total: totalOf(p.breakdown) }));
  const cumulative = points.reduce((sum, p) => sum + totalOf(p.breakdown), 0);
  return { today, daily7, cumulative };
}

/** token 用量图文小组件（复用详情统计，不自己查一套） */
export function TokenWidget({ squadId, onOpenTokenStats }: TokenWidgetProps) {
  const { t } = useTranslation(['studio', 'common']);
  const range = useMemo(last60DayRange, []);
  const todayKey = range.to;
  const state = useSquadTokenStats(squadId, {
    from: range.from,
    to: range.to,
    scope: 'team',
    granularity: 'day',
  });
  const data = useMemo<WidgetData>(
    () =>
      state.kind === 'ok'
        ? deriveWidgetData(state.data.series, todayKey)
        : { today: null, daily7: [], cumulative: 0 },
    [state, todayKey],
  );

  const today = data.today;
  const todayTotal = today ? totalOf(today) : 0;
  const maxDaily = Math.max(1, ...data.daily7.map((d) => d.total));
  const loading = state.kind === 'loading';

  return (
    <button
      type="button"
      data-action-key="studio.squad.open-token-statistics"
      onClick={() => onOpenTokenStats(squadId)}
      className="group flex w-full flex-col gap-2.5 rounded-xl border border-border bg-surface p-3.5 text-left shadow-none transition-[box-shadow] duration-150 hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)] focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus)]"
    >
      {/* 标题行 */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted">{t('studio:tokenWidget.title')}</span>
        <span className="text-[10px] text-muted-2 transition-colors group-hover:text-fg">
          {t('studio:tokenWidget.viewDetail')} ›
        </span>
      </div>

      {/* 今日总量 / 60 天总量并排（v0.0.288：去三色比例条，改两数据并排变矮） */}
      <div className="flex items-baseline justify-between">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-2">{t('studio:tokenWidget.todayTotal')}</span>
          {loading ? (
            <div className="h-[18px] w-[60px] animate-pulse rounded bg-surface-2" />
          ) : (
            <span className="font-mono text-[14px] font-bold text-fg">
              {today ? formatTokens(todayTotal) : '—'}
            </span>
          )}
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-2">{t('studio:tokenWidget.total60d')}</span>
          {loading ? (
            <div className="h-[18px] w-[60px] animate-pulse rounded bg-surface-2" />
          ) : (
            <span className="font-mono text-[14px] font-bold text-fg">
              {state.kind === 'ok' ? formatTokens(data.cumulative) : '—'}
            </span>
          )}
        </div>
      </div>

      {/* 7 日迷你柱（series 末 7 点，h-[22px] 压缩变矮） */}
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-2">{t('studio:tokenWidget.trend7d')}</div>
        <div className="flex h-[22px] items-end gap-1">
          {data.daily7.length === 0
            ? Array.from({ length: 7 }).map((_, i) => (
                <span key={i} className="block w-[10px] rounded-t bg-surface-2" style={{ height: '6%' }} />
              ))
            : data.daily7.map((d, i) => (
                <span
                  key={`${d.label}-${i}`}
                  className="block w-[10px] rounded-t opacity-85"
                  style={{
                    height: `${Math.max(4, (d.total / maxDaily) * 100)}%`,
                    background: 'linear-gradient(var(--hue-blue), #06b6d4)',
                  }}
                  title={`${d.label}: ${formatTokens(d.total)}`}
                />
              ))}
        </div>
      </div>
    </button>
  );
}

export default TokenWidget;
