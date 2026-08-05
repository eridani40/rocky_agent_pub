// @vitest-environment node
/**
 * formatMsgTime 单测（v0.0.165 T3）
 * 参考: specs/tech/version_logs/v0.0.165/change_plan.md §6（message-time 行）
 *       specs/ui/components/chat-page/component-msg-time.md
 *
 * 覆盖矩阵：
 *   - 同日：不同小时/分钟 → HH:mm
 *   - 跨日：昨天/上月/去年 → MM-dd HH:mm
 *   - 边界：跨 0 点（同一秒内的 date 已换）；月末跨月；年末跨年
 *   - 兜底：空串 / 非法 ISO / null-like → ''
 *   - now 注入：不依赖 Date.now，同输入同输出
 */
import { describe, it, expect } from 'vitest';
import { formatMsgTime, deriveRelativeTimeKind } from '../format-time';

describe('formatMsgTime', () => {
  // ────────────────────────────────────────────────────────────────
  // 同日 → HH:mm（不跨日历日）
  // ────────────────────────────────────────────────────────────────
  it('同日：早/午/晚三档均返 HH:mm', () => {
    const now = new Date(2026, 6, 17, 14, 30, 0); // 2026-07-17 14:30 local
    expect(formatMsgTime(new Date(2026, 6, 17, 9, 5).toISOString(), now)).toBe('09:05');
    expect(formatMsgTime(new Date(2026, 6, 17, 12, 0).toISOString(), now)).toBe('12:00');
    expect(formatMsgTime(new Date(2026, 6, 17, 23, 59).toISOString(), now)).toBe('23:59');
  });

  it('同日边界：00:00 与 23:59 均正确补零', () => {
    const now = new Date(2026, 6, 17, 12, 0, 0);
    expect(formatMsgTime(new Date(2026, 6, 17, 0, 0).toISOString(), now)).toBe('00:00');
    expect(formatMsgTime(new Date(2026, 6, 17, 5, 7).toISOString(), now)).toBe('05:07');
  });

  // ────────────────────────────────────────────────────────────────
  // 跨日 → MM-dd HH:mm
  // ────────────────────────────────────────────────────────────────
  it('跨日（昨天/前天）→ MM-dd HH:mm', () => {
    const now = new Date(2026, 6, 17, 14, 30, 0); // 2026-07-17
    // 昨天 (07-16)
    expect(formatMsgTime(new Date(2026, 6, 16, 22, 15).toISOString(), now)).toBe('07-16 22:15');
    // 前天 (07-15)
    expect(formatMsgTime(new Date(2026, 6, 15, 9, 5).toISOString(), now)).toBe('07-15 09:05');
  });

  it('跨月/跨年边界：11/28、01/01 均正确', () => {
    const now = new Date(2026, 6, 17, 12, 0, 0);
    // 跨月
    expect(formatMsgTime(new Date(2025, 10, 28, 8, 0).toISOString(), now)).toBe('11-28 08:00');
    // 跨年
    expect(formatMsgTime(new Date(2025, 0, 1, 0, 0).toISOString(), now)).toBe('01-01 00:00');
  });

  it('跨 0 点：now 是次日 00:05，消息在前日 23:55 → 跨日格式（避「同一秒 date 已换」失误）', () => {
    const now = new Date(2026, 6, 18, 0, 5, 0); // 07-18 00:05
    const iso = new Date(2026, 6, 17, 23, 55, 0).toISOString(); // 07-17 23:55
    expect(formatMsgTime(iso, now)).toBe('07-17 23:55');
  });

  // ────────────────────────────────────────────────────────────────
  // 兜底：空/非法 iso → ''
  // ────────────────────────────────────────────────────────────────
  it('无效 iso 兜底返空串（组件层决定不渲染）', () => {
    expect(formatMsgTime('')).toBe('');
    expect(formatMsgTime('not-a-date')).toBe('');
    // 明确传入非字符串（防御 caller 意外传 null/undefined）
    expect(formatMsgTime(null as unknown as string)).toBe('');
    expect(formatMsgTime(undefined as unknown as string)).toBe('');
  });

  // ────────────────────────────────────────────────────────────────
  // 纯函数：同输入同输出
  // ────────────────────────────────────────────────────────────────
  it('纯函数：同输入 + 同 now → 恒同输出', () => {
    const now = new Date(2026, 6, 17, 10, 0, 0);
    const iso = new Date(2026, 6, 17, 8, 30).toISOString();
    const a = formatMsgTime(iso, now);
    const b = formatMsgTime(iso, now);
    expect(a).toBe(b);
    expect(a).toBe('08:30');
  });

  it('now 缺省 fallback 到 new Date()（不 throw；不断言具体值）', () => {
    // 只断言不抛错、返值为 string；不锁定具体值（Date.now 相关，避免 flaky）
    const out = formatMsgTime(new Date().toISOString());
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('deriveRelativeTimeKind — v0.0.165 T5 SeatCard「最近活跃」派生', () => {
  const now = new Date(2026, 6, 17, 14, 30, 0);

  it('<1 分钟 → justNow', () => {
    expect(deriveRelativeTimeKind(new Date(2026, 6, 17, 14, 29, 40).toISOString(), now))
      .toEqual({ kind: 'justNow' });
  });
  it('30 分钟前 → minutesAgo(30)', () => {
    expect(deriveRelativeTimeKind(new Date(2026, 6, 17, 14, 0, 0).toISOString(), now))
      .toEqual({ kind: 'minutesAgo', n: 30 });
  });
  it('2 小时前 → hoursAgo(2)', () => {
    expect(deriveRelativeTimeKind(new Date(2026, 6, 17, 12, 30, 0).toISOString(), now))
      .toEqual({ kind: 'hoursAgo', n: 2 });
  });
  it('3 天前 → daysAgo(3)', () => {
    expect(deriveRelativeTimeKind(new Date(2026, 6, 14, 14, 30, 0).toISOString(), now))
      .toEqual({ kind: 'daysAgo', n: 3 });
  });
  it('无效 iso → null（调用方降级）', () => {
    expect(deriveRelativeTimeKind('', now)).toBeNull();
    expect(deriveRelativeTimeKind('bad-date', now)).toBeNull();
    expect(deriveRelativeTimeKind(null as unknown as string, now)).toBeNull();
  });
  it('未来时间（now 早于 iso）→ justNow（diff<60s 分支，边界安全）', () => {
    // 时钟略微超前不影响；防 negative diff 溢出到 daysAgo
    expect(deriveRelativeTimeKind(new Date(2026, 6, 17, 14, 30, 5).toISOString(), now))
      .toEqual({ kind: 'justNow' });
  });
});
