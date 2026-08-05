/**
 * computeNextCronRunMs — cron 下次到点计算（per-job tz 扩展）。
 * 参考: specs/tech/scheduling/[P0]cron_expr.md §4-§5
 *       refs/claude-code/src/utils/cron.ts（computeNextCronRun 搬迁源，setHours+carry 思路）
 *
 * 设计动机：原 epoch-ms 直接 +1h/+1d 的写法不 reset 子字段（minute/hour），
 * 在「minute=0 但当前 minute>0」等场景下漏匹配（如 `0 9 * * *` from 08:00
 * 应得当日 09:00，实际拿到次日 09:00）。对齐 claude-code 的 Date.setHours
 * (h+1,0,0,0) carry 语义，在 tz-local 字段空间做迭代避免此 bug。
 *
 * DST（[P0]cron_expr.md §5）：
 *   - spring-forward gap（02:00-03:00 跳过）：wall-clock 不存在 → wallToEpoch 验出不一致
 *     → 该候选跳过（cron 该日不触发，等下一日）
 *   - fall-back repeat（02:00-03:00 重复）：算法选第二个出现（standard time），
 *     isDue 满足后 lastFiredAt 推进，只触发一次
 */
import { parseCronExpression } from './cron-expr';

/** tz 本地 wall-clock 字段（cron 精度到分钟，不含秒/毫秒） */
interface WallClock {
  y: number;
  mo: number; // 1-12
  d: number; // 1-31
  h: number; // 0-23
  mi: number; // 0-59
}

/** 用 Intl.DateTimeFormat 取 d 在 tz 的 wall-clock 字段（hourCycle h23 防 24）。 */
function fieldsInTzWall(d: Date, tz: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  }).formatToParts(d);
  const g = (t: string): number =>
    Number((parts.find(p => p.type === t) || { value: '0' }).value);
  return {
    y: g('year'),
    mo: g('month'),
    d: g('day'),
    h: g('hour') % 24, // hourCycle:'h23' 在部分 locale 仍可能返 24，归一为 0
    mi: g('minute'),
  };
}

/** 指定 (y, mo) 的月天数（用于 day carry）。Date.UTC(y, mo, 0) = 上月末。 */
function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/**
 * Zeller congruence 计算 Gregorian 日期的 Sunday=0 周几（与 Date.getDay 一致）。
 * 用本地算避免每个 wall-clock 候选都 new Date + Intl.formatToParts（性能优化）。
 */
function zellersDow(y: number, mo: number, d: number): number {
  let yy = y;
  let mm = mo;
  if (mm < 3) {
    mm += 12;
    yy -= 1;
  }
  const k = yy % 100;
  const j = Math.floor(yy / 100);
  // h: 0=Saturday..6=Friday → 转 Sunday=0：(h+6) mod 7
  const h =
    (d + Math.floor((13 * (mm + 1)) / 5) + k + Math.floor(k / 4) + Math.floor(j / 4) + 5 * j) % 7;
  return (h + 6) % 7;
}

/** wall-clock +1 分钟（含 hour/day/month carry）。 */
function wallIncMinute(w: WallClock): WallClock {
  let { y, mo, d, h, mi } = w;
  if (++mi > 59) {
    mi = 0;
    if (++h > 23) {
      h = 0;
      if (++d > daysInMonth(y, mo)) {
        d = 1;
        if (++mo > 12) {
          mo = 1;
          y++;
        }
      }
    }
  }
  return { y, mo, d, h, mi };
}

/** 跳到下个整点（h+1, mi=0；含 day/month carry）。 */
function wallSkipToNextHour(w: WallClock): WallClock {
  let { y, mo, d, h } = w;
  if (++h > 23) {
    h = 0;
    if (++d > daysInMonth(y, mo)) {
      d = 1;
      if (++mo > 12) {
        mo = 1;
        y++;
      }
    }
  }
  return { y, mo, d, h, mi: 0 };
}

/** 跳到下一天 00:00（h=0, mi=0；含 month carry）。 */
function wallSkipToNextDay(w: WallClock): WallClock {
  let { y, mo, d } = w;
  if (++d > daysInMonth(y, mo)) {
    d = 1;
    if (++mo > 12) {
      mo = 1;
      y++;
    }
  }
  return { y, mo, d, h: 0, mi: 0 };
}

