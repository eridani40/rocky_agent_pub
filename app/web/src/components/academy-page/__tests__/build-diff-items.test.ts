/**
 * @vitest-environment node
 * build-diff-items 单测 —— 版本 diff 4 个卡的组装（纯函数，无 hook / 无 fetch）
 * 参考: specs/ui/components/academy-page/component-diff-viewer.md（DiffItem 契约）
 *
 * 覆盖：4 项顺序与齐全性、defaultOpen 规则（system+skills 展开 / memory+model 折叠）、
 * skills 项承载两级结构 + 四态计数摘要 + 截断提示、model 变化判定、版本内容缺失的降级。
 */
import { describe, it, expect } from 'vitest';
import type { VersionContent } from '../../../lib/academy-api';
import type { SkillDirDiff } from '../component-diff-viewer';
import { buildDiffItems } from '../build-diff-items';

/** 直通 t：返回 key 本身（+ 插值参数无关，本模块文案不带插值） */
const t = (key: string) => key;

function version(agentsMd: string, model?: { providerId?: string; modelId: string }): Pick<VersionContent, 'content'> {
  return {
    content: {
      agentsMd,
      skills: [],
      memory: [],
      versionJson: model ? { versionLabel: '1.0', model } : null,
    },
  };
}

const dirs: SkillDirDiff[] = [
  { skillName: 'a-new', changeKind: 'added', files: [{ path: 'SKILL.md', changeKind: 'added' }] },
  { skillName: 'b-mod', changeKind: 'modified', files: [{ path: 'references/x.py', changeKind: 'modified' }] },
  { skillName: 'c-gone', changeKind: 'removed', files: [{ path: 'SKILL.md', changeKind: 'removed' }] },
  { skillName: 'd-same', changeKind: 'unchanged', files: [{ path: 'SKILL.md', changeKind: 'unchanged' }] },
];

describe('buildDiffItems', () => {
  it('固定产出 4 项，顺序 system → skills → memory → model', () => {
    const items = buildDiffItems({ baseContent: null, candContent: null, skillDirs: [], t });
    expect(items.map((i) => i.kind)).toEqual(['system', 'skills', 'memory', 'model']);
    // 每项都带 icon/name/summary 与自身载荷
    expect(items[0]?.system).toBeDefined();
    expect(items[1]?.skills).toBeDefined();
    expect(items[2]?.memory).toBeDefined();
    expect(items[3]?.model).toBeDefined();
  });

  it('defaultOpen：system + skills 默认展开，memory + model 默认折叠', () => {
    const items = buildDiffItems({ baseContent: null, candContent: null, skillDirs: dirs, t });
    expect(items[0]?.defaultOpen).toBe(true);
    expect(items[1]?.defaultOpen).toBe(true);
    expect(items[2]?.defaultOpen).toBeUndefined();
    expect(items[3]?.defaultOpen).toBeUndefined();
  });

  it('skills 项承载两级结构，摘要按四态计数（unchanged 不计）', () => {
    const items = buildDiffItems({ baseContent: null, candContent: null, skillDirs: dirs, t });
    expect(items[1]?.skills?.skills).toBe(dirs);
    expect(items[1]?.summary).toBe('diff.skillsSummary · diff.newSkill 1 · diff.removedSkill 1 · diff.modSkill 1');
  });

  it('skills 全不变 → 摘要显「未变」；truncated 时追加截断提示', () => {
    const same: SkillDirDiff[] = [{ skillName: 's', changeKind: 'unchanged', files: [] }];
    expect(buildDiffItems({ baseContent: null, candContent: null, skillDirs: same, t })[1]?.summary).toBe(
      'diff.skillsSummary · diff.unchanged',
    );
    const truncated = buildDiffItems({ baseContent: null, candContent: null, skillDirs: dirs, skillsTruncated: true, t });
    expect(truncated[1]?.summary).toContain('diff.filesTruncated');
  });

  it('system 取两侧 AGENTS.md；版本内容缺失降级为空串', () => {
    const items = buildDiffItems({ baseContent: version('old text'), candContent: version('new text'), skillDirs: [], t });
    expect(items[0]?.system).toEqual({ baseContent: 'old text', candContent: 'new text' });
    const missing = buildDiffItems({ baseContent: null, candContent: version('only cand'), skillDirs: [], t });
    expect(missing[0]?.system).toEqual({ baseContent: '', candContent: 'only cand' });
  });

  it('model：providerId 或 modelId 任一不同即 changed；相同则摘要显「未变」', () => {
    const changed = buildDiffItems({
      baseContent: version('', { providerId: 'p1', modelId: 'm1' }),
      candContent: version('', { providerId: 'p1', modelId: 'm2' }),
      skillDirs: [],
      t,
    });
    expect(changed[3]?.model).toEqual({ baseText: 'm1', candText: 'm2', changed: true });
    expect(changed[3]?.summary).toBe('diff.modelSummary');

    const same = buildDiffItems({
      baseContent: version('', { providerId: 'p1', modelId: 'm1' }),
      candContent: version('', { providerId: 'p1', modelId: 'm1' }),
      skillDirs: [],
      t,
    });
    expect(same[3]?.model?.changed).toBe(false);
    expect(same[3]?.summary).toBe('diff.unchanged');
  });

  it('无 version.json → 两侧显「未设置」文案且判未变', () => {
    const items = buildDiffItems({ baseContent: version(''), candContent: version(''), skillDirs: [], t });
    expect(items[3]?.model).toEqual({ baseText: 'tuple.modelUnset', candText: 'tuple.modelUnset', changed: false });
  });

  it('memory 恒空对照（后端 content.memory 未实现）', () => {
    const items = buildDiffItems({ baseContent: null, candContent: null, skillDirs: [], t });
    expect(items[2]?.memory).toEqual({ baseEntries: [], candEntries: [] });
    expect(items[2]?.summary).toBe('diff.unchanged');
  });
});
