/**
 * component-token-stats-panel —— 统计视图主容器（state 管理 + 数据 fetching + 503 降级）
 * 参考: specs/ui/components/studio-page/component-token-stats.md
 *       specs/api/overall/11c-token-stats.md §3（TokenUsageQueryResult 契约）
 *
 * 职责：
 *   - 持 state：{granularity, scope, kind, view, selectedDate, modelSelection}
 *   - fetch GET /squad/:id/token-stats（每次 state 变更触发新查询）
 *   - 503（sqlite 未就绪）→ 显降级空态；其他错误 → 显 error
 *   - 渲染：控制条 + 汇总条 + 主图（calendar/timeline）+ 团队口径说明（scope=team 时）
 *
 * 边界：本组件不持返回键（路由容器负责）；state 在 unmount 后丢（与 board/panorama 同范式）。
 */
import { useEffect, useMemo, useState } from 'react';
import type { SquadDetail } from './squad-types';
import type {
  AvailableModel,
  Granularity,
  KindFilter,
  SeriesPoint,
  ViewMode,
} from './component-token-stats-types';
import { pointToBreakdown } from './component-token-stats-types';
import { formatDateShort, formatHour, formatTokens, kindColor, kindLabelCN, parseModelSelection } from './component-token-stats-helpers';
import { totalOf, valueByKind } from './component-token-stats-types';
import { TokenStatsControls } from './component-token-stats-controls';
import { TokenStatsCalendar } from './component-token-stats-calendar';
import { TokenStatsTimeline } from './component-token-stats-timeline';
import { useSquadTokenStats } from './use-squad-token-stats';
import type { TokenStatsLoadState } from './use-squad-token-stats';

interface TokenStatsPanelProps {
  squadId: string;
  detail: SquadDetail;
}

