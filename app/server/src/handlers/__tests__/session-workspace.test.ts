/**
 * session-workspace handler UT — GET tree / POST open / POST pick-directory（v0.0.17 T3）
 * 参考: specs/api/overall/04-agent-session.md §2.6（workspace 端点契约）
 *       specs/tech/agent/session/[P0]session_workspace.md §6（路径白名单 resolve+startsWith）
 *
 * 覆盖：
 *   GET tree：
 *     - 顶层（无 parent）返 workspaceDir 直接子项 + hasChildren（dir）
 *     - ignore node_modules / .git
 *     - 子目录 ?parent=src lazy（只返该层直接子项，不递归）
 *     - parent 字段（顶层=null；子目录=相对路径）
 *     - 路径白名单 ?parent=../../etc → 400
 *     - [v0.0.263] symlink 展开放行（?parent=escape → 200）+ isSymlink/linkTarget 字段 + 链式深层
 *     - [v0.0.263] 绝对路径注入 ?parent=/etc → 400（step1 前缀检查回归）
 *     - depth 非 [1,10] → 400
 *     - 404 session 不存在
 *   POST open：
 *     - file/folder kind + 200（spawn 经 deps mock，不真实打开系统应用）
 *     - spawn 失败 → 500（mock 失败分支）
 *     - 路径白名单 ../etc/passwd → 400
 *     - [v0.0.263] open symlink 目录（指向外部）→ 200（授权放行）
 *     - kind 非法 → 400
 *     - 路径不存在 → 404
 *   POST pick-directory：
 *     - 选定 → 200 + {path}；取消 → 200 + {path:null}；失败 → 500（均 dialog mock）
 *
 * 测试策略：真实 SessionStore（fs + tmpdir）+ 真实 fs 布局；spawn/dialog 经
 * SessionHandlerDeps.openWorkspaceItem / pickWorkspaceDirectory 注入 mock ——
 * 绝不真实 spawnSync('open'/'osascript')：macOS 会弹 Finder/编辑器/原生 dialog 到
 * 系统 GUI 层面（非 bash stderr，无法捕获，直接干扰用户）。不 vi.mock child_process
 * （学 T2 教训：避免模块缓存污染）。
 *
 * 文件系统隔离：tmpdir + mkdtemp + afterEach rm。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { ulid } from '../../config/ulid';
import {
  handleWorkspaceTree,
  handleWorkspaceOpen,
  handleWorkspacePickDirectory,
} from '../session-workspace';
import { handleSessionUpdate } from '../session-update';
import type { SessionHandlerDeps } from '../session';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { SessionWorkspaceManager } from '../../agent/session-workspace-manager';
import type { ReplayableEventBus } from '../../agent/event-bus';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-ws-handler-'));
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
});

/**
 * 构造空 SessionHandlerDeps。
 * open/pick spawn 默认 mock（绝不真实 spawnSync 系统命令 —— 避免 macOS 弹
 * Finder/编辑器/原生 dialog 到系统 GUI 层面，副作用不进 bash stderr 无法捕获）。
 * openResult / pickResult 可注入失败/取消分支。
 */
function makeDeps(opts: {
  workspaceManager?: SessionWorkspaceManager;
  openResult?: { ok: boolean; error?: string };
  pickResult?: { path: string | null; error?: string };
} = {}): SessionHandlerDeps {
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
    openWorkspaceItem: () => ({
      ok: opts.openResult?.ok ?? true,
      ...(opts.openResult?.error ? { error: opts.openResult.error } : {}),
    }),
    // opts.pickResult 存在就用其 path（含 null=取消语义，不能用 ?? —— null ?? x 会 fallback）
    pickWorkspaceDirectory: () =>
      opts.pickResult
        ? {
            path: opts.pickResult.path,
            ...(opts.pickResult.error ? { error: opts.pickResult.error } : {}),
          }
        : { path: '/mock/picked-by-test' },
    ...(opts.workspaceManager ? { workspaceManager: opts.workspaceManager } : {}),
  };
}

