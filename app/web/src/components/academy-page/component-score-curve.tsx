/**
 * component-score-curve —— 评分走势折线图（轮次 X vs 平均分 Y，纯 SVG 零依赖）
 * 参考: specs/ui/components/academy-page/component-score-curve.md（可选组件，MVP 实现）
 *       design §8.5（训练视图：临时基线演进可视化）
 *
 * 纯展示：折线 + 数据点 + base 水平虚线 + 轴标签；isBaseline 点 sage 实心高亮。
 */
import { useMemo } from 'react';

export interface ScorePoint {
  turn: number;
  score: number;
  /** 成为临时基线的轮次（sage 实心点） */
  isBaseline?: boolean;
}

interface Props {
  /** 按轮次升序 */
  points: ScorePoint[];
  /** base 分基线（水平虚线；undefined 不画） */
  baseScore?: number;
  /** 图高（缺省 120） */
  height?: number;
}

const W = 460; // viewBox 宽（train-col 520 - padding，SVG 等比缩放）
const PAD = { l: 26, r: 10, t: 10, b: 18 };
const Y_MAX = 10;

/** 评分走势折线图（SVG；轴标签 11px mono muted） */
export function ComponentScoreCurve({ points, baseScore, height = 120 }: Props) {
  const geo = useMemo(() => {
    const innerW = W - PAD.l - PAD.r;
    const innerH = height - PAD.t - PAD.b;
    const xOf = (turn: number) => {
      if (points.length <= 1) return PAD.l + innerW / 2;
      const min = points[0]!.turn;
      const max = points[points.length - 1]!.turn;
      return PAD.l + (max === min ? innerW / 2 : ((turn - min) / (max - min)) * innerW);
    };
    const yOf = (score: number) => PAD.t + innerH - (Math.max(0, Math.min(Y_MAX, score)) / Y_MAX) * innerH;
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.turn).toFixed(1)},${yOf(p.score).toFixed(1)}`).join(' ');
    return { xOf, yOf, path, innerH };
  }, [points, height]);

  if (points.length === 0) return null;

  return (
    <svg
      viewBox={`0 0 ${W} ${height}`}
      className="w-full"
      style={{ height }}
      role="img"
      aria-label="score curve"
    >
      {/* Y 轴 0/5/10 网格线 + 标签 */}
      {[0, 5, 10].map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={W - PAD.r} y1={geo.yOf(v)} y2={geo.yOf(v)} stroke="var(--color-surface-2)" strokeWidth="1" />
          <text x={PAD.l - 5} y={geo.yOf(v) + 3.5} textAnchor="end" fontSize="9" fill="var(--color-muted-2)" fontFamily="var(--font-mono)">
            {v}
          </text>
        </g>
      ))}
      {/* base 水平虚线 */}
      {baseScore !== undefined && (
        <line
          x1={PAD.l} x2={W - PAD.r}
          y1={geo.yOf(baseScore)} y2={geo.yOf(baseScore)}
          stroke="var(--color-muted-2)" strokeWidth="1" strokeDasharray="4 3"
        />
      )}
      {/* 折线 */}
      <path d={geo.path} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" />
      {/* 数据点：isBaseline sage 实心 / 普通 accent */}
      {points.map((p) => (
        <g key={p.turn}>
          <circle
            cx={geo.xOf(p.turn)} cy={geo.yOf(p.score)} r={p.isBaseline ? 4 : 3}
            fill={p.isBaseline ? 'var(--color-sage)' : 'var(--color-accent)'}
          />
          <text x={geo.xOf(p.turn)} y={height - 4} textAnchor="middle" fontSize="9" fill="var(--color-muted-2)" fontFamily="var(--font-mono)">
            {p.turn}
          </text>
          <title>{`#${p.turn} · ${p.score}`}</title>
        </g>
      ))}
    </svg>
  );
}

export default ComponentScoreCurve;