/** 跳到下月 1 号 00:00（d=1, h=0, mi=0；含 year carry）。 */
function wallSkipToFirstOfNextMonth(w: WallClock): WallClock {
  let { y, mo } = w;
  if (++mo > 12) {
    mo = 1;
    y++;
  }
  return { y, mo, d: 1, h: 0, mi: 0 };
}

/**
 * wall-clock 字段（在 tz 下）→ epoch ms。
 * 用 Intl.DateTimeFormat 计算偏移并迭代 2 轮收敛（DST 边界 1 轮可能未对齐）。
 * DST spring-forward gap（02:00-03:00 不存在）→ 验证失败返 null（caller 跳过该候选）。
 */
function wallToEpoch(w: WallClock, tz: string): number | null {
  const targetWallAsUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let epoch = targetWallAsUtc;
  for (let i = 0; i < 2; i++) {
    const f = fieldsInTzWall(new Date(epoch), tz);
    const actualAsUtc = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi);
    const offsetMs = actualAsUtc - epoch; // tz 相对 UTC 的偏移（含 DST）
    epoch = targetWallAsUtc - offsetMs;
  }
  // 验证：epoch 解回 wall-clock 必须等于输入；否则该时刻在 tz 不存在（DST gap）
  const v = fieldsInTzWall(new Date(epoch), tz);
  if (v.y !== w.y || v.mo !== w.mo || v.d !== w.d || v.h !== w.h || v.mi !== w.mi) {
    return null;
  }
  return epoch;
}

/**
 * 计算严格大于 from 的下一次 cron 到点时刻（epoch ms）。
 *
 * 锚点策略（[P0]engine.md §4 isDue 用）：
 *   - from = lastFiredAt ?? createdAt（caller 传）
 *   - 严格大于（from 所在分钟的下一分钟起算）— at-most-once 不追溯
 *
 * 算法：tz-local wall-clock 字段空间内 carry-based 迭代。
 *   - month 不匹配 → 跳到下月 1 号 00:00（reset d/h/mi）
 *   - day 不匹配（dom/dow OR 失败）→ 跳到次日 00:00（reset h/mi）
 *   - hour 不匹配 → 跳到下个整点（reset mi）
 *   - minute 不匹配 → +1 分钟
 *   - 全匹配 → wallToEpoch 转 epoch ms（DST gap 跳到次日）
 *
 * dom/dow OR 语义：都 constrained → 任一匹配；其一 wildcard → 该字段恒真。
 *
 * @returns null=expr 非法 / 一年内无匹配（如 `0 0 30 2 *`，AND 语义永不命中）
 */
export function computeNextCronRunMs(
  expr: string,
  from: Date,
  tz: string,
): number | null {
  const fields = parseCronExpression(expr);
  if (!fields) return null;

  const minuteSet = new Set(fields.minute);
  const hourSet = new Set(fields.hour);
  const domSet = new Set(fields.dayOfMonth);
  const monthSet = new Set(fields.month);
  const dowSet = new Set(fields.dayOfWeek);

  // dom/dow 是否 wildcard（全范围）。claude-code 用 length 判：dom=31 / dow=7
  const domWild = fields.dayOfMonth.length === 31;
  const dowWild = fields.dayOfWeek.length === 7;

  // 起：from 在 tz 的 wall-clock + 1 分钟（不含 from 当分钟）
  let w = wallIncMinute(fieldsInTzWall(from, tz));

  const maxIter = 366 * 24 * 60; // 一年分钟数兜底（cron 必然一年内有解）
  for (let i = 0; i < maxIter; i++) {
    if (!monthSet.has(w.mo)) {
      w = wallSkipToFirstOfNextMonth(w);
      continue;
    }
    const dow = zellersDow(w.y, w.mo, w.d);
    const dayMatches =
      domWild && dowWild
        ? true
        : domWild
          ? dowSet.has(dow)
          : dowWild
            ? domSet.has(w.d)
            : domSet.has(w.d) || dowSet.has(dow);
    if (!dayMatches) {
      w = wallSkipToNextDay(w);
      continue;
    }
    if (!hourSet.has(w.h)) {
      w = wallSkipToNextHour(w);
      continue;
    }
    if (!minuteSet.has(w.mi)) {
      w = wallIncMinute(w);
      continue;
    }
    // 全字段匹配 → wall-clock 转 epoch ms
    const epoch = wallToEpoch(w, tz);
    if (epoch === null) {
      // DST gap：wall-clock 不存在（spring-forward 跳过的时段），跳到次日 00:00
      w = wallSkipToNextDay(w);
      continue;
    }
    return epoch;
  }

  return null;
}