/** 创建 session 并手动指定 workspaceDir（绕过自动建目录，直接用我们准备的 tmpdir 子目录） */
async function newSessionWithWorkspace(workspaceDir: string): Promise<string> {
  const sid = ulid();
  await store.createSession({ id: sid, title: 'test', workspaceDir });
  return sid;
}

/** body 解析 helper */
async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

// ============================================================
// GET /session/:id/workspace/tree
// ============================================================

describe('GET /session/:id/workspace/tree', () => {
  it('顶层（无 parent）返 workspaceDir 直接子项 + hasChildren=true 对 dir', async () => {
    // 布局：workspaceDir/{a.ts, src/{auth/login.ts}}
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-tree-'));
    try {
      writeFileSync(join(ws, 'a.ts'), 'x');
      mkdirSync(join(ws, 'src'), { recursive: true });
      mkdirSync(join(ws, 'src', 'auth'), { recursive: true });
      writeFileSync(join(ws, 'src', 'auth', 'login.ts'), 'y');
      const sid = await newSessionWithWorkspace(ws);
      const deps = makeDeps();

      const res = await handleWorkspaceTree(
        new Request(`http://x/session/${sid}/workspace/tree`),
        'GET',
        sid,
        deps,
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(b.workspaceDir).toBe(ws);
      expect(b.parent).toBeNull();
      // tree 含 a.ts（file）+ src（dir，hasChildren=true）
      const src = b.tree.find((n: any) => n.name === 'src');
      const a = b.tree.find((n: any) => n.name === 'a.ts');
      expect(src).toBeTruthy();
      expect(src.type).toBe('dir');
      expect(src.hasChildren).toBe(true);
      expect(src.path).toBe('src');
      expect(a).toBeTruthy();
      expect(a.type).toBe('file');
      expect(a.hasChildren).toBe(false);
      // 无 children 字段递归（lazy 一层）
      expect(src.children).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('ignore node_modules / .git（与 chokidar WATCH_OPTIONS 一致）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-ignore-'));
    try {
      mkdirSync(join(ws, 'node_modules'), { recursive: true });
      mkdirSync(join(ws, '.git'), { recursive: true });
      writeFileSync(join(ws, 'keep.ts'), 'x');
      const sid = await newSessionWithWorkspace(ws);

      const res = await handleWorkspaceTree(
        new Request(`http://x/session/${sid}/workspace/tree`),
        'GET',
        sid,
        makeDeps(),
      );
      const b = await body(res);
      const names = b.tree.map((n: any) => n.name);
      expect(names).not.toContain('node_modules');
      expect(names).not.toContain('.git');
      expect(names).toContain('keep.ts');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('?parent=src 返 src 直接子项（lazy，不递归 auth/ 下）+ parent 字段="src"', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-parent-'));
    try {
      mkdirSync(join(ws, 'src', 'auth'), { recursive: true });
      writeFileSync(join(ws, 'src', 'auth', 'login.ts'), 'y');
      writeFileSync(join(ws, 'src', 'root.ts'), 'z');
      const sid = await newSessionWithWorkspace(ws);

      const res = await handleWorkspaceTree(
        new Request(`http://x/session/${sid}/workspace/tree?parent=src`),
        'GET',
        sid,
        makeDeps(),
      );
      const b = await body(res);
      expect(b.parent).toBe('src');
      const names = b.tree.map((n: any) => n.name).sort();
      // src 直接子项：auth/（dir）+ root.ts（file）；不递归 auth/login.ts
      expect(names).toEqual(['auth', 'root.ts']);
      const auth = b.tree.find((n: any) => n.name === 'auth');
      expect(auth.hasChildren).toBe(true);
      expect(auth.children).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('?parent=../../etc 路径白名单越界 → 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-white-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceTree(
        new Request(`http://x/session/${sid}/workspace/tree?parent=../../etc`),
        'GET',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(400);
      const b = await body(res);
      expect(b.error).toMatch(/traversal|out of workspace/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('?depth=11 非 [1,10] → 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-depth-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceTree(
        new Request(`http://x/session/${sid}/workspace/tree?depth=11`),
        'GET',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('[v0.0.263] ?parent=escape（workspace 内 symlink 指向外部）→ 200 返回目标内容（授权放行，UC-2）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'oobt-ws-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'topsecret');
      symlinkSync(outside, join(ws, 'escape')); // ws/escape -> outside（越界 symlink）
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceTree(
        new Request(`http://x/session/${sid}/workspace/tree?parent=escape`),
        'GET',
        sid,
        makeDeps(),
      );
      // 本版本行为变更：workspace 内存在的 symlink = 用户放置 = 授权 → 展开返回目标内容（非 400）
      expect(res.status).toBe(200);
      const b = await body(res);
      const names = b.tree.map((n: any) => n.name);
      expect(names).toContain('secret.txt'); // 外部目录内容可见
      // 子节点 path 保留 symlink 段（前端可继续链式展开/打开）
      const secret = b.tree.find((n: any) => n.name === 'secret.txt');
      expect(secret.path).toBe('escape/secret.txt');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('[v0.0.263] 顶层 tree 对 symlink 节点返回 isSymlink:true + linkTarget（type 保持真实类型）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-symlink-field-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'oobt-ws-outdir-'));
    const outsideFile = join(tmpdir(), `oobt-ws-outfile-${Date.now()}.txt`);
    try {
      mkdirSync(join(outsideDir, 'nested'), { recursive: true }); // 让 symlink→dir hasChildren=true
      writeFileSync(outsideFile, 'x');
      symlinkSync(outsideDir, join(ws, 'linkdir')); // symlink → dir
      symlinkSync(outsideFile, join(ws, 'linkfile')); // symlink → file
      writeFileSync(join(ws, 'plain.ts'), 'y'); // 普通文件（无字段）
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceTree(
        new Request(`http://x/session/${sid}/workspace/tree`),
        'GET',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      const linkdir = b.tree.find((n: any) => n.name === 'linkdir');
      expect(linkdir.isSymlink).toBe(true);
      // realpath 绝对路径（macOS /var → /private/var，linkTarget 是 realpath 后值）
      expect(linkdir.linkTarget).toBe(realpathSync(outsideDir));
      expect(linkdir.type).toBe('dir'); // statSync 跟随后的真实类型
      expect(linkdir.hasChildren).toBe(true); // symlink→dir 沿用 dirHasChildren
      const linkfile = b.tree.find((n: any) => n.name === 'linkfile');
      expect(linkfile.isSymlink).toBe(true);
      expect(linkfile.linkTarget).toBe(realpathSync(outsideFile));
      expect(linkfile.type).toBe('file');
      const plain = b.tree.find((n: any) => n.name === 'plain.ts');
      expect(plain.isSymlink).toBeUndefined(); // 非 symlink 缺省（旧响应零差异）
      expect(plain.linkTarget).toBeUndefined();
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
      rmSync(outsideFile, { force: true });
    }
  });

  it('[v0.0.263] 链式深层：?parent=escape/sub（symlink 目录内子目录）→ 200（UC-3）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-symlink-chain-'));
    const outside = mkdtempSync(join(tmpdir(), 'oobt-ws-chain-out-'));
    try {
      mkdirSync(join(outside, 'sub'), { recursive: true });
      writeFileSync(join(outside, 'sub', 'inner.txt'), 'inner');
      symlinkSync(outside, join(ws, 'escape')); // ws/escape -> outside
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceTree(
        new Request(`http://x/session/${sid}/workspace/tree?parent=escape/sub`),
        'GET',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      const names = b.tree.map((n: any) => n.name);
      expect(names).toContain('inner.txt');
      expect(b.tree.find((n: any) => n.name === 'inner.txt').path).toBe('escape/sub/inner.txt');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('[v0.0.263] 未授权越界回归：绝对路径注入 ?parent=/etc → 400（step1 前缀检查）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-white-abs-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceTree(
        new Request(`http://x/session/${sid}/workspace/tree?parent=/etc`),
        'GET',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(400);
      const b = await body(res);
      expect(b.error).toMatch(/traversal|out of workspace/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('404 session 不存在', async () => {
    const res = await handleWorkspaceTree(
      new Request('http://x/session/nope/workspace/tree'),
      'GET',
      'nope',
      makeDeps(),
    );
    expect(res.status).toBe(404);
  });

  it('405 非 GET', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspaceTree(
      new Request(`http://x/session/${sid}/workspace/tree`, { method: 'POST' }),
      'POST',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(405);
  });
});

// ============================================================
// POST /session/:id/workspace/open
// ============================================================

describe('POST /session/:id/workspace/open', () => {
  it('kind=file 真实文件 → 200 + {ok:true}（spawn mock，不真实打开系统应用）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-open-'));
    try {
      writeFileSync(join(ws, 'a.ts'), 'x');
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceOpen(
        new Request(`http://x/session/${sid}/workspace/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'a.ts', kind: 'file' }),
        }),
        'POST',
        sid,
        makeDeps(), // spawn mock → 不真实打开编辑器
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(b.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('kind=file spawn 失败 → 500（mock open 失败分支）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-open-fail-'));
    try {
      writeFileSync(join(ws, 'a.ts'), 'x');
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceOpen(
        new Request(`http://x/session/${sid}/workspace/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'a.ts', kind: 'file' }),
        }),
        'POST',
        sid,
        makeDeps({ openResult: { ok: false, error: 'spawn ENOENT (mock)' } }),
      );
      expect(res.status).toBe(500);
      const b = await body(res);
      expect(b.error).toMatch(/spawn|ENOENT/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('kind=folder 真实目录 → 200 + {ok:true}（spawn mock）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-open-folder-'));
    try {
      mkdirSync(join(ws, 'subdir'));
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceOpen(
        new Request(`http://x/session/${sid}/workspace/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'subdir', kind: 'folder' }),
        }),
        'POST',
        sid,
        makeDeps(), // spawn mock → 不真实打开 Finder
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(b.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('路径白名单越界（../etc/passwd）→ 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-open-white-'));
    try {
      writeFileSync(join(ws, 'a.ts'), 'x');
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceOpen(
        new Request(`http://x/session/${sid}/workspace/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '../etc/passwd', kind: 'file' }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(400);
      const b = await body(res);
      expect(b.error).toMatch(/traversal|out of workspace/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('[v0.0.263] open symlink 目录（指向外部）→ 200（授权放行，UC-5，spawn mock）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-open-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'oobt-ws-open-outside-'));
    try {
      writeFileSync(join(outside, 'secret.txt'), 'topsecret');
      symlinkSync(outside, join(ws, 'escape')); // ws/escape -> outside
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceOpen(
        new Request(`http://x/session/${sid}/workspace/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'escape', kind: 'folder' }),
        }),
        'POST',
        sid,
        makeDeps(), // spawn mock → 不真实打开 Finder
      );
      // 本版本行为变更：workspace 内 symlink = 授权 → open 放行（非 400）
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(b.ok).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('kind 非法 → 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-open-kind-'));
    try {
      writeFileSync(join(ws, 'a.ts'), 'x');
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceOpen(
        new Request(`http://x/session/${sid}/workspace/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'a.ts', kind: 'invalid' }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('路径不存在 → 404', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-open-404-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceOpen(
        new Request(`http://x/session/${sid}/workspace/open`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'does-not-exist.ts', kind: 'file' }),
        }),
        'POST',
        sid,
        makeDeps(),
      );
      expect(res.status).toBe(404);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('404 session 不存在', async () => {
    const res = await handleWorkspaceOpen(
      new Request('http://x/session/nope/workspace/open', {
        method: 'POST',
        body: JSON.stringify({ path: 'a', kind: 'file' }),
      }),
      'POST',
      'nope',
      makeDeps(),
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================
// POST /session/:id/workspace/pick-directory
// ============================================================

describe('POST /session/:id/workspace/pick-directory', () => {
  it('用户选定目录 → 200 + {path:string}（dialog mock）', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspacePickDirectory(
      new Request(`http://x/session/${sid}/workspace/pick-directory`, {
        method: 'POST',
      }),
      'POST',
      sid,
      makeDeps({ pickResult: { path: '/mock/picked-dir' } }),
    );
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.path).toBe('/mock/picked-dir');
  });

  it('用户取消 dialog → 200 + {path:null}（取消非错误，spec §2.6.3）', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspacePickDirectory(
      new Request(`http://x/session/${sid}/workspace/pick-directory`, {
        method: 'POST',
      }),
      'POST',
      sid,
      makeDeps({ pickResult: { path: null } }),
    );
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.path).toBeNull();
  });

  it('dialog spawn 失败 → 500（mock dialog 失败分支）', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspacePickDirectory(
      new Request(`http://x/session/${sid}/workspace/pick-directory`, {
        method: 'POST',
      }),
      'POST',
      sid,
      makeDeps({ pickResult: { path: null, error: 'osascript not found (mock)' } }),
    );
    expect(res.status).toBe(500);
  });

  it('currentDir 相对路径 → 400（必须绝对路径）', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspacePickDirectory(
      new Request(`http://x/session/${sid}/workspace/pick-directory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentDir: 'relative/path' }),
      }),
      'POST',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  it('404 session 不存在', async () => {
    const res = await handleWorkspacePickDirectory(
      new Request('http://x/session/nope/workspace/pick-directory', {
        method: 'POST',
      }),
      'POST',
      'nope',
      makeDeps(),
    );
    expect(res.status).toBe(404);
  });
});

// ============================================================
// PUT /session/:id（session-update 切 workspaceDir）
// ============================================================

/**
 * 构造 mock SessionWorkspaceManager，记录 switchDir 调用。
 * [v0.0.139] 懒监听重构后 switchDir 内部语义变为 recycleSession→setDirCb（不重启），
 * 但本文件只关心 PUT handler 是否正确调用 switchDir 及其参数/顺序——mock 内部用
 * stopCalls/startCalls 命名沿用旧「stop→set→start」叙事仅作调用顺序探针，不代表真实
 * manager 仍有 startWatch/stopWatch 方法（该二方法已随 v0.0.139 重写删除，见
 * session-workspace-manager.ts）。
 */
function makeMockWorkspaceManager(opts: { hadWatcher?: boolean } = {}): SessionWorkspaceManager & {
  switchDirCalls: { sid: string; newDir: string }[];
  startCalls: { sid: string; dir: string }[];
  stopCalls: { sid: string }[];
} {
  const switchDirCalls: { sid: string; newDir: string }[] = [];
  const startCalls: { sid: string; dir: string }[] = [];
  const stopCalls: { sid: string }[] = [];
  const hadWatcher = opts.hadWatcher ?? true;
  const fake = {
    switchDir: vi.fn(
      async (
        sid: string,
        newDir: string,
        setDirCb: (s: string, d: string) => Promise<void>,
      ): Promise<void> => {
        switchDirCalls.push({ sid, newDir });
        stopCalls.push({ sid });
        await setDirCb(sid, newDir);
        if (hadWatcher) startCalls.push({ sid, dir: newDir });
      },
    ),
    stopAll: vi.fn(async () => {}),
    getStatus: vi.fn(() => []),
  };
  return Object.assign(fake as unknown as SessionWorkspaceManager, {
    switchDirCalls,
    startCalls,
    stopCalls,
  });
}

describe('PUT /session/:id 切 workspaceDir（session-update）', () => {
  it('200：校验通过 → manager.switchDir 调用 + setWorkspaceDir emit dir_changed + 返更新 Session', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-old-'));
    const newDir = mkdtempSync(join(tmpdir(), 'oobt-ws-new-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeMockWorkspaceManager({ hadWatcher: true });
      const deps = makeDeps({ workspaceManager: wm });

      const res = await handleSessionUpdate(
        new Request(`http://x/session/${sid}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceDir: newDir }),
        }),
        'PUT',
        sid,
        deps,
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(b.workspaceDir).toBe(newDir);
      // switchDir 被调（编排 stop→set→start）
      expect(wm.switchDirCalls).toEqual([{ sid, newDir }]);
      // 持久化：重新 getSession 验字段
      const got = await store.getSession(sid);
      expect(got?.workspaceDir).toBe(newDir);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(newDir, { recursive: true, force: true });
    }
  });

  it('manager.switchDir 编排顺序：stop 在前 setDirCb 中间 start 在后（hadWatcher=true 时 start）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-order-old-'));
    const newDir = mkdtempSync(join(tmpdir(), 'oobt-ws-order-new-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeMockWorkspaceManager({ hadWatcher: true });
      const deps = makeDeps({ workspaceManager: wm });

      await handleSessionUpdate(
        new Request(`http://x/session/${sid}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceDir: newDir }),
        }),
        'PUT',
        sid,
        deps,
      );
      // mock 的 switchDir 严格按 stop → setDirCb → start 顺序调用
      expect(wm.switchDirCalls.length).toBe(1);
      expect(wm.stopCalls.length).toBe(1); // stop 在前
      expect(wm.startCalls.length).toBe(1); // hadWatcher=true → start
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(newDir, { recursive: true, force: true });
    }
  });

  it('400：newDir 不存在 → 不调 switchDir + 不更新', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-400-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeMockWorkspaceManager({ hadWatcher: true });
      const deps = makeDeps({ workspaceManager: wm });

      const res = await handleSessionUpdate(
        new Request(`http://x/session/${sid}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceDir: '/nonexistent/path/xyz' }),
        }),
        'PUT',
        sid,
        deps,
      );
      expect(res.status).toBe(400);
      expect(wm.switchDirCalls.length).toBe(0);
      // 字段未变
      const got = await store.getSession(sid);
      expect(got?.workspaceDir).toBe(ws);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('400：newDir 非绝对路径 → 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-rel-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const deps = makeDeps();

      const res = await handleSessionUpdate(
        new Request(`http://x/session/${sid}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceDir: 'relative/path' }),
        }),
        'PUT',
        sid,
        deps,
      );
      expect(res.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('400：newDir 是文件而非目录 → 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-file-'));
    const file = join(tmpRoot, 'notdir.txt');
    writeFileSync(file, 'x');
    try {
      const sid = await newSessionWithWorkspace(ws);
      const deps = makeDeps();

      const res = await handleSessionUpdate(
        new Request(`http://x/session/${sid}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceDir: file }),
        }),
        'PUT',
        sid,
        deps,
      );
      expect(res.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('404 session 不存在', async () => {
    const newDir = mkdtempSync(join(tmpdir(), 'oobt-ws-404-new-'));
    try {
      const res = await handleSessionUpdate(
        new Request('http://x/session/nope', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceDir: newDir }),
        }),
        'PUT',
        'nope',
        makeDeps(),
      );
      expect(res.status).toBe(404);
    } finally {
      rmSync(newDir, { recursive: true, force: true });
    }
  });

  it('无 workspaceManager 注入时仍能切目录（直接 store.setWorkspaceDir，无 watch 联动）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-nomanager-old-'));
    const newDir = mkdtempSync(join(tmpdir(), 'oobt-ws-nomanager-new-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const deps = makeDeps(); // 无 workspaceManager

      const res = await handleSessionUpdate(
        new Request(`http://x/session/${sid}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceDir: newDir }),
        }),
        'PUT',
        sid,
        deps,
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(b.workspaceDir).toBe(newDir);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(newDir, { recursive: true, force: true });
    }
  });
});
