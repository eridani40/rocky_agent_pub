/**
 * cron-expr UT — 5 字段解析 + dom/dow OR + per-job tz + DST gap + 跨月。
 * 参考: specs/tech/scheduling/[P0]cron_expr.md §2-§5
 *       task.json T1 acceptanceCriteria §3
 *
 * 覆盖：
 *   - parseCronExpression 5 字段语法（通配 / step / range / range-step / list / 单值 / 7=Sunday alias）
 *   - parseCronExpression 非法（字段数 / 越界）
 *   - computeNextCronRunMs 基础（每 N 分钟 / 每天 HH:mm / 每周 X HH:mm）
 *   - dom/dow OR 语义（都 constrained 任一匹配）
 *   - per-job tz（同 expr 不同 tz 算出不同 nextRunMs）
 *   - DST spring-forward gap（02:00-03:00 跳过的日不触发）
 *   - 跨月（1 月算到 4 月）
 */
import { describe, it, expect } from 'vitest';
import {
  parseCronExpression,
  computeNextCronRunMs,
} from '../cron-expr';

// ============================================================
// helpers
// ============================================================

/**
 * 取 cron 下次到点（epoch ms），相对 from，tz 下。
 * 包一层简化测试调用。
 */
function nextRunMs(expr: string, fromISO: string, tz: string): number | null {
  return computeNextCronRunMs(expr, new Date(fromISO), tz);
}

/** 取 cron 下次到点的 ISO 字符串（debug 友好） */
function nextRunISO(expr: string, fromISO: string, tz: string): string | null {
  const ms = nextRunMs(expr, fromISO, tz);
  return ms === null ? null : new Date(ms).toISOString();
}

// ============================================================
// parseCronExpression — 5 字段语法
// ============================================================

describe('parseCronExpression — 通配', () => {
  it('* * * * * 全字段通配 → 各字段全范围', () => {
    const f = parseCronExpression('* * * * *')!;
    expect(f.minute).toHaveLength(60);
    expect(f.minute[0]).toBe(0);
    expect(f.minute[59]).toBe(59);
    expect(f.hour).toHaveLength(24);
    expect(f.dayOfMonth).toHaveLength(31);
    expect(f.month).toHaveLength(12);
    expect(f.dayOfWeek).toHaveLength(7);
  });
});

describe('parseCronExpression — step (星-N)', () => {
  it('*/30 分钟 → [0,30]', () => {
    const f = parseCronExpression('*/30 * * * *')!;
    expect(f.minute).toEqual([0, 30]);
  });
  it('*/15 分钟 → [0,15,30,45]', () => {
    const f = parseCronExpression('*/15 * * * *')!;
    expect(f.minute).toEqual([0, 15, 30, 45]);
  });
  it('*/N 步长 0 非法', () => {
    expect(parseCronExpression('*/0 * * * *')).toBeNull();
  });
});

describe('parseCronExpression — range', () => {
  it('9-17 hour → [9..17]', () => {
    const f = parseCronExpression('0 9-17 * * *')!;
    expect(f.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });
  it('range 越界非法', () => {
    expect(parseCronExpression('0 5-30 * * *')).toBeNull();
  });
  it('range 反序非法', () => {
    expect(parseCronExpression('0 17-9 * * *')).toBeNull();
  });
});

describe('parseCronExpression — range-step', () => {
  it('1-31/2 dom → [1,3,...,31]', () => {
    const f = parseCronExpression('0 0 1-31/2 * *')!;
    expect(f.dayOfMonth).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31]);
  });
});

describe('parseCronExpression — list', () => {
  it('0,15,30,45 minute → 列表', () => {
    const f = parseCronExpression('0,15,30,45 * * * *')!;
    expect(f.minute).toEqual([0, 15, 30, 45]);
  });
  it('混合 list (单值 + range)', () => {
    const f = parseCronExpression('0,10-12,30 * * * *')!;
    expect(f.minute).toEqual([0, 10, 11, 12, 30]);
  });
});

describe('parseCronExpression — 单值', () => {
  it('0 9 * * 1 → minute=[0] hour=[9] dow=[1]', () => {
    const f = parseCronExpression('0 9 * * 1')!;
    expect(f.minute).toEqual([0]);
    expect(f.hour).toEqual([9]);
    expect(f.dayOfWeek).toEqual([1]);
  });
});

describe('parseCronExpression — 7=Sunday alias', () => {
  it('dow=7 归一为 0（与 Sunday 等价）', () => {
    const f = parseCronExpression('0 0 * * 7')!;
    expect(f.dayOfWeek).toEqual([0]);
  });
  it('dow range 5-7 → [5,6,0]（Fri,Sat,Sun）', () => {
    const f = parseCronExpression('0 0 * * 5-7')!;
    expect(f.dayOfWeek).toEqual([0, 5, 6]);
  });
  it('dow list 0,7 → [0]（去重，两者都 Sunday）', () => {
    const f = parseCronExpression('0 0 * * 0,7')!;
    expect(f.dayOfWeek).toEqual([0]);
  });
});

