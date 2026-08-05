/**
 * component-token-stats-calendar —— 日历热力视图（月历，每天色块，深度=当日用量/缓存率）
 * 参考: specs/ui/components/studio-page/component-token-stats.md
 *
 * - 按月分组（跨月时多月卡），每月一张 7 列日历表（周一首列）
 * - 每天色块颜色深度按 value/max 归一（heatColor 4 档透明度阶梯）
 * - 按 kind 着色 + 切基底色：
 *     token 类（total/input/output/cache）→ hue-blue 基底，深度=当日 token 量
 *     cacheRate → hue-amber 基底，深度=当日缓存率（绝对 0-1 作色阶，max=1）
 * - hover 显示明细浮层（总体 5 行 / 分项 1 行 / cacheRate 缓存率 1 行）+ native title 兜底
 * - 边界：纯展示，points 由 Panel 按查询派生后传入；零 fetch
 */
import type { KindFilter, SeriesPoint, UsageBreakdown } from './component-token-stats-types';
import { valueByKind } from './component-token-stats-types';
import {
  buildBreakdownTitle,
  formatDateCN,
  formatTokens,
  heatColor,
  kindLabelCN,
  maxByKind,
} from './component-token-stats-helpers';
import { BreakdownTooltipRows } from './component-token-stats-tooltip';

interface TokenStatsCalendarProps {
  points: SeriesPoint[];
  kind: KindFilter;
}

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日'];

/** Calendar 内部使用的 DailyEntry 形（label=dateKey） */
interface DailyEntry {
  dateKey: string;
  breakdown: UsageBreakdown;
}

/** 把 SeriesPoint（granularity=day）映射为 DailyEntry */
function toDailyEntries(points: SeriesPoint[]): DailyEntry[] {
  return points.map((p) => ({ dateKey: p.bucket, breakdown: p.breakdown }));
}

/** 把日序列按月分组（保留月内顺序，跨月按年-月 升序） */
function groupByMonth(entries: DailyEntry[]): { monthLabel: string; days: DailyEntry[] }[] {
  const map = new Map<string, DailyEntry[]>();
  for (const e of entries) {
    const [y, m] = e.dateKey.split('-');
    const key = `${y}-${m}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, days]) => {
      const [y, m] = key.split('-').map(Number);
      return { monthLabel: `${y}年${m}月`, days };
    });
}

/** 单月表：把日期按周排成 7 列网格（前置空位补 null） */
function buildMonthGrid(days: DailyEntry[]): (DailyEntry | null)[] {
  if (days.length === 0) return [];
  const first = new Date(days[0]!.dateKey + 'T00:00:00');
  const firstDow = (first.getDay() + 6) % 7; // 周一为首列：getDay() 周日=0,周一=1 → 转换
  const grid: (DailyEntry | null)[] = [];
  for (let i = 0; i < firstDow; i++) grid.push(null);
  grid.push(...days);
  while (grid.length % 7 !== 0) grid.push(null);
  return grid;
}

/** 单月日历 */
function MonthCalendar({
  monthLabel,
  days,
  kind,
  maxValue,
  heatBase,
}: {
  monthLabel: string;
  days: DailyEntry[];
  kind: KindFilter;
  maxValue: number;
  heatBase: string;
}) {
  const grid = buildMonthGrid(days);
  const isRate = kind === 'cacheRate';
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 text-[13px] font-semibold text-fg">{monthLabel}</div>
      <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[10.5px] text-muted-2">
        {WEEK_LABELS.map((w) => <div key={w}>{w}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {grid.map((entry, i) => {
          if (!entry) return <div key={i} className="aspect-square" />;
          const value = valueByKind(entry.breakdown, kind);
          const date = new Date(entry.dateKey + 'T00:00:00');
          const isWeekend = date.getDay() === 0 || date.getDay() === 6;
          const dateLabel = formatDateCN(entry.dateKey);
          return (
            <div
              key={entry.dateKey}

              data-date={entry.dateKey}
              className="group relative aspect-square rounded-[5px] border border-border/60"
              style={{ background: heatColor(value, maxValue, heatBase) }}
              title={buildBreakdownTitle(dateLabel, entry.breakdown, kind)}
            >
              <span
                className={`absolute left-1 top-0.5 font-mono text-[9px] leading-none ${
                  isWeekend ? 'text-muted-2' : 'text-muted'
                }`}
              >
                {date.getDate()}
              </span>
              {value > 0 && (
                <span className="absolute bottom-0.5 right-1 font-mono text-[8.5px] leading-none text-fg-2">
                  {isRate ? `${Math.round(value * 100)}%` : formatTokens(value)}
                </span>
              )}
              {/* hover 明细浮层（总体 5 行 / 分项 1 行 / cacheRate 缓存率 1 行） */}
              <div className="pointer-events-none absolute left-full top-0 z-popover ml-1 hidden min-w-[180px] rounded-md border border-border bg-surface p-2 text-[11px] shadow-md group-hover:block">
                <div className="mb-1 text-[11.5px] font-semibold text-fg">{dateLabel}</div>
                <BreakdownTooltipRows breakdown={entry.breakdown} kind={kind} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 日历视图根：按月分组渲染 */
export function TokenStatsCalendar({ points, kind }: TokenStatsCalendarProps) {
  const isRate = kind === 'cacheRate';
  const daily = toDailyEntries(points);
  // cacheRate 用绝对比率 0-1 作色阶上限（maxValue=1）；token 类用序列最大值归一
  const maxValue = isRate ? 1 : maxByKind(daily, kind);
  const heatBase = isRate ? '245, 158, 11' : '59, 130, 246'; // amber vs blue
  const months = groupByMonth(daily);
  if (months.length === 0) {
    return <div className="text-[12px] text-muted">暂无数据</div>;
  }
  return (
    <div className="flex flex-col gap-4">
      {/* 色阶图例（基底色按 kind） */}
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span>{kindLabelCN(kind)}少</span>
        <div className="flex gap-px">
          {[0.15, 0.35, 0.55, 0.8].map((a) => (
            <span key={a} className="h-3 w-6" style={{ background: `rgba(${heatBase}, ${a})` }} />
          ))}
        </div>
        <span>多</span>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {months.map((m) => (
          <MonthCalendar
            key={m.monthLabel}
            monthLabel={m.monthLabel}
            days={m.days}
            kind={kind}
            maxValue={maxValue}
            heatBase={heatBase}
          />
        ))}
      </div>
    </div>
  );
}

