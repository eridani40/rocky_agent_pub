/**
 * cron UI HTTP handler 单测（白盒）— 6 端点（GET/POST/PATCH/disable/enable/DELETE）+ 400/404 错误路径。
 * 参考: specs/api/overall/16-cron.md §2（端点契约 + status/body schema/错误码）
 *       specs/tech/scheduling/[P1]cron_subsystem.md §7（UI 端点 vs agent 工具正交）
 *
 * 覆盖（task.json T4 acceptanceCriteria §3）：
 *   L1 GET 空列表 → 200 {items:[]}
 *   L2 GET 非空 → 200 + nextFireAt 现算（enabled=true 非空 / disabled=null）
 *   C1 POST 创建 → 201 + CronJobSummary 全字段（id=`cron:${sid}:${eid}` / nextFireAt 现算）
 *   C2 POST cron expr 非法 → 400 `cron expr invalid`
 *   C3 POST prompt 空 → 400 `prompt required`
 *   C4 POST body 非法 JSON → 400 `invalid JSON body`
 *   C5 POST session 不存在 → 404
 *   C6 POST name 缺省 = prompt.slice(0,30)
 *   C7 POST 取 session.timezone（写入 job.schedule.tz）
 *   C9 POST body.timezone（client local）优先 → schedule.tz（v0.0.58.cron-fix2）
 *   C10 POST body.timezone 缺省 → resolveTz fallback
 *   C11 POST body.timezone 空串 → 视为缺省
 *   U1 PATCH 更新 cron/prompt/name → 200 + 字段改
 *   U2 PATCH cron 非法 → 400
 *   U3 PATCH session 不存在 → 404 / job 不存在 → 404
 *   D1 disable → 200 {id, enabled:false} + GET 验 nextFireAt=null
 *   D2 enable → 200 {id, enabled:true} + 不重置 lastFiredAt
 *   D3 disable/enable session/job 不存在 → 404
 *   X1 DELETE 永久删 → 200 {id, deleted:true} + 再 GET 空
 *   X2 DELETE 不存在 → 404
 *   X3 路径不存在 → 404 / 方法错 → 405
 *
 * 文件系统隔离：mkdtempSync(tmpdir) + afterEach rmSync（不碰 ~/.oobt-desktop/）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '../../config/ulid';
import { handleCronRoute, type CronRouteDeps } from '../cron-handler';
import { CronPersistenceAdapter } from '../../scheduling/persistence/cron-adapter';
import { SchedulerEngine } from '../../scheduling/engine';
import { JobHandlerRegistry } from '../../scheduling/registry';
import { SessionStore } from '../../agent/session-store';
import { SessionSchema } from '../../agent/schema_defs';
import { SquadStore } from '../../stores/squad-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';

let tmpRoot: string;
let engine: SchedulerEngine;
let cronStore: CronPersistenceAdapter;
let sessionStore: SessionStore;
let squadStore: SquadStore;
let deps: CronRouteDeps;
let sessionId: string;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cron-http-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine)
    .mount('transcript', fsEngine)
    .mount('summary', fsEngine)
    .mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  squadStore = new SquadStore({ root: tmpRoot });
  engine = new SchedulerEngine({ registry: new JobHandlerRegistry() });
  cronStore = new CronPersistenceAdapter({
    fsRoot: tmpRoot,
    resolveSquadId: async () => null,
  });
  deps = { cronStore, engine, sessionStore, squadStore };
  sessionId = ulid();
  await sessionStore.createSession({ id: sessionId, title: 't' });
});

afterEach(() => {
  engine.stop();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const req = new Request(`http://test${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const res = await handleCronRoute(req, method, path, deps);
  return { status: res.status, body: await res.json() };
}

const CRON = '0 9 * * *'; // 每天 9 点

async function createJob(overrides: Partial<{ cron: string; prompt: string; name: string; enabled: boolean }> = {}): Promise<string> {
  const { status, body } = await call('POST', `/session/${sessionId}/cron`, {
    cron: overrides.cron ?? CRON,
    prompt: overrides.prompt ?? '检查 todo.md',
    ...(overrides.name !== undefined ? { name: overrides.name } : {}),
    ...(overrides.enabled !== undefined ? { enabled: overrides.enabled } : {}),
  });
  expect(status).toBe(201);
  return body.id as string;
}

// ============================================================
// GET 列表
// ============================================================

describe('cron HTTP handler — GET 列表', () => {
  it('L1: GET 空列表 → 200 {items:[]}', async () => {
    const { status, body } = await call('GET', `/session/${sessionId}/cron`);
    expect(status).toBe(200);
    expect(body).toEqual({ items: [] });
  });

  it('L2: GET 非空 → 200 + nextFireAt 现算（enabled=true 非空 / disabled=null）', async () => {
    const jid1 = await createJob();
    const jid2 = await createJob({ enabled: false });
    const { status, body } = await call('GET', `/session/${sessionId}/cron`);
    expect(status).toBe(200);
    expect(body.items).toHaveLength(2);
    const e1 = body.items.find((x: any) => x.id === jid1);
    const e2 = body.items.find((x: any) => x.id === jid2);
    expect(e1.nextFireAt).toBeTruthy();
    expect(e2.nextFireAt).toBeNull();
  });

  it('L3: GET session 不存在 → 404', async () => {
    const { status, body } = await call('GET', `/session/no-such/cron`);
    expect(status).toBe(404);
    expect(body.error).toMatch(/session not found/);
  });
});

// ============================================================
// POST 新建
// ============================================================

describe('cron HTTP handler — POST 新建', () => {
  it('C1: POST 创建 → 201 + CronJobSummary 全字段', async () => {
    const { status, body } = await call('POST', `/session/${sessionId}/cron`, {
      cron: CRON,
      prompt: '检查 todo.md',
    });
    expect(status).toBe(201);
    expect(body.id).toMatch(new RegExp(`^cron:${sessionId}:`));
    expect(body.sessionId).toBe(sessionId);
    expect(body.cron).toBe(CRON);
    expect(body.prompt).toBe('检查 todo.md');
    expect(body.enabled).toBe(true);
    expect(body.lastFiredAt).toBeNull();
    expect(body.tz).toBeTruthy();
    expect(body.nextFireAt).toBeTruthy();
    expect(body.createdAt).toBeTruthy();
  });

  it('C2: POST cron expr 非法 → 400', async () => {
    const { status, body } = await call('POST', `/session/${sessionId}/cron`, {
      cron: 'not-a-cron',
      prompt: 'x',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cron expr invalid/);
  });

  it('C3: POST prompt 空 → 400', async () => {
    const { status, body } = await call('POST', `/session/${sessionId}/cron`, {
      cron: CRON,
      prompt: '   ',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/prompt required/);
  });

  it('C4: POST body 非法 JSON → 400', async () => {
    const req = new Request(`http://test/session/${sessionId}/cron`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await handleCronRoute(req, 'POST', `/session/${sessionId}/cron`, deps);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid JSON body/);
  });

  it('C5: POST session 不存在 → 404', async () => {
    const { status, body } = await call('POST', `/session/no-such/cron`, {
      cron: CRON,
      prompt: 'x',
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/session not found/);
  });

  it('C6: POST name 缺省 = prompt.slice(0,30)', async () => {
    const longPrompt = 'a'.repeat(50);
    const { body } = await call('POST', `/session/${sessionId}/cron`, {
      cron: CRON,
      prompt: longPrompt,
    });
    expect(body.name).toBe('a'.repeat(30));
  });

  it('C7: POST 取 session.timezone（写入 job.schedule.tz）', async () => {
    // 直接 crud 写 timezone（updateSession 不暴露 timezone patch 字段，T5 UI 后续加端点）。
    // 注意 RESERVED_ENVELOPE_FIELDS（createdAt/updatedAt/version）由 store 注入，record 不得自带。
    const cur = (sessionStore as any).crud.get(SessionSchema, sessionId);
    const { createdAt: _ca, updatedAt: _ua, version: _v, ...rest } = cur;
    void _ca; void _ua; void _v;
    (sessionStore as any).crud.put(SessionSchema, { ...rest, timezone: 'Asia/Tokyo' });
    const { body } = await call('POST', `/session/${sessionId}/cron`, {
      cron: CRON,
      prompt: 'x',
    });
    expect(body.tz).toBe('Asia/Tokyo');
  });

  it('C8: POST enabled=false → nextFireAt=null', async () => {
    const { body } = await call('POST', `/session/${sessionId}/cron`, {
      cron: CRON,
      prompt: 'x',
      enabled: false,
    });
    expect(body.enabled).toBe(false);
    expect(body.nextFireAt).toBeNull();
  });

  // v0.0.58.cron-fix2：UI HTTP body.timezone（client local）优先作 schedule.tz
  it('C9: POST body.timezone（Asia/Shanghai）→ schedule.tz = body.timezone（不 fallback）', async () => {
    const { status, body } = await call('POST', `/session/${sessionId}/cron`, {
      cron: CRON,
      prompt: 'x',
      timezone: 'Asia/Shanghai',
    });
    expect(status).toBe(201);
    expect(body.tz).toBe('Asia/Shanghai');
    // nextFireAt 用该 tz 现算（0 9 * * * Asia/Shanghai 当天 09:00 → 非 null）
    expect(body.nextFireAt).toBeTruthy();
  });

  it('C10: POST body.timezone 缺省 → schedule.tz = resolveTz fallback（session 无 tz → 进程本地）', async () => {
    // test 运行时无 session.timezone/squad.timezone，走 LOCAL_TZ（Intl 进程本地）
    const { body } = await call('POST', `/session/${sessionId}/cron`, {
      cron: CRON,
      prompt: 'x',
    });
    const expectedFallback =
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    expect(body.tz).toBe(expectedFallback);
  });

  it('C11: POST body.timezone 空串 → 视为缺省，走 fallback（不写空 tz）', async () => {
    const { body } = await call('POST', `/session/${sessionId}/cron`, {
      cron: CRON,
      prompt: 'x',
      timezone: '   ',
    });
    const expectedFallback =
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    expect(body.tz).toBe(expectedFallback);
  });
});

// ============================================================
// PATCH 更新
// ============================================================

describe('cron HTTP handler — PATCH 更新', () => {
  it('U1: PATCH 更新 cron/prompt/name → 200 + 字段改', async () => {
    const jid = await createJob();
    const { status, body } = await call('PATCH', `/session/${sessionId}/cron/${jid}`, {
      cron: '*/5 * * * *',
      prompt: 'new prompt',
      name: 'new name',
    });
    expect(status).toBe(200);
    expect(body.cron).toBe('*/5 * * * *');
    expect(body.prompt).toBe('new prompt');
    expect(body.name).toBe('new name');
  });

  it('U2: PATCH cron 非法 → 400', async () => {
    const jid = await createJob();
    const { status, body } = await call('PATCH', `/session/${sessionId}/cron/${jid}`, {
      cron: '99 99 99 99 99',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cron expr invalid/);
  });

  it('U3a: PATCH session 不存在 → 404', async () => {
    const { status } = await call('PATCH', `/session/no-such/cron/whatever`, { cron: CRON });
    expect(status).toBe(404);
  });

  it('U3b: PATCH job 不存在 → 404', async () => {
    const { status, body } = await call('PATCH', `/session/${sessionId}/cron/cron:missing:1`, {
      cron: CRON,
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/job not found/);
  });

  // ── BUG-001 回归：PATCH 也支持 encoded jobId（findJob 兼容） ──
  it('U4: PATCH 用 encoded jobId（BUG-001 场景）→ 200 + 字段改', async () => {
    const jid = await createJob();
    const encoded = encodeURIComponent(jid);
    const { status, body } = await call('PATCH', `/session/${sessionId}/cron/${encoded}`, {
      cron: '*/5 * * * *',
      prompt: 'encoded-input',
    });
    expect(status).toBe(200);
    expect(body.cron).toBe('*/5 * * * *');
    expect(body.prompt).toBe('encoded-input');
    // id 是 canonical decoded（与 GET list summary.id 一致）
    expect(body.id).toBe(jid);
  });
});

