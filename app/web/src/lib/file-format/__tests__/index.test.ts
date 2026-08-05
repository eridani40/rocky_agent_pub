/**
 * index.ts 单测 —— dispatcher 路由 + md/plain 兜底
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B index.ts 行
 *   specs/prd/version_logs/v0.0.241.md §3.1（FormatResult + 调用方按 category 守门）
 */
import { describe, it, expect } from 'vitest';
import { formatText, validateText } from '../index';

describe('formatText — 按 format 路由', () => {
  it('json → formatJson', () => {
    const out = formatText('json', '{"a":1}');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toBe('{\n  "a": 1\n}');
  });

  it('yaml → formatYaml', () => {
    const out = formatText('yaml', 'a: 1');
    expect(out.ok).toBe(true);
  });

  it('csv → formatCsv', () => {
    const out = formatText('csv', 'a,b\n1,2');
    expect(out.ok).toBe(true);
  });

  it('xml → formatXml', () => {
    const out = formatText('xml', '<a/>');
    expect(out.ok).toBe(true);
  });
});

describe('formatText — md/plain 兜底 unsupported', () => {
  const unsupported: Array<'md' | 'txt' | 'ini' | 'env' | 'log'> = [
    'md',
    'txt',
    'ini',
    'env',
    'log',
  ];
  for (const fmt of unsupported) {
    it(`formatText('${fmt}', ...) → ok:false + 该格式不支持格式化`, () => {
      const out = formatText(fmt, 'whatever');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain('不支持格式化');
    });
  }
});

describe('validateText — 按 format 路由', () => {
  it('json 合法 → ok', () => {
    const out = validateText('json', '{"a":1}');
    expect(out.ok).toBe(true);
  });

  it('jsonl 第 2 行坏 → line:2', () => {
    const out = validateText('jsonl', '{"a":1}\n{bad}');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.line).toBe(2);
  });

  it('csv 字段数不符 → line:N', () => {
    const out = validateText('csv', 'a,b\n1');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.line).toBe(2);
  });
});

describe('validateText — md/plain 兜底 unsupported', () => {
  const unsupported: Array<'md' | 'txt' | 'ini' | 'env' | 'log'> = [
    'md',
    'txt',
    'ini',
    'env',
    'log',
  ];
  for (const fmt of unsupported) {
    it(`validateText('${fmt}', ...) → ok:false + 该格式不支持校验`, () => {
      const out = validateText(fmt, 'whatever');
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toContain('不支持校验');
    });
  }
});
