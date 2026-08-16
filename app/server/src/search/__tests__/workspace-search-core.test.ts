/**
 * workspace-search-core UT —— searchWorkspace 公共搜索核心（v0.0.346）
 * 参考: specs/tech/version_logs/v0.0.346/change_plan.md（search-core 行 + tests 行）
 *       specs/tech/version_logs/v0.0.360/change_plan.md §1.1（symlink 受控跟随 C1-C6）
 *
 * 覆盖 change_plan tests 行必覆盖清单：
 *   basename 匹配 / pathMode 完整相对路径匹配 / 目录命中不递归其下层 / node_modules+.git 排除 /
 *   点开头目录可遍历可命中 / 100 条早停 truncated:true / symlink 受控跟随（v0.0.360：
 *   workspace 内 symlink = 授权 → 跟随递归；realpath visited 防循环；broken symlink 跳过）
 *
 * 文件系统隔离：tmpdir + mkdtemp + afterEach rm（no-mock fs，对齐既有 handler UT 风格）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchWorkspace, SEARCH_LIMIT } from '../workspace-search-core';

const tmpRoots: string[] = [];

/** 每次用例独立 tmp workspace，返回根路径 */
function makeWs(): string {
  const ws = mkdtempSync(join(tmpdir(), 'oobt-searchcore-'));
  tmpRoots.push(ws);
  return ws;
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('searchWorkspace', () => {
  it('basename 匹配：q 不含 `/` → 文件与目录按名字 substring（大小写不敏感）', () => {
    const ws = makeWs();
    mkdirSync(join(ws, 'src', 'utils'), { recursive: true });
    mkdirSync(join(ws, 'src', 'helper-dir'), { recursive: true });
    writeFileSync(join(ws, 'src', 'helper.ts'), 'x');
    writeFileSync(join(ws, 'src', 'utils', 'helper-utils.ts'), 'x');
    writeFileSync(join(ws, 'src', 'helper-dir', 'readme.md'), 'x');

    const r = searchWorkspace(ws, 'HELPER');
    expect(r.files).toEqual(expect.arrayContaining(['src/helper.ts', 'src/utils/helper-utils.ts']));
    expect(r.dirs).toEqual(['src/helper-dir']);
    expect(r.truncated).toBe(false);
  });

  it('pathMode 匹配：q 含 `/` → 完整相对路径 substring，basename 命中不生效', () => {
    const ws = makeWs();
    mkdirSync(join(ws, 'src', 'auth'), { recursive: true });
    mkdirSync(join(ws, 'src', 'api'), { recursive: true });
    writeFileSync(join(ws, 'src', 'auth', 'login.ts'), 'x');
    writeFileSync(join(ws, 'src', 'auth', 'register.ts'), 'x');
    writeFileSync(join(ws, 'src', 'api', 'auth.ts'), 'x');
    writeFileSync(join(ws, 'auth.ts'), 'x');

    const r = searchWorkspace(ws, 'auth/');
    expect(r.files).toEqual(expect.arrayContaining(['src/auth/login.ts', 'src/auth/register.ts']));
    expect(r.files).not.toContain('src/api/auth.ts');
    expect(r.files).not.toContain('auth.ts');
    expect(r.truncated).toBe(false);
  });

  it('目录命中 → 推 dirs 且不递归其下层（子目录内容不返回）', () => {
    const ws = makeWs();
    // helper-dir 目录名命中 → dirs 有它，但其下层 readme 不再遍历（哪怕内部也含 helper）
    mkdirSync(join(ws, 'helper-dir', 'deep'), { recursive: true });
    writeFileSync(join(ws, 'helper-dir', 'inner-helper.txt'), 'x');
    writeFileSync(join(ws, 'helper-dir', 'deep', 'deep-helper.txt'), 'x');

    const r = searchWorkspace(ws, 'helper');
    expect(r.dirs).toContain('helper-dir');
    // 目录命中不递归：其下层文件不返回（相对路径含 helper-dir/ 的条目不应出现）
    expect(r.files).toEqual([]);
    expect(r.files.some((p: string) => p.startsWith('helper-dir/'))).toBe(false);
  });

  it('IGNORED_NAMES 排除：node_modules/.git 内条目不遍历不返回', () => {
    const ws = makeWs();
    mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeFileSync(join(ws, 'node_modules', 'pkg', 'helper.js'), 'x');
    writeFileSync(join(ws, '.git', 'helper-config'), 'x');
    writeFileSync(join(ws, 'real-helper.txt'), 'x');

    const r = searchWorkspace(ws, 'helper');
    expect(r.files).toEqual(['real-helper.txt']);
    expect(r.dirs).toEqual([]);
  });

  it('点开头目录可遍历可命中（仅 IGNORED_NAMES 排除，无点开头排除）', () => {
    const ws = makeWs();
    mkdirSync(join(ws, '.rocky_project'), { recursive: true });
    mkdirSync(join(ws, '.claude'), { recursive: true });
    writeFileSync(join(ws, '.rocky_project', 'rocky-settings.json'), 'x');
    writeFileSync(join(ws, '.claude', 'rocky-notes.md'), 'x');

    // 目录名命中 → dirs（点开头目录本身可命中）
    const r1 = searchWorkspace(ws, 'rocky_project');
    expect(r1.dirs).toContain('.rocky_project');
    expect(r1.files).toEqual([]);
    // 点开头目录下层可命中：.claude 目录名不含 rocky → 递归其下层 → rocky-notes.md 命中；
    // .rocky_project 目录名含 rocky → 命中不递归 → rocky-settings.json 不返回
    const r2 = searchWorkspace(ws, 'rocky');
    expect(r2.dirs).toContain('.rocky_project');
    expect(r2.files).toContain('.claude/rocky-notes.md');
    expect(r2.files).not.toContain('.rocky_project/rocky-settings.json');
    // 下层文件独立命中：.rocky_project 目录名不含 settings → 递归 → settings 文件命中
    const r3 = searchWorkspace(ws, 'settings');
    expect(r3.files).toEqual(['.rocky_project/rocky-settings.json']);
  });

  it(`${SEARCH_LIMIT} 早停：files+dirs 合计 ≥ limit → truncated:true 且不超限`, () => {
    const ws = makeWs();
    for (let i = 0; i < 150; i++) {
      writeFileSync(join(ws, `hit-${i}.txt`), 'x');
    }

    const r = searchWorkspace(ws, 'hit-');
    expect(r.truncated).toBe(true);
    expect(r.files.length + r.dirs.length).toBeLessThanOrEqual(SEARCH_LIMIT);
    expect(r.files.length).toBe(SEARCH_LIMIT);
  });

  it('未达上限 → truncated:false', () => {
    const ws = makeWs();
    writeFileSync(join(ws, 'small.txt'), 'x');

    const r = searchWorkspace(ws, 'small');
    expect(r.files).toEqual(['small.txt']);
    expect(r.truncated).toBe(false);
  });

  it('[v0.0.360] symlink→dir 受控跟随：workspace 内链接 = 授权，目标内文件可命中（目标可在 workspace 外）', () => {
    const ws = makeWs();
    const outside = mkdtempSync(join(tmpdir(), 'oobt-searchcore-out-'));
    tmpRoots.push(outside);
    try {
      writeFileSync(join(outside, 'secret-helper.txt'), 'secret');
      symlinkSync(outside, join(ws, 'link'));
      writeFileSync(join(ws, 'inside-helper.txt'), 'x');

      const r = searchWorkspace(ws, 'helper');
      // 语义翻转核心：经 workspace 内 symlink 进入的目标目录递归跟随，其内文件按链接路径返回
      expect(r.files).toContain('inside-helper.txt');
      expect(r.files).toContain('link/secret-helper.txt');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('[v0.0.360] 循环引用不死循环：self/祖先链接 realpath 归一后去重，正常返回', () => {
    const ws = makeWs();
    // self → 根（自指循环）
    symlinkSync(ws, join(ws, 'self'));
    // 祖先回环：sub/back → sub（祖先指向）
    mkdirSync(join(ws, 'sub'), { recursive: true });
    symlinkSync(join(ws, 'sub'), join(ws, 'sub', 'back'));
    writeFileSync(join(ws, 'self-helper.txt'), 'x');
    writeFileSync(join(ws, 'sub', 'helper.txt'), 'x');

    const r = searchWorkspace(ws, 'helper');
    // 循环未导致无限递归 → 正常返回；各自真实文件命中
    expect(r.files).toEqual(expect.arrayContaining(['self-helper.txt', 'sub/helper.txt']));
    expect(r.truncated).toBe(false);
  });

  it('[v0.0.360] 多级 symlink 链跟随（a→b→file 链式授权逐段解析）+ broken symlink 跳过', () => {
    const ws = makeWs();
    const outside = mkdtempSync(join(tmpdir(), 'oobt-searchcore-chain-'));
    tmpRoots.push(outside);
    try {
      mkdirSync(join(outside, 'docs'), { recursive: true });
      writeFileSync(join(outside, 'docs', 'guide-helper.md'), 'x');
      // 链式（两段均在 workspace 外也无妨——逐段解析直至真实目录）：
      //   outside/docs 真目录 → outside/b 链 → ws/a 链；ws 内唯一入口 = a
      symlinkSync(join(outside, 'docs'), join(outside, 'b'));
      symlinkSync(join(outside, 'b'), join(ws, 'a'));
      // broken：指向不存在目标
      symlinkSync(join(ws, 'no-such-target'), join(ws, 'broken'));

      const r = searchWorkspace(ws, 'helper');
      // 多级链逐段跟随（a → b → docs，含链中间段在 workspace 外）：guide-helper.md 经最外层
      //   链接路径返回；ws 内 a 是唯一入口 → 断言无 readdir 顺序依赖
      expect(r.files).toEqual(['a/guide-helper.md']);
      // broken symlink → statSync 失败 → 跳过（不崩、不进结果）
      expect(r.files.some((p: string) => p.startsWith('broken'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('relRoot 参数化：从子目录起搜，返回路径仍相对 rootDir（带 relRoot 前缀）', () => {
    const ws = makeWs();
    mkdirSync(join(ws, 'src', 'auth'), { recursive: true });
    mkdirSync(join(ws, 'lib'), { recursive: true });
    writeFileSync(join(ws, 'src', 'auth', 'login.ts'), 'x');
    writeFileSync(join(ws, 'lib', 'auth-util.ts'), 'x');

    // q=login：src/auth 目录名不含 login → 递归其下层 → login.ts 命中（路径带 src/ 前缀）；
    // lib/ 不在 relRoot=src 范围内 → 不遍历
    const r = searchWorkspace(ws, 'login', { relRoot: 'src' });
    expect(r.files).toEqual(['src/auth/login.ts']);
    expect(r.files.some((p: string) => p.startsWith('lib/'))).toBe(false);
  });
});
