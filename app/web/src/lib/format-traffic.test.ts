// @vitest-environment node
/**
 * formatTraffic 单测（v0.0.96.ui_fix Feature 1）
 * 参考: specs/prd/version_logs/v0.0.96.ui_fix.md §2.1
 *       specs/tech/version_logs/v0.0.96.ui_fix/change_plan.md Feature 1（UT 行：K/M/B/T 4 临界 + 3 边界）
 *
 * 覆盖矩阵：
 *   - 量级：123 / 1234 / 1234567 / 1234567890 / 1e12 五档典型
 *   - 4 临界切换：999.9 (< 1000) / 1000 (=K) / 999999.9 (< 1e6) / 1e6 (=M) / 999999999.9 (< 1e9) / 1e9 (=B) / 999999999999.9 (< 1e12) / 1e12 (=T)
 *   - 3 边界：0 / -1 / NaN
 *   - Infinity 兜底（与 NaN 同走 Number.isFinite 兜底分支）
 *   - 纯函数：同输入同输出（无副作用断言）
 */
import { describe, it, expect } from 'vitest';
import { formatTraffic } from './format-traffic';

describe('formatTraffic', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 量级典型值（5 档）
  // ──────────────────────────────────────────────────────────────────────────
  it('n < 1000 返原值字符串', () => {
    expect(formatTraffic(0)).toBe('0');
    expect(formatTraffic(1)).toBe('1');
    expect(formatTraffic(123)).toBe('123');
    expect(formatTraffic(999)).toBe('999');
  });

  it('1000 ≤ n < 1e6 返 K 格式 1 位小数', () => {
    expect(formatTraffic(1000)).toBe('1.0K');
    expect(formatTraffic(1234)).toBe('1.2K');
    expect(formatTraffic(12345)).toBe('12.3K');
    expect(formatTraffic(999999)).toBe('1000.0K'); // 接近上限：999999/1000=999.999→toFixed(1)=1000.0
  });

  it('1e6 ≤ n < 1e9 返 M 格式', () => {
    expect(formatTraffic(1e6)).toBe('1.0M');
    expect(formatTraffic(1234567)).toBe('1.2M');
    expect(formatTraffic(999999999)).toBe('1000.0M'); // 接近上限：999999999/1e6=999.999999→1000.0
  });

  it('1e9 ≤ n < 1e12 返 B 格式', () => {
    expect(formatTraffic(1e9)).toBe('1.0B');
    expect(formatTraffic(1234567890)).toBe('1.2B');
  });

  it('n ≥ 1e12 返 T 格式', () => {
    expect(formatTraffic(1e12)).toBe('1.0T');
    expect(formatTraffic(1.5e12)).toBe('1.5T');
    expect(formatTraffic(1.234e15)).toBe('1234.0T');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 4 临界切换点（防 off-by-one）
  // ──────────────────────────────────────────────────────────────────────────
  it('K 临界：999.9 仍是原值，1000 进入 K', () => {
    expect(formatTraffic(999.9)).toBe('999.9');
    expect(formatTraffic(999.95)).toBe('999.95'); // < 1000 走原值分支
    expect(formatTraffic(1000)).toBe('1.0K');
  });

  it('M 临界：999999.9 仍是 K，1e6 进入 M', () => {
    expect(formatTraffic(999999.9)).toBe('1000.0K'); // 999.9999K → toFixed(1)=1000.0K
    expect(formatTraffic(1e6)).toBe('1.0M');
  });

  it('B 临界：999999999.9 仍是 M，1e9 进入 B', () => {
    expect(formatTraffic(999999999.9)).toBe('1000.0M'); // 999.9999999M → 1000.0M
    expect(formatTraffic(1e9)).toBe('1.0B');
  });

  it('T 临界：999999999999.9 仍是 B，1e12 进入 T', () => {
    expect(formatTraffic(999999999999.9)).toBe('1000.0B');
    expect(formatTraffic(1e12)).toBe('1.0T');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // toFixed(1) 自带 round 验证
  // ──────────────────────────────────────────────────────────────────────────
  it('toFixed(1) 自带 round：1234 → 1.2K（不是 1.234K）', () => {
    // 1234 / 1000 = 1.234 → toFixed(1) = "1.2"
    expect(formatTraffic(1234)).toBe('1.2K');
    // 1250 / 1000 = 1.25 → toFixed(1) = "1.3"（round half up / 银行家舍入按 JS 实现）
    expect(formatTraffic(1250)).toBe('1.3K');
    // 1249 / 1000 = 1.249 → toFixed(1) = "1.2"
    expect(formatTraffic(1249)).toBe('1.2K');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3 边界（acceptanceCriteria 硬约束）
  // ──────────────────────────────────────────────────────────────────────────
  it('0 返 "0"（防 "0.0K" 丑态）', () => {
    expect(formatTraffic(0)).toBe('0');
  });

  it('-1 返 "-1"（防 "-0.0K" / "-1.5K" 丑态）', () => {
    expect(formatTraffic(-1)).toBe('-1');
    expect(formatTraffic(-1500)).toBe('-1500'); // 负数原样不分级
  });

  it('NaN 返 "NaN"（防 "NaNK" 丑态）', () => {
    expect(formatTraffic(NaN)).toBe('NaN');
  });

  it('Infinity 返原值字符串（Number.isFinite 兜底）', () => {
    expect(formatTraffic(Infinity)).toBe('Infinity');
    expect(formatTraffic(-Infinity)).toBe('-Infinity');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 纯函数无副作用
  // ──────────────────────────────────────────────────────────────────────────
  it('纯函数：同输入同输出（确定性）', () => {
    expect(formatTraffic(1234)).toBe(formatTraffic(1234));
    expect(formatTraffic(1234567)).toBe(formatTraffic(1234567));
  });
});
