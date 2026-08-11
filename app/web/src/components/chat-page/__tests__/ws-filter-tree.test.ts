/**
 * ws-filter-tree UT — buildFilterTree 纯函数单测（v0.0.324 D2）
 * 参考: specs/tech/version_logs/v0.0.324/change_plan.md D2 约束
 */
import { describe, it, expect } from 'vitest';
import { buildFilterTree, basename } from '../ws-filter-tree';
import type { SearchHit } from '../ws-filter-tree';

describe('buildFilterTree', () => {
  it('单个文件命中 → 顶层 + 祖先补全 + 全部展开', () => {
    const hits: SearchHit[] = [
      { path: 'src/auth/login.ts', type: 'file' },
    ];
    const result = buildFilterTree(hits, { limit: 100 });

    // 顶层 = src
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0]!.path).toBe('src');
    expect(result.tree[0]!.type).toBe('dir');

    // 祖先展开
    expect(result.expandedPaths).toEqual(expect.arrayContaining(['src', 'src/auth']));

    // childrenCache: src → [src/auth], src/auth → [src/auth/login.ts]
    const srcChildren = result.childrenCache['src'];
    expect(srcChildren).toBeDefined();
    expect(srcChildren![0]!.path).toBe('src/auth');

    const authChildren = result.childrenCache['src/auth'];
    expect(authChildren).toBeDefined();
    expect(authChildren![0]!.path).toBe('src/auth/login.ts');
    expect(authChildren![0]!.type).toBe('file');

    // hitCount
    expect(result.hitCount).toBe(1);
  });

  it('同路径合并：同 parent 下多 hit 自然归入同 children 数组', () => {
    const hits: SearchHit[] = [
      { path: 'src/a.ts', type: 'file' },
      { path: 'src/b.ts', type: 'file' },
    ];
    const result = buildFilterTree(hits, { limit: 100 });

    // 顶层 = src（一个节点）
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0]!.path).toBe('src');

    // src 的 children 有 2 个文件
    const srcChildren = result.childrenCache['src'];
    expect(srcChildren).toHaveLength(2);
    expect(srcChildren!.map((n) => n.path)).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
  });

  it('根目录文件命中 → parentPath 为空串', () => {
    const hits: SearchHit[] = [
      { path: 'root-file.ts', type: 'file' },
    ];
    const result = buildFilterTree(hits, { limit: 100 });

    // 顶层直接是文件
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0]!.path).toBe('root-file.ts');
    expect(result.tree[0]!.type).toBe('file');
    // 无祖先需展开
    expect(result.expandedPaths).toHaveLength(0);
  });

  it('目录命中 → 命中目录不在 expandedPaths（v0.0.327：不自动展开）+ 祖先仍展开', () => {
    const hits: SearchHit[] = [
      { path: 'src/components', type: 'dir' },
    ];
    const result = buildFilterTree(hits, { limit: 100 });

    // 顶层 = src（祖先目录）
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0]!.path).toBe('src');

    // src 的 children = src/components（命中目录）
    const srcChildren = result.childrenCache['src'];
    expect(srcChildren![0]!.path).toBe('src/components');
    expect(srcChildren![0]!.type).toBe('dir');
    expect(srcChildren![0]!.hasChildren).toBe(true);

    // [v0.0.327] 命中目录不在 expandedPaths 中（不自动展开）
    expect(result.expandedPaths).not.toContain('src/components');
    // 祖先仍在（路径可见性必需）
    expect(result.expandedPaths).toContain('src');
  });

  it('目录命中 + existingChildrenCache 有子项 → 用缓存真实子项替换裁剪子项', () => {
    const hits: SearchHit[] = [
      { path: 'src/auth', type: 'dir' },
    ];
    const existingCache: Record<string, import('../workspace-types').WsTreeNode[]> = {
      'src/auth': [
        { name: 'login.ts', path: 'src/auth/login.ts', type: 'file', hasChildren: false },
        { name: 'register.ts', path: 'src/auth/register.ts', type: 'file', hasChildren: false },
        { name: 'utils', path: 'src/auth/utils', type: 'dir', hasChildren: false },
      ],
    };
    const result = buildFilterTree(hits, { limit: 100, existingChildrenCache: existingCache });

    // src/auth 命中且缓存有子项 → childrenCache 用真实子项（3 个）
    const authChildren = result.childrenCache['src/auth'];
    expect(authChildren).toHaveLength(3);
    expect(authChildren!.map((n) => n.path)).toEqual(
      expect.arrayContaining(['src/auth/login.ts', 'src/auth/register.ts', 'src/auth/utils']),
    );
  });

  it('限量截断：hits 超 limit → 截断 + hitCount 保持原始总数', () => {
    const hits: SearchHit[] = Array.from({ length: 150 }, (_, i) => ({
      path: `file-${i}.ts`,
      type: 'file' as const,
    }));
    const result = buildFilterTree(hits, { limit: 100 });

    // hitCount = 原始总数
    expect(result.hitCount).toBe(150);
    // 顶层节点 = 100（截断后）
    expect(result.tree).toHaveLength(100);
  });

  it('空命中 → 空树 + 空 expandedPaths', () => {
    const result = buildFilterTree([], { limit: 100 });
    expect(result.tree).toHaveLength(0);
    expect(result.expandedPaths).toHaveLength(0);
    expect(result.hitCount).toBe(0);
  });

  it('不同深度多路径混合 → 祖先不重复创建', () => {
    const hits: SearchHit[] = [
      { path: 'src/a.ts', type: 'file' },
      { path: 'src/b.ts', type: 'file' },
      { path: 'src/sub/c.ts', type: 'file' },
    ];
    const result = buildFilterTree(hits, { limit: 100 });

    // src 只创建一次
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0]!.path).toBe('src');

    // src children = a.ts, b.ts, sub（3 个，不重复）
    const srcChildren = result.childrenCache['src'];
    expect(srcChildren).toHaveLength(3);
    expect(srcChildren!.map((n) => n.path)).toEqual(
      expect.arrayContaining(['src/a.ts', 'src/b.ts', 'src/sub']),
    );
  });
});

describe('basename', () => {
  it('普通路径取最后段', () => {
    expect(basename('src/auth/login.ts')).toBe('login.ts');
  });
  it('根目录文件', () => {
    expect(basename('a.ts')).toBe('a.ts');
  });
  it('反斜杠兼容', () => {
    expect(basename('src\\auth\\login.ts')).toBe('login.ts');
  });
});
