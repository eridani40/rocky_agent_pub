/**
 * toml.ts 单测 —— formatToml/validateToml + 中文保留 + 错误 line/col
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B TOML 行；§0.2 库选型
 *   specs/prd/version_logs/v0.0.241.md §3.2 TOML
 */
import { describe, it, expect } from 'vitest';
import { formatToml, validateToml } from '../toml';

describe('formatToml — 成功', () => {
  it('基本 TOML 输出', () => {
    const text = 'name = "alice"\nage = 30';
    const out = formatToml(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toContain('name = "alice"');
      expect(out.output).toContain('age = 30');
    }
  });

  it('嵌套 table（[section]）', () => {
    const text = '[count]\nx = 1\n[parent.child]\ny = 2';
    const out = formatToml(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toContain('[count]');
      expect(out.output).toContain('[parent.child]');
    }
  });

  it('中文保留不转义', () => {
    const text = 'name = "中文"\nkey = "值"';
    const out = formatToml(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.output).toContain('"中文"');
      expect(out.output).toContain('"值"');
      expect(out.output).not.toContain('\\u');
    }
  });
});

describe('formatToml — 失败带位置', () => {
  it('缺值 → ok:false + line/col 提取', () => {
    const out = formatToml('name = ');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.line).toBeDefined();
      expect(out.col).toBeDefined();
      expect(typeof out.line).toBe('number');
    }
  });

  it('重复 key → ok:false', () => {
    const out = formatToml('a = 1\na = 2');
    expect(out.ok).toBe(false);
  });
});

describe('validateToml — 成功（output = 原文）', () => {
  it('合法 TOML → ok:true + output 不变', () => {
    const text = 'name = "alice"\nage = 30';
    const out = validateToml(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toBe(text);
  });
});

describe('validateToml — 失败带位置', () => {
  it('缺值 → ok:false', () => {
    const out = validateToml('name = ');
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.line).toBeDefined();
    }
  });
});
