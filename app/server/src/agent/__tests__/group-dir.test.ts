/**
 * group-dir 单测 —— group ws 根唯一解析点
 * 参考: specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md 模块 A2
 *
 * 覆盖：squadWsDir 路径拼接 + assertPerIdName 防逃逸 +
 *       resolveGroupWsDir（squadId 命中 / 空串软解析）。
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { assertPerIdName, resolveGroupWsDir, squadWsDir } from '../group-dir';

describe('squadWsDir', () => {
  it('squadWsDir = <dataDir>/squads/<squadId>/', () => {
    expect(squadWsDir('/data', 'sq1')).toBe(join('/data', 'squads', 'sq1'));
  });
});

describe('assertPerIdName 防逃逸', () => {
  it.each(['', '  ', 'a/b', 'a\\b', '.', '..'])('非法 id %j → 抛错', (v) => {
    expect(() => assertPerIdName(v, 'squadId')).toThrow();
  });
  it('错误消息含 kind 锚点', () => {
    expect(() => assertPerIdName('', 'squadId')).toThrow(/squadId is required/);
  });
});

describe('resolveGroupWsDir', () => {
  it('squadId 命中 → squad ws', () => {
    expect(resolveGroupWsDir('/data', { squadId: 'sq1' })).toBe(join('/data', 'squads', 'sq1'));
  });
  it('无 / 空串 → undefined（软解析不抛错）', () => {
    expect(resolveGroupWsDir('/data', {})).toBeUndefined();
    expect(resolveGroupWsDir('/data', { squadId: '  ' })).toBeUndefined();
  });
});
