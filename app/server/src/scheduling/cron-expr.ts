/**
 * 5 字段 cron expr 解析（parseCronExpression + expandField）。
 * 参考: specs/tech/scheduling/[P0]cron_expr.md §2-§3
 *       refs/claude-code/src/utils/cron.ts（搬迁源）
 *
 * 设计：
 *   - 5 字段 minute-hour-dom-month-dow（vixie-cron 标准）
 *   - 支持语法: 通配 / 单值 / step (星-N) / range / range-step / list / dow 7=Sunday alias
 *   - 0 npm 依赖（不引入 croner / cron-parser / cron-expression-parser）
 *
 * computeNextCronRunMs（cron 下次到点计算）拆到 ./cron-next.ts（密度过高分离，
 * 详 [P0]cron_expr.md §4 + 任务 T1 验收 §1「拆 expandField/parse/computeNext 三子文件」）。
 */

/** cron 5 字段展开后形态（每字段 = sorted 升序 number[]） */
export interface CronFields {
  /** [0..59] */
  minute: number[];
  /** [0..23] */
  hour: number[];
  /** [1..31] */
  dayOfMonth: number[];
  /** [1..12] */
  month: number[];
  /** [0..6]，7 已归一为 0（Sunday） */
  dayOfWeek: number[];
}

/** 各字段合法值域（顺序: minute/hour/dom/month/dow） */
type FieldRange = { min: number; max: number };

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // dayOfMonth
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }, // dayOfWeek (0=Sunday; 7 accepted as Sunday alias)
];

/**
 * 解析单 cron 字段为 sorted 数组。
 * 支持语法: 通配 (星) / step (星-N) / range (N-M) / range-step / list / 单值。
 * dow 字段：7=Sunday alias（与 0 等价），范围如 5-7 归一为 [5,6,0]。
 *
 * @returns null=语法非法；非空 sorted number[]
 */
function expandField(field: string, range: FieldRange): number[] | null {
  const { min, max } = range;
  const out = new Set<number>();
  const isDow = min === 0 && max === 6;
  const effMax = isDow ? 7 : max; // dow 接受 7（Sunday alias）

  for (const part of field.split(',')) {
    // 通配 或 step (星 / 星-N)
    const stepMatch = part.match(/^\*(?:\/(\d+))?$/);
    if (stepMatch) {
      const step = stepMatch[1] ? parseInt(stepMatch[1]!, 10) : 1;
      if (step < 1) return null;
      for (let i = min; i <= max; i += step) out.add(i);
      continue;
    }

    // 范围 (N-M) 或 range-step (N-M/S)
    const rangeMatch = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1]!, 10);
      const hi = parseInt(rangeMatch[2]!, 10);
      const step = rangeMatch[3] ? parseInt(rangeMatch[3]!, 10) : 1;
      if (lo > hi || step < 1 || lo < min || hi > effMax) return null;
      for (let i = lo; i <= hi; i += step) {
        out.add(isDow && i === 7 ? 0 : i);
      }
      continue;
    }

    // 单值 (N)
    const singleMatch = part.match(/^\d+$/);
    if (singleMatch) {
      let n = parseInt(part, 10);
      if (isDow && n === 7) n = 0; // dow 7=Sunday alias → 0
      if (n < min || n > max) return null;
      out.add(n);
      continue;
    }

    return null;
  }

  if (out.size === 0) return null;
  return Array.from(out).sort((a, b) => a - b);
}

/**
 * 解析 5 字段 cron expr 为 CronFields。
 * @returns null=字段数非 5 / 任字段语法非法
 */
export function parseCronExpression(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const expanded: number[][] = [];
  for (let i = 0; i < 5; i++) {
    const result = expandField(parts[i]!, FIELD_RANGES[i]!);
    if (!result) return null;
    expanded.push(result);
  }

  return {
    minute: expanded[0]!,
    hour: expanded[1]!,
    dayOfMonth: expanded[2]!,
    month: expanded[3]!,
    dayOfWeek: expanded[4]!,
  };
}

// computeNextCronRunMs 实现在 ./cron-next.ts，re-export 保 backward compat
// （engine.ts / 现有 UT 直接 import from './cron-expr' 不破）
export { computeNextCronRunMs } from './cron-next';
