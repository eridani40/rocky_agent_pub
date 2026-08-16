/**
 * component-quota-ring — 额度双环（单环）（v0.0.356 T1）
 * 参考: specs/prd/squad-quota-entry-demo-v2.html §②（.ring r-used/.r-time）
 *        specs/prd/version_logs/v0.0.356-squad-quota-entry/change_log.md §2.3
 *
 * 职责：
 *   - SVG circle stroke-dashoffset 实现圆环进度
 *   - 左/用量环 fast 时整体琥珀（同 footer 双柱 fast 语义）
 *   - 右/时间环固定灰；中心文案传参
 *   - role="progressbar" + aria-label（provider+档位+已用%）
 * 边界：纯展示组件；百分比 clamp 0-100。
 */
import { useMemo } from 'react';

export interface QuotaRingProps {
  /** 已用/时间进度百分比 0-100 */
  percent: number;
  /** 环底标签（5小时额度/周额度） */
  label: string;
  /** 环中心文本（如 "3%" / "5小时"） */
  centerText: string;
  /** 是否消耗偏快（琥珀色） */
  fast?: boolean;
  /** 环类型：used=用量环；time=时间进度环（影响主色） */
  kind: 'used' | 'time';
  /** 辅助 aria-label */
  ariaLabel?: string;
}

export function QuotaRing({ percent, label, centerText, fast, kind, ariaLabel }: QuotaRingProps) {
  const p = Math.min(100, Math.max(0, percent));
  const size = 36;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (p / 100) * c;

  const color = useMemo(() => {
    if (kind === 'time') return 'text-muted';
    return fast ? 'text-gold' : 'text-fg';
  }, [kind, fast]);
  const trackColor = kind === 'time' ? 'text-bg-warm' : 'text-border';

  return (
    <div className="flex flex-col items-center gap-0.5" role="progressbar" aria-label={ariaLabel ?? `${label}: ${centerText}`} aria-valuenow={Math.round(p)}>
      <svg width={size} height={size} className="-rotate-90" viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" className={trackColor} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          className={color}
          strokeWidth={stroke}
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          className={`${color} text-[9px] font-bold`}
          transform="rotate(90, 18, 18)"
        >
          {centerText}
        </text>
      </svg>
      <span className="text-[10px] text-muted whitespace-nowrap">{label}</span>
    </div>
  );
}
