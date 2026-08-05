/**
 * component-panorama-bar-chart —— 全景 bar_chart 原语（近 N 天 bucket 聚合计数 + 可选堆叠）
 * 参考: specs/ui/components/studio-page/component-panorama-view.md（bar_chart 渲染契约）
 *       reqs/[working] v0.0.189.dsl_board/demo/src/components/bar-chart.js（参考实现）
 *
 * 纯展示不可交互（无点击/拖拽）。bucket 按本地时区天聚合；stack_by 存在 → 分段堆叠 + 图例。
 */
import { useTranslation } from 'react-i18next';
import type { BarChartViewDef, EntityDef } from './panorama-types';
import { dayKey, statusColor, statusLabel } from './panorama-utils';

export interface PanoramaBarChartProps {
  view: BarChartViewDef;
  entity: EntityDef;
  records: Record<string, unknown>[];
}

interface Bucket {
  key: string;
  label: string;
  counts: Record<string, number>;
  total: number;
}

/** 近 N 天日期桶（含今天，升序）+ 按 stack_by 聚合计数 */
function buildBuckets(view: BarChartViewDef, records: Record<string, unknown>[]): Bucket[] {
  const { field, days } = view.bucket;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const buckets: Bucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    buckets.push({ key: dayKey(d), label: `${d.getMonth() + 1}/${d.getDate()}`, counts: {}, total: 0 });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const rec of records) {
    const raw = rec[field];
    if (!raw) continue;
    const b = byKey.get(dayKey(new Date(String(raw))));
    if (!b) continue;
    const g = view.stack_by ? String(rec[view.stack_by] ?? '') : '__all__';
    b.counts[g] = (b.counts[g] ?? 0) + 1;
    b.total += 1;
  }
  return buckets;
}

/** 堆叠分组序列（stack_by 是 enum 字段 → values 序；否则单组） */
function stackGroups(view: BarChartViewDef, entity: EntityDef): string[] {
  if (!view.stack_by) return ['__all__'];
  const f = entity.fields[view.stack_by];
  return f && f.type === 'enum' ? f.values : [];
}

/** 分组展示 label/色（stack_by 是状态机字段时走 status_labels/colors） */
function groupMeta(view: BarChartViewDef, entity: EntityDef, g: string): { label: string; color: string } {
  if (g === '__all__') return { label: entity.label, color: 'var(--accent)' };
  const isState = entity.states?.field === view.stack_by;
  return {
    label: isState ? statusLabel(entity, g) : entity.display?.[`${view.stack_by ?? ''}_labels`]?.[g] ?? g,
    color: isState ? statusColor(entity, g) : 'var(--accent)',
  };
}

export function PanoramaBarChart({ view, entity, records }: PanoramaBarChartProps) {
  const { t } = useTranslation('studio');
  const buckets = buildBuckets(view, records);
  const groups = stackGroups(view, entity);
  const maxTotal = Math.max(1, ...buckets.map((b) => b.total));

  return (
    <div data-view-id={view.id} className="rounded-xl border border-border bg-surface p-4">
      {/* 柱区：每桶一柱，高度按 maxTotal 归一 */}
      <div className="flex h-[180px] items-end gap-2">
        {buckets.map((b) => (
          <div key={b.key} className="flex flex-1 flex-col items-center gap-1">
            <span className="font-mono text-[11px] text-muted">{b.total > 0 ? b.total : ''}</span>
            <div
              className="flex w-full max-w-[36px] flex-col-reverse justify-start overflow-hidden rounded-sm"
              style={{ height: `${Math.max(2, (b.total / maxTotal) * 100)}%` }}
              title={t('panorama.barTotal', { label: b.label, count: b.total })}
            >
              {groups.map((g) => {
                const n = b.counts[g] ?? 0;
                if (!n) return null;
                const meta = groupMeta(view, entity, g);
                return (
                  <div
                    key={g}
                    style={{ background: meta.color, flexGrow: n, minHeight: 2 }}
                    title={`${meta.label}: ${n}`}
                  />
                );
              })}
            </div>
            <span className="font-mono text-[10.5px] text-muted">{b.label}</span>
          </div>
        ))}
      </div>
      {/* 图例（stack_by 存在时） */}
      {view.stack_by && (
        <div className="mt-3 flex flex-wrap gap-3 border-t border-border pt-3">
          {groups.map((g) => {
            const meta = groupMeta(view, entity, g);
            return (
              <span key={g} className="flex items-center gap-1.5 text-[11.5px] text-fg-2">
                <span className="h-2 w-2 rounded-full" style={{ background: meta.color }} aria-hidden />
                {meta.label}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default PanoramaBarChart;
