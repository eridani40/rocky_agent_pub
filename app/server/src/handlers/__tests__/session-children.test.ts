/**
 * GET /session/:id/children handler UT（v0.0.28 task-2）
 * 参考: specs/api/overall/10-multi-agent.md §3（GET /session/:id/children 契约）
 *       states/v0.0.28/task.json tasks[1] acceptance「GET /session/:id/children 端点」
 *
 * 覆盖：
 *   - 200 + ChildrenView（running/terminated 分组）
 *   - 404 parent 不存在
 *   - 400 status 非 running/terminated
 *   - 400 limit 非 [1,100]
 *   - 405 非 GET
 *
 * 真实落盘：fs engine + tmpdir + afterEach 清理。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import {
  SessionSchema, MessageSchema, SummarySchema, RunSchema,
} from '../../agent/schema_defs';
import { SessionStore } from '../../agent/session-store';
import { handleSessionChildren } from '../session-children';
import type { SessionHandlerDeps } from '../session';

let tmpRoot: string;
let store: SessionStore;
let deps: SessionHandlerDeps;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-children-handler-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  deps = {
    store,
    agentManager: {} as never,
    appConfig: {} as never,
    pluginManager: {} as never,
    contextEngine: {} as never,
    dataDir: tmpRoot,
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function req(): Request {
  return new Request('http://x/session/x/children');
}

describe('handleSessionChildren', () => {
  it('200 + ChildrenView（parent 存在）', async () => {
    const parentSid = ulid();
    await store.createSession({ id: parentSid, title: 'parent' });
    const child = ulid();
    await store.createSession({
      id: child, parentSessionId: parentSid, derivation: 'subagent', role: 'rocky', 
    });

    const res = await handleSessionChildren(req(), 'GET', parentSid, deps, new URL('http://x/session/' + parentSid + '/children'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parentSessionId: string; terminated: Array<{ sessionId: string }>; running: Array<{ sessionId: string }> };
    expect(body.parentSessionId).toBe(parentSid);
    expect(body.terminated.length).toBe(1);
    expect(body.terminated[0]!.sessionId).toBe(child);
  });

  it('404 parent 不存在', async () => {
    const res = await handleSessionChildren(req(), 'GET', 'nonexistent', deps, new URL('http://x/session/nonexistent/children'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('session not found');
  });

  it('400 status 非 running/terminated', async () => {
    const parentSid = ulid();
    await store.createSession({ id: parentSid });
    const res = await handleSessionChildren(
      req(), 'GET', parentSid, deps,
      new URL('http://x/session/' + parentSid + '/children?status=invalid'),
    );
    expect(res.status).toBe(400);
  });

  it('400 limit 非 [1,100]（0）', async () => {
    const parentSid = ulid();
    await store.createSession({ id: parentSid });
    const res = await handleSessionChildren(
      req(), 'GET', parentSid, deps,
      new URL('http://x/session/' + parentSid + '/children?limit=0'),
    );
    expect(res.status).toBe(400);
  });

  it('400 limit 非 [1,100]（101）', async () => {
    const parentSid = ulid();
    await store.createSession({ id: parentSid });
    const res = await handleSessionChildren(
      req(), 'GET', parentSid, deps,
      new URL('http://x/session/' + parentSid + '/children?limit=101'),
    );
    expect(res.status).toBe(400);
  });

  it('405 非 GET', async () => {
    const parentSid = ulid();
    await store.createSession({ id: parentSid });
    const res = await handleSessionChildren(req(), 'POST', parentSid, deps, new URL('http://x/' + parentSid));
    expect(res.status).toBe(405);
  });

  it('limit=50 合法 → 截断生效', async () => {
    const parentSid = ulid();
    await store.createSession({ id: parentSid });
    for (let i = 0; i < 60; i++) {
      await store.createSession({ id: ulid(), parentSessionId: parentSid, derivation: 'subagent', role: 'rocky' });
    }
    const res = await handleSessionChildren(
      req(), 'GET', parentSid, deps,
      new URL('http://x/session/' + parentSid + '/children?limit=50'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { terminated: unknown[] };
    expect(body.terminated.length).toBe(50);
  });
});
