/**
 * component-usage-ring —— usage-panel 圆环（primitive）
 * 参考: specs/ui/components/chat-page/component-usage-panel.md §1（UsageRing）/ §4.2（视觉基线 SVG）
 *       reqs/v0.0.16/mqnbr367-easy-opc-chat-v9a.html §550-561（UsageRing SVG）
 *
 * 纯 SVG 圆环，配色随占用率：pct<0.5 success / <0.8 warning / ≥0.8 danger 语义色。
 * 收起态 36×36 stroke4（v0.0.326 起，原 28×28）/ 展开态大号 52×52 stroke6；dasharray 0.3s 动画。
 *
 * testid `usage-ring` 收起 + 展开共用（component-usage-panel.md §5）。
 */
interface UsageRingProps {
  /** 已用 input token（不含 maxOutputTokens） */
  used: number;
  /** 总额度（tokenLimit） */
  total: number;
  /** 直径 px（收起 36 / 展开 52） */
  size?: number;
  /** 描边宽度（收起 4 / 展开 6） */
  stroke?: number;
}

/**
 * 根据占用率选色（§4.2 配色阈值）。
 * pct<0.5 success / 0.5-0.8 warning / ≥0.8 danger 语义色。
 */
export function usageRingColor(pct: number): string {
  if (pct < 0.5) return 'var(--success)';
  if (pct < 0.8) return 'var(--warning)';
  return 'var(--danger)';
}

/**
 * UsageRing SVG 圆环。dasharray = `${c*pct} ${c}`，rotate(-90) 让起点在 12 点位置。
 */
export function ComponentUsageRing({
  used,
  total,
  size = 36,
  stroke = 4,
}: UsageRingProps) {
  const pct = Math.min(1, total > 0 ? used / total : 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = usageRingColor(pct);
  const cx = size / 2;
  const cy = size / 2;

  return (
    <svg

      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="block shrink-0"
      aria-hidden
    >
      {/* 底环 */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke="var(--color-border-2)"
        strokeWidth={stroke}
      />
      {/* 填充环：rotate(-90) 让起点在 12 点位置；dasharray 0.3s 动画 */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ transition: 'stroke-dasharray 0.3s ease' }}
      />
    </svg>
  );
}

export default ComponentUsageRing;
