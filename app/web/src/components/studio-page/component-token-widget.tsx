/**
 * component-token-widget —— 首页左列 Token 用量图文小组件（整卡点击进 token-stats）
 * 参考: specs/ui/components/studio-page/component-token-widget.md
 *       reqs/[working] v0.0.240.squad_task/demo-home.html（.card.token 块，视觉契约）
 *
 * 职责：图文结合展示 token 用量（今日三色比例条 + 7 日迷你柱 + 近 60 天合计）+ 整卡点击 → token-stats。
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

/** 三色比例条单段：label + 比例条（按值占三段峰值） + 数字 */
function TokenBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-[7px] flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="w-[78px] shrink-0 text-right text-[10.5px] text-muted">
        {label} {formatTokens(value)}
      </div>
    </div>
  );
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
  const maxOfDay = today ? Math.max(today.input, today.output, today.cache) : 0;
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

      {/* 今日三色比例条 */}
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-2">{t('studio:tokenWidget.todayLabel')}</div>
        {loading ? (
          <div className="h-[42px] animate-pulse rounded bg-surface-2" />
        ) : today ? (
          <div className="flex flex-col gap-1">
            <TokenBar label={t('studio:tokenWidget.kindInput')} value={today.input} max={maxOfDay} color="var(--hue-blue)" />
            <TokenBar label={t('studio:tokenWidget.kindOutput')} value={today.output} max={maxOfDay} color="var(--hue-violet)" />
            <TokenBar label={t('studio:tokenWidget.kindCache')} value={today.cache} max={maxOfDay} color="var(--hue-green)" />
          </div>
        ) : (
          <div className="text-[11px] text-muted">—</div>
        )}
      </div>

      {/* 7 日迷你柱（series 末 7 点） */}
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-2">{t('studio:tokenWidget.trend7d')}</div>
        <div className="flex h-[26px] items-end gap-1">
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

      {/* 累计：近 60 天合计（=详情 panel summary 同口径，复用详情统计；非 budget） */}
      <div className="flex items-baseline justify-between text-[11px] text-muted">
        <span>{t('studio:tokenWidget.consumedLabel')}</span>
        <span className="font-mono text-[14px] font-bold text-fg">
          {state.kind === 'ok' ? formatTokens(data.cumulative) : '—'}
        </span>
      </div>
    </button>
  );
}

export default TokenWidget;
