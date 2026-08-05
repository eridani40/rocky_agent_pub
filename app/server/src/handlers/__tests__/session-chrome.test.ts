/**
 * GET /session/:id/chrome handler UT（v0.0.216 T1）
 * 参考: specs/api/overall/04a-session-chrome.md §2/§6（端点契约 + 错误码）
 *
 * 覆盖：
 *   - 200 + SessionChromeView（真实 SessionStore 落盘 session）
 *   - 404 session 不存在
 *   - 405 非 GET（Allow: GET）
 *
 * 真实落盘：fs engine + tmpdir + afterEach 清理（文件系统隔离规范）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import { SessionStore } from '../../agent/session-store';
import { handleSessionChrome, type SessionChromeDeps } from '../session-chrome';
import type { SessionChromeView } from '../../services/session-chrome';

let tmpRoot: string;
let store: SessionStore;
let deps: SessionChromeDeps;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-chrome-handler-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  deps = {
    store,
    // 数据源 fake（独立 SessionChromeDeps，结构子集即可）
    appConfig: {
      get: (g, k) => (g === 'default_models' && k === 'default' ? { chat: 'app-chat' } : undefined),
    },
    squadStore: { getSquad: async () => undefined },
    memberStore: { listMembers: async () => [] },
    academyStore: { getClassroom: async () => undefined },
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function req(): Request {
  return new Request('http://x/session/x/chrome');
}

describe('handleSessionChrome', () => {
  it('200 + SessionChromeView（playground 缺省 kind + defaultModel 走 appConfig）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid, title: '会话A', modelId: 'default' });

    const res = await handleSessionChrome(req(), 'GET', sid, deps);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SessionChromeView;
    expect(body.sessionId).toBe(sid);
    expect(body.kind).toBe('playground');
    expect(body.readOnly).toBe(false);
    expect(body.title).toBe('会话A');
    // 保留字 'default' → sessionModel null（picker 显默认态）
    expect(body.sessionModel).toBeNull();
    expect(body.defaultModel).toEqual({ modelId: 'app-chat' });
    expect(body.members).toEqual([]);
    expect(body.memberId).toBeNull();
    expect(body.capabilities.runState).toBe(true);
    expect(body.capabilities.groupRender).toBe(false);
  });

  it('404 session 不存在', async () => {
    const res = await handleSessionChrome(req(), 'GET', 'nonexistent', deps);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('session not found');
  });

  it('405 非 GET（Allow: GET）', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await handleSessionChrome(req(), method, 'any', deps);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow'), method).toBe('GET');
    }
  });
});
