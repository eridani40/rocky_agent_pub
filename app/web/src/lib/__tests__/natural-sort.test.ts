/**
 * natural-sort 单测 —— 自然序比较器边界全覆盖
 * 参考: states/v0.0.239/verify/test-plan.md §2.1（UT case 清单）
 *       specs/tech/version_logs/v0.0.239/change_plan.md 变更清单行 1-2
 *
 * 断言对齐 VSCode 实测行为：自定义分段（文字段字符串序大小写不敏感 / 数字段数值序
 * / 同值不同格式按原 digit 字符串兜底）+ 文件夹（type='dir'）置顶。
 */
import { describe, it, expect } from 'vitest';
import { compareNaturalNames, compareWorkspaceNodes } from '../natural-sort';
import type { WsTreeNode } from '../../components/chat-page/workspace-types';

const file = (name: string): WsTreeNode => ({ name, path: name, type: 'file', hasChildren: false });
const dir = (name: string): WsTreeNode => ({ name, path: name, type: 'dir', hasChildren: true });

/** helper：把名字数组 sort 后断言结果顺序 */
const sortedNames = (names: string[]) => [...names].sort(compareNaturalNames);

describe('compareNaturalNames — 数字段数值序', () => {
  it('90.txt < 100.txt（核心痛点：字典序会反）', () => {
    expect(compareNaturalNames('90.txt', '100.txt')).toBeLessThan(0);
    expect(compareNaturalNames('100.txt', '90.txt')).toBeGreaterThan(0);
  });

  it('1.txt < 2.txt < 10.txt < 90.txt < 100.txt（多数字升序）', () => {
    expect(sortedNames(['100.txt', '90.txt', '10.txt', '2.txt', '1.txt'])).toEqual([
      '1.txt',
      '2.txt',
      '10.txt',
      '90.txt',
      '100.txt',
    ]);
  });

  it('file1.md < file2.md < file10.md（前缀 + 数字段）', () => {
    expect(sortedNames(['file10.md', 'file2.md', 'file1.md'])).toEqual([
      'file1.md',
      'file2.md',
      'file10.md',
    ]);
  });

  it('a9 < a10（文字段 + 数字段）', () => {
    expect(compareNaturalNames('a9', 'a10')).toBeLessThan(0);
    expect(sortedNames(['a10', 'a9', 'a1'])).toEqual(['a1', 'a9', 'a10']);
  });

  it('纯数字 2 < 10（数值序，非字典序）', () => {
    expect(compareNaturalNames('2', '10')).toBeLessThan(0);
    expect(sortedNames(['10', '2', '1'])).toEqual(['1', '2', '10']);
  });
});

describe('compareNaturalNames — 同值不同格式 digit 兜底（D 决策核心边界）', () => {
  it('09.txt < 9.txt（值同 9，按原 digit 字符串序：\'0\' < \'9\'）', () => {
    expect(compareNaturalNames('09.txt', '9.txt')).toBeLessThan(0);
    expect(compareNaturalNames('9.txt', '09.txt')).toBeGreaterThan(0);
  });

  it('09 < 9（纯数字同值不同格式）', () => {
    expect(compareNaturalNames('09', '9')).toBeLessThan(0);
    expect(sortedNames(['9', '09'])).toEqual(['09', '9']);
  });

  it('file09 < file9（前缀相同 + 同值 digit 兜底）', () => {
    expect(compareNaturalNames('file09', 'file9')).toBeLessThan(0);
  });
});

describe('compareNaturalNames — 文字段字符串序', () => {
  it('纯文字 abc < abd', () => {
    expect(compareNaturalNames('abc', 'abd')).toBeLessThan(0);
    expect(sortedNames(['abd', 'abc'])).toEqual(['abc', 'abd']);
  });

  it('A.txt 与 a.txt 同序级（大小写不敏感）', () => {
    expect(compareNaturalNames('A.txt', 'a.txt')).toBe(0);
    expect(compareNaturalNames('a.txt', 'A.txt')).toBe(0);
  });

  it('大小写不敏感：B < a 不成立（统一 lowercase 比较）', () => {
    // toLowerCase 后 'b' > 'a'，故 'B' > 'a'
    expect(compareNaturalNames('B', 'a')).toBeGreaterThan(0);
    expect(compareNaturalNames('a', 'B')).toBeLessThan(0);
  });
});

describe('compareNaturalNames — 多段交替', () => {
  it('a1b2 < a1b10（多段交替：前两段相等，第三段数值序）', () => {
    expect(compareNaturalNames('a1b2', 'a1b10')).toBeLessThan(0);
    expect(sortedNames(['a1b10', 'a1b2'])).toEqual(['a1b2', 'a1b10']);
  });

  it('a1b2 < a2b1（第二段数值序优先于第三段）', () => {
    expect(compareNaturalNames('a1b2', 'a2b1')).toBeLessThan(0);
  });
});

describe('compareNaturalNames — 长度/前缀', () => {
  it('公共前缀全等：短者在前（abc < abcd）', () => {
    expect(compareNaturalNames('abc', 'abcd')).toBeLessThan(0);
    expect(compareNaturalNames('abcd', 'abc')).toBeGreaterThan(0);
  });

  it('完全相等返 0', () => {
    expect(compareNaturalNames('file10.md', 'file10.md')).toBe(0);
  });

  it('空串 < 非空串', () => {
    expect(compareNaturalNames('', 'a')).toBeLessThan(0);
    expect(compareNaturalNames('a', '')).toBeGreaterThan(0);
    expect(compareNaturalNames('', '')).toBe(0);
  });
});

describe('compareWorkspaceNodes — 文件夹置顶（D7 决策）', () => {
  it('type=dir 排在 type=file 前', () => {
    expect(compareWorkspaceNodes(dir('z'), file('a'))).toBeLessThan(0);
    expect(compareWorkspaceNodes(file('a'), dir('z'))).toBeGreaterThan(0);
  });

  it('同为 dir：按 name 自然序', () => {
    const nodes = [dir('a10'), dir('a2'), dir('a1')];
    expect([...nodes].sort(compareWorkspaceNodes).map((n) => n.name)).toEqual([
      'a1',
      'a2',
      'a10',
    ]);
  });

  it('同为 file：按 name 自然序', () => {
    const nodes = [file('100.txt'), file('90.txt'), file('9.txt')];
    expect([...nodes].sort(compareWorkspaceNodes).map((n) => n.name)).toEqual([
      '9.txt',
      '90.txt',
      '100.txt',
    ]);
  });

  it('综合：dir 组内置顶 + 组内自然序 + file 组内自然序', () => {
    // [docs/(dir), 90.txt(file), 100.txt(file), a9/(dir), a10/(dir)]
    // 期望：[a9/, a10/, docs/, 90.txt, 100.txt]（dir 整体置顶 + dir 组内自然序 + file 组内自然序）
    const nodes = [dir('docs'), file('90.txt'), file('100.txt'), dir('a9'), dir('a10')];
    expect([...nodes].sort(compareWorkspaceNodes).map((n) => n.name)).toEqual([
      'a9',
      'a10',
      'docs',
      '90.txt',
      '100.txt',
    ]);
  });

  it('文件夹置顶优先于文件名字典序（即使 file 名 < dir 名）', () => {
    // 'a.txt' 字典序小于 'zzz/'，但 dir 必须置顶
    expect(compareWorkspaceNodes(dir('zzz'), file('a.txt'))).toBeLessThan(0);
  });
});
