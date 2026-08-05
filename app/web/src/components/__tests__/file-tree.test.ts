/**
 * @vitest-environment node
 * common/file-tree 树转换工具单测：buildFileTree / findFirstFilePath / collectDirPaths
 * 参考: specs/api/overall/06-skill.md §6.2（SkillFileNode 扁平数组）
 *       specs/ui/components/common/component-file-tree.md（树一次性整树 + 默认全展开 + 默认选首个文件）
 *
 * 覆盖：扁平→嵌套转换、乱序输入、dir/file 排序（dir 在前 + 字母序）、
 * 深度优先首个文件查找、所有 dir path 收集。
 */
import { describe, it, expect } from 'vitest';
import type { SkillFileNode } from '../../lib/api-client';
import { buildFileTree, findFirstFilePath, collectDirPaths } from '../common/file-tree';

describe('buildFileTree', () => {
  it('空数组 → 空 children 的虚拟根', () => {
    const root = buildFileTree([]);
    expect(root.children).toEqual([]);
  });

  it('扁平文件列表 → 嵌套树（顶层）', () => {
    const flat: SkillFileNode[] = [
      { name: 'SKILL.md', path: 'SKILL.md', type: 'file', size: 100 },
      { name: 'README.md', path: 'README.md', type: 'file', size: 50 },
    ];
    const root = buildFileTree(flat);
    expect(root.children).toHaveLength(2);
    // 都是 file，按字母序
    expect(root.children[0]!.name).toBe('README.md');
    expect(root.children[1]!.name).toBe('SKILL.md');
  });

  it('嵌套目录 → 子节点挂到正确父节点', () => {
    const flat: SkillFileNode[] = [
      { name: 'SKILL.md', path: 'SKILL.md', type: 'file' },
      { name: 'refs', path: 'refs', type: 'dir' },
      { name: 'guide.md', path: 'refs/guide.md', type: 'file' },
      { name: 'adv.md', path: 'refs/adv.md', type: 'file' },
    ];
    const root = buildFileTree(flat);
    // dir 在前
    expect(root.children[0]!.name).toBe('refs');
    expect(root.children[0]!.type).toBe('dir');
    expect(root.children[1]!.name).toBe('SKILL.md');
    // refs 下子节点字母序
    const refs = root.children[0]!;
    expect(refs.children.map((c) => c.name)).toEqual(['adv.md', 'guide.md']);
  });

  it('乱序输入 → 仍正确建树（父目录可能在子路径之后）', () => {
    const flat: SkillFileNode[] = [
      { name: 'a.md', path: 'dir/a.md', type: 'file' },
      { name: 'dir', path: 'dir', type: 'dir' },
    ];
    const root = buildFileTree(flat);
    const dir = root.children.find((c) => c.name === 'dir');
    expect(dir).toBeDefined();
    expect(dir!.children.map((c) => c.name)).toEqual(['a.md']);
  });

  it('dir 排在 file 之前（同层）', () => {
    const flat: SkillFileNode[] = [
      { name: 'zfile.md', path: 'zfile.md', type: 'file' },
      { name: 'adir', path: 'adir', type: 'dir' },
    ];
    const root = buildFileTree(flat);
    expect(root.children[0]!.name).toBe('adir');
    expect(root.children[1]!.name).toBe('zfile.md');
  });
});

describe('findFirstFilePath', () => {
  it('深度优先首个文件（dir 先递归）', () => {
    const flat: SkillFileNode[] = [
      { name: 'b.md', path: 'b.md', type: 'file' },
      { name: 'a', path: 'a', type: 'dir' },
      { name: '1.md', path: 'a/1.md', type: 'file' },
    ];
    const root = buildFileTree(flat);
    // 排序后 a(dir) 在前，深度优先进入 a → a/1.md
    expect(findFirstFilePath(root)).toBe('a/1.md');
  });

  it('无文件 → null', () => {
    const flat: SkillFileNode[] = [{ name: 'empty', path: 'empty', type: 'dir' }];
    const root = buildFileTree(flat);
    expect(findFirstFilePath(root)).toBeNull();
  });

  it('空树 → null', () => {
    expect(findFirstFilePath(buildFileTree([]))).toBeNull();
  });
});

describe('collectDirPaths', () => {
  it('收集所有 dir 的 path（含嵌套）', () => {
    const flat: SkillFileNode[] = [
      { name: 'SKILL.md', path: 'SKILL.md', type: 'file' },
      { name: 'refs', path: 'refs', type: 'dir' },
      { name: 'guide.md', path: 'refs/guide.md', type: 'file' },
      { name: 'deep', path: 'refs/deep', type: 'dir' },
      { name: 'x.md', path: 'refs/deep/x.md', type: 'file' },
    ];
    const root = buildFileTree(flat);
    const acc = collectDirPaths(root);
    expect(acc).toEqual({
      refs: true,
      'refs/deep': true,
    });
  });

  it('无 dir → 空对象', () => {
    const flat: SkillFileNode[] = [{ name: 'a.md', path: 'a.md', type: 'file' }];
    const root = buildFileTree(flat);
    expect(collectDirPaths(root)).toEqual({});
  });
});