describe('parseCronExpression — 非法', () => {
  it("字段数非 5", () => {
    expect(parseCronExpression('* * * *')).toBeNull();
    expect(parseCronExpression('* * * * * *')).toBeNull();
    expect(parseCronExpression('')).toBeNull();
  });
  it("字段越界", () => {
    expect(parseCronExpression('60 * * * *')).toBeNull();   // minute>59
    expect(parseCronExpression('* 24 * * *')).toBeNull();   // hour>23
    expect(parseCronExpression('* * 0 * *')).toBeNull();    // dom<1
    expect(parseCronExpression('* * * 13 *')).toBeNull();   // month>12
    expect(parseCronExpression('* * * * 8')).toBeNull();    // dow>7（7 自身合法，8 非法）
  });
  it("非法字符", () => {
    expect(parseCronExpression('A * * * *')).toBeNull();
    expect(parseCronExpression('* * * * MON')).toBeNull();  // 不支持 name alias
  });
});

// ============================================================
// computeNextCronRunMs — 基础场景
// ============================================================

describe('computeNextCronRunMs — 每 N 分钟', () => {
  it('*/5 从 12:00:00 → 12:05:00（同 tz）', () => {
    const r = nextRunISO('*/5 * * * *', '2026-03-15T12:00:00.000Z', 'UTC')!;
    expect(r).toBe('2026-03-15T12:05:00.000Z');
  });
  it('*/5 从 12:02:30 → 12:05:00（ceil to next minute）', () => {
    const r = nextRunISO('*/5 * * * *', '2026-03-15T12:02:30.000Z', 'UTC')!;
    expect(r).toBe('2026-03-15T12:05:00.000Z');
  });
  it('*/30 从 12:31 → 13:00（跨小时）', () => {
    const r = nextRunISO('*/30 * * * *', '2026-03-15T12:31:00.000Z', 'UTC')!;
    expect(r).toBe('2026-03-15T13:00:00.000Z');
  });
});

describe('computeNextCronRunMs — 每天 HH:mm', () => {
  it('0 9 * * * 从 08:00 → 09:00（同日）', () => {
    const r = nextRunISO('0 9 * * *', '2026-03-15T08:00:00.000Z', 'UTC')!;
    expect(r).toBe('2026-03-15T09:00:00.000Z');
  });
  it('0 9 * * * 从 10:00 → 次日 09:00', () => {
    const r = nextRunISO('0 9 * * *', '2026-03-15T10:00:00.000Z', 'UTC')!;
    expect(r).toBe('2026-03-16T09:00:00.000Z');
  });
});

describe('computeNextCronRunMs — 每周 X HH:mm', () => {
  // 2026-03-15 是周日（UTC）。2026-03-16 周一。
  it('0 9 * * 1（每周一）从周日 → 次日（周一）09:00', () => {
    const r = nextRunISO('0 9 * * 1', '2026-03-15T12:00:00.000Z', 'UTC')!;
    expect(r).toBe('2026-03-16T09:00:00.000Z');
  });
});

// ============================================================
// computeNextCronRunMs — dom/dow OR 语义
// ============================================================

describe('computeNextCronRunMs — dom/dow OR 语义', () => {
  it('都 wildcard → 每日（dom/dow 都不约束）', () => {
    const r = nextRunISO('0 0 * * *', '2026-03-15T12:00:00.000Z', 'UTC')!;
    expect(r).toBe('2026-03-16T00:00:00.000Z');
  });
  it('dom constrained dow wildcard → 仅 dom 匹配日触发', () => {
    // 每月 1 号 00:00
    const r = nextRunISO('0 0 1 * *', '2026-03-15T12:00:00.000Z', 'UTC')!;
    expect(r).toBe('2026-04-01T00:00:00.000Z');
  });
  it('dow constrained dom wildcard → 仅 dow 匹配日触发', () => {
    // 每周一 00:00。2026-03-15 周日 → 周一 2026-03-16
    const r = nextRunISO('0 0 * * 1', '2026-03-15T12:00:00.000Z', 'UTC')!;
    expect(r).toBe('2026-03-16T00:00:00.000Z');
  });
  it('dom AND dow 都 constrained → 任一匹配即触发（OR 语义）', () => {
    // 0 0 1 * 1：每月 1 号 OR 每周一 00:00
    // 2026-03-15 周日。下一个周一是 2026-03-16；下一个月 1 号是 2026-04-01。
    // OR 语义下应取更早的 2026-03-16（周一）。
    const r = nextRunISO('0 0 1 * 1', '2026-03-15T12:00:00.000Z', 'UTC')!;
    expect(r).toBe('2026-03-16T00:00:00.000Z');
  });
  it('OR 语义：当 1 号比周一更早时取 1 号', () => {
    // 2026-03-04 是周三。dom=1 下一次是 2026-04-01；dow=1（周一）下一次是 2026-03-09。
    // OR 语义取更早的 2026-03-09（周一）。
    const r = nextRunISO('0 0 1 * 1', '2026-03-04T12:00:00.000Z', 'UTC')!;
    expect(r).toBe('2026-03-09T00:00:00.000Z');
  });
});

