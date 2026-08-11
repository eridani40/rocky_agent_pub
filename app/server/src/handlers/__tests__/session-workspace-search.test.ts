/**
 * session-workspace-search handler UT — GET /session/:id/workspace/search（v0.0.320）
 * 参考: specs/api/version_logs/v0.0.320/change_log.md §1.3（端点契约）
 *       specs/tech/version_logs/v0.0.320/change_plan.md D10
 *
 * 覆盖 test-plan §2 必覆盖清单：
 *   搜索命中文件名 / 命中文件夹名 / ignore node_modules/.git / 200 上限截断 + truncated /
 *   空 q → 400 / 无匹配 → 200 空结果 / 大小写不敏感 / 405 / 404 session / symlink 目录不跟随
 *
 * 文件系统隔离：tmpdir + mkdtemp + beforeEach/afterEach rm（no-mock fs，对齐 test-plan §2）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { ulid } from '../../config/ulid';
import { handleWorkspaceSearch } from '../session-workspace-search';
import type { SessionHandlerDeps } from '../session';
import type { AgentManagerImpl } from '../../agent/agent-manager';

let tmpRoot: string;
let ws: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-wssearch-root-'));
  ws = mkdtempSync(join(tmpdir(), 'oobt-wssearch-ws-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(ws, { recursive: true, force: true });
});

/** 构造空 SessionHandlerDeps（search 不依赖其他 deps） */
function makeDeps(): SessionHandlerDeps {
  const fake = {
    abort: async () => ({ accepted: false }),
    clearReplay: () => undefined,
  };
  return {
    store,
    agentManager: fake as unknown as AgentManagerImpl,
    appConfig: {} as never,
    pluginManager: {} as never,
    contextEngine: {} as never,
    dataDir: tmpRoot,
  };
}

/** 创建 session 并手动指定 workspaceDir */
async function newSessionWithWorkspace(workspaceDir: string): Promise<string> {
  const sid = ulid();
  await store.createSession({ id: sid, title: 'test', workspaceDir });
  return sid;
}

/** body 解析 helper */
async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

