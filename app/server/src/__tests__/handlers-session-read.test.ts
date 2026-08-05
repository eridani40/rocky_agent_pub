/**
 * handlers-session-read 单测 — POST /session/:id/read 端点契约 + GET 纯读无副作用（v0.0.27）
 * 参考:
 *   - specs/api/overall/04-agent-session.md §2.1（Session 含 unread）/ §2.3（GET 纯读）/ §2.3.1（POST /read 契约）
 *   - specs/tech/agent/session/[P0]session_event.md §2/§3（session_read_update 触发时机）
 *
 * 覆盖（task.json task[1] acceptanceCriteria）：
 *   - 端点契约：POST /read → 200 {ok:true, session:{...,unread:false}}；session 不存在 → 404；非 POST → 405
 *   - 幂等：unread 已 false 时 POST /read 仍 200，CAS 0 行不发 session_read_update 事件
 *   - GET /session 列表 + GET /session/:id 响应含 unread 字段
 *   - GET 纯读无副作用：GET 前后 unread 值不变 + 不发 session_read_update 事件
 *   - session_read_update 事件结构：{type, sessionId, data:{unread:false}, createdAt}
 *
 * 策略：真实 SessionStore（tmpdir + statusBus），handler 直接调，断言 Response + 事件计数。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { CompositeStore } from '../persistence/composite';
import { FsCrudStore } from '../persistence/fs-store';
import { SessionStore } from '../agent/session-store';
import { ReplayableEventBus } from '../agent/event-bus';
import { ulid } from '../config/ulid';
import { AppConfigService } from '../config/app-config-service';
import { bootstrapBuiltinPlugins } from '../bootstrap';
import {
  handleSessionCollection,
  handleSessionItem,
  type SessionHandlerDeps,
} from '../handlers/session';
import { handleSessionRead } from '../handlers/session-read';
import type { SessionReadUpdateEvent } from '../agent/session-event-types';

let tmpRoot: string;
let store: SessionStore;
let statusBus: ReplayableEventBus;
let deps: SessionHandlerDeps;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-session-read-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  statusBus = new ReplayableEventBus({ replayable: true });
  store = new SessionStore({ crud, fsRoot: tmpRoot, statusBus });
  const appConfig = new AppConfigService({ root: tmpRoot });
  const devConfig = new AppConfigService({ root: tmpRoot });
  const bs = await bootstrapBuiltinPlugins(mkdtempSync(join(tmpdir(), 'rocky-session-read-bs-')));
  deps = {
    store,
    agentManager: { subscribe: (() => {}) as never } as never,
    appConfig,
    pluginManager: bs.pluginManager,
    contextEngine: bs.contextEngine,
    dataDir: tmpRoot,
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function req(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://127.0.0.1:3700${path}`, init);
}

async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

/** 订阅 statusBus 收 session_read_update 事件（异步消费，返引用数组供断言计数） */
function collectReadEvents(sid: string): SessionReadUpdateEvent[] {
  const out: SessionReadUpdateEvent[] = [];
  const iter = statusBus.subscribe<SessionReadUpdateEvent>(`session_id:${sid}`)[Symbol.asyncIterator]();
  void (async () => {
    while (true) {
      const r = await iter.next();
      if (r.done) break;
      if (r.value?.data?.type === 'session_read_update') {
        out.push(r.value.data as SessionReadUpdateEvent);
      }
    }
  })();
  return out;
}

/** 让事件循环跑一拍，保证异步 iter 消费完 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('POST /session/:id/read — 端点契约', () => {
  it('unread=true → POST /read → 200 {ok:true, session.unread=false} + emit 事件', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const events = collectReadEvents(sid);
    await store.markUnreadTrue(sid); // 前置：置 unread=true

    const r = await handleSessionRead(req('POST', `/session/${sid}/read`), 'POST', sid, deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.ok).toBe(true);
    expect(body.session.id).toBe(sid);
    expect(body.session.unread).toBe(false);

    await flushMicrotasks();
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('session_read_update');
    expect(events[0]!.sessionId).toBe(sid);
    expect(events[0]!.data).toEqual({ unread: false });
    expect(typeof events[0]!.createdAt).toBe('string');
  });

  it('session 不存在 → 404', async () => {
    const r = await handleSessionRead(req('POST', '/session/nope/read'), 'POST', 'nope', deps);
    expect(r.status).toBe(404);
  });

  it('非 POST → 405 + Allow: POST', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    const r = await handleSessionRead(req('GET', `/session/${sid}/read`), 'GET', sid, deps);
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
  });
});

describe('POST /session/:id/read — 幂等性', () => {
  it('unread 已 false → POST /read 仍 200，CAS 0 行不发事件', async () => {
    const sid = ulid();
    await store.createSession({ id: sid }); // 默认 unread=false
    const events = collectReadEvents(sid);

    const r = await handleSessionRead(req('POST', `/session/${sid}/read`), 'POST', sid, deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(body.ok).toBe(true);
    expect(body.session.unread).toBe(false);

    await flushMicrotasks();
    expect(events).toHaveLength(0); // 幂等 no-op，不发事件
  });
});

describe('GET 响应含 unread 字段 + 纯读无副作用', () => {
  it('GET /session 列表 items[*] 含 unread（boolean）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.markUnreadTrue(sid); // 一项 unread=true

    const r = await handleSessionCollection(req('GET', '/session'), 'GET', deps);
    expect(r.status).toBe(200);
    const body = await jsonBody(r);
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const it of body.items) {
      expect(typeof it.unread).toBe('boolean');
    }
    const target = body.items.find((it: any) => it.id === sid);
    expect(target.unread).toBe(true);
  });

  it('GET /session/:id 响应含 unread，且纯读无副作用（值不变 + 不发事件）', async () => {
    const sid = ulid();
    await store.createSession({ id: sid });
    await store.markUnreadTrue(sid); // unread=true
    const events = collectReadEvents(sid);

    // GET 前断言 unread=true
    const before = await jsonBody(
      await handleSessionItem(req('GET', `/session/${sid}`), 'GET', sid, deps),
    );
    expect(before.unread).toBe(true);

    // 再 GET 一次（纯读，不应改变状态）
    const after = await jsonBody(
      await handleSessionItem(req('GET', `/session/${sid}`), 'GET', sid, deps),
    );
    expect(after.unread).toBe(true); // 仍 true，GET 不调 markRead

    await flushMicrotasks();
    expect(events).toHaveLength(0); // GET 不发 session_read_update
  });
});
