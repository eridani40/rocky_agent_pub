/**
 * model-routing-status 单测（v0.0.347 T1）
 * 参考: specs/api/overall/21-model-routing.md §2.6（响应形状 + D16 presentation 映射）
 *
 * 覆盖：
 *   - 无任何熔断记录 → 全 closed / normal（无 remainingSeconds）
 *   - open → abnormal + remainingSeconds；half_open → observing（无倒计时）
 *   - 同模型多 item 去重（按 priority 只出一条）
 *   - planId 不存在 → 404；planId 缺失 → 400
 *   - 方案隔离（其他 planId 的熔断记录不影响本方案）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../config/app-config-service';
import {
  handleModelRoutingStatus,
  mapCircuitPresentation,
  EmptyCircuitRegistry,
  type CircuitRegistryPort,
  type CircuitSnapshotEntry,
} from '../model-routing-status';

let tmpRoot: string;
let appConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mr-status-'));
  appConfig = new AppConfigService({ root: tmpRoot });
  appConfig.set('providers', 'prov-a', {
    id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'model-a', enabled: true }],
  });
  appConfig.set('providers', 'prov-b', {
    id: 'prov-b', name: 'b', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'model-b', enabled: true }],
  });
  // 方案 A：2 条目（a 带时间 + b 无条件）
  appConfig.set('model_routing_plans', 'plan-a', {
    id: 'plan-a', name: 'A', createdAt: 1755200000000,
    items: [
      { providerId: 'prov-a', modelId: 'model-a', priority: 1, timeCondition: { hours: [2, 3] }, enabled: true },
      { providerId: 'prov-b', modelId: 'model-b', priority: 2, enabled: true },
    ],
  });
  // 方案 B（隔离验证用）
  appConfig.set('model_routing_plans', 'plan-b', {
    id: 'plan-b', name: 'B', createdAt: 1755200000001,
    items: [{ providerId: 'prov-a', modelId: 'model-a', priority: 1, enabled: true }],
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function entry(partial: Partial<CircuitSnapshotEntry>): CircuitSnapshotEntry {
  return {
    planId: 'plan-a', providerId: 'prov-a', modelId: 'model-a',
    state: 'closed', failureCount: 0, totalRequests: 0, errorRate: 0,
    ...partial,
  };
}

describe('[v0.0.347] GET /model-routing/plans/:planId/status', () => {
  it('空注册表 → 200 全 closed/normal，无 remainingSeconds', async () => {
    const r = handleModelRoutingStatus('plan-a', appConfig, new EmptyCircuitRegistry());
    expect(r.status).toBe(200);
    const b = JSON.parse(await r.text());
    expect(b.planId).toBe('plan-a');
    expect(b.items.length).toBe(2);
    for (const it of b.items) {
      expect(it.circuitState).toBe('closed');
      expect(it.presentation).toBe('normal');
      expect(it.remainingSeconds).toBeUndefined();
    }
  });

  it('open → abnormal + remainingSeconds；half_open → observing 无倒计时（D16 映射）', async () => {
    const registry: CircuitRegistryPort = {
      snapshot: () => [
        entry({ state: 'open', failureCount: 6, totalRequests: 20, errorRate: 0.5, remainingSeconds: 23 }),
        entry({ providerId: 'prov-b', modelId: 'model-b', state: 'half_open', failureCount: 1, totalRequests: 5, errorRate: 0.2 }),
      ],
    };
    const r = handleModelRoutingStatus('plan-a', appConfig, registry);
    const b = JSON.parse(await r.text());
    const a = b.items.find((i: any) => i.modelId === 'model-a');
    const bb = b.items.find((i: any) => i.modelId === 'model-b');
    expect(a.circuitState).toBe('open');
    expect(a.presentation).toBe('abnormal');
    expect(a.remainingSeconds).toBe(23);
    expect(a.failureCount).toBe(6);
    expect(a.errorRate).toBe(0.5);
    expect(bb.circuitState).toBe('half_open');
    expect(bb.presentation).toBe('observing');
    expect(bb.remainingSeconds).toBeUndefined();
  });

  it('同模型多 item 去重：按 priority 只出一条', async () => {
    // 方案 A 追加同模型 a 的第二条（带时间 + 无条件合法组合）
    appConfig.set('model_routing_plans', 'plan-a', {
      id: 'plan-a', name: 'A', createdAt: 1755200000000,
      items: [
        { providerId: 'prov-a', modelId: 'model-a', priority: 1, timeCondition: { hours: [2, 3] }, enabled: true },
        { providerId: 'prov-a', modelId: 'model-a', priority: 3, enabled: true },
        { providerId: 'prov-b', modelId: 'model-b', priority: 2, enabled: true },
      ],
    });
    const r = handleModelRoutingStatus('plan-a', appConfig, new EmptyCircuitRegistry());
    const b = JSON.parse(await r.text());
    expect(b.items.length).toBe(2);
    const aCount = b.items.filter((i: any) => i.modelId === 'model-a').length;
    expect(aCount).toBe(1);
  });

  it('方案隔离：其他 planId 的熔断记录不影响本方案（closed 基态）', async () => {
    const registry: CircuitRegistryPort = {
      snapshot: () => [entry({ planId: 'plan-b', state: 'open', remainingSeconds: 5 })],
    };
    const r = handleModelRoutingStatus('plan-a', appConfig, registry);
    const b = JSON.parse(await r.text());
    for (const it of b.items) expect(it.presentation).toBe('normal');
  });

  it('planId 不存在 → 404', async () => {
    const r = handleModelRoutingStatus('ghost', appConfig, new EmptyCircuitRegistry());
    expect(r.status).toBe(404);
  });

  it('planId 缺失/空 → 400', async () => {
    expect(handleModelRoutingStatus(undefined, appConfig, new EmptyCircuitRegistry()).status).toBe(400);
    expect(handleModelRoutingStatus('', appConfig, new EmptyCircuitRegistry()).status).toBe(400);
  });

  it('mapCircuitPresentation 纯函数映射（D16 权威表）', () => {
    expect(mapCircuitPresentation('closed')).toEqual({ presentation: 'normal' });
    expect(mapCircuitPresentation('open', entry({ remainingSeconds: 9 }))).toEqual({
      presentation: 'abnormal', remainingSeconds: 9,
    });
    expect(mapCircuitPresentation('open', entry({}))).toEqual({ presentation: 'abnormal', remainingSeconds: undefined });
    expect(mapCircuitPresentation('half_open')).toEqual({ presentation: 'observing' });
  });
});
