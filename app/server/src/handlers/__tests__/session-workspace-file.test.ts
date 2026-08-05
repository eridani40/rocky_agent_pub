/**
 * session-workspace-file handler UT — GET file / POST file/save（v0.0.227）
 * 参考: specs/api/overall/04-agent-session.md §2.6.7（端点契约）
 *       specs/prd/version_logs/v0.0.227.md
 *       specs/tech/version_logs/v0.0.227/change_plan.md（test-ut 行）
 *
 * 覆盖 test-plan §2 必覆盖清单：
 *   GET：正常读 / traversal（../ + 绝对路径 + symlink 外部）→ 400 / not_found→404 / 三类 4xx+405
 *   POST save：正常覆盖写 / round-trip / body+path+content 三类 400 / traversal 不落盘 /
 *               symlink 不落盘到外部 / not_found→404（不新建）
 *
 * 文件系统隔离：tmpdir + mkdtemp + beforeEach/afterEach rm（no-mock fs，对齐 test-plan §2）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { ulid } from '../../config/ulid';
import { handleWorkspaceFileRead, handleWorkspaceFileSave } from '../session-workspace-file';
import type { SessionHandlerDeps } from '../session';
import type { AgentManagerImpl } from '../../agent/agent-manager';

let tmpRoot: string;
let ws: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-wsfile-root-'));
  ws = mkdtempSync(join(tmpdir(), 'oobt-wsfile-ws-'));
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

/** 构造空 SessionHandlerDeps（file 读/存不依赖其他 deps） */
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

// ============================================================
// GET /session/:id/workspace/file
// ============================================================