describe('GET /session/:id/workspace/search', () => {
  it('命中文件名 + 文件夹名 → 200 {files,dirs} 全路径（相对 workspaceDir）', async () => {
    mkdirSync(join(ws, 'src', 'utils'), { recursive: true });
    mkdirSync(join(ws, 'src', 'helper-dir'), { recursive: true });
    writeFileSync(join(ws, 'src', 'helper.ts'), 'x');
    writeFileSync(join(ws, 'src', 'utils', 'helper-utils.ts'), 'x');
    writeFileSync(join(ws, 'src', 'helper-dir', 'readme.md'), 'x');
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceSearch(
      new Request(`http://x/session/${sid}/workspace/search?q=helper`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    expect(parsed.files).toEqual(expect.arrayContaining(['src/helper.ts', 'src/utils/helper-utils.ts']));
    expect(parsed.dirs).toEqual(expect.arrayContaining(['src/helper-dir']));
    // 相对路径（不以 / 开头，无 workspaceDir 前缀）
    for (const p of [...parsed.files, ...parsed.dirs]) {
      expect(p.startsWith('/')).toBe(false);
      expect(p.includes('oobt-wssearch-ws')).toBe(false);
    }
  });

  it('大小写不敏感 substring 匹配（q=HELPER 命中 helper.ts）', async () => {
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'MyHelper.ts'), 'x');
    writeFileSync(join(ws, 'src', 'other.txt'), 'x');
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceSearch(
      new Request(`http://x/session/${sid}/workspace/search?q=MYHELPER`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    expect(parsed.files).toContain('src/MyHelper.ts');
    expect(parsed.files).not.toContain('src/other.txt');
  });

  it('ignore node_modules/.git：其内文件/目录不返回', async () => {
    mkdirSync(join(ws, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeFileSync(join(ws, 'node_modules', 'pkg', 'helper.js'), 'x');
    writeFileSync(join(ws, '.git', 'helper-config'), 'x');
    writeFileSync(join(ws, 'real-helper.txt'), 'x');
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceSearch(
      new Request(`http://x/session/${sid}/workspace/search?q=helper`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    expect(parsed.files).toContain('real-helper.txt');
    expect(parsed.files.some((p: string) => p.includes('node_modules'))).toBe(false);
    expect(parsed.files.some((p: string) => p.includes('.git'))).toBe(false);
    expect(parsed.dirs.some((p: string) => p.includes('node_modules'))).toBe(false);
    expect(parsed.dirs.some((p: string) => p.includes('.git'))).toBe(false);
  });

  it('100 上限截断：files+dirs 合计 ≥100 → truncated:true 且不超限', async () => {
    // 生成 150 个命中文件（平铺），保证超 100 上限
    for (let i = 0; i < 150; i++) {
      writeFileSync(join(ws, `hit-${i}.txt`), 'x');
    }
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceSearch(
      new Request(`http://x/session/${sid}/workspace/search?q=hit-`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    expect(parsed.truncated).toBe(true);
    expect(parsed.files.length + parsed.dirs.length).toBeLessThanOrEqual(100);
  });

  it('未达上限 → truncated 缺省（undefined）', async () => {
    writeFileSync(join(ws, 'small.txt'), 'x');
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceSearch(
      new Request(`http://x/session/${sid}/workspace/search?q=small`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    expect(parsed.files).toEqual(['small.txt']);
    expect(parsed.truncated).toBeUndefined();
  });

  it('q 缺失 / 空串 / 纯空白 → 400 {error:q required}', async () => {
    writeFileSync(join(ws, 'a.txt'), 'x');
    const sid = await newSessionWithWorkspace(ws);
    const search = (url: string) =>
      handleWorkspaceSearch(new Request(url), 'GET', sid, makeDeps());
    // 缺失
    const r1 = await search(`http://x/session/${sid}/workspace/search`);
    expect(r1.status).toBe(400);
    expect((await body(r1)).error).toBe('q required');
    // 空串
    const r2 = await search(`http://x/session/${sid}/workspace/search?q=`);
    expect(r2.status).toBe(400);
    // 纯空白
    const r3 = await search(`http://x/session/${sid}/workspace/search?q=%20%20`);
    expect(r3.status).toBe(400);
  });

  it('无匹配 → 200 {files:[], dirs:[]}（非 404）', async () => {
    writeFileSync(join(ws, 'a.txt'), 'x');
    const sid = await newSessionWithWorkspace(ws);
    const res = await handleWorkspaceSearch(
      new Request(`http://x/session/${sid}/workspace/search?q=zzz-no-match`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ files: [], dirs: [] });
  });

  it('[安全] symlink 目录不跟随递归（目标出 workspace / 循环 → 不越权不卡死）', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'oobt-wssearch-out-'));
    try {
      writeFileSync(join(outside, 'secret-helper.txt'), 'secret');
      // ws/link -> outside（workspace 外）
      symlinkSync(outside, join(ws, 'link'));
      // ws/self -> ws（循环引用）
      symlinkSync(ws, join(ws, 'self'));
      writeFileSync(join(ws, 'inside-helper.txt'), 'x');
      const sid = await newSessionWithWorkspace(ws);

      const res = await handleWorkspaceSearch(
        new Request(`http://x/session/${sid}/workspace/search?q=helper`),
        'GET', sid, makeDeps(),
      );
      expect(res.status).toBe(200);
      const parsed = await body(res);
      // 只命中 workspace 内真实文件；symlink 目录本身不命中（link/self 目录名不含 helper）
      expect(parsed.files).toContain('inside-helper.txt');
      expect(parsed.files.some((p: string) => p.includes('secret-helper'))).toBe(false);
      // 不卡死（循环 self 未导致无限递归）→ 已正常返回即证明
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('[v0.0.324] q 含 `/` → 匹配完整相对路径（relChild 子串），不匹配 basename', async () => {
    mkdirSync(join(ws, 'src', 'auth'), { recursive: true });
    mkdirSync(join(ws, 'src', 'api'), { recursive: true });
    // auth 路径下的文件（路径含 "auth/"）
    writeFileSync(join(ws, 'src', 'auth', 'login.ts'), 'x');
    writeFileSync(join(ws, 'src', 'auth', 'register.ts'), 'x');
    // api 路径下名为 auth.ts 的文件（basename 含 auth 但路径不含 "auth/"）
    writeFileSync(join(ws, 'src', 'api', 'auth.ts'), 'x');
    // 根目录名为 auth.ts 的文件（basename 含 auth 但路径不含 "auth/"）
    writeFileSync(join(ws, 'auth.ts'), 'x');
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceSearch(
      new Request(`http://x/session/${sid}/workspace/search?q=auth/`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    // 命中 src/auth/ 下的文件（完整相对路径含 "auth/" 子串）
    expect(parsed.files).toEqual(expect.arrayContaining(['src/auth/login.ts', 'src/auth/register.ts']));
    // 不命中 basename 含 auth 但路径不含 "auth/" 的文件
    expect(parsed.files).not.toContain('src/api/auth.ts');
    expect(parsed.files).not.toContain('auth.ts');
  });

  it('[v0.0.324] q 含 `/` 路径匹配大小写不敏感', async () => {
    mkdirSync(join(ws, 'src', 'Components'), { recursive: true });
    writeFileSync(join(ws, 'src', 'Components', 'Button.tsx'), 'x');
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceSearch(
      new Request(`http://x/session/${sid}/workspace/search?q=components/`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    expect(parsed.files).toContain('src/Components/Button.tsx');
  });

  it('[v0.0.324] q 不含 `/` → basename 匹配（行为不变，含路径中间段不命中）', async () => {
    mkdirSync(join(ws, 'src', 'auth'), { recursive: true });
    writeFileSync(join(ws, 'src', 'auth', 'login.ts'), 'x');
    // basename 含 "auth" 的目录命中（basename 匹配）
    mkdirSync(join(ws, 'auth-module'), { recursive: true });
    writeFileSync(join(ws, 'auth-module', 'index.ts'), 'x');
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceSearch(
      new Request(`http://x/session/${sid}/workspace/search?q=auth`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    // basename 匹配：auth-module 目录命中
    expect(parsed.dirs).toContain('auth-module');
    // login.ts basename 不含 auth → 不命中
    expect(parsed.files).not.toContain('src/auth/login.ts');
  });

  it('session 不存在 → 404；非 GET → 405', async () => {
    // session 不存在
    const r1 = await handleWorkspaceSearch(
      new Request('http://x/session/01KVNOPE/workspace/search?q=a'),
      'GET', '01KVNOPE', makeDeps(),
    );
    expect(r1.status).toBe(404);
    // 非 GET
    writeFileSync(join(ws, 'a.txt'), 'x');
    const sid = await newSessionWithWorkspace(ws);
    const r2 = await handleWorkspaceSearch(
      new Request(`http://x/session/${sid}/workspace/search?q=a`, { method: 'POST' }),
      'POST', sid, makeDeps(),
    );
    expect(r2.status).toBe(405);
    expect(r2.headers.get('allow')).toBe('GET');
  });
});
