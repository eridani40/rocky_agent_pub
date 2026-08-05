/**
 * component-token-stats-helpers —— 格式化 + 颜色映射 + native title 生成
 * 参考: specs/ui/components/studio-page/component-token-stats.md §口径
 *       specs/prd/version_logs/v0.0.194/prd.md §2.2 单位口径
 *
 * 单位口径（用户裁决）：
 *   - token 数一律 M（÷1e6）：<0.01M 兜底 / <1M 2 位 / <100M 1 位 / ≥100M 整数
 *   - cacheRate = cache / (cache + input) * 100，1 位小数（去尾 0），分母 ≤0 显 0%
 *
 * 视觉契约：颜色走 tokens.css 的 hue palette（input=蓝 / output=紫 / cache=绿 / cacheRate=amber）。
 */
import type { KindFilter, UsageBreakdown } from './component-token-stats-types';
import { totalOf, valueByKind } from './component-token-stats-types';

/** 去尾 0：'5.20' → '5.2'；'5.00' → '5'；'0.10' → '0.1' */
function stripZero(s: string): string {
  return String(parseFloat(s));
}

/**
 * token 数值一律 M 单位（÷1e6 + 1-2 位小数）。
 *   - <0.01M (10k) → '<0.01M' 兜底（避免 0M 丢精度感）
 *   - <1M → 2 位小数（0.5M / 0.12M）
 *   - <100M → 1 位小数（5M / 5.2M）
 *   - ≥100M → 整数
 */
export function formatTokens(n: number): string {
  const m = n / 1_000_000;
  if (m < 0.01) return n > 0 ? '<0.01M' : '0M';
  if (m < 1) return `${stripZero(m.toFixed(2))}M`;
  if (m < 100) return `${stripZero(m.toFixed(1))}M`;
  return `${Math.round(m)}M`;
}

/**
 * 缓存率：cache / (cache + input) * 100，保留 1 位小数（去尾 0）。
 * 分母 ≤0 时返 '0%'（无数据兜底）。
 */
export function formatCacheRate(cache: number, input: number): string {
  const denom = cache + input;
  if (denom <= 0) return '0%';
  const r = (cache / denom) * 100;
  return `${stripZero(r.toFixed(1))}%`;
}

/**
 * 生成 native title 文本（hover 浮层兜底，与可视化 tooltip 同口径）。
 *   - kind=total → head + 总体/输入/输出/缓存/缓存率 5 行
 *   - kind=cacheRate → head + 缓存率 1 行（%，不走 formatTokens）
 *   - kind=单类 token → head + 该分项 1 行（M）
 */
export function buildBreakdownTitle(head: string, b: UsageBreakdown, kind: KindFilter): string {
  if (kind === 'total') {
    return (
      `${head}\n` +
      `总体: ${formatTokens(totalOf(b))}\n` +
      `输入: ${formatTokens(b.input)}\n` +
      `输出: ${formatTokens(b.output)}\n` +
      `缓存: ${formatTokens(b.cache)}\n` +
      `缓存率: ${formatCacheRate(b.cache, b.input)}`
    );
  }
  if (kind === 'cacheRate') {
    return `${head}\n${kindLabelCN('cacheRate')}: ${formatCacheRate(b.cache, b.input)}`;
  }
  return `${head}\n${kindLabelCN(kind)}: ${formatTokens(valueByKind(b, kind))}`;
}

/**
 * 计算 Y 轴最大值（用于时间轴柱高归一 + Y 轴刻度）。
 * 把实际峰值向上取整到「漂亮的步长」倍数（0.25M / 0.5M / 1M / 5M / 10M）。
 */
export function computeAxisMax(maxTotal: number): number {
  const M = 1_000_000;
  if (maxTotal <= 0) return M;
  const m = maxTotal / M;
  let step: number;
  if (m <= 0.5) step = 0.25;
  else if (m <= 2) step = 0.5;
  else if (m <= 5) step = 1;
  else if (m <= 20) step = 5;
  else step = 10;
  return Math.ceil(m / step) * step * M;
}

/** 'YYYY-MM-DD' → 'M月D日' */
export function formatDateCN(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number);
  return `${m}月${d}日`;
}

/** 'YYYY-MM-DD' → 'M/D'（紧凑横轴） */
export function formatDateShort(dateKey: string): string {
  const [, m, d] = dateKey.split('-').map(Number);
  return `${m}/${d}`;
}

/** 'YYYY-MM-DD HH' → 'HH'（hour 横轴） */
export function formatHour(bucket: string): string {
  // hour bucket = 'YYYY-MM-DD HH'，取末两位
  const parts = bucket.split(' ');
  return parts.length === 2 ? parts[1]! : bucket;
}

/** 按类型返回色 token（hue palette）—— 日历着色 + 堆积分段共用 */
export function kindColor(kind: Exclude<KindFilter, 'total'>): string {
  switch (kind) {
    case 'input':
      return 'var(--hue-blue)';
    case 'output':
      return 'var(--hue-violet)';
    case 'cache':
      return 'var(--hue-green)';
    case 'cacheRate':
      return 'var(--hue-amber)';
  }
}

/** 类型中文 label */
export function kindLabelCN(kind: KindFilter): string {
  switch (kind) {
    case 'total':
      return '总览';
    case 'input':
      return '输入';
    case 'output':
      return '输出';
    case 'cache':
      return '缓存';
    case 'cacheRate':
      return '缓存率';
  }
}

/**
 * 日历热力色块深度：把 value 归一到 [0,1]，映射到 rgba 的 alpha 阶梯。
 * 4 档透明度（0.15 / 0.35 / 0.55 / 0.8）；0 值返 transparent。
 */
export function heatColor(value: number, max: number, baseRgb = '59, 130, 246'): string {
  if (value <= 0 || max <= 0) return 'transparent';
  const ratio = Math.min(1, value / max);
  const alpha = ratio < 0.25 ? 0.15 : ratio < 0.5 ? 0.35 : ratio < 0.75 ? 0.55 : 0.8;
  return `rgba(${baseRgb}, ${alpha})`;
}

/**
 * 解析 model 筛选下拉的 value（`${providerId}/${modelId}`）回 { providerId, modelId }。
 *   - '__all__' 或不含 '/' → undefined（不带 model 筛选）
 *   - 否则按**首个** '/' 切：providerId = 前半（永远是 slash-free ULID 或 '__unknown__'），
 *     modelId = 后半整体（OpenRouter 等的 modelId 本身可含 '/'，如 'deepseek/deepseek-chat'，
 *     必须整体保留不能 split 截断，否则后端过滤不命中）
 *
 * 参考: specs/ui/components/studio-page/component-token-stats.md
 */
export function parseModelSelection(
  selection: string,
): { providerId: string; modelId: string } | undefined {
  if (selection === '__all__') return undefined;
  const idx = selection.indexOf('/');
  if (idx < 0) return undefined;
  return { providerId: selection.slice(0, idx), modelId: selection.slice(idx + 1) };
}

/** 一个序列里按 kind 取最大值（用于日历色阶归一） */
export function maxByKind(points: { breakdown: UsageBreakdown }[], kind: KindFilter): number {
  let m = 0;
  for (const p of points) {
    const v = valueByKind(p.breakdown, kind);
    if (v > m) m = v;
  }
  return m;
}
