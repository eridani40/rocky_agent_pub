/**
 * dailyTimeToCron UT —— "HH:mm" → 5 字段 cron expr 固定公式转换。
 * 参考: specs/tech/scheduling/[P1]consolidation_job.md §5
 */
import { describe, it, expect } from 'vitest';
import { dailyTimeToCron } from '../consolidation-cron';

describe('dailyTimeToCron', () => {
  it('04:00 → "0 4 * * *"', () => {
    expect(dailyTimeToCron('04:00')).toBe('0 4 * * *');
  });

  it('18:30 → "30 18 * * *"', () => {
    expect(dailyTimeToCron('18:30')).toBe('30 18 * * *');
  });

  it('00:00 → "0 0 * * *"', () => {
    expect(dailyTimeToCron('00:00')).toBe('0 0 * * *');
  });

  it('23:59 → "59 23 * * *"', () => {
    expect(dailyTimeToCron('23:59')).toBe('59 23 * * *');
  });
});
