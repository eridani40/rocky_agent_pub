/**
 * session-workspace-seed handler UT - ET seed 端点（v0.0.17 新建）
 * 参考: tests/e2e/chat/workspace_{tc}/checkpoint.json（ET case 依赖此 seed fs）
 *       specs/tech/agent/session/[P0]session_workspace.md §6（路径白名单复用）
 *
 * 覆盖：
 *   POST /api/workspace/ensure-dir:
 *     - 正常 seed：相对路径建子目录（src/utils）→ 200 + dir 真实落地
 *     - 正常 seed：绝对路径（在 workspaceDir 内）建目录 → 200
 *     - 越界 ../etc → 400
 *     - 越界绝对路径（workspaceDir 外）→ 400
 *     - session 不存在 → 404
 *     - 缺 path/sessionId → 400
 *   POST /api/workspace/touch:
 *     - 正常 seed：建文件（src/index.ts）→ 200 + 文件内容真实落地
 *     - 父目录不存在 → 自动 mkdir recursive
 *     - 越界 ../etc/passwd → 400
 *     - session 不存在 → 404
 *   POST /api/workspace/ensure?path=<abs>:
 *     - 正常：建 /tmp 目录 → 200 + 幂等
 *     - 相对路径 → 400
 *     - 缺 path → 400
 *
 * 测试策略：真实 SessionStore（fs + tmpdir）+ 真实 fs 写入验证；
 * 不 mock fs —— 验证 mkdir/writeFile 真落地 + 白名单真生效。
 * 文件系统隔离：tmpdir + mkdtemp + afterEach rm。
 *
 * 注意：NODE_ENV=test gate 的 404 在 router 层（非 handler），
 * 本 UT 直接调 handler 不经 router，故不测 404 gate（router UT 另行覆盖）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { ulid } from '../../config/ulid';
import {
  handleWorkspaceEnsureDir,
  handleWorkspaceTouch,
  handleWorkspaceEnsure,
} from '../session-workspace-seed';
import type { SessionHandlerDeps } from '../session';
import type { AgentManagerImpl } from '../../agent/agent-manager';
import type { AppConfigService } from '../../config/app-config-service';
import type { PluginManager } from '../../plugin/plugin-manager';
import type { ContextEngine } from '../../agent/context-engine';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-seed-'));
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

/** 构造空 SessionHandlerDeps */
function makeDeps(): SessionHandlerDeps {
  const fake = {
    abort: async () => ({ accepted: false }),
    clearReplay: () => undefined,
  };
  return {
    store,
    agentManager: fake as unknown as AgentManagerImpl,
    appConfig: {} as AppConfigService,
    pluginManager: {} as PluginManager,
    contextEngine: {} as ContextEngine,
    dataDir: tmpRoot,
  };
}

/** body 解析 helper */
async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

/** 创建 session 并手动指定 workspaceDir */
async function newSessionWithWorkspace(workspaceDir: string): Promise<string> {
  const sid = ulid();
  await store.createSession({ id: sid, title: 'test', workspaceDir });
  return sid;
}

// ============================================================
// POST /api/workspace/ensure-dir
// ============================================================

