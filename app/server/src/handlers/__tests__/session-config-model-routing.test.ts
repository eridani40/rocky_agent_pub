/**
 * v0.0.347 — buildSessionConfigFromDeps 模型路由 resolve 双分支（D11/D12）UT
 * 参考: specs/tech/agent/providers_and_models/[P0]model_routing.md §4（resolve 双分支）
 *       specs/tech/version_logs/v0.0.347/change_plan.md resolve 行
 *
 * 覆盖：
 *   1. playground 挂载（model_routing.default.playgroundPlanId）+ session modelId=default
 *      → 分支 2：modelRoutingPlan = 方案 items 原序 + circuit 默认值填充；不 resolveModel（无 fallback）
 *   2. session 显式 modelId（非保留字）→ priority 0 插入顶部合成；不写回方案实体
 *   3. 无挂载 → 分支 1：modelRoutingPlan undefined（现有 resolveModel 原链零回归）
 *   4. 挂载悬空（方案不存在）→ 分支 1 兜底（不抛）
 *   5. studio squad 挂载（studioContext.squad.modelRoutingPlanId）→ 分支 2
 *
 * 真实 AppConfigService + bootstrapBuiltinPlugins（mock provider）+ tmpdir 隔离。
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { SessionStore } from '../../agent/session-store';
import { AppConfigService } from '../../config/app-config-service';
import { ulid } from '../../config/ulid';
import { bootstrapBuiltinPlugins } from '../../bootstrap';
import { buildSessionConfigFromDeps, resolveModelRoutingPlan } from '../session-config';
import { buildRealSessionTypePolicy } from '../../agent/__helpers__/session-type-policy-test-helper';
import type { SessionHandlerDeps } from '../session';
import { SessionKind } from '@app/shared';
import { MODEL_ROUTING_PLANS_GROUP, MODEL_ROUTING_GROUP, MODEL_ROUTING_DEFAULT_KEY } from '../../services/model-routing-store';
import { DEFAULT_CIRCUIT_CONFIG } from '../../services/model-routing-validation';
import { ModelNotConfiguredError } from '../../services/model-resolver';

const PG_ROCKY_MAIN = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent' });

let tmpRoot: string;
let store: SessionStore;
let appConfig: AppConfigService;
let deps: SessionHandlerDeps;

/** 预置 mock provider（p-a/p-b 各带模型）+ playground 挂载方案 */
function seedPlan(planId = 'plan-1'): void {
  appConfig.set('providers', 'p-a', {
    id: 'p-a', name: 'mock', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'model-a' }, { modelId: 'model-b' }],
  });
  appConfig.set('providers', 'p-b', {
    id: 'p-b', name: 'mock', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'model-c' }],
  });
  appConfig.set(MODEL_ROUTING_PLANS_GROUP, planId, {
    id: planId, name: 'test-plan', createdAt: 1,
    items: [
      { providerId: 'p-a', modelId: 'model-a', priority: 1, enabled: true },
      { providerId: 'p-b', modelId: 'model-c', priority: 2, enabled: true },
    ],
  });
  appConfig.set(MODEL_ROUTING_GROUP, MODEL_ROUTING_DEFAULT_KEY, { playgroundPlanId: planId });
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-routing-'));
  const fs = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  store = new SessionStore({ crud, fsRoot: tmpRoot });
  appConfig = new AppConfigService({ root: tmpRoot });
  const bs = await bootstrapBuiltinPlugins(tmpRoot);
  deps = {
    store,
    agentManager: bs.agentManager,
    appConfig,
    pluginManager: bs.pluginManager,
    contextEngine: bs.contextEngine,
    dataDir: tmpRoot,
    sessionTypePolicy: buildRealSessionTypePolicy(tmpRoot),
  };
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('[v0.0.347] resolveModelRoutingPlan — resolve 双分支', () => {
  it('playground 挂载 + session modelId=default → 分支 2：方案 items 原序 + circuit 默认填充', () => {
    seedPlan();
    const plan = resolveModelRoutingPlan(deps, { modelId: 'default' }, false, undefined);
    expect(plan).toBeDefined();
    expect(plan!.planId).toBe('plan-1');
    expect(plan!.items.map((i) => `${i.providerId}/${i.modelId}`)).toEqual(['p-a/model-a', 'p-b/model-c']);
    expect(plan!.circuit).toEqual(DEFAULT_CIRCUIT_CONFIG);
  });

  it('session 显式 modelId（非保留字）→ priority 0 插入顶部合成；不写回方案实体', () => {
    seedPlan();
    const plan = resolveModelRoutingPlan(deps, { modelId: 'model-b' }, false, undefined);
    expect(plan).toBeDefined();
    // priority 0 合成在顶部（session 显式模型 providerId 反查命中 p-a）
    expect(plan!.items[0]).toMatchObject({ providerId: 'p-a', modelId: 'model-b', priority: 0 });
    expect(plan!.items.map((i) => i.priority)).toEqual([0, 1, 2]);
    // 不写回方案实体：实体 items 仍 2 条原序
    const stored = appConfig.get(MODEL_ROUTING_PLANS_GROUP, 'plan-1') as {
      items: Array<{ providerId: string; modelId: string; priority: number }>;
    };
    expect(stored.items).toHaveLength(2);
    expect(stored.items[0]!.priority).toBe(1);
  });

  it('session 显式 modelId 带 providerId hint → 直接用 hint 合成 priority 0', () => {
    seedPlan();
    const plan = resolveModelRoutingPlan(deps, { providerId: 'p-b', modelId: 'model-c' }, false, undefined);
    expect(plan!.items[0]).toMatchObject({ providerId: 'p-b', modelId: 'model-c', priority: 0 });
  });

  it('无挂载 → undefined（分支 1；不抛）', () => {
    const plan = resolveModelRoutingPlan(deps, { modelId: 'default' }, false, undefined);
    expect(plan).toBeUndefined();
  });

  it('挂载悬空（方案不存在）→ undefined（分支 1 兜底；不抛）', () => {
    appConfig.set(MODEL_ROUTING_GROUP, MODEL_ROUTING_DEFAULT_KEY, { playgroundPlanId: 'ghost-plan' });
    const plan = resolveModelRoutingPlan(deps, { modelId: 'default' }, false, undefined);
    expect(plan).toBeUndefined();
  });

  it('studio squad 挂载（studioContext.squad.modelRoutingPlanId）→ 分支 2', () => {
    seedPlan();
    const plan = resolveModelRoutingPlan(deps, { modelId: 'default' }, true, {
      role: 'mate', squadId: 'sq-1', squad: { modelRoutingPlanId: 'plan-1' } as never,
    });
    expect(plan).toBeDefined();
    expect(plan!.planId).toBe('plan-1');
  });

  it('studio squad 未挂载 → undefined（分支 1）', () => {
    const plan = resolveModelRoutingPlan(deps, { modelId: 'default' }, true, {
      role: 'mate', squadId: 'sq-1', squad: {} as never,
    });
    expect(plan).toBeUndefined();
  });

  it('academy 会话（isAcademy=true）→ undefined（分支 1；不越界 playground 挂载）', () => {
    seedPlan();
    const plan = resolveModelRoutingPlan(deps, { modelId: 'default' }, false, undefined, true);
    expect(plan).toBeUndefined();
  });
});

