/**
 * session-workspace-watch handler UT —— POST watch/unwatch（v0.0.139 懒监听 acquire/release）
 * 参考: specs/api/overall/04-agent-session.md §2.6.5（watch/unwatch 契约）
 *       specs/tech/agent/session/[P0]session_workspace_manager.md（懒监听权威源）
 *       specs/tech/version_logs/v0.0.139/change_plan.md 模块5
 *
 * 独立文件（而非并入 session-workspace.test.ts）：与源码拆分一致——handleWorkspaceWatch/
 * Unwatch 落 handlers/session-workspace-watch.ts（非 session-workspace.ts），本测试同构拆分，
 * 避免 session-workspace.test.ts（已 770 行）继续膨胀超单文件行数上限。
 *
 * 覆盖（task4 acceptanceCriteria）：200 / 404 session / 400 穿越 / 缺 clientId 400 /
 *   release-all / 重复 watch 不叠加 / unwatch 未持有 no-op / 405 非 POST。
 * 用真实 SessionWorkspaceManager（真实 fs + chokidar），经 getStatus() 断言端到端记账效果
 * ——比 mock manager 更贴近契约真实性（watch/unwatch 的核心价值就是「记账是否正确」）。
 *
 * 文件系统隔离：tmpdir + mkdtemp + afterEach rm。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { ulid } from '../../config/ulid';
import { handleWorkspaceWatch, handleWorkspaceUnwatch, handleWorkspaceWatchSet } from '../session-workspace-watch';
import { SessionWorkspaceManager } from '../../agent/session-workspace-manager';
import { ReplayableEventBus } from '../../agent/event-bus';
import type { SessionHandlerDeps } from '../session';
import type { AgentManagerImpl } from '../../agent/agent-manager';

let tmpRoot: string;
let store: SessionStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-ws-watch-handler-'));
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

function makeDeps(opts: { workspaceManager?: SessionWorkspaceManager } = {}): SessionHandlerDeps {
  const fake = { abort: async () => ({ accepted: false }), clearReplay: () => undefined };
  return {
    store,
    agentManager: fake as unknown as AgentManagerImpl,
    appConfig: {} as never,
    pluginManager: {} as never,
    contextEngine: {} as never,
    dataDir: tmpRoot,
    openWorkspaceItem: () => ({ ok: true }),
    pickWorkspaceDirectory: () => ({ path: null }),
    ...(opts.workspaceManager ? { workspaceManager: opts.workspaceManager } : {}),
  };
}

async function newSessionWithWorkspace(workspaceDir: string): Promise<string> {
  const sid = ulid();
  await store.createSession({ id: sid, title: 'test', workspaceDir });
  return sid;
}

async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

/** 真实 SessionWorkspaceManager（真实 fs + chokidar），供端到端记账断言。 */
function makeRealWorkspaceManager(): SessionWorkspaceManager {
  return new SessionWorkspaceManager({ statusBus: new ReplayableEventBus({ replayable: false }) });
}

async function postWatch(sid: string, deps: SessionHandlerDeps, reqBody: Record<string, unknown>) {
  return handleWorkspaceWatch(
    new Request(`http://x/session/${sid}/workspace/watch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reqBody),
    }),
    'POST',
    sid,
    deps,
  );
}

async function postUnwatch(sid: string, deps: SessionHandlerDeps, reqBody: Record<string, unknown>) {
  return handleWorkspaceUnwatch(
    new Request(`http://x/session/${sid}/workspace/unwatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reqBody),
    }),
    'POST',
    sid,
    deps,
  );
}

// ============================================================
// POST /session/:id/workspace/watch
// ============================================================

