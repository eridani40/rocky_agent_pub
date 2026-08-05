/**
 * @vitest-environment node
 * skill-diff 单测 —— 两级 skill diff 派生（目录 × 文件四态 + 内容取用清单 + 回填）
 * 参考: specs/ui/components/academy-page/component-skill-diff-list.md
 *       specs/api/overall/18-academy.md §1.8（per-file hash = sha1 前 12）
 *
 * 防回归重点：
 *   - 只在 base 侧的 skill 判 removed（历史实现误标「不变」，本版核心修复）
 *   - modified 只看 hash：同 size 不同内容必须判 modified、hash 相同必须判 unchanged
 *   - SKILL.md 之外的附属文件（references/*.py）改动也要能让目录判 modified
 *   - binary（hash 缺失 / 后端标记）绝不进内容取用与行级 diff
 */
import { describe, it, expect } from 'vitest';
import type { SkillSummary } from '../../../lib/academy-api';
import { applySkillFileContents, buildSkillDirDiffs, collectDiffFileRefs, DEFAULT_DIFF_FILE_LIMIT } from '../skill-diff';

/** 构造 skill 摘要（files 只给 path + hash + size，与后端 AcademySkillFileNode 结构一致） */
function skill(name: string, files: Array<{ path: string; hash?: string; size?: number; type?: 'file' | 'dir' }>): SkillSummary {
  return {
    name,
    fileCount: files.filter((f) => (f.type ?? 'file') === 'file').length,
    files: files.map((f) => ({
      name: f.path.slice(f.path.lastIndexOf('/') + 1),
      path: f.path,
      type: f.type ?? 'file',
      ...(f.size !== undefined ? { size: f.size } : {}),
      ...(f.hash !== undefined ? { hash: f.hash } : {}),
    })),
  };
}

