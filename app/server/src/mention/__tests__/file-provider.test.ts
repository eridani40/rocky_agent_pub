/**
 * FileProvider 单测 —— workspace 文件搜索 / limit 分页 / cursor / MentionItem 结构
 * 参考: specs/tech/mention/provider-interface.md §5
 *
 * fixture：改用 os.tmpdir() + mkdtempSync 临时目录动态生成（CLAUDE.md 文件系统隔离 MANDATORY），
 * 不再依赖 tests/api/mention/_fixtures/ 静态目录——该目录随 v0.0.69→3981b817「test naming 收敛」
 * 迁移旧 AT 框架（tests/api → tests_v2/api）时被删除（新 AT 框架的 mention case 不再用静态
 * fixture 目录），UT 不应依赖 tests/ 测试框架自身的目录结构演变。
 *   small-workspace — 3 个 .md 文件（README/changelog/notes）
 *   multi-file-workspace — 12 个 .md 文件（file_01~file_12）
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProvider } from '../providers/file-provider';
import type { SearchCtx } from '../types';

/** 临时 fixture 根目录（beforeAll 创建，afterAll 清理） */
let tmpRoot: string;
let SMALL_WS: string;
let MULTI_WS: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'file-provider-test-'));

  // small-workspace：3 个 .md 文件（根目录，无子目录）
  SMALL_WS = join(tmpRoot, 'small-workspace');
  mkdirSync(SMALL_WS, { recursive: true });
  writeFileSync(join(SMALL_WS, 'README.md'), '# readme\n');
  writeFileSync(join(SMALL_WS, 'changelog.md'), '# changelog\n');
  writeFileSync(join(SMALL_WS, 'notes.md'), '# notes\n');

  // multi-file-workspace：12 个 .md 文件（file_01~file_12），供 limit/cursor 分页测试
  MULTI_WS = join(tmpRoot, 'multi-file-workspace');
  mkdirSync(MULTI_WS, { recursive: true });
  for (let i = 1; i <= 12; i++) {
    const name = `file_${String(i).padStart(2, '0')}.md`;
    writeFileSync(join(MULTI_WS, name), `# ${name}\n`);
  }
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造最小 SearchCtx（workspaceDir 可覆盖） */
function makeCtx(overrides: Partial<SearchCtx> = {}): SearchCtx {
  return {
    query: '',
    limit: 20,
    bizType: 'playground',
    biz: 'playground',
    role: 'rocky',
    derivation: 'parent',
    sessionId: 'test-session',
    workspaceDir: SMALL_WS,
    ...overrides,
  };
}

describe('FileProvider', () => {
  const provider = new FileProvider();

  it('provider 元信息: name=file, label=Files', () => {
    expect(provider.name).toBe('file');
    expect(provider.label).toBe('Files');
  });

  it('search query="md" 在 small-workspace 返回 >=1 个 MentionItem', async () => {
    const result = await provider.search(makeCtx({ query: 'md' }));
    expect(result.items.length).toBeGreaterThanOrEqual(1);
  });

  it('每个 MentionItem 含 type/path/listView 字段', async () => {
    const result = await provider.search(makeCtx({ query: 'md' }));
    for (const item of result.items) {
      expect(item.type).toBe('file');
      expect(item.path).toBeTruthy();
      expect(item.listView.title).toBeTruthy();
    }
  });

  it('listView.icon 为 file', async () => {
    const result = await provider.search(makeCtx({ query: 'md' }));
    for (const item of result.items) {
      expect(item.listView.icon).toBe('file');
    }
  });

  it('空 query 匹配 workspace 内所有非隐藏文件', async () => {
    const result = await provider.search(makeCtx({ query: '' }));
    // small-workspace 有 3 个 .md 文件
    expect(result.items.length).toBeGreaterThanOrEqual(3);
  });

  it('不匹配的文件返回空列表', async () => {
    const result = await provider.search(makeCtx({ query: 'xyznonexistent' }));
    expect(result.items).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it('大小写不敏感搜索', async () => {
    const upper = await provider.search(makeCtx({ query: 'README' }));
    const lower = await provider.search(makeCtx({ query: 'readme' }));
    expect(upper.items.length).toBe(lower.items.length);
    expect(upper.items.length).toBeGreaterThanOrEqual(1);
  });

  it('limit 生效 + nextCursor 存在', async () => {
    const result = await provider.search(
      makeCtx({ query: 'md', limit: 2, workspaceDir: MULTI_WS }),
    );
    expect(result.items.length).toBeLessThanOrEqual(2);
    // multi-file-workspace 有 12 个文件，limit=2 应该有 nextCursor
    expect(result.nextCursor).toBeDefined();
  });

  it('cursor 翻页返回后续结果', async () => {
    // 第一页
    const page1 = await provider.search(
      makeCtx({ query: 'md', limit: 5, workspaceDir: MULTI_WS }),
    );
    expect(page1.items.length).toBeLessThanOrEqual(5);
    expect(page1.nextCursor).toBeDefined();

    // 第二页
    const page2 = await provider.search(
      makeCtx({ query: 'md', limit: 5, cursor: page1.nextCursor, workspaceDir: MULTI_WS }),
    );
    expect(page2.items.length).toBeGreaterThanOrEqual(1);

    // 两页 item path 不重叠
    const paths1 = new Set(page1.items.map((i) => i.path));
    for (const item of page2.items) {
      expect(paths1.has(item.path)).toBe(false);
    }
  });

  it('path = 相对 POSIX 路径', async () => {
    const result = await provider.search(makeCtx({ query: 'md' }));
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    for (const item of result.items) {
      expect(item.path).not.toContain('\\'); // POSIX 分隔符
      // file provider 总是设置 path（非空断言消除 optional 类型）
      expect(item.path!.startsWith('/')).toBe(false); // 相对路径
    }
  });

  it('subtitle 为文件所在目录相对路径', async () => {
    const result = await provider.search(makeCtx({ query: 'md' }));
    // small-workspace 的文件都在根目录，subtitle 可能是 undefined（dirname = '.'）
    // 这个测试验证结构完整性
    for (const item of result.items) {
      // subtitle 可以是 undefined 或字符串
      if (item.listView.subtitle !== undefined) {
        expect(typeof item.listView.subtitle).toBe('string');
      }
    }
  });
});
