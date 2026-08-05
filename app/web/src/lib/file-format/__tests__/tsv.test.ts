/**
 * tsv.ts 单测 —— 复用 csv helper（分隔符 \t）+ 列对齐 + 行列校验
 *
 * 参考:
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B TSV 行
 *   specs/prd/version_logs/v0.0.241.md §3.2 TSV
 */
import { describe, it, expect } from 'vitest';
import { formatTsv, validateTsv } from '../tsv';
import { parseCsvRows } from '../csv';

describe('parseCsvRows — TSV 分隔符（\\t）', () => {
  it('按 tab 切字段', () => {
    expect(parseCsvRows('a\tb\tc\n1\t2\t3', '\t')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('TSV 字段内含 tab 引号包裹', () => {
    expect(parseCsvRows('"a\tb"\tc', '\t')).toEqual([['a\tb', 'c']]);
  });
});

describe('formatTsv — 列对齐', () => {
  it('不等长字段 tab 对齐（padEnd 到列宽）', () => {
    const text = 'name\tage\nalice\t30\nbob\t8';
    const out = formatTsv(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      const lines = out.output.split('\n');
      // 列 0 宽度 = max(4,5,3) = 5，padEnd 后 tab 在固定位置
      expect(lines[0]).toBe('name \tage');
      expect(lines[1]).toBe('alice\t30');
      expect(lines[2]).toBe('bob  \t8');
    }
  });

  it('不改字段数', () => {
    const text = 'a\tb\n1\t2';
    const out = formatTsv(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      for (const line of out.output.split('\n')) {
        expect(line.split('\t')).toHaveLength(2);
      }
    }
  });
});

describe('validateTsv — 行列校验', () => {
  it('一致 → ok:true', () => {
    const text = 'a\tb\tc\n1\t2\t3';
    const out = validateTsv(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toBe(text);
  });

  it('第 2 行字段数不符 → ok:false + line:2', () => {
    const text = 'a\tb\tc\n1\t2';
    const out = validateTsv(text);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.line).toBe(2);
      expect(out.error).toContain('第 2 行字段数为 2');
      expect(out.error).toContain('与首行 3 不符');
    }
  });
});