describe('[v0.0.353 T1 D3] 显式模型条目继承 timeCondition', () => {
  /** 方案内 p-a/model-a 带时间条件（hours [9]）的 seed 变体 */
  function seedPlanWithTime(planId = 'plan-1'): void {
    appConfig.set('providers', 'p-a', {
      id: 'p-a', name: 'mock', enabled: true, kind: 'mock', credential: {},
      models: [{ modelId: 'model-a' }, { modelId: 'model-b' }],
    });
    appConfig.set('providers', 'p-b', {
      id: 'p-b', name: 'mock', enabled: true, kind: 'mock', credential: {},
      models: [{ modelId: 'model-c' }],
    });
    appConfig.set(MODEL_ROUTING_PLANS_GROUP, planId, {
      id: planId, name: 'test-plan', createdAt: 1,
      items: [
        { providerId: 'p-a', modelId: 'model-a', priority: 1, enabled: true, timeCondition: { hours: [9, 10], timezone: 'UTC' } },
        { providerId: 'p-b', modelId: 'model-c', priority: 2, enabled: true },
      ],
    });
    appConfig.set(MODEL_ROUTING_GROUP, MODEL_ROUTING_DEFAULT_KEY, { playgroundPlanId: planId });
  }

  it('显式模型与方案同模型（p-a/model-a）→ 继承首个带时间条件启用条目的 timeCondition', () => {
    seedPlanWithTime();
    const plan = resolveModelRoutingPlan(deps, { modelId: 'model-a' }, false, undefined);
    expect(plan).toBeDefined();
    expect(plan!.items[0]).toMatchObject({
      providerId: 'p-a', modelId: 'model-a', priority: 0,
      timeCondition: { hours: [9, 10], timezone: 'UTC' },
    });
    // 方案实体原 items 不受影响（临时合成不写回）
    const stored = appConfig.get(MODEL_ROUTING_PLANS_GROUP, 'plan-1') as {
      items: Array<{ timeCondition?: unknown }>;
    };
    expect(stored.items).toHaveLength(2);
  });

  it('显式模型在方案内无同模型条目（p-a/model-b）→ 全天（不带 timeCondition）', () => {
    seedPlanWithTime();
    const plan = resolveModelRoutingPlan(deps, { modelId: 'model-b' }, false, undefined);
    expect(plan).toBeDefined();
    expect(plan!.items[0]).toMatchObject({ providerId: 'p-a', modelId: 'model-b', priority: 0 });
    expect(plan!.items[0]!.timeCondition).toBeUndefined();
  });

  it('同模型但条目 disabled → 不继承（只继承启用条目的时间条件）', () => {
    seedPlanWithTime();
    // 方案内追加一条 disabled 的同模型带时间条件条目 → 不应被继承
    appConfig.set(MODEL_ROUTING_PLANS_GROUP, 'plan-1', {
      id: 'plan-1', name: 'test-plan', createdAt: 1,
      items: [
        { providerId: 'p-a', modelId: 'model-b', priority: 1, enabled: false, timeCondition: { hours: [1] } },
        { providerId: 'p-b', modelId: 'model-c', priority: 2, enabled: true },
      ],
    });
    const plan = resolveModelRoutingPlan(deps, { modelId: 'model-b' }, false, undefined);
    expect(plan).toBeDefined();
    expect(plan!.items[0]).toMatchObject({ providerId: 'p-a', modelId: 'model-b', priority: 0 });
    expect(plan!.items[0]!.timeCondition).toBeUndefined();
  });
});

