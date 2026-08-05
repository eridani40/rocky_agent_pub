/**
 * filterSkillsBySource 单测：4 分类映射 + 边界（空数组 / productionMethod undefined 不归 rocky）
 * 参考: specs/ui/components/skill-page/component-skill-source-filter.md 来源映射表
 *       PRD v0.0.198 §2.2 来源映射表
 *
 * 纯函数无副作用：不修改原数组、不调 API。
 */
import { describe, it, expect } from 'vitest';
import { filterSkillsBySource } from '../component-skill-source-filter';
import type { SkillEntry } from '../../../lib/api-client';

/** 构造测试 skill 条目（可选字段按需） */
function mk(partial: Partial<SkillEntry>): SkillEntry {
  return {
    name: partial.name ?? 's',
    description: '',
    scope: partial.scope ?? 'app',
    skillDir: '/x',
    enabled: partial.enabled ?? true,
    ...partial,
  };
}

describe('filterSkillsBySource', () => {
  it("'all' → passthrough 原数组（同一引用，不拷贝）", () => {
    const skills = [
      mk({ name: 'a', scope: 'builtin' }),
      mk({ name: 'b', marketRef: 'github/foo' }),
      mk({ name: 'c', productionMethod: 'consolidation' }),
    ];
    const out = filterSkillsBySource(skills, 'all');
    expect(out).toBe(skills); // 同一引用，passthrough
    expect(out.length).toBe(3);
  });

  it("'builtin' → 仅 scope==='builtin'", () => {
    const skills = [
      mk({ name: 'b1', scope: 'builtin' }),
      mk({ name: 'b2', scope: 'builtin' }),
      mk({ name: 'app1', scope: 'app' }),
      mk({ name: 'ws1', scope: 'workspace' }),
    ];
    const out = filterSkillsBySource(skills, 'builtin');
    expect(out.map((s) => s.name)).toEqual(['b1', 'b2']);
  });

  it("'market' → Boolean(marketRef)（空字符串/undefined 都过滤掉）", () => {
    const skills = [
      mk({ name: 'm1', marketRef: 'github/foo' }),
      mk({ name: 'm2', marketRef: 'gitlab/bar' }),
      mk({ name: 'empty', marketRef: '' }),
      mk({ name: 'undef', /* marketRef 缺省 */ }),
    ];
    const out = filterSkillsBySource(skills, 'market');
    expect(out.map((s) => s.name)).toEqual(['m1', 'm2']);
  });

  it("'rocky' → productionMethod==='consolidation'（精确匹配，undefined/handwritten/download 都不归）", () => {
    const skills = [
      mk({ name: 'r1', productionMethod: 'consolidation' }),
      mk({ name: 'r2', productionMethod: 'consolidation' }),
      mk({ name: 'hand', productionMethod: 'handwritten' }),
      mk({ name: 'dl', productionMethod: 'download' }),
      mk({ name: 'undef', /* productionMethod 缺省 */ }),
    ];
    const out = filterSkillsBySource(skills, 'rocky');
    expect(out.map((s) => s.name)).toEqual(['r1', 'r2']);
  });

  it('边界：空数组无论 filter 何值都返回空', () => {
    expect(filterSkillsBySource([], 'all')).toEqual([]);
    expect(filterSkillsBySource([], 'builtin')).toEqual([]);
    expect(filterSkillsBySource([], 'market')).toEqual([]);
    expect(filterSkillsBySource([], 'rocky')).toEqual([]);
  });

  it('边界：productionMethod undefined 不归 rocky（与 handwritten 同等待遇）', () => {
    const skills = [
      mk({ name: 'undef-pm' /* productionMethod 缺省 */ }),
      mk({ name: 'rocky', productionMethod: 'consolidation' }),
    ];
    expect(filterSkillsBySource(skills, 'rocky').map((s) => s.name)).toEqual(['rocky']);
  });

  it('纯函数：不改原数组', () => {
    const skills = [
      mk({ name: 'a', scope: 'app' }),
      mk({ name: 'b', scope: 'builtin' }),
    ];
    const snapshot = skills.map((s) => ({ ...s }));
    filterSkillsBySource(skills, 'builtin');
    filterSkillsBySource(skills, 'market');
    filterSkillsBySource(skills, 'rocky');
    expect(skills).toEqual(snapshot); // 原数组未被 mutate
    expect(skills.length).toBe(2);
  });

  it('混合场景：builtin 不被 market 或 rocky 误匹配', () => {
    // builtin skill 通常无 marketRef 无 productionMethod
    const skills = [
      mk({ name: 'builtin-1', scope: 'builtin' }),
      mk({ name: 'builtin-2', scope: 'builtin' }),
    ];
    expect(filterSkillsBySource(skills, 'market')).toEqual([]);
    expect(filterSkillsBySource(skills, 'rocky')).toEqual([]);
    expect(filterSkillsBySource(skills, 'builtin').length).toBe(2);
    expect(filterSkillsBySource(skills, 'all').length).toBe(2);
  });
});