describe('buildSkillDirDiffs', () => {
  it('仅候选侧有的 skill → 目录 added，其下文件全 added', () => {
    const dirs = buildSkillDirDiffs([], [skill('code-review', [{ path: 'SKILL.md', hash: 'aaa111' }])]);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]?.skillName).toBe('code-review');
    expect(dirs[0]?.changeKind).toBe('added');
    expect(dirs[0]?.files.map((f) => [f.path, f.changeKind])).toEqual([['SKILL.md', 'added']]);
  });

  it('【防回归】仅 base 侧有的 skill → 目录 removed（不是 unchanged），其下文件全 removed', () => {
    const dirs = buildSkillDirDiffs([skill('legacy-lint', [{ path: 'SKILL.md', hash: 'bbb222' }])], []);
    expect(dirs[0]?.changeKind).toBe('removed');
    expect(dirs[0]?.files[0]?.changeKind).toBe('removed');
    // 旧实现把「只在 base 有」的 skill 塞成 unchanged，导致删除永不可见
    expect(dirs[0]?.changeKind).not.toBe('unchanged');
  });

  it('SKILL.md 外的附属文件 hash 变化 → 文件 modified 且目录 modified', () => {
    const base = [skill('audit', [{ path: 'SKILL.md', hash: 'same00' }, { path: 'references/audit.py', hash: 'old111' }])];
    const cand = [skill('audit', [{ path: 'SKILL.md', hash: 'same00' }, { path: 'references/audit.py', hash: 'new222' }])];
    const dirs = buildSkillDirDiffs(base, cand);
    expect(dirs[0]?.changeKind).toBe('modified');
    // 文件按 path 码位序稳定排列：'SKILL.md'（大写）在 'references/…' 之前
    expect(dirs[0]?.files.map((f) => [f.path, f.changeKind])).toEqual([
      ['SKILL.md', 'unchanged'],
      ['references/audit.py', 'modified'],
    ]);
  });

  it('三级以上嵌套按完整相对 path 精确配对（同基名不同路径 = 两个文件）', () => {
    const base = [
      skill('deep-nest', [
        { path: 'templates/sub/deep/x.yaml', hash: 'old111' },
        { path: 'templates/x.yaml', hash: 'keep00' },
        { path: 'templates/sub/old.txt', hash: 'gone11' },
      ]),
    ];
    const cand = [
      skill('deep-nest', [
        { path: 'templates/sub/deep/x.yaml', hash: 'new222' },
        { path: 'templates/x.yaml', hash: 'keep00' },
        { path: 'templates/sub/deep/new.json', hash: 'add333' },
      ]),
    ];
    const dirs = buildSkillDirDiffs(base, cand);
    expect(dirs[0]?.changeKind).toBe('modified');
    expect(dirs[0]?.files.map((f) => [f.path, f.changeKind])).toEqual([
      ['templates/sub/deep/new.json', 'added'],
      ['templates/sub/deep/x.yaml', 'modified'],
      ['templates/sub/old.txt', 'removed'],
      // 同基名 x.yaml 但路径不同 → 独立文件，不与深层的那个混为一谈
      ['templates/x.yaml', 'unchanged'],
    ]);
    // 取内容清单同样按全路径（深层文件不丢、unchanged 的同名文件不进）
    expect(collectDiffFileRefs(dirs).refs.map((r) => r.path)).toEqual([
      'templates/sub/deep/new.json',
      'templates/sub/deep/x.yaml',
      'templates/sub/old.txt',
    ]);
  });

  it('hash 全同 → 目录与文件均 unchanged（同 hash 绝不误报）', () => {
    const files = [{ path: 'SKILL.md', hash: 'h0h0h0', size: 120 }];
    const dirs = buildSkillDirDiffs([skill('fmt', files)], [skill('fmt', files)]);
    expect(dirs[0]?.changeKind).toBe('unchanged');
    expect(dirs[0]?.files[0]?.changeKind).toBe('unchanged');
  });

  it('size 相同但 hash 不同 → modified（判定不看 size）', () => {
    const dirs = buildSkillDirDiffs(
      [skill('fmt', [{ path: 'SKILL.md', hash: 'aaaaaa', size: 200 }])],
      [skill('fmt', [{ path: 'SKILL.md', hash: 'zzzzzz', size: 200 }])],
    );
    expect(dirs[0]?.files[0]?.changeKind).toBe('modified');
    expect(dirs[0]?.changeKind).toBe('modified');
  });

  it('dir 节点不参与文件级 diff（只比 file 节点）', () => {
    const dirs = buildSkillDirDiffs(
      [skill('t', [{ path: 'references', type: 'dir' }, { path: 'references/a.md', hash: 'x1' }])],
      [skill('t', [{ path: 'references', type: 'dir' }, { path: 'references/a.md', hash: 'x1' }])],
    );
    expect(dirs[0]?.files.map((f) => f.path)).toEqual(['references/a.md']);
    expect(dirs[0]?.changeKind).toBe('unchanged');
  });

  it('skill 名 asc + 混合四态：added / removed / modified / unchanged 同时出现', () => {
    const dirs = buildSkillDirDiffs(
      [skill('b-mod', [{ path: 'SKILL.md', hash: 'm1' }]), skill('c-same', [{ path: 'SKILL.md', hash: 's1' }]), skill('d-gone', [{ path: 'SKILL.md', hash: 'g1' }])],
      [skill('a-new', [{ path: 'SKILL.md', hash: 'n1' }]), skill('b-mod', [{ path: 'SKILL.md', hash: 'm2' }]), skill('c-same', [{ path: 'SKILL.md', hash: 's1' }])],
    );
    expect(dirs.map((d) => [d.skillName, d.changeKind])).toEqual([
      ['a-new', 'added'],
      ['b-mod', 'modified'],
      ['c-same', 'unchanged'],
      ['d-gone', 'removed'],
    ]);
  });

  it('hash 缺失（后端读失败）→ 标 binary 且保守判 modified', () => {
    const dirs = buildSkillDirDiffs(
      [skill('img', [{ path: 'logo.png', size: 10 }])],
      [skill('img', [{ path: 'logo.png', size: 20 }])],
    );
    expect(dirs[0]?.files[0]).toMatchObject({ path: 'logo.png', changeKind: 'modified', binary: true, baseSize: 10, candSize: 20 });
  });
});