describe('[v0.0.347] buildSessionConfigFromDeps — 分支 2 装配', () => {
  it('有挂载 → SessionConfig.modelRoutingPlan 注入；modelId 取 session 持久口径（非首候选）', () => {
    seedPlan();
    const config = buildSessionConfigFromDeps(deps, ulid(), {}, PG_ROCKY_MAIN);
    expect(config.modelRoutingPlan).toBeDefined();
    expect(config.modelRoutingPlan!.items).toHaveLength(2);
    expect(config.client).toBeDefined();
    // [v0.0.353 T4 根治版] 分支 2 取消启动前预选污染；SessionConfig.modelId 为 session 持久口径
    expect(config.modelId).toBe('');
  });

  it('有挂载 + session 显式 modelId → SessionConfig.modelId 取 session 持久值（非首候选）', () => {
    seedPlan();
    const config = buildSessionConfigFromDeps(deps, ulid(), { modelId: 'model-b' }, PG_ROCKY_MAIN);
    expect(config.modelRoutingPlan).toBeDefined();
    expect(config.client).toBeDefined();
    // session 持久口径：即使首候选是 model-a，也显示 session 的 model-b
    expect(config.modelId).toBe('model-b');
  });

  it('无挂载 → modelRoutingPlan undefined + resolveModel 原链（零回归）', () => {
    // 仅 default_models 配置（无 model_routing 挂载）→ 分支 1
    appConfig.set('providers', 'mock-prov', {
      id: 'mock-prov', name: 'mock', enabled: true, kind: 'mock', credential: {},
      models: [{ modelId: 'mock-model' }],
    });
    appConfig.set('default_models', 'default', { chat: 'mock-model', summary: 'mock-model' });
    const config = buildSessionConfigFromDeps(deps, ulid(), {}, PG_ROCKY_MAIN);
    expect(config.modelRoutingPlan).toBeUndefined();
    expect(config.modelId).toBe('mock-model');
    expect(config.client).toBeDefined();
  });

  it('academy 会话（playground 有挂载）→ modelRoutingPlan undefined（不越界；分支 1 走 classroom 链）', () => {
    seedPlan();
    const ACADEMY_COACH = new SessionKind({ biz: 'academy', role: 'coach', derivation: 'parent' });
    // academy 两档链（session → classroom.defaultModel）：教室默认模型 = p-a/model-a
    const config = buildSessionConfigFromDeps(
      deps, ulid(), {}, ACADEMY_COACH,
      undefined, undefined, undefined, undefined, undefined, undefined,
      { providerId: 'p-a', modelId: 'model-a' },
    );
    expect(config.modelRoutingPlan).toBeUndefined();
    expect(config.modelId).toBe('model-a'); // 走 classroom 链，不被 playground 挂载劫持
  });
});

describe('[v0.0.349] buildSessionConfigFromDeps — 分支 2 全 dangling 容错降级（决策④）', () => {
  /** tombstone 删 provider（与 DELETE /provider/:id handler 同形态：_deleted:true 覆写 record） */
  function tombstoneProvider(pid: string): void {
    appConfig.set('providers', pid, { id: pid, _deleted: true } as never);
  }

  it('全 dangling（方案候选的 provider 全被删）→ throw ModelNotConfiguredError（非裸 500；code=MODEL_NOT_CONFIGURED + message 含方案提示）', () => {
    seedPlan();
    // 两个 provider 全 tombstone → buildLlmClient 对每候选都抛 ProviderNotFoundError
    tombstoneProvider('p-a');
    tombstoneProvider('p-b');
    let caught: unknown;
    try {
      buildSessionConfigFromDeps(deps, ulid(), {}, PG_ROCKY_MAIN);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ModelNotConfiguredError);
    const err = caught as ModelNotConfiguredError;
    expect(err.code).toBe('MODEL_NOT_CONFIGURED');
    expect(err.message).toContain('方案内所有模型');
    expect(err.detail).toEqual({ sessionType: 'playground' });
  });

  it('部分 dangling（首候选 p-a 被删，p-b 存活）→ 首可用候选 p-b/model-c 正常组装（既有行为零回归）', () => {
    seedPlan();
    tombstoneProvider('p-a');
    const config = buildSessionConfigFromDeps(deps, ulid(), {}, PG_ROCKY_MAIN);
    expect(config.modelRoutingPlan).toBeDefined();
    expect(config.client).toBeDefined();
    // [v0.0.353 T4 根治版] 分支 2 SessionConfig.modelId 取 session 持久口径（非首候选）
    expect(config.modelId).toBe('');
  });
});
