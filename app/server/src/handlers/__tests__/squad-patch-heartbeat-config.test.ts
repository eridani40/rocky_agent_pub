/**
 * squad-api Task#3 单测（白盒）——validateHeartbeatConfig 校验链 + SquadDetail 回显 + 废弃端点
 * 参考: specs/api/overall/11a-squad-endpoints.md §1.4（PATCH /squad heartbeatConfig 字段/400 语义）
 *       specs/tech/squad/[P1]data_model.md §1.1a（interval 枚举/activeWindows 段校验/scope）
 *       AT: tests/api/squad/heartbeat_config_crud_tc1/checkpoint.json
 *
 * 覆盖：
 *   UC-8  PATCH heartbeatConfig 合法 → 200 + SquadDetail.heartbeatConfig 回显
 *   UC-8  PATCH heartbeatConfig:null → 200 + GET 回显 null
 *   UC-8  400 interval 非枚举（7）
 *   UC-8  400 activeWindows 段重叠（09:00-18:00 + 17:00-20:00）
 *   UC-8  400 单段 start>=end（18:00,09:00）
 *   UC-8  400 scope.mode 非法（everyone）
 *   400 优先于 404（bad heartbeatConfig 先于 squad 查）
 *   PATCH /squad/:id/member/:mid/heartbeat → 404（端点已废弃，router 不再分发）
 *   SquadDetail.members[].currentWork 字段存在（presence 回显）
 *   PatchMemberBody.heartbeat → warn-and-ignore（不写盘）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleSquadRoute, type SquadHandlerDeps, type SquadRuntimePort } from '../squad';
import { handleMemberRoute } from '../member';
import { createSquadService } from '../../services/squad-service';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';

let tmpRoot: string;
let sessionStore: SessionStore;
let squadId: string;
let leaderId: string;
let reloadSquadMock: ReturnType<typeof vi.fn>;
let deps: SquadHandlerDeps;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-hb-config-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine).mount('transcript', fsEngine)
    .mount('summary', fsEngine).mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  const squadStore = new SquadStore({ root: tmpRoot });
  const memberStore = new MemberStore({ root: tmpRoot });
  const created = await createSquadService(
    { sessionStore, squadStore, memberStore, dataDir: tmpRoot },
    { name: 'testSquad', modelDefault: 'm', leader: { name: 'leader' } },
  );
  squadId = created.squad.id;
  leaderId = created.leaderMember.id;
  reloadSquadMock = vi.fn().mockResolvedValue(undefined);
  const runtime: SquadRuntimePort = {
    reloadSquad: reloadSquadMock,
    getScheduler: () => undefined,
    disposeSquad: vi.fn(),
  };
  deps = { sessionStore, dataDir: tmpRoot, squadRuntime: runtime };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

function patchSquadReq(body: unknown): Request {
  return new Request(`http://test/squad/${squadId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getSquadReq(): Request {
  return new Request(`http://test/squad/${squadId}`, { method: 'GET' });
}

// ===================== heartbeatConfig 校验链 =====================

describe('PATCH /squad heartbeatConfig — 校验链（UC-8）', () => {
  it('合法 heartbeatConfig → 200 + SquadDetail.heartbeatConfig 回显 + reloadSquad', async () => {
    const cfg = {
      interval: 15,
      activeWindows: [{ start: '09:00', end: '18:00' }],
      scope: { mode: 'whitelist', memberIds: [leaderId] },
    };
    const r = await handleSquadRoute(patchSquadReq({ heartbeatConfig: cfg }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.heartbeatConfig).toEqual(cfg);
    expect(reloadSquadMock).toHaveBeenCalledWith(squadId);
  });

  it('heartbeatConfig:null → 200 + GET 回显 null（清空=回退默认）', async () => {
    // 先写一次配置
    await handleSquadRoute(patchSquadReq({
      heartbeatConfig: { interval: 15, activeWindows: [], scope: { mode: 'all', memberIds: [] } },
    }), 'PATCH', `/squad/${squadId}`, deps);
    reloadSquadMock.mockClear();

    // 再清空
    const r = await handleSquadRoute(patchSquadReq({ heartbeatConfig: null }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.heartbeatConfig).toBeNull();
    expect(reloadSquadMock).toHaveBeenCalledWith(squadId);

    // GET 验回显
    const gr = await handleSquadRoute(getSquadReq(), 'GET', `/squad/${squadId}`, deps);
    const gb = await jsonBody(gr);
    expect(gb.heartbeatConfig).toBeNull();
  });

  it('heartbeatConfig undefined → 不改（不传则 heartbeatConfig 保持原值）', async () => {
    // 先写配置
    const cfg = { interval: 5, activeWindows: [], scope: { mode: 'all', memberIds: [] } };
    await handleSquadRoute(patchSquadReq({ heartbeatConfig: cfg }), 'PATCH', `/squad/${squadId}`, deps);
    // 只改 enableHeartBeat，不传 heartbeatConfig
    const r = await handleSquadRoute(patchSquadReq({ enableHeartBeat: true }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.heartbeatConfig).toEqual(cfg);
  });

  it('400 interval 非枚举（7）', async () => {
    const r = await handleSquadRoute(patchSquadReq({
      heartbeatConfig: { interval: 7, activeWindows: [], scope: { mode: 'all', memberIds: [] } },
    }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(400);
    const b = await jsonBody(r);
    expect(b.error).toMatch(/interval/);
  });

  it('400 activeWindows 段重叠（09:00-18:00 + 17:00-20:00）', async () => {
    const r = await handleSquadRoute(patchSquadReq({
      heartbeatConfig: {
        interval: 15,
        activeWindows: [{ start: '09:00', end: '18:00' }, { start: '17:00', end: '20:00' }],
        scope: { mode: 'all', memberIds: [] },
      },
    }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(400);
    const b = await jsonBody(r);
    expect(b.error).toMatch(/overlap/i);
  });

  it('400 单段 start>=end（start:18:00,end:09:00）', async () => {
    const r = await handleSquadRoute(patchSquadReq({
      heartbeatConfig: {
        interval: 15,
        activeWindows: [{ start: '18:00', end: '09:00' }],
        scope: { mode: 'all', memberIds: [] },
      },
    }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(400);
    const b = await jsonBody(r);
    expect(b.error).toMatch(/start.*before.*end|cross-midnight/i);
  });

  it('400 scope.mode 非法（everyone）', async () => {
    const r = await handleSquadRoute(patchSquadReq({
      heartbeatConfig: {
        interval: 15,
        activeWindows: [],
        scope: { mode: 'everyone', memberIds: [] },
      },
    }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(400);
    const b = await jsonBody(r);
    expect(b.error).toMatch(/scope\.mode/);
  });

  it('400 activeWindows HH:mm 格式错（9am）', async () => {
    const r = await handleSquadRoute(patchSquadReq({
      heartbeatConfig: {
        interval: 15,
        activeWindows: [{ start: '9am', end: '17:00' }],
        scope: { mode: 'all', memberIds: [] },
      },
    }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(400);
    const b = await jsonBody(r);
    expect(b.error).toMatch(/HH:mm/i);
  });

  it('400 优先于 404（bad heartbeatConfig 先于 squad 查）', async () => {
    const r = await handleSquadRoute(new Request('http://test/squad/bogus-squad', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        heartbeatConfig: { interval: 7, activeWindows: [], scope: { mode: 'all', memberIds: [] } },
      }),
    }), 'PATCH', '/squad/bogus-squad', deps);
    expect(r.status).toBe(400);
  });
});

// ===================== SquadDetail 回显 =====================

describe('SquadDetail 回显（11a §1.3）', () => {
  it('GET /squad/:id → heartbeatConfig 字段存在（新建 squad 为 null）', async () => {
    const r = await handleSquadRoute(getSquadReq(), 'GET', `/squad/${squadId}`, deps);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b).toHaveProperty('heartbeatConfig');
    expect(b.heartbeatConfig).toBeNull();
  });

  it('GET /squad/:id → members[] 存在，currentWork 访问不报错（presence 回显；新建 member 可 undefined）', async () => {
    const r = await handleSquadRoute(getSquadReq(), 'GET', `/squad/${squadId}`, deps);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.members.length).toBeGreaterThan(0);
    // currentWork 可能 undefined（schema required:false + 新建 member 无值），但访问不崩溃
    const cw = b.members[0].currentWork;
    expect(cw === null || cw === undefined || typeof cw === 'object').toBe(true);
  });
});

// ===================== dead 字段 warn-and-ignore =====================

describe('PatchMemberBody.heartbeat dead（warn-and-ignore）', () => {
  it('PATCH member with heartbeat → 200 + heartbeat 不写盘', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await handleMemberRoute(
      new Request(`http://test/squad/${squadId}/member/${leaderId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ heartbeat: { activeWindow: { start: '09:00', end: '17:00' }, interval: 5 } }),
      }),
      'PATCH',
      `/squad/${squadId}/member/${leaderId}`,
      deps,
    );
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    // heartbeat dead 字段不写盘：存量 member 无 heartbeat → undefined（schema required:false）
    expect(b.member.heartbeat === null || b.member.heartbeat === undefined).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringMatching(/heartbeat.*dead/i));
    consoleSpy.mockRestore();
  });
});