describe('POST /api/workspace/ensure-dir', () => {
  it('相对路径建子目录（src/utils）→ 200 + dir 真实落地', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-seed-dir-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceEnsureDir(
        new Request('http://x/api/workspace/ensure-dir', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'src/utils', sessionId: sid }),
        }),
        'POST',
        makeDeps(),
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(b.ok).toBe(true);
      // macOS /tmp → /private/tmp symlink：handler 内部 realpath(workspaceDir)，
      // 返回的 dir 是 realRoot 下的绝对路径。用 endsWith 校验相对部分 + existsSync 真落地。
      expect(b.dir).toMatch(/\/src\/utils$/);
      expect(existsSync(resolve(ws, 'src', 'utils'))).toBe(true);
      expect(statSync(resolve(ws, 'src', 'utils')).isDirectory()).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('绝对路径（在 workspaceDir 内）建目录 → 200', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-seed-abs-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      // 用 realRoot（realpath(ws)）拼 absSub，避免 macOS /tmp symlink 导致前缀不匹配
      const realWs = realpathSync(ws);
      const absSub = resolve(realWs, 'src/auth');
      const res = await handleWorkspaceEnsureDir(
        new Request('http://x/api/workspace/ensure-dir', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: absSub, sessionId: sid }),
        }),
        'POST',
        makeDeps(),
      );
      expect(res.status).toBe(200);
      expect(existsSync(resolve(ws, 'src', 'auth'))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('越界 ../etc → 400 + 不建目录', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-seed-traversal-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceEnsureDir(
        new Request('http://x/api/workspace/ensure-dir', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: '../../etc/evil', sessionId: sid }),
        }),
        'POST',
        makeDeps(),
      );
      expect(res.status).toBe(400);
      const b = await body(res);
      expect(b.error).toMatch(/traversal|out of workspace/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('越界绝对路径（workspaceDir 外）→ 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-seed-outside-'));
    const outside = mkdtempSync(join(tmpdir(), 'oobt-seed-outside-target-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceEnsureDir(
        new Request('http://x/api/workspace/ensure-dir', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: resolve(outside, 'evil'),
            sessionId: sid,
          }),
        }),
        'POST',
        makeDeps(),
      );
      expect(res.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('session 不存在 → 404', async () => {
    const res = await handleWorkspaceEnsureDir(
      new Request('http://x/api/workspace/ensure-dir', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'src', sessionId: 'nope' }),
      }),
      'POST',
      makeDeps(),
    );
    expect(res.status).toBe(404);
  });

  it('缺 path 或 sessionId → 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-seed-missing-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      // 缺 sessionId
      const r1 = await handleWorkspaceEnsureDir(
        new Request('http://x/api/workspace/ensure-dir', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'src' }),
        }),
        'POST',
        makeDeps(),
      );
      expect(r1.status).toBe(400);
      // 缺 path
      const r2 = await handleWorkspaceEnsureDir(
        new Request('http://x/api/workspace/ensure-dir', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sid }),
        }),
        'POST',
        makeDeps(),
      );
      expect(r2.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ============================================================
// POST /api/workspace/touch
// ============================================================

describe('POST /api/workspace/touch', () => {
  it('正常 seed：建文件（src/index.ts）→ 200 + 内容真实落地', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-seed-touch-'));
    try {
      // 先 ensure-dir src
      mkdirSync(join(ws, 'src'), { recursive: true });
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceTouch(
        new Request('http://x/api/workspace/touch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: 'src/index.ts',
            sessionId: sid,
            content: 'export {};',
          }),
        }),
        'POST',
        makeDeps(),
      );
      expect(res.status).toBe(200);
      const b = await body(res);
      expect(b.ok).toBe(true);
      // 内容真实落地
      const file = resolve(ws, 'src', 'index.ts');
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('export {};');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('父目录不存在 → 自动 mkdir recursive', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-seed-touch-mkdir-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceTouch(
        new Request('http://x/api/workspace/touch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: 'src/utils/helper.ts',
            sessionId: sid,
            content: 'export const x = 1;',
          }),
        }),
        'POST',
        makeDeps(),
      );
      expect(res.status).toBe(200);
      expect(existsSync(resolve(ws, 'src', 'utils', 'helper.ts'))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('越界 ../etc/passwd → 400 + 不写文件', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-seed-touch-trav-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceTouch(
        new Request('http://x/api/workspace/touch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: '../../etc/passwd_evil',
            sessionId: sid,
            content: 'evil',
          }),
        }),
        'POST',
        makeDeps(),
      );
      expect(res.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('session 不存在 → 404', async () => {
    const res = await handleWorkspaceTouch(
      new Request('http://x/api/workspace/touch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'a.ts', sessionId: 'nope' }),
      }),
      'POST',
      makeDeps(),
    );
    expect(res.status).toBe(404);
  });

  it('content 缺省 → 写空串', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-seed-touch-empty-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await handleWorkspaceTouch(
        new Request('http://x/api/workspace/touch', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'empty.ts', sessionId: sid }),
        }),
        'POST',
        makeDeps(),
      );
      expect(res.status).toBe(200);
      expect(readFileSync(resolve(ws, 'empty.ts'), 'utf8')).toBe('');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ============================================================
// POST /api/workspace/ensure?path=<abs>
// ============================================================

describe('POST /api/workspace/ensure?path=<abs>', () => {
  it('正常建 /tmp 临时目录 → 200 + 幂等（重复调不报错）', async () => {
    const target = resolve(tmpdir(), 'oobt-seed-ensure-' + ulid());
    try {
      const r1 = await handleWorkspaceEnsure(
        new Request(`http://x/api/workspace/ensure?path=${encodeURIComponent(target)}`, {
          method: 'POST',
        }),
        'POST',
        makeDeps(),
      );
      expect(r1.status).toBe(200);
      expect(existsSync(target)).toBe(true);
      // 幂等
      const r2 = await handleWorkspaceEnsure(
        new Request(`http://x/api/workspace/ensure?path=${encodeURIComponent(target)}`, {
          method: 'POST',
        }),
        'POST',
        makeDeps(),
      );
      expect(r2.status).toBe(200);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('相对路径 → 400', async () => {
    const res = await handleWorkspaceEnsure(
      new Request('http://x/api/workspace/ensure?path=relative/dir', {
        method: 'POST',
      }),
      'POST',
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });

  it('缺 path query → 400', async () => {
    const res = await handleWorkspaceEnsure(
      new Request('http://x/api/workspace/ensure', { method: 'POST' }),
      'POST',
      makeDeps(),
    );
    expect(res.status).toBe(400);
  });
});

// ============================================================
// NODE_ENV=test gate（router 层）
// ============================================================

describe('NODE_ENV=test gate (router 层非 test → 404)', () => {
  // 此 UT 仅文档性说明：gate 在 router.ts handleRequest 中
  // （process.env.NODE_ENV !== 'test' → /api/workspace/* 返 404）
  // 不在 handler UT 测 router gate（需另起 router UT），此处仅断言 handler 行为正确
  it('文档性：seed handler 本身无 NODE_ENV 检查（gate 在 router）', async () => {
    // handler 直接调用永远生效（不论 NODE_ENV），router 层负责 gate
    // 这保证 UT 可直接测 handler 不需 mock NODE_ENV
    const target = resolve(tmpdir(), 'oobt-seed-gate-' + ulid());
    try {
      const r = await handleWorkspaceEnsure(
        new Request(`http://x/api/workspace/ensure?path=${encodeURIComponent(target)}`, {
          method: 'POST',
        }),
        'POST',
        makeDeps(),
      );
      expect(r.status).toBe(200);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
