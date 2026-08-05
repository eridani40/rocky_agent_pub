// @vitest-environment jsdom
/**
 * cron-humanize 单测（v0.0.58 T5）
 * 参考: specs/ui/components/chat-page/component-cron-panel.md §1/§6
 *       specs/prd/version_logs/v0.0.58/change_log.md §5.1（展示态翻译）
 *
 * 覆盖：
 *   - 4 预设频率 ↔ cron expr 程序生成（PRD §5.2 表）
 *   - cronstrue zh_CN 翻译典型 expr
 *   - 库翻译不出 / 抛错 → fallback raw expr
 *   - 空字符串 / 非字符串 → 不抛错
 */
import { describe, it, expect } from 'vitest';
import { buildCronExpr, cronHumanize, WEEKDAY_LABELS } from '../cron-humanize';

describe('buildCronExpr — 4 预设 → cron expr', () => {
  it('minutes 预设 → 星号-斜杠-N + 4 个星号', () => {
    expect(buildCronExpr('minutes', { intervalMin: 30 })).toBe('*/30 * * * *');
    expect(buildCronExpr('minutes', { intervalMin: 5 })).toBe('*/5 * * * *');
    expect(buildCronExpr('minutes', { intervalMin: 1 })).toBe('*/1 * * * *');
  });

  it('minutes 预设 N<1 兜底为 1（防 0 或负数）', () => {
    expect(buildCronExpr('minutes', { intervalMin: 0 })).toBe('*/1 * * * *');
    expect(buildCronExpr('minutes', { intervalMin: -3 })).toBe('*/1 * * * *');
  });

  it('hours 预设 → 0 + 星号-斜杠-N + 3 个星号', () => {
    expect(buildCronExpr('hours', { intervalHour: 4 })).toBe('0 */4 * * *');
    expect(buildCronExpr('hours', { intervalHour: 1 })).toBe('0 */1 * * *');
    expect(buildCronExpr('hours', { intervalHour: 12 })).toBe('0 */12 * * *');
  });

  it('daily 预设 → M H * * *', () => {
    expect(buildCronExpr('daily', { timeHHmm: '09:00' })).toBe('0 9 * * *');
    expect(buildCronExpr('daily', { timeHHmm: '18:30' })).toBe('30 18 * * *');
    expect(buildCronExpr('daily', { timeHHmm: '00:00' })).toBe('0 0 * * *');
    expect(buildCronExpr('daily', { timeHHmm: '23:59' })).toBe('59 23 * * *');
  });

  it('weekly 预设 → M H * * D（1-7；周日=7）', () => {
    expect(buildCronExpr('weekly', { timeHHmm: '09:00', weekday: 1 })).toBe('0 9 * * 1');
    expect(buildCronExpr('weekly', { timeHHmm: '18:00', weekday: 5 })).toBe('0 18 * * 5');
    // weekday=0（UI「周日」）→ cron 7
    expect(buildCronExpr('weekly', { timeHHmm: '09:00', weekday: 0 })).toBe('0 9 * * 7');
  });

  it('daily/weekly 默认 09:00（timeHHmm 缺省）', () => {
    expect(buildCronExpr('daily', {})).toBe('0 9 * * *');
    expect(buildCronExpr('weekly', {})).toBe('0 9 * * 1');
  });
});

describe('cronHumanize — cronstrue zh_CN 翻译', () => {
  it('每 N 分钟 翻译含「分钟」', () => {
    const out = cronHumanize('*/30 * * * *');
    expect(out).toContain('30');
    expect(out).toContain('分钟');
  });

  it('每 N 小时 翻译含「小时」', () => {
    const out = cronHumanize('0 */4 * * *');
    expect(out).toContain('4');
    expect(out).toContain('小时');
  });

  it('每天 HH:mm 翻译含时间', () => {
    const out = cronHumanize('0 9 * * *');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe('0 9 * * *'); // 翻译成功，不 fallback
  });

  it('工作日 09:00 (1-5) 翻译成功', () => {
    const out = cronHumanize('0 9 * * 1-5');
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toBe('0 9 * * 1-5');
  });

  it('非法 expr 库抛错 → fallback raw expr', () => {
    const raw = 'not a cron';
    expect(cronHumanize(raw)).toBe(raw);
  });

  it('空字符串 → 返空（不抛错）', () => {
    expect(cronHumanize('')).toBe('');
  });

  it('null/undefined 兜底 → 返空字符串（不抛错）', () => {
    expect(cronHumanize(null as unknown as string)).toBe('');
    expect(cronHumanize(undefined as unknown as string)).toBe('');
  });
});

describe('WEEKDAY_LABELS', () => {
  it('1-6 = 周一-周六；0/7 = 周日', () => {
    expect(WEEKDAY_LABELS[1]).toBe('周一');
    expect(WEEKDAY_LABELS[6]).toBe('周六');
    expect(WEEKDAY_LABELS[0]).toBe('周日');
    expect(WEEKDAY_LABELS[7]).toBe('周日');
  });
});
