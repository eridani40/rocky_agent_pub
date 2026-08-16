/**
 * squad modelRoutingPlanId 挂载单测（v0.0.347 T1）
 * 参考: specs/api/overall/21-model-routing.md §2.5（PATCH 三语义 + SquadDetail 回显）
 *
 * 覆盖（task.json acceptanceCriteria）：
 *   - PATCH modelRoutingPlanId 挂载成功 + SquadDetail 回显 + GET 落盘一致
 *   - planId 不存在 → 400 plan not found
 *   - null 清空（响应无字段省略；GET 也无字段）
 *   - undefined 不写（改 name 不动 modelRoutingPlanId）
 *   - 非字符串/空串 → 400
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { handleSquadRoute, type SquadHandlerDeps } from '../squad';
import { createSquadService } from '../../services/squad-service';
import { SquadStore, MemberStore } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { AppConfigService } from '../../config/app-config-service';

let tmpRoot: string;
let sessionStore: SessionStore;
let squadId: string;
let deps: SquadHandlerDeps;
let appConfig: AppConfigService;

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-mr-'));
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
  appConfig = new AppConfigService({ root: tmpRoot });
  // 一个合法 provider + 一个合法方案（plan-a）
  appConfig.set('providers', 'prov-a', {
    id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'model-a', enabled: true }],
  });
  appConfig.set('model_routing_plans', 'plan-a', {
    id: 'plan-a', name: 'A', createdAt: 1755200000000,
    items: [{ providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true }],
  });
  deps = { sessionStore, dataDir: tmpRoot, appConfig };
});

afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

async function jsonBody(r: Response): Promise<any> { return JSON.parse(await r.text()); }

function patchReq(body: unknown): Request {
  return new Request(`http://t/squad/${squadId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('[v0.0.347] squad PATCH modelRoutingPlanId（api §2.5）', () => {
  it('挂载存在的方案 → 200 回显 + GET 落盘一致', async () => {
    const r = await handleSquadRoute(patchReq({ modelRoutingPlanId: 'plan-a' }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).modelRoutingPlanId).toBe('plan-a');
    const g = await handleSquadRoute(new Request(`http://t/squad/${squadId}`), 'GET', `/squad/${squadId}`, deps);
    expect((await jsonBody(g)).modelRoutingPlanId).toBe('plan-a');
  });

  it('planId 不存在 → 400 plan not found（不落盘）', async () => {
    const r = await handleSquadRoute(patchReq({ modelRoutingPlanId: '01KZZZZZZZZZZZZZZZZZZZZZZ' }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toContain('plan not found');
  });

  it('null 清空 → 200 无字段省略 + GET 也无字段', async () => {
    await handleSquadRoute(patchReq({ modelRoutingPlanId: 'plan-a' }), 'PATCH', `/squad/${squadId}`, deps);
    const r = await handleSquadRoute(patchReq({ modelRoutingPlanId: null }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(200);
    expect((await jsonBody(r)).modelRoutingPlanId).toBeUndefined();
    const g = await handleSquadRoute(new Request(`http://t/squad/${squadId}`), 'GET', `/squad/${squadId}`, deps);
    expect((await jsonBody(g)).modelRoutingPlanId).toBeUndefined();
  });

  it('undefined 不写：改 name 不动 modelRoutingPlanId（先清空后改名仍无字段）', async () => {
    await handleSquadRoute(patchReq({ modelRoutingPlanId: 'plan-a' }), 'PATCH', `/squad/${squadId}`, deps);
    await handleSquadRoute(patchReq({ modelRoutingPlanId: null }), 'PATCH', `/squad/${squadId}`, deps);
    const r = await handleSquadRoute(patchReq({ name: 'renamed' }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.name).toBe('renamed');
    expect(b.modelRoutingPlanId).toBeUndefined();
  });

  it('undefined 不写：已有挂载时改 name 保留挂载', async () => {
    await handleSquadRoute(patchReq({ modelRoutingPlanId: 'plan-a' }), 'PATCH', `/squad/${squadId}`, deps);
    const r = await handleSquadRoute(patchReq({ name: 'renamed2' }), 'PATCH', `/squad/${squadId}`, deps);
    expect((await jsonBody(r)).modelRoutingPlanId).toBe('plan-a');
  });

  it('非字符串 / 空串 → 400', async () => {
    const r1 = await handleSquadRoute(patchReq({ modelRoutingPlanId: 123 }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r1.status).toBe(400);
    const r2 = await handleSquadRoute(patchReq({ modelRoutingPlanId: '' }), 'PATCH', `/squad/${squadId}`, deps);
    expect(r2.status).toBe(400);
  });
});

// [v0.0.347 T6 修正段决策㉝] PATCH 双非空互斥 400（老板 22:22 拍板「必须只保留一个有效的」）
describe('[v0.0.347 T6] squad PATCH 严格互斥（双非空 400）', () => {
  it('载荷同时含非空 modelDefault + 非空 modelRoutingPlanId → 400 mutually exclusive', async () => {
    const r = await handleSquadRoute(
      patchReq({ modelDefault: 'model-a', modelRoutingPlanId: 'plan-a' }), 'PATCH', `/squad/${squadId}`, deps,
    );
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toBe('modelDefault and modelRoutingPlanId are mutually exclusive');
  });

  it('选模型组合（非空 modelDefault + planId:null）→ 200 合法放行', async () => {
    const r = await handleSquadRoute(
      patchReq({ modelDefault: 'model-a', modelRoutingPlanId: null }), 'PATCH', `/squad/${squadId}`, deps,
    );
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.modelDefault).toBe('model-a');
    expect(b.modelRoutingPlanId).toBeUndefined();
  });

  it('选方案组合（modelDefault 清空 + 非空 planId）→ 200 合法落盘', async () => {
    const r = await handleSquadRoute(
      patchReq({ modelDefault: '', modelDefaultProviderId: '', modelRoutingPlanId: 'plan-a' }), 'PATCH', `/squad/${squadId}`, deps,
    );
    expect(r.status).toBe(200);
    const b = await jsonBody(r);
    expect(b.modelRoutingPlanId).toBe('plan-a');
  });

  it('双非空校验先于 404（不存在的 squad + 双非空 → 400 优先）', async () => {
    const r = await handleSquadRoute(
      new Request('http://t/squad/nonexistent', {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ modelDefault: 'model-a', modelRoutingPlanId: 'plan-a' }),
      }), 'PATCH', '/squad/nonexistent', deps,
    );
    expect(r.status).toBe(400);
    expect((await jsonBody(r)).error).toContain('mutually exclusive');
  });
});
