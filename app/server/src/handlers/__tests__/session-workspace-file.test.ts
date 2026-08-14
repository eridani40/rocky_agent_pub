/**
 * session-workspace-file handler UT — GET file / POST file/save（v0.0.227）
 * 参考: specs/api/overall/04-agent-session.md §2.6.7（端点契约）
 *       specs/prd/version_logs/v0.0.227.md
 *       specs/tech/version_logs/v0.0.227/change_plan.md（test-ut 行）
 *
 * 覆盖 test-plan §2 必覆盖清单：
 *   GET：正常读 / traversal（../ + 绝对路径）→ 400 / symlink 外部读放行（v0.0.263 授权模型）/
 *        not_found→404 / 三类 4xx+405
 *   POST save：正常覆盖写 / round-trip / body+path+content 三类 400 / traversal 不落盘 /
 *               symlink 外部写放行（v0.0.263 授权模型）/ not_found→404（不新建）
 *
 * [v0.0.263] symlink 语义变更：workspace 内存在的 symlink = 用户放置 = 授权，读/写均放行
 *   （旧版本 400 拒绝；PRD §7 本版本行为变更）。未授权越界（非 symlink 段的 ../、绝对路径）仍 400。
 *
 * 文件系统隔离：tmpdir + mkdtemp + beforeEach/afterEach rm（no-mock fs，对齐 test-plan §2）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, symlinkSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { ulid } from '../../config/ulid';
import { handleWorkspaceFileRead, handleWorkspaceFileSave, handleWorkspaceStat } from '../session-workspace-file';
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

  it('[v0.0.320] 读文件返回 version（${mtimeMs}:${size} 格式，与 statSync 一致）', async () => {
    const md = '# version 测试';
    writeFileSync(join(ws, 'notes.md'), md);
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=notes.md`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    expect(parsed.content).toBe(md);
    // version = statSync 的 mtimeMs:size（确定性契约）
    const st = statSync(join(ws, 'notes.md'));
    expect(parsed.version).toBe(`${st.mtimeMs}:${st.size}`);
    expect(parsed.version).toMatch(/^\d+(\.\d+)?:\d+$/);
  });

  it('[v0.0.320] 文件内容变化（size 变化）→ version 变化', async () => {
    writeFileSync(join(ws, 'v.md'), 'aaaa');
    const sid = await newSessionWithWorkspace(ws);
    const r1 = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=v.md`),
      'GET', sid, makeDeps(),
    );
    const v1 = (await body(r1)).version;

    // 外部改文件（size 变大 → version 必变）
    writeFileSync(join(ws, 'v.md'), 'aaaa-bbbb-cccc');
    const r2 = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=v.md`),
      'GET', sid, makeDeps(),
    );
    const v2 = (await body(r2)).version;
    expect(v1).toMatch(/^\d+(\.\d+)?:\d+$/);
    expect(v2).toMatch(/^\d+(\.\d+)?:\d+$/);
    expect(v2).not.toBe(v1);
  });

  it('[v0.0.320] binary=1 分支不加 version（image 无冲突语义，向后兼容 {content}）', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(ws, 'img.png'), png);
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=img.png&binary=1`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    expect(typeof parsed.content).toBe('string');
    expect(parsed.version).toBeUndefined();
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

  it('[v0.0.263] symlink 文件读放行：path=escape/secret.md（指向外部）→ 200 内容正确（UC-4）', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'oobt-wsfile-out-'));
    try {
      writeFileSync(join(outside, 'secret.md'), 'topsecret');
      symlinkSync(outside, join(ws, 'escape')); // ws/escape -> outside
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceFileRead(
        new Request(`http://x/session/${sid}/workspace/file?path=escape/secret.md`),
        'GET', sid, makeDeps(),
      );
      // 本版本行为变更：workspace 内 symlink = 授权 → 读放行（非 400）
      expect(res.status).toBe(200);
      expect((await body(res)).content).toBe('topsecret');
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

  it('[v0.0.269] binary=1 → 读 Buffer 返 base64（图片二进制通道；UTF-8 读会乱码的内容可正确取回）', async () => {
    // 1x1 透明 PNG（含 NUL 字节，UTF-8 读会乱码）——验证 Buffer 读取而非 utf8 decode
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    mkdirSync(join(ws, 'img'), { recursive: true });
    writeFileSync(join(ws, 'img', 'dot.png'), png);
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=img/dot.png&binary=1`),
      'GET', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    expect(typeof parsed.content).toBe('string');
    // base64 取回后还原 == 原 Buffer（确定性契约）
    expect(Buffer.from(parsed.content, 'base64').equals(png)).toBe(true);
  });

  it('[v0.0.269] binary=1 白名单校验不变：traversal → 400 / 不存在 → 404', async () => {
    writeFileSync(join(ws, 'a.png'), 'x');
    const sid = await newSessionWithWorkspace(ws);
    // traversal
    const r1 = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=../etc/passwd&binary=1`),
      'GET', sid, makeDeps(),
    );
    expect(r1.status).toBe(400);
    // not_found
    const r2 = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=missing.png&binary=1`),
      'GET', sid, makeDeps(),
    );
    expect(r2.status).toBe(404);
  });

  it('[v0.0.269] binary 参数缺失/非 "1" → utf8 现状向后兼容', async () => {
    const md = '# Notes';
    writeFileSync(join(ws, 'a.md'), md);
    const sid = await newSessionWithWorkspace(ws);
    // 无 binary 参数
    const r1 = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=a.md`),
      'GET', sid, makeDeps(),
    );
    expect(r1.status).toBe(200);
    expect((await body(r1)).content).toBe(md);
    // binary=0（非 '1'）
    const r2 = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=a.md&binary=0`),
      'GET', sid, makeDeps(),
    );
    expect(r2.status).toBe(200);
    expect((await body(r2)).content).toBe(md);
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
    const parsed = await body(res);
    expect(parsed.ok).toBe(true);
    // [v0.0.320] 成功响应返回写后新 version（写后 stat）
    expect(parsed.version).toMatch(/^\d+(\.\d+)?:\d+$/);
    const st = statSync(join(ws, 'notes.md'));
    expect(parsed.version).toBe(`${st.mtimeMs}:${st.size}`);
    // 真实落盘验证（no-mock fs）
    expect(readFileSync(join(ws, 'notes.md'), 'utf8')).toBe(newContent);
  });

  it('[v0.0.320] save 无 expectedVersion → 200 last-write-wins（向后兼容旧调用方）', async () => {
    writeFileSync(join(ws, 'legacy.md'), '旧');
    const sid = await newSessionWithWorkspace(ws);
    const res = await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'legacy.md', content: '新' }),
      }),
      'POST', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    expect((await body(res)).ok).toBe(true);
    expect(readFileSync(join(ws, 'legacy.md'), 'utf8')).toBe('新');
  });

  it('[v0.0.320] expectedVersion 匹配当前 version → 200 返回新 version', async () => {
    writeFileSync(join(ws, 'ok.md'), '初始');
    const sid = await newSessionWithWorkspace(ws);
    // 先读拿当前 version
    const readRes = await handleWorkspaceFileRead(
      new Request(`http://x/session/${sid}/workspace/file?path=ok.md`),
      'GET', sid, makeDeps(),
    );
    const expected = (await body(readRes)).version;

    const res = await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'ok.md', content: '更新', expectedVersion: expected }),
      }),
      'POST', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    const parsed = await body(res);
    expect(parsed.ok).toBe(true);
    expect(parsed.version).toMatch(/^\d+(\.\d+)?:\d+$/);
    expect(readFileSync(join(ws, 'ok.md'), 'utf8')).toBe('更新');
  });

  it('[v0.0.320] expectedVersion 不匹配 → 409 {error:conflict,currentVersion} 且不写盘', async () => {
    writeFileSync(join(ws, 'conflict.md'), '外部内容-B');
    const sid = await newSessionWithWorkspace(ws);

    const res = await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: 'conflict.md',
          content: 'overwrite-attempt',
          expectedVersion: '1:1', // 必然不匹配
        }),
      }),
      'POST', sid, makeDeps(),
    );
    expect(res.status).toBe(409);
    const parsed = await body(res);
    expect(parsed.error).toBe('conflict');
    expect(parsed.currentVersion).toMatch(/^\d+(\.\d+)?:\d+$/);
    // 不写盘：文件保留外部最新内容
    expect(readFileSync(join(ws, 'conflict.md'), 'utf8')).toBe('外部内容-B');
  });

  it('[v0.0.320] force:true → 跳过校验覆盖成功（即使 expectedVersion 不匹配）', async () => {
    writeFileSync(join(ws, 'force.md'), '外部内容');
    const sid = await newSessionWithWorkspace(ws);
    const res = await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path: 'force.md',
          content: 'force-overwrite',
          expectedVersion: 'wrong-version',
          force: true,
        }),
      }),
      'POST', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    expect((await body(res)).ok).toBe(true);
    expect(readFileSync(join(ws, 'force.md'), 'utf8')).toBe('force-overwrite');
  });

  it('[v0.0.320] expectedVersion/force 非 string/boolean → 宽松忽略（不 400，对齐契约宽松扩展）', async () => {
    writeFileSync(join(ws, 'loose.md'), '旧');
    const sid = await newSessionWithWorkspace(ws);
    const res = await handleWorkspaceFileSave(
      new Request(`http://x/session/${sid}/workspace/file/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'loose.md', content: '新', expectedVersion: 123, force: 'yes' }),
      }),
      'POST', sid, makeDeps(),
    );
    expect(res.status).toBe(200);
    expect((await body(res)).ok).toBe(true);
    expect(readFileSync(join(ws, 'loose.md'), 'utf8')).toBe('新');
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

  it('[v0.0.263] symlink 文件写放行：save escape/secret.md（指向外部）→ 200 写入目标文件（UC-4）', async () => {
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
      // 本版本行为变更：workspace 内 symlink = 授权 → 写放行（非 400）
      expect(res.status).toBe(200);
      expect((await body(res)).ok).toBe(true);
      // 外部目标文件被覆盖（授权根模型：symlink 目标 = 用户放置 = 可写）
      expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('pwn');
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

// ============================================================
// GET /session/:id/workspace/stat（v0.0.339：文件大小判定，打开分流用）
// ============================================================

describe('GET /session/:id/workspace/stat', () => {
  it('正常 stat 文件 → 200 + { size }（只 stat 不读内容）', async () => {
    writeFileSync(join(ws, 'big.log'), 'x'.repeat(1024));
    const sid = await newSessionWithWorkspace(ws);
    const r = await handleWorkspaceStat(
      new Request(`http://x/session/${sid}/workspace/stat?path=big.log`),
      'GET', sid, makeDeps(),
    );
    expect(r.status).toBe(200);
    const parsed = await body(r);
    expect(parsed.size).toBe(1024);
  });

  it('子目录文件 stat → 200 + { size }（与 file read 同 whitelistResolve 安全面）', async () => {
    mkdirSync(join(ws, 'sub'), { recursive: true });
    writeFileSync(join(ws, 'sub/nested.md'), 'hello');
    const sid = await newSessionWithWorkspace(ws);
    const r = await handleWorkspaceStat(
      new Request(`http://x/session/${sid}/workspace/stat?path=sub%2Fnested.md`),
      'GET', sid, makeDeps(),
    );
    expect(r.status).toBe(200);
    expect((await body(r)).size).toBe(5);
  });

  it('文件不存在 → 404', async () => {
    const sid = await newSessionWithWorkspace(ws);
    const r = await handleWorkspaceStat(
      new Request(`http://x/session/${sid}/workspace/stat?path=missing.md`),
      'GET', sid, makeDeps(),
    );
    expect(r.status).toBe(404);
  });

  it('目录 → 404（stat 端点只服务文件大小判定）', async () => {
    mkdirSync(join(ws, 'dir'), { recursive: true });
    const sid = await newSessionWithWorkspace(ws);
    const r = await handleWorkspaceStat(
      new Request(`http://x/session/${sid}/workspace/stat?path=dir`),
      'GET', sid, makeDeps(),
    );
    expect(r.status).toBe(404);
  });

  it('路径穿越 ../ → 400（whitelistResolve traversal）', async () => {
    const sid = await newSessionWithWorkspace(ws);
    const r = await handleWorkspaceStat(
      new Request(`http://x/session/${sid}/workspace/stat?path=..%2Fetc%2Fpasswd`),
      'GET', sid, makeDeps(),
    );
    expect(r.status).toBe(400);
  });

  it('绝对路径注入 /etc/passwd → 400', async () => {
    const sid = await newSessionWithWorkspace(ws);
    const r = await handleWorkspaceStat(
      new Request(`http://x/session/${sid}/workspace/stat?path=${encodeURIComponent('/etc/passwd')}`),
      'GET', sid, makeDeps(),
    );
    expect(r.status).toBe(400);
  });

  it('path 缺失 / session 不存在 / 非 GET → 400 / 404 / 405', async () => {
    const sid = await newSessionWithWorkspace(ws);
    // path 缺失
    const r1 = await handleWorkspaceStat(
      new Request(`http://x/session/${sid}/workspace/stat`), 'GET', sid, makeDeps(),
    );
    expect(r1.status).toBe(400);
    // session 不存在
    const r2 = await handleWorkspaceStat(
      new Request(`http://x/session/01KVNOPE/workspace/stat?path=a.md`), 'GET', '01KVNOPE', makeDeps(),
    );
    expect(r2.status).toBe(404);
    // 非 GET（POST）→ 405 + allow=GET
    const r3 = await handleWorkspaceStat(
      new Request(`http://x/session/${sid}/workspace/stat?path=a.md`), 'POST', sid, makeDeps(),
    );
    expect(r3.status).toBe(405);
    expect(r3.headers.get('allow')).toBe('GET');
  });
});