describe('GET /session/:id/workspace/file', () => {
  it('正常读 UTF-8 文本（含子目录路径）→ 200 + {content}', async () => {
    const md = '# Notes\n\n你好 world';
    mkdirSync(join(ws, 'docs'), { recursive: true });
    writeFileSync(join(ws, 'docs', 'notes.md'), md);
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=docs/notes.md`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    expect((await body(res)).content).toBe(md);
  });

  it('路径穿越 ../etc/passwd → 400（字符串前缀层挡）', async () => {
    writeFileSync(join(ws, 'a.md'), 'x');
    const sid = await newSessionWithWorkspace(ws);
    const res = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=../etc/passwd`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatch(/traversal|out of workspace/i);
  });

  it('绝对路径注入 /etc/passwd → 400', async () => {
    writeFileSync(join(ws, 'a.md'), 'x');
    const sid = await newSessionWithWorkspace(ws);
    const res = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=/etc/passwd`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  it('symlink 穿越外部 → 400（realpath 层挡）', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'oobt-wsfile-out-'));
    try {
      writeFileSync(join(outside, 'secret.md'), 'topsecret');
      symlinkSync(outside, join(ws, 'escape')); // ws/escape -> outside
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceFileRead(
        new Request(`http://x/session/${sid}/workspace/file?path=escape/secret.md`),
        'GET', sid, makeDeps(),
      );
      expect(res.status).toBe(400);
      expect((await body(res)).error).toMatch(/traversal|out of workspace/i);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('文件不存在 → 404', async () => {
    const sid = await newSessionWithWorkspace(ws);
    const res = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=missing.md`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(404);
  });

  it('path 缺失 / session 不存在 / 非 GET → 400 / 404 / 405', async () => {
    const sid = await newSessionWithWorkspace(ws);
    // path 缺失
    const r1 = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file`), 'GET', sid, makeDeps(),
    );
    expect(r1.status).toBe(400);
    // session 不存在
    const r2 = await handleWorkspaceFileRead(
      new Request(`http://x/session/01KVNOPE/workspace/file?path=a.md`), 'GET', '01KVNOPE', makeDeps(),
    );
    expect(r2.status).toBe(404);
    // 非 GET
    const r3 = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=a.md`), 'POST', sid, makeDeps(),
    );
    expect(r3.status).toBe(405);
    expect(r3.headers.get('allow')).toBe('GET');
  });
});

// ============================================================
// POST /session/:id/workspace/file/save
// ============================================================

describe('POST /session/:id/workspace/file/save', () => {
  it('正常覆盖写 → 200 + {ok:true}，readFileSync 取回新内容', async () => {
    writeFileSync(join(ws, 'notes.md'), '旧内容');
    const sid = await newSessionWithWorkspace(ws);
    const newContent = '# 新内容\n\n更新后';

    const res = await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'notes.md', content: newContent }),
      }),
      'POST', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    expect((await body(res)).ok).toBe(true);
    // 真实落盘验证（no-mock fs）
    expect(readFileSync(join(ws, 'notes.md'), 'utf8')).toBe(newContent);
  });

  it('round-trip：save 后 read 取回等值', async () => {
    writeFileSync(join(ws, 'rt.md'), '初始');
    const sid = await newSessionWithWorkspace(ws);
    const deps = makeDeps();
    const payload = 'round-trip 内容 ' + Date.now();

    await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'rt.md', content: payload }),
      }),
      'POST', sid, deps,
    );
    const res = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=rt.md`),
      'GET', sid, deps,
    );
    expect(res.status).toBe(200);
    expect((await body(res)).content).toBe(payload);
  });

  it('content 空串 → 200（合法=清空文件）', async () => {
    writeFileSync(join(ws, 'a.md'), '旧内容');
    const sid = await newSessionWithWorkspace(ws);
    const res = await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'a.md', content: '' }),
      }),
      'POST', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    expect(readFileSync(join(ws, 'a.md'), 'utf8')).toBe('');
  });

  it('body 非法 JSON / path 非 string / content 非 string → 400', async () => {
    writeFileSync(join(ws, 'a.md'), 'x');
    const sid = await newSessionWithWorkspace(ws);
    const post = (b: string) =>
      handleWorkspaceFileSave(
        new Request(`http://x/session/${sid}/workspace/file/save`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: b,
        }),
        'POST', sid, makeDeps(),
      );
    expect((await post('not-json')).status).toBe(400);
    expect((await post(JSON.stringify({ path: 123, content: 'x' }))).status).toBe(400);
    expect((await post(JSON.stringify({ path: 'a.md', content: 42 }))).status).toBe(400);
  });

  it('路径穿越 ../escape.md → 400 且不落盘（越界文件未写 + 原文件未变）', async () => {
    writeFileSync(join(ws, 'a.md'), 'keep');
    const sid = await newSessionWithWorkspace(ws);
    const res = await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '../escape.md', content: 'pwn' }),
      }),
      'POST', sid, makeDeps(),
    );
    expect(res.status).toBe(400);
    // 越界文件不落盘（ws 同级未新建 escape.md）+ 原文件未变
    expect(existsSync(join(ws, '..', 'escape.md'))).toBe(false);
    expect(readFileSync(join(ws, 'a.md'), 'utf8')).toBe('keep');
  });

  it('绝对路径注入 /tmp/... → 400', async () => {
    writeFileSync(join(ws, 'a.md'), 'x');
    const sid = await newSessionWithWorkspace(ws);
    const res = await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/tmp/oobt-wsfile-escape.md', content: 'pwn' }),
      }),
      'POST', sid, makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  it('symlink 穿越外部 → 400 且不覆盖外部文件', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'oobt-wsfile-save-out-'));
    try {
      writeFileSync(join(outside, 'secret.md'), 'orig');
      symlinkSync(outside, join(ws, 'escape')); // ws/escape -> outside
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceFileSave(
        new Request(`http://x/session/${sid}/workspace/file/save`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'escape/secret.md', content: 'pwn' }),
        }),
        'POST', sid, makeDeps(),
      );
      expect(res.status).toBe(400);
      // 外部文件未被覆盖
      expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('orig');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('文件不存在 → 404（last-write-wins 不新建）', async () => {
    const sid = await newSessionWithWorkspace(ws);
    const res = await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'newfile.md', content: 'x' }),
      }),
      'POST', sid, makeDeps(),
    );
    expect(res.status).toBe(404);
    expect(existsSync(join(ws, 'newfile.md'))).toBe(false);
  });

  it('session 不存在 / 非 POST → 404 / 405', async () => {
    writeFileSync(join(ws, 'a.md'), 'x');
    const sid = await newSessionWithWorkspace(ws);
    // session 不存在
    const r1 = await handleWorkspaceFileSave(
      new Request(`http://x/session/01KVNOPE/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'a.md', content: 'x' }),
      }),
      'POST', '01KVNOPE', makeDeps(),
    );
    expect(r1.status).toBe(404);
    // 非 POST
    const r2 = await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, { method: 'GET' }),
      'GET', sid, makeDeps(),
    );
    expect(r2.status).toBe(405);
    expect(r2.headers.get('allow')).toBe('POST');
  });
});
