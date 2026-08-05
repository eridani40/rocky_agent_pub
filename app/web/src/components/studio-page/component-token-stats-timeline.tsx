/**
 * component-token-stats-timeline —— 时间轴堆积图（横坐标=时间，纵坐标=堆积类型色块）
 * 参考: specs/ui/components/studio-page/component-token-stats.md
 *
 * kind 模式分支：
 *   - 'total' → 三段堆积（输入+输出+缓存）
 *   - 'input'/'output'/'cache' → 单色柱（token 量，蓝/紫/绿）
 *   - 'cacheRate' → 单色柱（缓存率 0-100%，amber）；Y 轴固定 0-100%，不走 M 的 axisMax 逻辑
 *
 * Y 轴口径按 kind 切：token 类走 computeAxisMax + M 刻度；cacheRate 走固定 1（100%）+ % 刻度。
 *
 * hover 浮层用 useHoverPortal + PortalTooltip（createPortal 到 body），脱离 overflow-x-auto 容器，
 * 不被垂直裁剪（CSS 规范：overflow-x!=visible 时 overflow-y 被算成 auto）。
 */
import type { KindFilter, SeriesPoint } from './component-token-stats-types';
import { totalOf, valueByKind } from './component-token-stats-types';
import {
  buildBreakdownTitle,
  computeAxisMax,
  formatTokens,
  kindColor,
  kindLabelCN,
} from './component-token-stats-helpers';
import {
  BreakdownTooltipRows,
  PortalTooltip,
  useHoverPortal,
} from './component-token-stats-tooltip';

interface TokenStatsTimelineProps {
  points: SeriesPoint[];
  kind: KindFilter;
  /** 横坐标单位提示（如 '近 60 天' / '24h'） */
  axisLabel: string;
}

/** 柱区虚线标尺（4 档 25/50/75/100%，与 Y 轴刻度对齐；不含 0/底） */
function Ruler() {
  const ratios = [0.25, 0.5, 0.75, 1];
  return (
    <div className="pointer-events-none absolute inset-0">
      {ratios.map((r) => (
        <div
          key={r}
          className="absolute left-0 right-0 border-t border-dashed border-border"
          style={{ bottom: `${r * 100}%` }}
        />
      ))}
    </div>
  );
}