describe('POST /session/:id/workspace/watch', () => {
  it('200：合法 clientId+path=""（根）→ manager 记账生效（getStatus 反映）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-watch-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeRealWorkspaceManager();
      const res = await postWatch(sid, makeDeps({ workspaceManager: wm }), { clientId: 'c1', path: '' });
      expect(res.status).toBe(200);
      expect((await body(res)).ok).toBe(true);
      const status = wm.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0]?.sessionId).toBe(sid);
      await wm.stopAll();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('404 session 不存在', async () => {
    const res = await postWatch('nope', makeDeps(), { clientId: 'c1', path: '' });
    expect(res.status).toBe(404);
  });

  it('缺 clientId → 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-watch-noclient-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await postWatch(sid, makeDeps(), { path: '' });
      expect(res.status).toBe(400);
      expect((await body(res)).error).toMatch(/clientId/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('path 穿越（../../etc）→ 400（路径白名单，同 tree 校验）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-watch-white-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await postWatch(sid, makeDeps(), { clientId: 'c1', path: '../../etc' });
      expect(res.status).toBe(400);
      expect((await body(res)).error).toMatch(/traversal|out of workspace/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('[v0.0.263] symlink 目录 watch 放行：path=<symlink-dir> → 200（不 400，UC-7）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-watch-symlink-'));
    const outside = mkdtempSync(join(tmpdir(), 'oobt-ws-watch-out-'));
    try {
      symlinkSync(outside, join(ws, 'escape')); // ws/escape -> outside
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeRealWorkspaceManager();
      const res = await postWatch(sid, makeDeps({ workspaceManager: wm }), {
        clientId: 'c1',
        path: 'escape',
      });
      // 本版本行为变更：workspace 内 symlink = 授权 → watch 放行（非 400）
      expect(res.status).toBe(200);
      expect((await body(res)).ok).toBe(true);
      await wm.stopAll();
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('重复 watch 同 (clientId,path) → 幂等不叠加 refcount', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-watch-idem-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeRealWorkspaceManager();
      const deps = makeDeps({ workspaceManager: wm });
      await postWatch(sid, deps, { clientId: 'c1', path: '' });
      const res2 = await postWatch(sid, deps, { clientId: 'c1', path: '' });
      expect(res2.status).toBe(200);
      const status = wm.getStatus();
      expect(status).toHaveLength(1);
      expect(status[0]?.refcount).toBe(1); // 未叠加
      await wm.stopAll();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('目标目录不存在 → 静默 200（manager 内部忽略，非 404/400）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-watch-notfound-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeRealWorkspaceManager();
      const res = await postWatch(sid, makeDeps({ workspaceManager: wm }), {
        clientId: 'c1',
        path: 'does-not-exist',
      });
      expect(res.status).toBe(200);
      expect(wm.getStatus()).toHaveLength(0);
      await wm.stopAll();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('405 非 POST', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspaceWatch(
      new Request(`http://x/session/${sid}/workspace/watch`, { method: 'GET' }),
      'GET',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(405);
  });
});

// ============================================================
// POST /session/:id/workspace/unwatch
// ============================================================

describe('POST /session/:id/workspace/unwatch', () => {
  it('200：release 单个已持有目录 → refcount 归零后 getStatus 空', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-unwatch-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeRealWorkspaceManager();
      const deps = makeDeps({ workspaceManager: wm });
      await postWatch(sid, deps, { clientId: 'c1', path: '' });
      expect(wm.getStatus()).toHaveLength(1);

      const res = await postUnwatch(sid, deps, { clientId: 'c1', path: '' });
      expect(res.status).toBe(200);
      expect(wm.getStatus()).toHaveLength(0);
      await wm.stopAll();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('unwatch 该 tab 未持有的 path → 静默 no-op 200（不抛错）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-unwatch-noop-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeRealWorkspaceManager();
      const res = await postUnwatch(sid, makeDeps({ workspaceManager: wm }), {
        clientId: 'c1',
        path: '',
      });
      expect(res.status).toBe(200);
      expect(wm.getStatus()).toHaveLength(0);
      await wm.stopAll();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('path 省略 → release-all（该 tab 全部监听清空；其他 tab 不受影响）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-unwatch-all-'));
    try {
      mkdirSync(join(ws, 'sub'), { recursive: true });
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeRealWorkspaceManager();
      const deps = makeDeps({ workspaceManager: wm });
      await postWatch(sid, deps, { clientId: 'c1', path: '' });
      await postWatch(sid, deps, { clientId: 'c1', path: 'sub' });
      await postWatch(sid, deps, { clientId: 'c2', path: '' }); // 另一 tab 也 watch 根
      expect(wm.getStatus()).toHaveLength(2); // 根(refcount2) + sub(refcount1)

      const res = await postUnwatch(sid, deps, { clientId: 'c1' }); // 无 path = release-all
      expect(res.status).toBe(200);
      const status = wm.getStatus();
      expect(status).toHaveLength(1); // 只剩 c2 持有的根
      // handler 内部走 realpathSync(workspaceDir) 做白名单基准（macOS /var 是 /private/var 的
      // symlink），absDir 记账值 = realpath 后的路径，非 tmpdir() 原始返回值
      expect(status[0]?.absDir).toBe(realpathSync(ws));
      expect(status[0]?.refcount).toBe(1);
      await wm.stopAll();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('404 session 不存在', async () => {
    const res = await postUnwatch('nope', makeDeps(), { clientId: 'c1' });
    expect(res.status).toBe(404);
  });

  it('缺 clientId → 400', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await postUnwatch(sid, makeDeps(), { path: '' });
    expect(res.status).toBe(400);
  });

  it('path 穿越（../../etc）→ 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-unwatch-white-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await postUnwatch(sid, makeDeps(), { clientId: 'c1', path: '../../etc' });
      expect(res.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('405 非 POST', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspaceUnwatch(
      new Request(`http://x/session/${sid}/workspace/unwatch`, { method: 'GET' }),
      'GET',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(405);
  });
});

// ============================================================
// POST /session/:id/workspace/watch-set（v0.0.271 声明式全量替换）
// ============================================================

async function postWatchSet(sid: string, deps: SessionHandlerDeps, reqBody: Record<string, unknown>) {
  return handleWorkspaceWatchSet(
    new Request(`http://x/session/${sid}/workspace/watch-set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reqBody),
    }),
    'POST',
    sid,
    deps,
  );
}

describe('POST /session/:id/workspace/watch-set', () => {
  it('200：paths 数组 → manager 建 watcher（getStatus 反映关注集合）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-set-'));
    mkdirSync(join(ws, 'sub'), { recursive: true });
    try {
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeRealWorkspaceManager();
      const deps = makeDeps({ workspaceManager: wm });
      const res = await postWatchSet(sid, deps, { clientId: 'c1', paths: ['', 'sub'] });
      expect(res.status).toBe(200);
      expect((await body(res)).ok).toBe(true);
      const status = wm.getStatus();
      expect(status).toHaveLength(2);
      expect(status.map((s) => s.absDir).sort()).toEqual([realpathSync(ws), realpathSync(join(ws, 'sub'))].sort());
      await wm.stopAll();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('200：paths 空数组 = 清空该 tab 全部监听（声明式替换语义）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-set-clear-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeRealWorkspaceManager();
      const deps = makeDeps({ workspaceManager: wm });
      await postWatch(sid, deps, { clientId: 'c1', path: '' });
      expect(wm.getStatus()).toHaveLength(1);

      const res = await postWatchSet(sid, deps, { clientId: 'c1', paths: [] });
      expect(res.status).toBe(200);
      expect(wm.getStatus()).toHaveLength(0);
      await wm.stopAll();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('404 session 不存在', async () => {
    const res = await postWatchSet('nope', makeDeps(), { clientId: 'c1', paths: [''] });
    expect(res.status).toBe(404);
  });

  it('缺 clientId → 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-set-noclient-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await postWatchSet(sid, makeDeps(), { paths: [''] });
      expect(res.status).toBe(400);
      expect((await body(res)).error).toMatch(/clientId/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('paths 非数组 → 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-set-noarr-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await postWatchSet(sid, makeDeps(), { clientId: 'c1', paths: 'not-array' });
      expect(res.status).toBe(400);
      expect((await body(res)).error).toMatch(/paths/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('paths 含非字符串元素 → 400', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-set-nonstr-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await postWatchSet(sid, makeDeps(), { clientId: 'c1', paths: ['', 42] });
      expect(res.status).toBe(400);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('任一 path 穿越（../../etc）→ 400（逐元素白名单，同 watch）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-set-white-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const res = await postWatchSet(sid, makeDeps(), { clientId: 'c1', paths: ['', '../../etc'] });
      expect(res.status).toBe(400);
      expect((await body(res)).error).toMatch(/traversal|out of workspace/i);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('paths 含不存在路径 → 静默跳过（其余合法路径照常建 watcher）', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'oobt-ws-set-notfound-'));
    try {
      const sid = await newSessionWithWorkspace(ws);
      const wm = makeRealWorkspaceManager();
      const res = await postWatchSet(sid, makeDeps({ workspaceManager: wm }), {
        clientId: 'c1',
        paths: ['', 'does-not-exist'],
      });
      expect(res.status).toBe(200);
      const status = wm.getStatus();
      expect(status).toHaveLength(1); // 只有根（不存在路径被跳过）
      expect(status[0]?.absDir).toBe(realpathSync(ws));
      await wm.stopAll();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('405 非 POST', async () => {
    const sid = await newSessionWithWorkspace(tmpRoot);
    const res = await handleWorkspaceWatchSet(
      new Request(`http://x/session/${sid}/workspace/watch-set`, { method: 'GET' }),
      'GET',
      sid,
      makeDeps(),
    );
    expect(res.status).toBe(405);
  });
});