/** 默认近 60 天的 from/to（YYYY-MM-DD，本地时区） */
function defaultRange(): { from: string; to: string } {
  const today = new Date();
  const to = formatLocalDate(today);
  const from60 = new Date(today);
  from60.setDate(from60.getDate() - 59);
  return { from: formatLocalDate(from60), to };
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 统计视图主容器 */
export function TokenStatsPanel({ squadId, detail }: TokenStatsPanelProps) {
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [scope, setScope] = useState<string>('__team__');
  const [kind, setKind] = useState<KindFilter>('total');
  const [view, setView] = useState<ViewMode>('timeline');
  const [selectedDate, setSelectedDate] = useState<string>(formatLocalDate(new Date()));
  // model 筛选：'__all__' 或 `${providerId}/${modelId}`
  const [modelSelection, setModelSelection] = useState<string>('__all__');
  // API 返回的 distinct model 列表（前端下拉数据源）
  const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);

  // 单日粒度按 selectedDate 查当天（后端 hour 粒度补零成固定 0~23 点 24 点位）；
  // 跨天粒度查默认近 60 天
  const range = granularity === 'hour'
    ? { from: selectedDate, to: selectedDate }
    : defaultRange();
  // 解码 modelSelection（`${providerId}/${modelId}`）→ providerId/modelId；__all__/非法 → 均 undefined（不带筛选）
  const { providerId, modelId } = parseModelSelection(modelSelection) ?? {};
  // 复用 useSquadTokenStats（与首页 widget 同一套 fetch，口径对齐，不重复统计）
  const state: TokenStatsLoadState = useSquadTokenStats(squadId, {
    from: range.from,
    to: range.to,
    scope: scope === '__team__' ? 'team' : scope,
    granularity,
    providerId,
    modelId,
  });

  // availableModels 同步 + modelSelection 重置（切 squad 后选中 model 可能不在新列表）
  useEffect(() => {
    if (state.kind !== 'ok') return;
    const models = state.data.availableModels ?? [];
    setAvailableModels(models);
    if (modelSelection !== '__all__') {
      const stillThere = models.some(
        (m) => `${m.providerId}/${m.modelId}` === modelSelection,
      );
      if (!stillThere) setModelSelection('__all__');
    }
  }, [state, modelSelection]);

  // 派生序列点（API series → 视图 SeriesPoint）
  const seriesPoints: SeriesPoint[] = useMemo(() => {
    if (state.kind !== 'ok') return [];
    return state.data.series.map((p) => ({
      bucket: p.bucket,
      label: state.data.granularity === 'day' ? formatDateShort(p.bucket) : formatHour(p.bucket),
      breakdown: pointToBreakdown(p),
    }));
  }, [state]);

  // 单日小时序列 = seriesPoints 本体（后端 hour 粒度已按 selectedDate 补零成固定 0~23 点
  // 24 点位；跨天粒度 = 近 60 天日序列），无需额外过滤
  const visiblePoints = seriesPoints;

  // 汇总：基于当前可见序列
  const summary = useMemo(() => {
    const acc = { input: 0, output: 0, cache: 0 };
    for (const p of visiblePoints) {
      acc.input += p.breakdown.input;
      acc.output += p.breakdown.output;
      acc.cache += p.breakdown.cache;
    }
    return acc;
  }, [visiblePoints]);

  const axisLabel = granularity === 'day' ? '近 60 天' : '24h';

  return (
    <div className="flex flex-col gap-4 px-8 py-5">
      <TokenStatsControls
        granularity={granularity}
        scope={scope}
        members={detail.members}
        kind={kind}
        view={view}
        selectedDate={selectedDate}
        modelSelection={modelSelection}
        availableModels={availableModels}
        onGranularity={setGranularity}
        onScope={setScope}
        onKind={setKind}
        onView={setView}
        onSelectedDate={setSelectedDate}
        onModelSelection={setModelSelection}
      />

      {state.kind === 'loading' && (
        <div className="rounded-lg border border-border bg-surface px-4 py-10 text-center text-[12px] text-muted">
          加载中…
        </div>
      )}
      {state.kind === 'empty' && (
        <div className="rounded-lg border border-border bg-surface-2/40 px-4 py-10 text-center text-[12px] text-muted">
          {state.reason}
        </div>
      )}
      {state.kind === 'error' && (
        <div className="rounded-lg border border-border bg-surface-2/40 px-4 py-10 text-center text-[12px] text-muted">
          加载失败：{state.message}
        </div>
      )}

      {state.kind === 'ok' && (
        <>
          {/* 汇总条：总 + 三段占比 + 团队/单 member 提示 */}
          <div

            className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3"
          >
            <div className="flex items-baseline gap-1.5">
              <span className="text-[11px] text-muted">合计</span>
              <span className="font-mono text-[20px] font-bold text-fg">{formatTokens(totalOf(summary))}</span>
              <span className="text-[11px] text-muted">tokens · {axisLabel}</span>
            </div>
            <div className="flex items-center gap-3">
              {(['input', 'output', 'cache'] as const).map((k) => (
                <div key={k} className="flex items-center gap-1.5 text-[11.5px]">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: kindColor(k) }} aria-hidden />
                  <span className="text-muted">{kindLabelCN(k)}</span>
                  <span className="font-mono text-fg-2">{formatTokens(valueByKind(summary, k))}</span>
                  <span className="text-muted-2">
                    ({totalOf(summary) > 0 ? Math.round((valueByKind(summary, k) / totalOf(summary)) * 100) : 0}%)
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 主图：按 view 切换 */}
          {view === 'calendar' ? (
            granularity === 'hour' ? (
              <div className="rounded-lg border border-border bg-surface-2/40 px-4 py-10 text-center text-[12px] text-muted">
                单日粒度的日历视图（小时热力）暂不支持；请切到「时间轴」查看 24h 分布。
              </div>
            ) : (
              <TokenStatsCalendar points={visiblePoints} kind={kind} />
            )
          ) : (
            <TokenStatsTimeline points={visiblePoints} kind={kind} axisLabel={axisLabel} />
          )}

          {/* 团队口径说明（仅 team 视图显） */}
          {scope === '__team__' && (
            <div className="rounded-md border border-border bg-surface-2/50 px-3 py-2 text-[11px] text-muted">
              团队口径：总量 = Σ 所有 member 的 usage（leader + mate）；subagent 消耗已隐含计入其 parent member。
            </div>
          )}
        </>
      )}
    </div>
  );
}