/** 右侧 Y 轴：5 档刻度（0/25/50/75/100%）；isRate 时显 % 否则显 M（按 axisMax 归一） */
function YAxis({ axisMax, isRate }: { axisMax: number; isRate: boolean }) {
  const ratios = [0, 0.25, 0.5, 0.75, 1];
  return (
    <div

      className="relative h-[200px] w-[48px] shrink-0 border-l border-border"
    >
      {ratios.map((r) => (
        <div
          key={r}
          className="absolute left-1 right-1"
          style={{ bottom: `calc(${r * 100}% - 6px)` }}
        >
          <span className="font-mono text-[9.5px] text-muted-2">
            {isRate ? `${r * 100}%` : formatTokens(axisMax * r)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 单柱（堆积/单色）+ portal hover 浮层 */
function StackBar({ point, kind, axisMax }: { point: SeriesPoint; kind: KindFilter; axisMax: number }) {
  const { ref, hovered, pos, onMouseEnter, onMouseLeave } = useHoverPortal();
  const isRate = kind === 'cacheRate';
  const value = valueByKind(point.breakdown, kind);
  const total = totalOf(point.breakdown);
  // 柱高归一：cacheRate 用 value*100（0-100%）；token 类用 total/axisMax*100
  const heightPct = isRate ? value * 100 : axisMax > 0 ? (total / axisMax) * 100 : 0;

  const segs: { value: number; color: string; label: string }[] = [];
  if (kind === 'total') {
    segs.push({ value: point.breakdown.input, color: kindColor('input'), label: kindLabelCN('input') });
    segs.push({ value: point.breakdown.output, color: kindColor('output'), label: kindLabelCN('output') });
    segs.push({ value: point.breakdown.cache, color: kindColor('cache'), label: kindLabelCN('cache') });
  } else if (isRate) {
    // 缓存率单色柱（amber），整柱一段
    segs.push({ value: 1, color: kindColor('cacheRate'), label: kindLabelCN('cacheRate') });
  } else {
    const k = kind as Exclude<KindFilter, 'total' | 'cacheRate'>;
    segs.push({ value, color: kindColor(k), label: kindLabelCN(kind) });
  }
  const segSum = isRate ? 1 : total;

  return (
    <div
      ref={ref}

      className="relative flex h-full flex-1 flex-col-reverse items-stretch"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      title={buildBreakdownTitle(point.label, point.breakdown, kind)}
    >
      <div
        className="mx-auto flex w-full max-w-[20px] flex-col-reverse overflow-hidden rounded-t-[3px]"
        style={{ height: `${heightPct}%`, minHeight: total > 0 || isRate ? 2 : 0 }}
      >
        {segs.map((s, i) => {
          if (s.value <= 0) return null;
          const segPct = segSum > 0 ? (s.value / segSum) * 100 : 0;
          return (
            <div
              key={i}
              style={{ background: s.color, height: `${segPct}%`, minHeight: 1 }}
              title={`${s.label}: ${formatTokens(s.value)}`}
            />
          );
        })}
      </div>
      {/* hover 浮层 portal 到 body（脱离 overflow-x-auto 祖先，避免垂直裁剪） */}
      {hovered && pos && (
        <PortalTooltip pos={pos}>
          <div className="mb-1 text-[11.5px] font-semibold text-fg">{point.label}</div>
          <BreakdownTooltipRows breakdown={point.breakdown} kind={kind} />
        </PortalTooltip>
      )}
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-fg-2">
      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} aria-hidden />
      {label}
    </span>
  );
}

/** 时间轴堆积图根 */
export function TokenStatsTimeline({ points, kind, axisLabel }: TokenStatsTimelineProps) {
  const isRateKind = kind === 'cacheRate';
  const maxTotal = Math.max(1, ...points.map((p) => totalOf(p.breakdown)));
  // cacheRate 固定 axisMax=1（100%）；token 类用 computeAxisMax 取整到漂亮步长
  const axisMax = isRateKind ? 1 : computeAxisMax(maxTotal);
  const labelEvery = Math.max(1, Math.ceil(points.length / 10));

  // 图例：total 三段 / cacheRate 单 amber / 单类 token 单色
  const legendColor = kind === 'total' ? null : kindColor(kind as Exclude<KindFilter, 'total'>);
  const legendLabel = kindLabelCN(kind);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      {/* 图例 */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        {kind === 'total' ? (
          <>
            <LegendItem color={kindColor('input')} label={kindLabelCN('input')} />
            <LegendItem color={kindColor('output')} label={kindLabelCN('output')} />
            <LegendItem color={kindColor('cache')} label={kindLabelCN('cache')} />
          </>
        ) : (
          <LegendItem color={legendColor!} label={legendLabel} />
        )}
        <span className="ml-auto text-[11px] text-muted">
          {isRateKind ? `缓存率 0-100% / ${axisLabel}` : `峰值 ${formatTokens(maxTotal)} / ${axisLabel}`}
        </span>
      </div>

      {/* 图区：柱区（横向滚动）+ 右侧 Y 轴（固定） */}
      <div className="flex">
        <div className="flex-1 overflow-x-auto">
          <div className="min-w-[640px]">
            <div className="relative h-[200px] rounded-md bg-surface-2/40 px-1 pb-0">
              <Ruler />
              <div className="relative flex h-full items-end gap-px">
                {points.map((p) => (
                  <StackBar key={p.label} point={p} kind={kind} axisMax={axisMax} />
                ))}
              </div>
            </div>
            <div className="mt-1 flex gap-px px-1">
              {points.map((p, i) => (
                <div key={p.label} className="flex-1 text-center font-mono text-[9px] text-muted-2">
                  {i % labelEvery === 0 ? p.label : ''}
                </div>
              ))}
            </div>
          </div>
        </div>
        <YAxis axisMax={axisMax} isRate={isRateKind} />
      </div>
    </div>
  );
}

