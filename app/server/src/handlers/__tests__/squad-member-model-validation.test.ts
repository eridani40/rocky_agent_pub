/**
 * squad/member handler 写入校验 UT（v0.0.36 fail-fast + v0.0.155 ModelRef 复合 + member.model 硬删）
 * 参考: specs/api/overall/11a-squad-endpoints.md §1 §2（400 错误码）
 *       specs/api/overall/02-llm-chat.md §5（provider/model enabled 语义）
 *       specs/tech/version_logs/v0.0.155/change_plan.md §B（复合 ModelRef）+ §C（member.model 硬删）
 *
 * 覆盖：
 *   - POST /squad modelDefault 非法 → 400；合法 → 201
 *   - POST /squad modelDefault + providerId 复合精确校验（v0.0.155 INV-B2）
 *   - PATCH /squad modelDefault 非法 → 400
 *   - hire fresh body.model 被忽略 + warn（A4 硬删；不再 400）
 *   - hire derive overrides.model 同样被忽略 + warn
 *   - PATCH member body.model 被忽略 + warn（不再 400）
 *
 * 文件系统隔离：mkdtempSync + rmSync。单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleSquadRoute } from '../squad';
import { handleMemberRoute } from '../member';
import type { SquadHandlerDeps } from '../squad';
import { createSquadService } from '../../services/squad-service';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { AppConfigService } from '../../config/app-config-service';

let tmpRoot: string;
let sessionStore: SessionStore;
let appConfig: AppConfigService;
let deps: SquadHandlerDeps;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-mv-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fsEngine).mount('transcript', fsEngine)
    .mount('summary', fsEngine).mount('runs', fsEngine);
  sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  appConfig = new AppConfigService({ root: tmpRoot });
  // 两 provider：prov-a 托管 default + minimax-m3 + shared-model；prov-b 仅 shared-model（测复合解歧义）
  appConfig.set('providers', 'prov-a', {
    id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
    models: [
      { modelId: 'claude-sonnet-4', enabled: true },
      { modelId: 'minimax-m3', enabled: true },
      { modelId: 'shared-model', enabled: true },
    ],
  });
  appConfig.set('providers', 'prov-b', {
    id: 'prov-b', name: 'b', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'shared-model', enabled: true }],
  });
  deps = { sessionStore, dataDir: tmpRoot, appConfig };
});

afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

async function jsonBody(r: Response): Promise<any> { return JSON.parse(await r.text()); }

function squadReq(method: string, path: string, body?: unknown): Request {
  return new Request(`http://t${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function memberReq(method: string, squadId: string, body?: unknown): Request {
  return new Request(`http://t/squad/${squadId}/member`, {
    method, headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('[v0.0.36] SquadHandler 写入校验（非法 modelDefault 被拒）', () => {
  it('POST /squad modelDefault 非法（claude-sonnet）→ 400', async () => {
    const r = await handleSquadRoute(squadReq('POST', '/squad', {
      name: 's1', modelDefault: 'claude-sonnet', leader: { name: 'lead' },
    }), 'POST', '/squad', deps);
    expect(r.status).toBe(400);
    const b = await jsonBody(r);
    expect(b.error).toContain('claude-sonnet');
  });

  it('POST /squad modelDefault 合法 → 201（不回归）', async () => {
    const r = await handleSquadRoute(squadReq('POST', '/squad', {
      name: 's1', modelDefault: 'claude-sonnet-4', leader: { name: 'lead' },
    }), 'POST', '/squad', deps);
    expect(r.status).toBe(201);
    expect((await jsonBody(r)).modelDefault).toBe('claude-sonnet-4');
  });

  it('PATCH /squad modelDefault 非法 → 400（字段级，优先于 404）', async () => {
    const created = await createSquadService(
      { sessionStore, squadStore: new SquadStore({ root: tmpRoot }), memberStore: new MemberStore({ root: tmpRoot }), dataDir: tmpRoot, appConfig },
      { name: 's1', modelDefault: 'claude-sonnet-4', leader: { name: 'lead' } },
    );
    const r = await handleSquadRoute(squadReq('PATCH', created.squad.id, {
      modelDefault: 'bogus-model',
    }), 'PATCH', `/squad/${created.squad.id}`, deps);
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toContain('bogus-model');
  });

  it('PATCH /squad modelDefault 合法 → 200', async () => {
    const created = await createSquadService(
      { sessionStore, squadStore: new SquadStore({ root: tmpRoot }), memberStore: new MemberStore({ root: tmpRoot }), dataDir: tmpRoot, appConfig },
      { name: 's1', modelDefault: 'claude-sonnet-4', leader: { name: 'lead' } },
    );
    const r = await handleSquadRoute(squadReq('PATCH', created.squad.id, {
      modelDefault: 'minimax-m3',
    }), 'PATCH', `/squad/${created.squad.id}`, deps);
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).modelDefault).toBe('minimax-m3');
  });
});

describe('[v0.0.155] SquadHandler 复合 ModelRef 校验（INV-B1/B2/C1）', () => {
  it('POST /squad modelDefault + providerId 复合精确命中 → 201', async () => {
    const r = await handleSquadRoute(squadReq('POST', '/squad', {
      name: 's1', modelDefault: 'shared-model', modelDefaultProviderId: 'prov-b',
      leader: { name: 'lead' },
    }), 'POST', '/squad', deps);
    expect(r.status).toBe(201);
    const b = await jsonBody(r);
    expect(b.modelDefault).toBe('shared-model');
    expect(b.modelDefaultProviderId).toBe('prov-b');
  });

  it('POST /squad providerId 命中 provider 但 provider 不含 modelId → 400（精确校验）', async () => {
    // prov-b 无 'claude-sonnet-4'，hint=prov-b → 精确失败
    const r = await handleSquadRoute(squadReq('POST', '/squad', {
      name: 's1', modelDefault: 'claude-sonnet-4', modelDefaultProviderId: 'prov-b',
      leader: { name: 'lead' },
    }), 'POST', '/squad', deps);
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toContain('不属于 provider prov-b');
  });

  it('POST /squad providerId 指向不存在 provider → 400', async () => {
    const r = await handleSquadRoute(squadReq('POST', '/squad', {
      name: 's1', modelDefault: 'claude-sonnet-4', modelDefaultProviderId: 'phantom-prov',
      leader: { name: 'lead' },
    }), 'POST', '/squad', deps);
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toContain('phantom-prov');
  });
});

describe('[v0.0.155] MemberHandler：member.model 硬删（A4）— body.model 忽略 + warn', () => {
  async function buildSquad(): Promise<string> {
    const created = await createSquadService(
      { sessionStore, squadStore: new SquadStore({ root: tmpRoot }), memberStore: new MemberStore({ root: tmpRoot }), dataDir: tmpRoot, appConfig },
      { name: 's1', modelDefault: 'claude-sonnet-4', leader: { name: 'lead' } },
    );
    return created.squad.id;
  }

  it('hire fresh body.model 旧 client 传 → 忽略 + warn（不 400）+ 201', async () => {
    const squadId = await buildSquad();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await handleMemberRoute(memberReq('POST', squadId, {
      mode: 'fresh', name: 'm1', intro: 'i', model: 'claude-sonnet',
    }), 'POST', `/squad/${squadId}/member`, deps);
    // 不再 400（A4 硬删；旧 client 兼容）
    expect(r.status).toBe(201);
    // warn 兜底触发
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('HireBody.model is dead'));
    // member record 无 model 字段
    const member = (await jsonBody(r)).member;
    expect(member.model).toBeUndefined();
    warnSpy.mockRestore();
  });

  it('hire derive overrides.model 旧 client 传 → 忽略 + warn', async () => {
    const squadId = await buildSquad();
    const hireR = await handleMemberRoute(memberReq('POST', squadId, {
      mode: 'fresh', name: 'src', intro: 'i',
    }), 'POST', `/squad/${squadId}/member`, deps);
    const srcId = (await jsonBody(hireR)).member.id;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await handleMemberRoute(memberReq('POST', squadId, {
      mode: 'derive', deriveFrom: srcId,
      overrides: { name: 'derived', model: 'bogus-model' },
    }), 'POST', `/squad/${squadId}/member`, deps);
    expect(r.status).toBe(201);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('overrides.model is dead'));
    warnSpy.mockRestore();
  });

  it('hire fresh 无 model → 201（member 无 model 字段）', async () => {
    const squadId = await buildSquad();
    const r = await handleMemberRoute(memberReq('POST', squadId, {
      mode: 'fresh', name: 'm1', intro: 'i',
    }), 'POST', `/squad/${squadId}/member`, deps);
    expect(r.status).toBe(201);
    const member = (await jsonBody(r)).member;
    expect(member.model).toBeUndefined();
  });

  it('PATCH member body.model 旧 client 传 → 忽略 + warn（不再 400）', async () => {
    const squadId = await buildSquad();
    const hireR = await handleMemberRoute(memberReq('POST', squadId, {
      mode: 'fresh', name: 'm1', intro: 'i',
    }), 'POST', `/squad/${squadId}/member`, deps);
    const mateId = (await jsonBody(hireR)).member.id;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await handleMemberRoute(new Request(`http://t/squad/${squadId}/member/${mateId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'bogus-model' }),
    }), 'PATCH', `/squad/${squadId}/member/${mateId}`, deps);
    // 不再 400（A4；body.model 被忽略）
    expect(r.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('PatchMemberBody.model is dead'));
    const member = (await jsonBody(r)).member;
    expect(member.model).toBeUndefined();
    warnSpy.mockRestore();
  });
});
