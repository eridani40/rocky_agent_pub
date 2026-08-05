/**
 * component-seat-stats —— 坐席统计 2×2 无缝格（v0.0.170 重写：C 紧凑指挥台左列中卡）
 * 参考: specs/ui/components/studio-page/component-seat-stats.md v1.1
 *       reqs/[working] v0.0.170.squad_home_ui/design-c-console.html（.statgrid，视觉契约）
 *
 * 职责：4 格 = 成员在线（在线/总数）/ 进行中任务 / 今日消息 / 已用 token。
 *   每格 = 数字（18px 700）+ label（11px muted）纵向紧凑排列，无图标（图标/hue 本版下线）。
 *   null 字段（todayMsgCount / tokenUsed 未配 budget）→ 数字位显「—」弱化，不隐藏整格（占位稳定）。
 * 边界：纯展示，数据由 use-seats-data 派生传入；不 fetch；不写状态；无 hex 硬编码。
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface SeatStatsProps {
  onlineCount: number;
  totalCount: number;
  inProgressCount: number;
  /** 今日消息：后端无 per-day 聚合 → 恒 null（降级「—」，见 PRD §6.4） */
  todayMsgCount: number | null;
  /** 已用 token：budget=null / 未拉到 → null */
  tokenUsed: number | null;
}

/** 大数缩写（≥1000 → `12.3k`；<1000 原样） */
function formatCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k.toFixed(k >= 100 ? 0 : 1)}k`;
}

/** 单格 props */
interface StatCellProps {
  num: string;
  numSuffix?: string;
  label: string;
  /** 「—」降级弱化（muted-2 dim） */
  dim?: boolean;
  mono?: boolean;
}

/** 单格（白底；数字 18px/700 + label 11px muted 纵向） */
function StatCell({ num, numSuffix, label, dim, mono }: StatCellProps): ReactNode {
  return (
    <div className="bg-surface px-3.5 py-3">
      <div

        className={`text-[18px] font-bold leading-none tracking-tight ${dim ? 'text-muted-2' : 'text-fg'} ${mono ? 'font-mono' : ''}`}
      >
        {num}
        {numSuffix && <span className="ml-0.5 text-[12px] font-normal text-muted">{numSuffix}</span>}
      </div>
      <div className="mt-1 truncate text-[11px] text-muted">{label}</div>
    </div>
  );
}

/**
 * 2×2 无缝格容器：grid-cols-2 + gap-px + 缝色底（--border）+ rounded-xl overflow-hidden。
 */
export function SeatStats({
  onlineCount,
  totalCount,
  inProgressCount,
  todayMsgCount,
  tokenUsed,
}: SeatStatsProps): ReactNode {
  const { t } = useTranslation('studio');
  const empty = t('seats.stats.empty');

  return (
    <div

      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border"
    >
      <StatCell

        num={String(onlineCount)}
        numSuffix={`/${totalCount}`}
        label={t('seats.stats.onlineLabel')}
      />
      <StatCell

        num={String(inProgressCount)}
        label={t('seats.stats.inProgressLabel')}
      />
      <StatCell

        num={todayMsgCount === null ? empty : formatCount(todayMsgCount)}
        label={t('seats.stats.todayMsgLabel')}
        dim={todayMsgCount === null}
      />
      <StatCell

        num={tokenUsed === null ? empty : formatCount(tokenUsed)}
        label={t('seats.stats.tokenUsedLabel')}
        dim={tokenUsed === null}
        mono
      />
    </div>
  );
}

export default SeatStats;
