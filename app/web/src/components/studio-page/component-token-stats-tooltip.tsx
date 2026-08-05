/**
 * component-token-stats-tooltip —— 共享 hover 明细浮层 body + portal 定位机制
 * 参考: specs/ui/components/studio-page/component-token-stats.md
 *
 * 口径（PRD §2.3.4）：
 *   - kind='total'：总体 + 输入 + 输出 + 缓存 + 缓存率 5 行
 *   - kind=单类：只显该分项 1 行
 *   - kind='cacheRate'：只显缓存率 1 行（%）
 *
 * Portal 定位机制（修 overflow 裁剪 bug，不回退）：
 *   - useHoverPortal：hover 时取 trigger rect → 算 viewport 坐标 → state 存 {top,left}
 *   - PortalTooltip：createPortal 到 document.body（脱离 DOM 树）+ position:fixed（viewport 相对）
 *   - 不被任何 overflow-x-auto 祖先垂直裁剪（CSS 规范：overflow-x!=visible 时 overflow-y 被算成 auto）
 */
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { KindFilter, UsageBreakdown } from './component-token-stats-types';
import { totalOf, valueByKind } from './component-token-stats-types';
import { formatCacheRate, formatTokens, kindColor, kindLabelCN } from './component-token-stats-helpers';

export interface TooltipRowProps {
  label: string;
  text: string;
  /** 色点（可选）：分项行带 hue 点 */
  color?: string;
  /** 强调行（如「总体」） */
  bold?: boolean;
}

/** 单行明细：左色点 + label，右数值 */
export function TooltipRow({ label, text, color, bold }: TooltipRowProps) {
  return (
    <div className={`flex items-center justify-between gap-3 ${bold ? 'font-semibold text-fg' : 'text-fg-2'}`}>
      <span className="flex items-center gap-1">
        {color && (
          <span className="h-2 w-2 rounded-sm" style={{ background: color }} aria-hidden />
        )}
        {label}
      </span>
      <span className="font-mono">{text}</span>
    </div>
  );
}

/** 按 kind 渲染明细行（总体 5 行 / 单类 1 行 / cacheRate 1 行） */
export function BreakdownTooltipRows({
  breakdown,
  kind,
}: {
  breakdown: UsageBreakdown;
  kind: KindFilter;
}) {
  if (kind === 'total') {
    return (
      <>
        <TooltipRow label="总体" text={formatTokens(totalOf(breakdown))} bold />
        <TooltipRow label={kindLabelCN('input')} text={formatTokens(breakdown.input)} color={kindColor('input')} />
        <TooltipRow label={kindLabelCN('output')} text={formatTokens(breakdown.output)} color={kindColor('output')} />
        <TooltipRow label={kindLabelCN('cache')} text={formatTokens(breakdown.cache)} color={kindColor('cache')} />
        <TooltipRow label="缓存率" text={formatCacheRate(breakdown.cache, breakdown.input)} />
      </>
    );
  }
  if (kind === 'cacheRate') {
    return (
      <TooltipRow
        label={kindLabelCN('cacheRate')}
        text={formatCacheRate(breakdown.cache, breakdown.input)}
        color={kindColor('cacheRate')}
      />
    );
  }
  // 单类 token 分支：kind 已收窄为非 'total'/'cacheRate'
  const k = kind as Exclude<KindFilter, 'total' | 'cacheRate'>;
  const v = valueByKind(breakdown, kind);
  return <TooltipRow label={kindLabelCN(kind)} text={formatTokens(v)} color={kindColor(k)} />;
}

/** 浮层预估宽度（水平居中 + 视口边界 clamp 用） */
const TOOLTIP_W = 200;

export interface HoverPortalPos {
  top: number;
  left: number;
}

/**
 * hover trigger → 取 trigger 的 viewport rect → 算浮层坐标。
 * 浮层定位：贴 trigger 上沿 8px，水平居中 trigger，靠视口右/左沿时 clamp 防溢出。
 */
export function useHoverPortal() {
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState<HoverPortalPos | null>(null);

  const onMouseEnter = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    let left = r.left + r.width / 2 - TOOLTIP_W / 2;
    if (left + TOOLTIP_W > vw - 8) left = vw - TOOLTIP_W - 8;
    if (left < 8) left = 8;
    setPos({ top: r.top - 8, left });
    setHovered(true);
  };
  const onMouseLeave = () => setHovered(false);

  return { ref, hovered, pos, onMouseEnter, onMouseLeave };
}

/**
 * portal 到 document.body 的 hover 浮层（脱离所有 overflow 祖先，不被裁剪）。
 * fixed + viewport 坐标；-translate-y-full 让浮层在 top 坐标上方展开。
 */
export function PortalTooltip({
  pos,
  children,
}: {
  pos: HoverPortalPos;
  children: ReactNode;
}) {
  return createPortal(
    <div

      className="pointer-events-none fixed z-popover min-w-[180px] -translate-y-full rounded-md border border-border bg-surface p-2 text-[11px] shadow-md"
      style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
    >
      {children}
    </div>,
    document.body,
  );
}
