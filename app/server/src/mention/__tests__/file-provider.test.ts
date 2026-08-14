/**
 * FileProvider 单测 —— workspace 文件搜索适配层 / limit 分页 / cursor / MentionItem 结构
 * 参考: specs/tech/mention/provider-interface.md §5
 *       specs/tech/version_logs/v0.0.346/change_plan.md（file-provider 行）
 *
 * v0.0.346：FileProvider 收敛为 workspace-search-core 适配层。新增覆盖：
 *   目录命中条目（type='file'/path=dir）、truncated 透传、点开头目录可命中、
 *   与 searchWorkspace 命中集合一致性；既有分页/cursor/MentionItem 断言保持。
 *
 * fixture：os.tmpdir() + mkdtempSync 临时目录动态生成（文件系统隔离 MANDATORY）：
 *   small-workspace — 3 个 .md 文件（README/changelog/notes），无子目录
 *   multi-file-workspace — 12 个 .md 文件（file_01~file_12），供 limit/cursor 分页测试
 *   dir-workspace — 含 src/auth.ts + src/utils/helper.ts + docs/guide.md + README.md（目录命中/一致性）
 *   dot-workspace — 含 .rocky_project/config.json + app/main.ts（点开头目录可遍历可命中）
 *   many-workspace — 101 个 .md 文件（file_000~file_100），供 truncated 透传测试
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileProvider } from '../providers/file-provider';
import { searchWorkspace } from '../../search/workspace-search-core';
import type { SearchCtx } from '../types';

/** 临时 fixture 根目录（beforeAll 创建，afterAll 清理） */
let tmpRoot: string;
let SMALL_WS: string;
let MULTI_WS: string;
let DIR_WS: string;
let DOT_WS: string;
let MANY_WS: string;

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

  // dir-workspace：文件 + 子目录（src/、src/utils/、docs/），供目录命中/一致性测试
  DIR_WS = join(tmpRoot, 'dir-workspace');
  mkdirSync(join(DIR_WS, 'src/utils'), { recursive: true });
  mkdirSync(join(DIR_WS, 'docs'), { recursive: true });
  writeFileSync(join(DIR_WS, 'README.md'), '# readme\n');
  writeFileSync(join(DIR_WS, 'src/auth.ts'), 'export const auth = 1;\n');
  writeFileSync(join(DIR_WS, 'src/utils/helper.ts'), 'export const helper = 1;\n');
  writeFileSync(join(DIR_WS, 'docs/guide.md'), '# guide\n');
  writeFileSync(join(DIR_WS, 'styles.css'), 'body {}\n');

  // dot-workspace：点开头目录（.rocky_project），供「点开头目录可遍历可命中」测试
  DOT_WS = join(tmpRoot, 'dot-workspace');
  mkdirSync(join(DOT_WS, '.rocky_project'), { recursive: true });
  mkdirSync(join(DOT_WS, 'app'), { recursive: true });
  writeFileSync(join(DOT_WS, '.rocky_project/config.json'), '{"a":1}\n');
  writeFileSync(join(DOT_WS, 'app/main.ts'), 'console.log(1);\n');

  // many-workspace：101 个 .md 文件（file_000~file_100），供 truncated 透传测试
  MANY_WS = join(tmpRoot, 'many-workspace');
  mkdirSync(MANY_WS, { recursive: true });
  for (let i = 0; i <= 100; i++) {
    const name = `file_${String(i).padStart(3, '0')}.md`;
    writeFileSync(join(MANY_WS, name), `# ${name}\n`);
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

  it('listView.icon 为 file（文件条目）', async () => {
    const result = await provider.search(makeCtx({ query: 'md' }));
    // small-workspace 只有文件（无目录命中）→ 全部 icon='file'
    for (const item of result.items) {
      expect(item.listView.icon).toBe('file');
      expect(item.isDir).toBeUndefined(); // 文件条目不设 isDir
    }
  });

  it('空 query 匹配 workspace 内所有条目', async () => {
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

  it('subtitle 为文件所在目录相对路径（根路径 "/" 始终展示）', async () => {
    const result = await provider.search(makeCtx({ query: 'md' }));
    // small-workspace 的文件都在根目录，subtitle 应为 '/'（dirname='.' → '/'，v0.0.346-2）
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    for (const item of result.items) {
      expect(item.listView.subtitle).toBe('/');
    }
  });

  // ─── v0.0.346 新增：适配层行为（目录命中 / truncated / 点开头 / 一致性） ───

  it('目录命中返回 type=file 条目且 path=目录相对路径（isDir:true + icon=folder）', async () => {
    const result = await provider.search(makeCtx({ query: 'src', workspaceDir: DIR_WS }));
    const dirItem = result.items.find((i) => i.path === 'src');
    expect(dirItem).toBeDefined();
    expect(dirItem!.type).toBe('file');
    expect(dirItem!.isDir).toBe(true); // 目录条目 isDir:true
    expect(dirItem!.display.icon).toBe('file'); // pill 不区分，display.icon 保持 'file'
    expect(dirItem!.display.label).toBe('src'); // basename（目录名）
    expect(dirItem!.listView.title).toBe('src'); // basename（目录名）
    expect(dirItem!.listView.subtitle).toBe('/'); // dirname='.' → '/'（根路径始终展示）
    expect(dirItem!.listView.icon).toBe('folder'); // 目录 icon=folder
  });

  it('子目录命中条目 subtitle=dirname、label/title=basename', async () => {
    const result = await provider.search(makeCtx({ query: 'utils', workspaceDir: DIR_WS }));
    const dirItem = result.items.find((i) => i.path === 'src/utils');
    expect(dirItem).toBeDefined();
    expect(dirItem!.display.label).toBe('utils');
    expect(dirItem!.listView.title).toBe('utils');
    expect(dirItem!.listView.subtitle).toBe('src');
  });

  it('文件命中条目 subtitle 为所在目录相对路径', async () => {
    const result = await provider.search(makeCtx({ query: 'helper', workspaceDir: DIR_WS }));
    const fileItem = result.items.find((i) => i.path === 'src/utils/helper.ts');
    expect(fileItem).toBeDefined();
    expect(fileItem!.display.label).toBe('helper.ts');
    expect(fileItem!.listView.subtitle).toBe('src/utils');
  });

  it('点开头目录可命中（type=file + path=目录相对路径）', async () => {
    const result = await provider.search(makeCtx({ query: 'rocky', workspaceDir: DOT_WS }));
    const dirItem = result.items.find((i) => i.path === '.rocky_project');
    expect(dirItem).toBeDefined();
    expect(dirItem!.type).toBe('file');
    expect(dirItem!.display.label).toBe('.rocky_project');
  });

  it('点开头目录可遍历（其下层文件可命中）', async () => {
    const result = await provider.search(makeCtx({ query: 'config', workspaceDir: DOT_WS }));
    const fileItem = result.items.find((i) => i.path === '.rocky_project/config.json');
    expect(fileItem).toBeDefined();
    expect(fileItem!.type).toBe('file');
  });

  it('命中集合与 searchWorkspace 一致（合并 files+dirs 排序）', async () => {
    const ctx = makeCtx({ query: 's', workspaceDir: DIR_WS });
    const result = await provider.search({ ...ctx, limit: 100 });
    // 与 searchWorkspace 同一排除/遍历/上限 → 合并排序后完全一致
    const { files, dirs } = searchWorkspace(DIR_WS, 's');
    const expected = [...dirs, ...files].sort();
    expect(result.items.map((i) => i.path)).toEqual(expected);
    // 目录 + 文件混合命中（query='s' 命中 src/、docs/ 目录 + styles.css 文件；
    // 目录命中不递归其下层 → src/auth.ts 不在集合内，与核心语义一致）
    expect(expected).toContain('src');
    expect(expected).toContain('docs');
    expect(expected).toContain('styles.css');
    expect(expected).not.toContain('src/auth.ts');
  });

  it('命中超上限 → truncated:true 透传', async () => {
    const result = await provider.search(makeCtx({ query: 'md', workspaceDir: MANY_WS }));
    // many-workspace 101 个 .md 全命中 → 100 早停
    expect(result.truncated).toBe(true);
  });

  it('未超上限 → 不携带 truncated（向后兼容）', async () => {
    const result = await provider.search(makeCtx({ query: 'md', workspaceDir: SMALL_WS }));
    expect(result.truncated).toBeUndefined();
  });

  it('truncated 时仍正常分页（nextCursor 与切片不受影响）', async () => {
    const result = await provider.search(
      makeCtx({ query: 'md', limit: 10, workspaceDir: MANY_WS }),
    );
    expect(result.items.length).toBe(10);
    expect(result.nextCursor).toBeDefined();
    expect(result.truncated).toBe(true);
  });
});
