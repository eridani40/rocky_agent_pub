/**
 * kv-config model-routing 校验钩子单测（v0.0.347 T1）
 * 参考: specs/api/overall/21-model-routing.md §2.2/§2.3/§2.4
 *
 * 覆盖：
 *   - PUT model_routing_plans：违规 400 + 明确 message 且不落盘；合法保存成功
 *   - PUT model_routing（playground 挂载）：planId 不存在 400；存在成功；data:{} 解除
 *   - DELETE：白名单 405 / key 缺失 400 / planId 不存在 404 / 成功 detached 清单（含 squad+playground 解除）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../config/app-config-service';
import { SquadStore } from '../../stores/squad-store';
import { ulid } from '../../config/ulid';
import { handleKvConfigPut, handleKvConfigDelete } from '../kv-config-handlers';

let tmpRoot: string;
let appConfig: AppConfigService;
let squadStore: SquadStore;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mr-kv-'));
  appConfig = new AppConfigService({ root: tmpRoot });
  squadStore = new SquadStore({ root: tmpRoot });
  appConfig.set('providers', 'prov-a', {
    id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'model-a', enabled: true }],
  });
  appConfig.set('providers', 'prov-b', {
    id: 'prov-b', name: 'b', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'model-b', enabled: true }],
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function putReq(body: unknown): Request {
  return new Request('http://t/config/app', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

function delReq(group: string, key: string | null): Request {
  const q = key === null ? `group=${group}` : `group=${group}&key=${key}`;
  return new Request(`http://t/config/app?${q}`, { method: 'DELETE' });
}

function planData(id: string, items: unknown[]): unknown {
  return { id, name: 'plan', items, createdAt: 1755200000000 };
}

async function bodyOf(r: Response): Promise<any> { return JSON.parse(await r.text()); }

describe('[v0.0.347] PUT model_routing_plans 校验钩子（api §2.2）', () => {
  it('合法方案 → 200 ok 且落库可读', async () => {
    const r = await handleKvConfigPut(putReq({
      group: 'model_routing_plans', key: 'plan-1',
      data: planData('plan-1', [
        { providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true },
        { providerId: 'prov-b', modelId: 'model-b', priority: 2, enabled: true },
      ]),
    }), appConfig);
    expect(r.status).toBe(200);
    expect(await bodyOf(r)).toEqual({ ok: true });
    const got = appConfig.get('model_routing_plans', 'plan-1') as { id: string };
    expect(got.id).toBe('plan-1');
  });

  it('违规（同模型 2 带时间）→ 400 + message 且不落盘', async () => {
    const r = await handleKvConfigPut(putReq({
      group: 'model_routing_plans', key: 'bad',
      data: planData('bad', [
        { providerId: 'prov-a', modelId: 'model-a', priority: 1, timeCondition: { hours: [1] }, enabled: true },
        { providerId: 'prov-a', modelId: 'model-a', priority: 2, timeCondition: { hours: [2] }, enabled: true },
      ]),
    }), appConfig);
    expect(r.status).toBe(400);
    expect((await bodyOf(r)).error).toContain('cannot have 2 time-condition items');
    expect(appConfig.get('model_routing_plans', 'bad')).toBeUndefined();
  });

  it('违规（带时间在下）→ 400 + message', async () => {
    const r = await handleKvConfigPut(putReq({
      group: 'model_routing_plans', key: 'bad',
      data: planData('bad', [
        { providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true },
        { providerId: 'prov-a', modelId: 'model-a', priority: 2, timeCondition: { hours: [1] }, enabled: true },
      ]),
    }), appConfig);
    expect(r.status).toBe(400);
    expect((await bodyOf(r)).error).toContain('time-condition item must be above');
  });

  it('违规（同模型 2 不带时间）→ 400 + message', async () => {
    const r = await handleKvConfigPut(putReq({
      group: 'model_routing_plans', key: 'bad',
      data: planData('bad', [
        { providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true },
        { providerId: 'prov-a', modelId: 'model-a', priority: 2, enabled: true },
      ]),
    }), appConfig);
    expect(r.status).toBe(400);
    expect((await bodyOf(r)).error).toContain('cannot have 2 unconditional items');
  });

  it('违规（model 不存在）→ 400 + message 且不落盘', async () => {
    const r = await handleKvConfigPut(putReq({
      group: 'model_routing_plans', key: 'bad',
      data: planData('bad', [
        { providerId: 'prov-a', modelId: 'nope', priority: 1, enabled: true },
      ]),
    }), appConfig);
    expect(r.status).toBe(400);
    expect((await bodyOf(r)).error).toContain('model not found or disabled');
  });

  it('整组提交形态也过方案校验（违规 400）', async () => {
    const r = await handleKvConfigPut(putReq({
      group: 'model_routing_plans',
      items: [{ key: 'bad', data: planData('bad', [
        { providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true },
        { providerId: 'prov-a', modelId: 'model-a', priority: 2, enabled: true },
      ]) }],
    }), appConfig);
    expect(r.status).toBe(400);
  });
});

describe('[v0.0.347] PUT model_routing（playground 挂载，api §2.4）', () => {
  it('挂载存在的方案 → 200 + playgroundPlanId 落库', async () => {
    await handleKvConfigPut(putReq({
      group: 'model_routing_plans', key: 'plan-1',
      data: planData('plan-1', [{ providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true }]),
    }), appConfig);
    const r = await handleKvConfigPut(putReq({
      group: 'model_routing', key: 'default', data: { playgroundPlanId: 'plan-1' },
    }), appConfig);
    expect(r.status).toBe(200);
    expect((appConfig.get('model_routing', 'default') as { playgroundPlanId: string }).playgroundPlanId).toBe('plan-1');
  });

  it('挂载不存在的方案 → 400 plan not found 且不落库', async () => {
    const r = await handleKvConfigPut(putReq({
      group: 'model_routing', key: 'default', data: { playgroundPlanId: 'no-such-plan' },
    }), appConfig);
    expect(r.status).toBe(400);
    expect((await bodyOf(r)).error).toContain('plan not found');
    expect(appConfig.get('model_routing', 'default')).toBeUndefined();
  });

  it('data:{}（解除挂载）→ 200 + 空对象落库', async () => {
    await handleKvConfigPut(putReq({
      group: 'model_routing_plans', key: 'plan-1',
      data: planData('plan-1', [{ providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true }]),
    }), appConfig);
    await handleKvConfigPut(putReq({
      group: 'model_routing', key: 'default', data: { playgroundPlanId: 'plan-1' },
    }), appConfig);
    const r = await handleKvConfigPut(putReq({
      group: 'model_routing', key: 'default', data: {},
    }), appConfig);
    expect(r.status).toBe(200);
    expect(appConfig.get('model_routing', 'default')).toEqual({});
  });
});

describe('[v0.0.347] DELETE /config/app 白名单（api §2.3）', () => {
  it('非 model_routing_plans group → 405 不落盘', async () => {
    const r = await handleKvConfigDelete(new URL('http://t/config/app?group=providers&key=x'), appConfig, tmpRoot);
    expect(r.status).toBe(405);
    expect(appConfig.get('providers', 'x')).toBeUndefined();
  });

  it('key 缺失 → 400', async () => {
    const r = await handleKvConfigDelete(new URL('http://t/config/app?group=model_routing_plans'), appConfig, tmpRoot);
    expect(r.status).toBe(400);
  });

  it('planId 不存在 → 404（幂等）', async () => {
    const r = await handleKvConfigDelete(new URL('http://t/config/app?group=model_routing_plans&key=ghost'), appConfig, tmpRoot);
    expect(r.status).toBe(404);
  });

  it('删除挂载中的方案 → 200 detached 含 squad+playground，引用全部解除', async () => {
    const planId = 'plan-1';
    await handleKvConfigPut(putReq({
      group: 'model_routing_plans', key: planId,
      data: planData(planId, [{ providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true }]),
    }), appConfig);
    // squad 挂载
    const sid = ulid();
    await squadStore.putSquad({
      id: sid, name: 's1', description: '', modelDefault: 'm', leaderId: ulid(),
      memberIds: [ulid()], squadChatSessionId: ulid(), budget: null,
      enableHeartBeat: false, enableGroupChat: false, timezone: 'UTC',
      modelRoutingPlanId: planId,
    } as never);
    // playground 挂载
    await handleKvConfigPut(putReq({
      group: 'model_routing', key: 'default', data: { playgroundPlanId: planId },
    }), appConfig);
    // 另一个 squad 挂别的方案（不受影响）
    const sid2 = ulid();
    await squadStore.putSquad({
      id: sid2, name: 's2', description: '', modelDefault: 'm', leaderId: ulid(),
      memberIds: [ulid()], squadChatSessionId: ulid(), budget: null,
      enableHeartBeat: false, enableGroupChat: false, timezone: 'UTC',
      modelRoutingPlanId: 'other-plan',
    } as never);

    const r = await handleKvConfigDelete(new URL(`http://t/config/app?group=model_routing_plans&key=${planId}`), appConfig, tmpRoot);
    expect(r.status).toBe(200);
    const b = await bodyOf(r);
    expect(b.detached).toEqual([`squad:${sid}`, 'playground']);
    // 方案已删
    expect(appConfig.get('model_routing_plans', planId)).toBeUndefined();
    // squad 引用解除（无字段）
    const s1 = await squadStore.getSquad(sid);
    expect((s1 as unknown as { modelRoutingPlanId?: string }).modelRoutingPlanId).toBeUndefined();
    // 未挂载该方案的 squad 不受影响
    const s2 = await squadStore.getSquad(sid2);
    expect((s2 as unknown as { modelRoutingPlanId?: string }).modelRoutingPlanId).toBe('other-plan');
    // playground 解除（空对象）
    expect(appConfig.get('model_routing', 'default')).toEqual({});
  });

  it('删除无挂载方案 → 200 detached 空数组', async () => {
    await handleKvConfigPut(putReq({
      group: 'model_routing_plans', key: 'plan-1',
      data: planData('plan-1', [{ providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true }]),
    }), appConfig);
    const r = await handleKvConfigDelete(new URL('http://t/config/app?group=model_routing_plans&key=plan-1'), appConfig, tmpRoot);
    expect(r.status).toBe(200);
    expect((await bodyOf(r)).detached).toEqual([]);
  });
});