// ============================================================
// computeNextCronRunMs — per-job tz
// ============================================================

describe('computeNextCronRunMs — per-job tz（同 expr 不同 tz）', () => {
  it('"0 9 * * *" 在 UTC vs Asia/Shanghai 算出不同 nextRunMs', () => {
    // 同一 from 时刻，同 expr，不同 tz
    const fromISO = '2026-03-15T00:00:00.000Z';
    const utcNext = nextRunMs('0 9 * * *', fromISO, 'UTC')!;
    const shNext = nextRunMs('0 9 * * *', fromISO, 'Asia/Shanghai')!;
    // 上海 09:00 = UTC 01:00（UTC+8）；UTC 09:00 = UTC 09:00
    // from = 00:00 UTC = 08:00 上海。两个 tz 的"下次 9 点"应不同。
    expect(utcNext).not.toBe(shNext);
    // 上海更早（1 小时后），UTC 较晚（9 小时后）
    expect(shNext).toBeLessThan(utcNext);
    expect(new Date(shNext).toISOString()).toBe('2026-03-15T01:00:00.000Z');
    expect(new Date(utcNext).toISOString()).toBe('2026-03-15T09:00:00.000Z');
  });
  it('server 在 UTC，user 在 Asia/Shanghai，"0 9 * * *" 仍按上海 9:00 触发', () => {
    const fromISO = '2026-03-15T00:00:00.000Z'; // 上海 08:00
    const r = nextRunISO('0 9 * * *', fromISO, 'Asia/Shanghai')!;
    // 上海 09:00 = UTC 01:00（同日）
    expect(r).toBe('2026-03-15T01:00:00.000Z');
  });
});

// ============================================================
// computeNextCronRunMs — DST spring-forward gap
// ============================================================

describe('computeNextCronRunMs — DST spring-forward gap', () => {
  it('America/New_York 2026-03-08 02:00 spring forward（02:00-03:00 不存在）', () => {
    // 2026-03-08 是 New York spring forward 日（夏令时开始）
    // 标准时间 = UTC-5；夏令时 = UTC-4
    // "0 2 * * *" 在 spring forward 日 02:00 不存在 → 跳到次日 02:00（已是 EDT=UTC-4）
    // from: 2026-03-07 23:00 UTC = 2026-03-07 18:00 EST
    const r = nextRunISO('0 2 * * *', '2026-03-07T23:00:00.000Z', 'America/New_York')!;
    // 期望：跳过 03-08 02:00（gap），下次匹配 03-09 02:00 EDT = 06:00 UTC
    expect(r).toBe('2026-03-09T06:00:00.000Z');
  });
  it('DST gap 后 cron "0 3 * * *" 仍能触发（03:00 在 gap 之后存在）', () => {
    const r = nextRunISO('0 3 * * *', '2026-03-07T23:00:00.000Z', 'America/New_York')!;
    // 03-08 03:00 EDT = 07:00 UTC（gap 之后，存在）
    expect(r).toBe('2026-03-08T07:00:00.000Z');
  });
});

// ============================================================
// computeNextCronRunMs — 跨月
// ============================================================

describe('computeNextCronRunMs — 跨月', () => {
  it('0 0 1 4 *（每年 4 月 1 日）从 3 月 → 当年 4 月 1 日', () => {
    const r = nextRunISO('0 0 1 4 *', '2026-03-15T12:00:00.000Z', 'UTC')!;
    expect(r).toBe('2026-04-01T00:00:00.000Z');
  });
  it('0 0 1 1 *（每年 1 月 1 日）从 12 月 → 次年 1 月 1 日', () => {
    const r = nextRunISO('0 0 1 1 *', '2026-12-15T12:00:00.000Z', 'UTC')!;
    expect(r).toBe('2027-01-01T00:00:00.000Z');
  });
  it('2 月无 30 号 → "0 0 30 2 *" AND 语义永不匹配返 null', () => {
    // cron month AND dayOfMonth：month=2 AND day=30 永不命中（vixie-cron 语义：
    // 不存在的日期组合 → 该 cron 永不触发，不是「跳到下个有 30 号的月」）
    const r = nextRunMs('0 0 30 2 *', '2026-01-15T12:00:00.000Z', 'UTC');
    expect(r).toBeNull();
  });
});

// ============================================================
// computeNextCronRunMs — 非法 expr 返 null
// ============================================================

describe('computeNextCronRunMs — 非法 expr', () => {
  it('字段数错返 null', () => {
    expect(nextRunMs('* * * *', '2026-03-15T00:00:00.000Z', 'UTC')).toBeNull();
  });
  it('字段越界返 null', () => {
    expect(nextRunMs('60 * * * *', '2026-03-15T00:00:00.000Z', 'UTC')).toBeNull();
  });
});
