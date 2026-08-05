/**
 * squad handler 单测（白盒）—— PATCH /squad/:id v0.0.33.4 行为变更
 * 参考: specs/api/version_logs/v0.0.33.4/change_log.md §2（字段生效 + reloadSquad + SquadDetail 三字段回显）
 *
 * 覆盖：
 *   - PATCH enableHeartBeat/budget/timezone → 200 + SquadDetail 三字段回显 + reloadSquad 调用
 *   - 字段持久（PATCH 后 GET 重读仍在）
 *   - 400 budget.limit<0 / 400 budget shape 错 / 400 timezone 非 IANA（Not/A_TZ）
 *   - 404 squad 不存在
 *   - GET /squad/:id → SquadDetail.timezone 必含（老 squad 未配 → 本地 tz 回显）
 *   - reloadSquad best-effort（抛错不影响持久化 → 200）
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleSquadRoute } from '../squad';
import type { SquadHandlerDeps, SquadRuntimePort } from '../squad';
import { createSquadService } from '../../services/squad-service';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';

let tmpRoot: string;
let sessionStore: SessionStore;
let squadId: string;
let reloadSquadMock: ReturnType<typeof vi.fn>;
let deps: SquadHandlerDeps;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-patch-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore().mount('session', fsEngine).mount('transcript', fsEngine)
    .mount('summary', fsEngine).mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  const squadStore = new SquadStore({ root: tmpRoot });
  const memberStore = new MemberStore({ root: tmpRoot });
  const created = await createSquadService(
    { sessionStore, squadStore, memberStore, dataDir: tmpRoot },
    { name: 's1', modelDefault: 'm', leader: { name: 'lead' } },
  );
  squadId = created.squad.id;
  reloadSquadMock = vi.fn().mockResolvedValue(undefined);
  const runtime = { reloadSquad: reloadSquadMock, getScheduler: () => undefined, disposeSquad: vi.fn() } as unknown as SquadRuntimePort;
  deps = { sessionStore, dataDir: tmpRoot, squadRuntime: runtime };
});

afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

async function jsonBody(r: Response): Promise<any> { return JSON.parse(await r.text()); }

function patchReq(body: unknown): Request {
  return new Request(`http://t/squad/${squadId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('SquadHandler PATCH — v0.0.33.4 字段生效（api §2）', () => {
  it('PATCH enableHeartBeat/budget/timezone → 200 + SquadDetail 三字段回显 + reloadSquad', async () => {
    const r = await handleSquadRoute(patchReq({
      enableHeartBeat: true,
      budget: { limit: 5000, window: 'daily', scope: 'team' },
      timezone: 'Asia/Shanghai',
    }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.enableHeartBeat).toBe(true);
    expect(b.budget).toEqual({ limit: 5000, window: 'daily', scope: 'team' });
    expect(b.timezone).toBe('Asia/Shanghai');
    expect(reloadSquadMock).toHaveBeenCalledWith(squadId);
  });

  it('字段持久：PATCH 后 GET 重读仍在', async () => {
    await handleSquadRoute(patchReq({
      enableHeartBeat: true, budget: { limit: 300, window: 'daily', scope: 'team' }, timezone: 'UTC',
    }), 'PATCH', `/squad/${squadId}`, deps);
    const r = await handleSquadRoute(new Request(`http://t/squad/${squadId}`), 'GET', `/squad/${squadId}`, deps);
    const b = await jsonBody(r);
    expect(b.enableHeartBeat).toBe(true);
    expect(b.budget.limit).toBe(300);
    expect(b.timezone).toBe('UTC');
  });

  it('budget=null → 200 + SquadDetail.budget=null', async () => {
    const r = await handleSquadRoute(patchReq({ budget: null }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).budget).toBeNull();
  });

  it('400 budget.limit<0', async () => {
    const r = await handleSquadRoute(patchReq({ budget: { limit: -5, window: 'daily', scope: 'team' } }),
      'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(400);
  });

  it('400 budget shape 错（缺字段）', async () => {
    const r = await handleSquadRoute(patchReq({ budget: { limit: 100 } }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(400);
  });

  it('400 timezone 非 IANA（Not/A_TZ）', async () => {
    const r = await handleSquadRoute(patchReq({ timezone: 'Not/A_TZ' }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(400);
  });

  it('404 squad 不存在', async () => {
    const r = await handleSquadRoute(patchReq({ enableHeartBeat: true }), 'PATCH', '/squad/bogus-squad', deps);
    expect(r.status).toBe(404);
    expect(reloadSquadMock).not.toHaveBeenCalled();
  });

  it('400 优先于 404（limit<0 先于 squad 查）', async () => {
    const r = await handleSquadRoute(patchReq({ budget: { limit: -1, window: 'daily', scope: 'team' } }),
      'PATCH', '/squad/bogus-squad', deps);
    expect(r.status).toBe(400);
  });

  it('GET /squad/:id → SquadDetail.timezone 必含（老 squad 未配 → 本地 tz 回显）', async () => {
    const r = await handleSquadRoute(new Request(`http://t/squad/${squadId}`), 'GET', `/squad/${squadId}`, deps);
    const b = await jsonBody(r);
    expect(typeof b.timezone).toBe('string');
    expect(b.timezone.length).toBeGreaterThan(0);
    // enableHeartBeat/budget 也必含
    expect(typeof b.enableHeartBeat).toBe('boolean');
    expect('budget' in b).toBe(true);
  });

  it('reloadSquad 抛错 → best-effort 不影响持久化（仍 200）', async () => {
    reloadSquadMock.mockRejectedValue(new Error('reload blew up'));
    const r = await handleSquadRoute(patchReq({ enableHeartBeat: true }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).enableHeartBeat).toBe(true);
  });

  it('旧 deps（无 squadRuntime）→ PATCH 仍 200，无 reload', async () => {
    const oldDeps: SquadHandlerDeps = { sessionStore, dataDir: tmpRoot };
    const r = await handleSquadRoute(patchReq({ enableHeartBeat: true }), 'PATCH', `/squad/${squadId}`, oldDeps);
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).enableHeartBeat).toBe(true);
  });
});
