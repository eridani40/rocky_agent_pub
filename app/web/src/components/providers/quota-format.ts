/**
 * quota-format.ts — 额度/余额渲染格式化辅助
 * 参考: specs/prd/quota-overview-demo-v2.html
 *
 * 职责：
 *   - 重置时间本地化为「周四 13:22」
 *   - 剩余时间格式化为「剩 4 小时 29 分」/「剩 5 天 4 小时」
 *   - 按窗口类型计算时间进度（0-1）
 *   - 判断消耗偏快（已用 > 时间进度）
 *   - [v0.0.356] 单单位时间四分支 + 金额千分位 + 白名单小时命中判定
 */

import type { QuotaTier } from '../../lib/api-client';

/** 窗口类型 → 周期毫秒数（未识别窗口返回 null，不画时间柱） */
function windowDurationMs(window: string): number | null {
  switch (window) {
    case 'five_hour':
      return 5 * 60 * 60 * 1000;
    case 'weekly':
      return 7 * 24 * 60 * 60 * 1000;
    case 'daily':
      return 24 * 60 * 60 * 1000;
    case 'monthly':
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

/** 「周四 13:22」本地时间展示（含星期） */
export function formatResetTime(ts: number | string, locales: string | string[] = navigator.language): string {
  return new Date(ts).toLocaleString(locales, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** 剩余时间：剩 X 小时 Y 分 / 剩 X 天 Y 小时（分钟级即可） */
export function formatRemaining(resetsAt: string | number, nowMs: number): string | null {
  const diff = new Date(resetsAt).getTime() - nowMs;
  if (diff <= 0) return null;
  const totalMinutes = Math.floor(diff / 60_000);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `剩 ${days} 天 ${hours} 小时`;
  return `剩 ${hours} 小时 ${minutes} 分`;
}

/** 时间进度 0-1；无法计算时返回 null */
export function computeTimeProgress(tier: QuotaTier, nowMs: number): number | null {
  if (!tier.resetsAt) return null;
  const duration = windowDurationMs(tier.window);
  if (duration === null) return null;
  const reset = new Date(tier.resetsAt).getTime();
  const start = reset - duration;
  const elapsed = nowMs - start;
  if (elapsed <= 0) return 0;
  if (elapsed >= duration) return 1;
  return elapsed / duration;
}

/** 消耗偏快：已用比例超过时间进度（usedPercent 是 0-100，timeProgress 是 0-1） */
export function isUsageFast(usedPercent: number, timeProgress: number | null): boolean {
  return timeProgress !== null && usedPercent / 100 > timeProgress;
}

/** formatSingleUnit 单位文案（组件层 useTranslation 传入；模块不硬编码中文，i18n key 驱动） */
export interface SingleUnitLabels {
  /** 天（≥1d） */
  day: string;
  /** 小时（≥1h） */
  hour: string;
  /** 分钟后缀（<60m） */
  minute: string;
  /** <1m 固定文案 */
  zero: string;
}

/**
 * [v0.0.356] 单单位剩余时间（收起态环内数字，PRD §2.3 固化四分支）：
 * ≥1 天→`X天`；≥1 小时→`X小时`（不携分钟）；<60 分→`Xm`；<1 分→`0min`
 */
export function formatSingleUnit(resetsAt: string | number, nowMs: number, labels: SingleUnitLabels): string {
  const diff = new Date(resetsAt).getTime() - nowMs;
  if (diff <= 0) return labels.zero;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return labels.zero;
  if (minutes < 60) return `${minutes}${labels.minute}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${labels.hour}`;
  return `${Math.floor(hours / 24)}${labels.day}`;
}

/** [v0.0.356] 金额千分位 + 两位小数（¥ 9,118.81 的数字部分） */
export function formatAmount(total: number): string {
  return total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** [v0.0.356] 余额币种符号（CNY/USD 常见映射；其余原码前缀） */
export function currencySymbol(currency: string): string {
  if (currency === 'CNY') return '¥';
  if (currency === 'USD') return '$';
  return `${currency} `;
}

/**
 * [v0.0.356] 白名单小时命中判定（change_plan D5）：
 * 用 Intl hourCycle 'h23' 取当前本地小时（0-23），禁 hour12:false（en-US 午夜会输出 "24"）。
 * [v0.0.364] 唯一时间段文本展示实现 = app-dev-config-page/component-hour-grid-picker 的 fmtHours
 * （formatHourRange 已删——多段合并 + 段末少 1h，见 states/v0.0.364/bug-analysis-tier-hour-range.md）。
 */
export function hourHit(hours: number[] | undefined, now: Date): boolean {
  if (!hours || hours.length === 0) return true;
  const h = Number(new Intl.DateTimeFormat('en-US', { hour: '2-digit', hourCycle: 'h23' }).format(now));
  return hours.includes(h);
}
