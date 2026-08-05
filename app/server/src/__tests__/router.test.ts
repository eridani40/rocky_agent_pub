/**
 * router 单测 — /counter HTTP 路由分发（不拉真 socket，只调 handler）
 * 参考: specs/api/overall/01-counter.md §2.2/§2.4
 *
 * 校验点：
 *   - GET /counter → 200 + { value, updatedAt }
 *   - POST /counter/inc → 200 + 自增后 { value, updatedAt }
 *   - GET /health → 200
 *   - 未匹配路径 → 404 { error: "Not Found" }
 *   - PUT /counter → 405 + Allow: GET
 *   - DELETE /counter/inc → 405 + Allow: POST
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { handleRequest } from '../router';

const ISO8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** 构造一个最小 Request，简化用 */
function req(method: string, path: string): Request {
  return new Request(`http://127.0.0.1:3700${path}`, { method });
}

async function jsonBody(r: Response): Promise<unknown> {
  return JSON.parse(await r.text());
}

describe('router.handleRequest', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-router-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('GET /counter 首次返回 value=0', async () => {
    const r = await handleRequest(req('GET', '/counter'), dataDir);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const body = (await jsonBody(r)) as { value: number; updatedAt: string };
    expect(body.value).toBe(0);
    expect(body.updatedAt).toMatch(ISO8601);
  });

  it('POST /counter/inc 自增并持久化', async () => {
    await handleRequest(req('POST', '/counter/inc'), dataDir);
    const r = await handleRequest(req('POST', '/counter/inc'), dataDir);
    expect(r.status).toBe(200);
    const body = (await jsonBody(r)) as { value: number };
    expect(body.value).toBe(2);
    const get = await handleRequest(req('GET', '/counter'), dataDir);
    expect(((await jsonBody(get)) as { value: number }).value).toBe(2);
  });

  it('GET /health 返回 200', async () => {
    const r = await handleRequest(req('GET', '/health'), dataDir);
    expect(r.status).toBe(200);
  });

  it('未匹配路径返回 404 { error: "Not Found" }', async () => {
    const r = await handleRequest(req('GET', '/counter/dec'), dataDir);
    expect(r.status).toBe(404);
    expect(((await jsonBody(r)) as { error: string }).error).toBe('Not Found');
  });

  it('PUT /counter 返回 405 + Allow: GET', async () => {
    const r = await handleRequest(req('PUT', '/counter'), dataDir);
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET');
    expect(((await jsonBody(r)) as { error: string }).error).toBe('Method Not Allowed');
  });

  it('DELETE /counter/inc 返回 405 + Allow: POST', async () => {
    const r = await handleRequest(req('DELETE', '/counter/inc'), dataDir);
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
  });

  it('GET /counter/inc 返回 405（inc 仅 POST）+ Allow: POST', async () => {
    const r = await handleRequest(req('GET', '/counter/inc'), dataDir);
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('POST');
  });
});

/**
 * v0.0.8 路由分发集成（session / sse 端点 + /chat 已删）
 * 参考: specs/api/version_logs/v0.0.8/change_log.md §1
 */
describe('router.handleRequest — v0.0.8 路由分发', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-router-v008-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('POST /chat → 404（v0.0.8 已删除 /chat 路由）', async () => {
    const r = await handleRequest(
      new Request('http://127.0.0.1:3700/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'x', modelId: 'y', messages: [] }),
      }),
      dataDir,
    );
    expect(r.status).toBe(404);
  });

  it('POST /session → 201（router 分发到 session handler）', async () => {
    const r = await handleRequest(
      new Request('http://127.0.0.1:3700/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
      dataDir,
    );
    expect(r.status).toBe(201);
  });

  it('GET /session → 200 + {items:[]}', async () => {
    const r = await handleRequest(req('GET', '/session'), dataDir);
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body.items).toEqual([]);
  });

  it('POST /sse/subscribe topic 非 agent_loop → 400（router 分发到 sse handler）', async () => {
    const r = await handleRequest(
      new Request('http://127.0.0.1:3700/sse/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'nope', group: 'g1' }),
      }),
      dataDir,
    );
    expect(r.status).toBe(400);
  });

  it('POST /sse/subscribe topic=agent_loop → 200 + {ok:true}', async () => {
    const r = await handleRequest(
      new Request('http://127.0.0.1:3700/sse/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic: 'agent_loop', group: 'session_id:S1' }),
      }),
      dataDir,
    );
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body.ok).toBe(true);
  });

  it('DELETE /sse → 405 + Allow: GET（GET-only）', async () => {
    const r = await handleRequest(req('DELETE', '/sse'), dataDir);
    expect(r.status).toBe(405);
    expect(r.headers.get('allow')).toBe('GET');
  });
});

/**
 * GET /consolidation/status —— 只读状态端点路由分发
 * 参考: specs/api/overall/03-config-center.md §2.7
 */
describe('router.handleRequest — GET /consolidation/status', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-router-consolidation-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('从未整理过 → 200 + {lastRunAt:null, summary:null, status:idle, startedAt:null}（[v0.0.205.t2_cons] 加 status/startedAt）', async () => {
    const r = await handleRequest(req('GET', '/consolidation/status'), dataDir);
    expect(r.status).toBe(200);
    const body = JSON.parse(await r.text());
    expect(body).toEqual({ lastRunAt: null, summary: null, status: 'idle', startedAt: null });
  });
});