// ============================================================
// disable / enable
// ============================================================

describe('cron HTTP handler — disable/enable', () => {
  it('D1: disable → 200 {id, enabled:false} + GET 验 nextFireAt=null', async () => {
    const jid = await createJob();
    const { status, body } = await call('POST', `/session/${sessionId}/cron/${jid}/disable`);
    expect(status).toBe(200);
    expect(body).toEqual({ id: jid, enabled: false });
    const list = await call('GET', `/session/${sessionId}/cron`);
    const e = list.body.items.find((x: any) => x.id === jid);
    expect(e.enabled).toBe(false);
    expect(e.nextFireAt).toBeNull();
  });

  it('D2: enable → 200 + 不重置 lastFiredAt', async () => {
    const jid = await createJob();
    await call('POST', `/session/${sessionId}/cron/${jid}/disable`);
    // 模拟 lastFiredAt 已有值：直接 upsertJob 把 lastFiredAt 写入
    const job = (await cronStore.loadJobs(sessionId)).find((j) => j.id === jid)!;
    const fired = '2025-01-01T00:00:00.000Z';
    await cronStore.upsertJob(sessionId, { ...job, lastFiredAt: fired, enabled: false });
    const { status, body } = await call('POST', `/session/${sessionId}/cron/${jid}/enable`);
    expect(status).toBe(200);
    expect(body).toEqual({ id: jid, enabled: true });
    const after = (await cronStore.loadJobs(sessionId)).find((j) => j.id === jid)!;
    expect(after.lastFiredAt).toBe(fired); // 续接保留
  });

  it('D3: disable session/job 不存在 → 404', async () => {
    const r1 = await call('POST', `/session/no-such/cron/x/disable`);
    expect(r1.status).toBe(404);
    const r2 = await call('POST', `/session/${sessionId}/cron/cron:nope:1/disable`);
    expect(r2.status).toBe(404);
  });

  it('D4: enable 不存在的 job → 404', async () => {
    const { status } = await call('POST', `/session/${sessionId}/cron/cron:nope:1/enable`);
    expect(status).toBe(404);
  });

  // ── BUG-001 回归：UI 把 `:` encoded 成 %3A，router 不 decode → 必须 findJob 兼容 ──
  it('D5: disable 用 encoded jobId（BUG-001 场景：cron%3Asid%3Aeid）→ 200 + canonical id', async () => {
    const jid = await createJob();
    const encoded = encodeURIComponent(jid); // cron%3Asid%3Aeid
    const { status, body } = await call('POST', `/session/${sessionId}/cron/${encoded}/disable`);
    expect(status).toBe(200);
    // 响应 id 用 canonical decoded（job.id），与 GET list summary.id 一致
    expect(body).toEqual({ id: jid, enabled: false });
    const list = await call('GET', `/session/${sessionId}/cron`);
    const e = list.body.items.find((x: any) => x.id === jid);
    expect(e.enabled).toBe(false);
  });

  it('D6: enable 用 encoded jobId → 200 + canonical id（D5 对偶）', async () => {
    const jid = await createJob();
    await call('POST', `/session/${sessionId}/cron/${jid}/disable`);
    const encoded = encodeURIComponent(jid);
    const { status, body } = await call('POST', `/session/${sessionId}/cron/${encoded}/enable`);
    expect(status).toBe(200);
    expect(body).toEqual({ id: jid, enabled: true });
  });
});

