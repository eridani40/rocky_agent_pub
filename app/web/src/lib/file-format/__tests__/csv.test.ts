/**
 * csv.ts 单测 —— parseCsvRows RFC 4180 + formatCsv 列对齐 + validateCsv 行列校验
 *
 * 参考:
 *   states/v0.0.241/verify/test-plan.md（UC-241-CSV-FMT 列对齐 + 行列校验）
 *   specs/tech/version_logs/v0.0.241/change_plan.md 模块 B CSV 行
 */
import { describe, it, expect } from 'vitest';
import { parseCsvRows, formatRows, findRowMismatch, formatCsv, validateCsv } from '../csv';

describe('parseCsvRows — RFC 4180 解析', () => {
  it('简单 CSV', () => {
    expect(parseCsvRows('a,b,c\n1,2,3', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('引号包裹的字段', () => {
    expect(parseCsvRows('"a","b"', ',')).toEqual([['a', 'b']]);
  });

  it('字段内含分隔符（引号包裹）', () => {
    expect(parseCsvRows('"a,b",c', ',')).toEqual([['a,b', 'c']]);
  });

  it('转义双引号 ""', () => {
    expect(parseCsvRows('"he said ""hi"""', ',')).toEqual([['he said "hi"']]);
  });

  it('字段内换行（引号包裹的多行字段）', () => {
    const text = '"line1\nline2",b';
    expect(parseCsvRows(text, ',')).toEqual([['line1\nline2', 'b']]);
  });

  it('\\r\\n 换行统一为 \\n', () => {
    expect(parseCsvRows('a,b\r\n1,2', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('尾随换行不产生空行', () => {
    expect(parseCsvRows('a,b\n', ',')).toEqual([['a', 'b']]);
  });

  it('空文本 → []', () => {
    expect(parseCsvRows('', ',')).toEqual([]);
  });
});

describe('formatRows — 列对齐', () => {
  it('不等长字段对齐（padEnd 到列宽，末列 trimEnd）', () => {
    const rows = [
      ['name', 'age'],
      ['alice', '30'],
      ['bob', '8'],
    ];
    const out = formatRows(rows, ',');
    const lines = out.split('\n');
    // 列 0 宽度 = max(4,5,3) = 5：每行 , 出现在固定位置（col 5）
    expect(lines[0]).toBe('name ,age');
    expect(lines[1]).toBe('alice,30');
    expect(lines[2]).toBe('bob  ,8');
    // 末列 trimEnd：无尾部空白
    expect(lines[0]).not.toMatch(/\s+$/);
    expect(lines[1]).not.toMatch(/\s+$/);
    expect(lines[2]).not.toMatch(/\s+$/);
  });

  it('不改字段数', () => {
    const rows = [
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ];
    const out = formatRows(rows, ',');
    for (const line of out.split('\n')) {
      // 不含字段内分隔符，所以按 , 切应得 3 字段
      expect(line.split(',')).toHaveLength(3);
    }
  });

  it('含分隔符的字段重新加引号', () => {
    const rows = [['a,b', 'c']];
    const out = formatRows(rows, ',');
    expect(out).toContain('"a,b"');
  });
});

describe('findRowMismatch — 行字段数校验', () => {
  it('一致 → null', () => {
    expect(findRowMismatch([['a', 'b'], ['1', '2']])).toBeNull();
  });

  it('第 2 行多一个字段 → line:2', () => {
    const r = findRowMismatch([['a', 'b'], ['1', '2', '3']]);
    expect(r).not.toBeNull();
    expect(r!.line).toBe(2);
    expect(r!.msg).toContain('第 2 行');
    expect(r!.msg).toContain('与首行 2 不符');
  });
});

describe('formatCsv — 集成', () => {
  it('CSV 格式化 → 列对齐', () => {
    const text = 'name,age\nalice,30\nbob,8';
    const out = formatCsv(text);
    expect(out.ok).toBe(true);
    if (out.ok) {
      const lines = out.output.split('\n');
      expect(lines[0]).toBe('name ,age');
      expect(lines[1]).toBe('alice,30');
      expect(lines[2]).toBe('bob  ,8');
    }
  });

  it('UC-241-CSV-FMT：多打逗号 → format 仍能对齐（quote 含 , 的字段）', () => {
    // 第二行多了一个字段值（导致字段数不一致），但 formatCsv 仍能对齐（不报错）
    const text = 'a,b\n1,2,3';
    const out = formatCsv(text);
    expect(out.ok).toBe(true);
  });
});

describe('validateCsv — 行列校验', () => {
  it('一致 → ok:true（output = 原文）', () => {
    const text = 'a,b,c\n1,2,3\nx,y,z';
    const out = validateCsv(text);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.output).toBe(text);
  });

  it('UC-241-CSV-FMT：第 2 行字段数不符 → ok:false + line:2', () => {
    const text = 'a,b,c\n1,2';
    const out = validateCsv(text);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.line).toBe(2);
      expect(out.error).toContain('第 2 行字段数为 2');
      expect(out.error).toContain('与首行 3 不符');
    }
  });

  it('第 3 行多逗号 → line:3', () => {
    const text = 'a,b\n1,2\nx,y,z';
    const out = validateCsv(text);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.line).toBe(3);
  });
});