describe('collectDiffFileRefs', () => {
  it('只摘变更文件；unchanged 与 binary 不进清单', () => {
    const dirs = buildSkillDirDiffs(
      [skill('s', [{ path: 'SKILL.md', hash: 'a1' }, { path: 'keep.md', hash: 'k1' }, { path: 'blob.bin' }])],
      [skill('s', [{ path: 'SKILL.md', hash: 'a2' }, { path: 'keep.md', hash: 'k1' }, { path: 'blob.bin' }])],
    );
    const { refs, truncated } = collectDiffFileRefs(dirs);
    expect(refs).toEqual([{ skillName: 's', path: 'SKILL.md', needBase: true, needCand: true }]);
    expect(truncated).toBe(false);
  });

  it('added 只需候选侧、removed 只需 base 侧', () => {
    const dirs = buildSkillDirDiffs([skill('gone', [{ path: 'SKILL.md', hash: 'g1' }])], [skill('fresh', [{ path: 'SKILL.md', hash: 'f1' }])]);
    const { refs } = collectDiffFileRefs(dirs);
    expect(refs).toEqual([
      { skillName: 'fresh', path: 'SKILL.md', needBase: false, needCand: true },
      { skillName: 'gone', path: 'SKILL.md', needBase: true, needCand: false },
    ]);
  });

  it('超出 limit → 截断且 truncated=true（默认上限 20）', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ path: `f${String(i).padStart(2, '0')}.md`, hash: `old${i}` }));
    const dirs = buildSkillDirDiffs([skill('big', many)], [skill('big', many.map((f) => ({ ...f, hash: `new${f.path}` })))]);
    const { refs, truncated } = collectDiffFileRefs(dirs);
    expect(refs).toHaveLength(DEFAULT_DIFF_FILE_LIMIT);
    expect(truncated).toBe(true);
    const limited = collectDiffFileRefs(dirs, 3);
    expect(limited.refs).toHaveLength(3);
    expect(limited.truncated).toBe(true);
  });
});

describe('applySkillFileContents', () => {
  it('按 skillName+path 回填两侧内容，未命中的文件原样保留', () => {
    const dirs = buildSkillDirDiffs(
      [skill('s', [{ path: 'SKILL.md', hash: 'a1' }, { path: 'other.md', hash: 'o1' }])],
      [skill('s', [{ path: 'SKILL.md', hash: 'a2' }, { path: 'other.md', hash: 'o2' }])],
    );
    const next = applySkillFileContents(dirs, [{ skillName: 's', path: 'SKILL.md', baseContent: 'old', candContent: 'new' }]);
    expect(next[0]?.files[0]).toMatchObject({ path: 'SKILL.md', baseContent: 'old', candContent: 'new' });
    expect(next[0]?.files[1]?.baseContent).toBeUndefined();
    // 纯函数：入参未被改动
    expect(dirs[0]?.files[0]?.baseContent).toBeUndefined();
  });

  it('后端标 binary → 落 binary=true 且清空两侧内容（不给行级 diff 任何输入）', () => {
    const dirs = buildSkillDirDiffs([skill('s', [{ path: 'a.bin', hash: 'b1' }])], [skill('s', [{ path: 'a.bin', hash: 'b2' }])]);
    const next = applySkillFileContents(dirs, [{ skillName: 's', path: 'a.bin', baseContent: '', candContent: '', binary: true }]);
    expect(next[0]?.files[0]?.binary).toBe(true);
    expect(next[0]?.files[0]?.baseContent).toBeUndefined();
    expect(next[0]?.files[0]?.candContent).toBeUndefined();
  });

  it('取内容失败（不在 loaded 内）→ 保持无内容，降级为无行级 diff', () => {
    const dirs = buildSkillDirDiffs([skill('s', [{ path: 'SKILL.md', hash: 'a1' }])], [skill('s', [{ path: 'SKILL.md', hash: 'a2' }])]);
    const next = applySkillFileContents(dirs, []);
    expect(next[0]?.files[0]?.changeKind).toBe('modified');
    expect(next[0]?.files[0]?.baseContent).toBeUndefined();
  });
});