// ============================================================
// DELETE 永久删
// ============================================================

describe('cron HTTP handler — DELETE', () => {
  it('X1: DELETE 永久删 → 200 {id, deleted:true} + 再 GET 空', async () => {
    const jid = await createJob();
    const { status, body } = await call('DELETE', `/session/${sessionId}/cron/${jid}`);
    expect(status).toBe(200);
    expect(body).toEqual({ id: jid, deleted: true });
    const list = await call('GET', `/session/${sessionId}/cron`);
    expect(list.body.items).toHaveLength(0);
  });

  it('X2: DELETE 不存在 → 404', async () => {
    const { status } = await call('DELETE', `/session/${sessionId}/cron/cron:nope:1`);
    expect(status).toBe(404);
  });

  it('X3: DELETE session 不存在 → 404', async () => {
    const { status } = await call('DELETE', `/session/no-such/cron/cron:nope:1`);
    expect(status).toBe(404);
  });

  // ── BUG-001 回归：DELETE 也支持 encoded jobId（engine.unregister + cronStore.removeJob 用 canonical） ──
  it('X4: DELETE 用 encoded jobId（BUG-001 场景）→ 200 {id: canonical, deleted:true} + 实际删掉', async () => {
    const jid = await createJob();
    const encoded = encodeURIComponent(jid);
    const { status, body } = await call('DELETE', `/session/${sessionId}/cron/${encoded}`);
    expect(status).toBe(200);
    // 响应 id 是 canonical decoded（job.id），不是入参 encoded
    expect(body).toEqual({ id: jid, deleted: true });
    const list = await call('GET', `/session/${sessionId}/cron`);
    expect(list.body.items).toHaveLength(0);
  });
});

// ============================================================
// 路由 / 方法兜底
// ============================================================

describe('cron HTTP handler — 路由 / 方法兜底', () => {
  it('M1: 路径不存在 → 404', async () => {
    const { status } = await call('GET', `/session/${sessionId}/cron/whatever/sub/sub`);
    expect(status).toBe(404);
  });

  it('M2: /cron 方法错 → 405 + Allow', async () => {
    const { status, body } = await call('DELETE', `/session/${sessionId}/cron`);
    expect(status).toBe(405);
    expect(body.error).toMatch(/Method Not Allowed/);
  });

  it('M3: /cron/:jid/disable 方法错 → 405', async () => {
    const jid = await createJob();
    const { status } = await call('DELETE', `/session/${sessionId}/cron/${jid}/disable`);
    expect(status).toBe(405);
  });

  it('M4: deps null → 503', async () => {
    const req = new Request(`http://test/session/${sessionId}/cron`);
    const res = await handleCronRoute(req, 'GET', `/session/${sessionId}/cron`, null);
    expect(res.status).toBe(503);
  });
});
