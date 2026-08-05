/**
 * version-range.satisfiesRange 单测。
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §A（UT 覆盖：数字段比较独立测）
 *
 * 覆盖点：
 *   - `<0.0.151` 满足 0.0.150、不满足 0.0.151 / 0.0.152
 *   - major/minor 段差异（数字段比较不混 string）
 *   - 非 `<` 前缀 throw；非法版本号段 throw
 */
import { describe, it, expect } from 'vitest';
import { satisfiesRange } from '../version-range';

describe('version-range.satisfiesRange', () => {
  it('<0.0.151 满足 0.0.150', () => {
    expect(satisfiesRange('0.0.150', '<0.0.151')).toBe(true);
  });

  it('<0.0.151 不满足 0.0.151（严格小于）', () => {
    expect(satisfiesRange('0.0.151', '<0.0.151')).toBe(false);
  });

  it('<0.0.151 不满足 0.0.152（远大于）', () => {
    expect(satisfiesRange('0.0.152', '<0.0.151')).toBe(false);
  });

  it('<0.0.151 不满足 0.0.0（边界：版本低于 range 也满足 "<"）', () => {
    // 0.0.0 < 0.0.151 → true（首次启动语义）
    expect(satisfiesRange('0.0.0', '<0.0.151')).toBe(true);
  });

  it('major 段差异：满足 <1.0.0 的 0.99.99', () => {
    expect(satisfiesRange('0.99.99', '<1.0.0')).toBe(true);
  });

  it('major 段差异：不满足 <1.0.0 的 1.0.0', () => {
    expect(satisfiesRange('1.0.0', '<1.0.0')).toBe(false);
  });

  it('minor 段差异：满足 <0.2.0 的 0.1.99', () => {
    expect(satisfiesRange('0.1.99', '<0.2.0')).toBe(true);
  });

  it('数字段比较不混 string：10.0.0 < 9.0.0 → false（数字比较 10 > 9）', () => {
    // 字典序 '10' < '9' 会判 true；正确数字比较 10 > 9 → false
    expect(satisfiesRange('10.0.0', '<9.0.0')).toBe(false);
  });

  it('数字段比较不混 string：9.0.0 < 10.0.0 → true', () => {
    expect(satisfiesRange('9.0.0', '<10.0.0')).toBe(true);
  });

  it('patch 段差异：0.0.149 < 0.0.150 → true', () => {
    expect(satisfiesRange('0.0.149', '<0.0.150')).toBe(true);
  });

  it('range 含空格：< 0.0.151 仍可解析', () => {
    expect(satisfiesRange('0.0.150', '< 0.0.151')).toBe(true);
  });

  it('非 < 前缀 throw（> 形式不支持）', () => {
    expect(() => satisfiesRange('0.0.150', '>0.0.100')).toThrow(/仅支持/);
  });

  it('非 < 前缀 throw（= 形式不支持）', () => {
    expect(() => satisfiesRange('0.0.150', '=0.0.150')).toThrow(/仅支持/);
  });

  it('range 无前缀 throw（裸版本号）', () => {
    expect(() => satisfiesRange('0.0.150', '0.0.151')).toThrow(/仅支持/);
  });

  it('非法版本号段（非数字）throw', () => {
    expect(() => satisfiesRange('0.0.x', '<0.0.151')).toThrow(/非负整数/);
  });

  it('非法版本号段（两段）throw', () => {
    expect(() => satisfiesRange('0.0', '<0.0.151')).toThrow(/三段/);
  });

  it('range bound 非法 throw', () => {
    expect(() => satisfiesRange('0.0.150', '<0.0')).toThrow(/三段/);
  });

  it('负数段 throw', () => {
    expect(() => satisfiesRange('0.0.-1', '<0.0.151')).toThrow(/非负整数/);
  });
});
