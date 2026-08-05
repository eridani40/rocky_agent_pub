/**
 * resolveTarget 单测(v2.0 — 两遍扫描 + 四元组 key)
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3 step 2 + §2.2(两遍扫描)
 *       specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §2(完整伪代码)
 *       specs/tech/agent/llm_caller/[P0]provider_health_registry.md §2(isPreferred/isAvailable)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveTarget, allDeadToClassifiedError } from '../resolve_target';
import {
  createProviderHealthRegistry,
  __resetProviderHealthRegistryForTest,
  type ProviderHealthRegistry,
} from '../provider_health_registry';
import { DEFAULT_LLM_REQUEST_CONFIG } from '../../../config/llm_request_config';
import type { LlmProviderConfig, LlmModelConfig } from '../../provider-types';
import type { LlmClient } from '../../client';

const SID = 'sess-a';

function makeProvider(id: string): LlmProviderConfig {
  return {
    id, name: 'anthropic_compatible', protocolId: 'anthropic_messages', baseUrl: `https://${id}.example.com`,
    credentials: { key: `sk-${id}` }, pluginId: 'builtin.anthropic', enabled: true,
    models: [makeModel('m1')],
  };
}

function makeModel(modelId: string): LlmModelConfig {
  return {
    modelId, inputModalities: ['text'], outputModalities: ['text'],
    contextWindow: 200000, maxOutputTokens: 8192, paramConstraints: {},
    pricing: { inputPerMillion: 0, outputPerMillion: 0, currency: 'USD' },
    providerId: '',
  };
}

function makeClient(): LlmClient {
  return { async *stream() { yield { type: 'finish', reason: 'stop' }; } } as unknown as LlmClient;
}

/** 构造两 provider chain,health,clientFactory,统一传 sessionId=SID。 */
function makeChain2(p1Id = 'p1', p2Id = 'p2') {
  const p1 = makeProvider(p1Id);
  const p2 = makeProvider(p2Id);
  const providers = new Map([[p1Id, p1], [p2Id, p2]]);
  const client = makeClient();
  const cfg = {
    ...DEFAULT_LLM_REQUEST_CONFIG,
    fallbackChain: [
      { providerId: p1Id, keyRef: 'default', modelId: 'm1' },
      { providerId: p2Id, keyRef: 'default', modelId: 'm1' },
    ],
  };
  return { p1, p2, providers, client, cfg };
}

beforeEach(() => __resetProviderHealthRegistryForTest());

describe('resolveTarget — 空 chain 退化', () => {
  it('空 chain + fallback target 可用 → 返回 target', () => {
    const provider = makeProvider('p1');
    const client = makeClient();
    const cfg = { ...DEFAULT_LLM_REQUEST_CONFIG, fallbackChain: [] };
    const r = resolveTarget({
      config: cfg, providers: new Map([[provider.id, provider]]),
      health: createProviderHealthRegistry(), sessionId: SID,
      clientFactory: { getClient: () => client },
      now: 1000,
      fallback: { provider, keyRef: 'default', model: provider.models[0]!, client },
    });
    expect(r.kind).toBe('target');
    if (r.kind === 'target') {
      expect(r.target.providerId).toBe('p1');
      expect(r.target.keyRef).toBe('default');
    }
  });

  it('空 chain + fallback target dead → all_dead', () => {
    const provider = makeProvider('p1');
    const client = makeClient();
    const cfg = { ...DEFAULT_LLM_REQUEST_CONFIG, fallbackChain: [] };
    const health = createProviderHealthRegistry();
    health.markDead(SID, 'p1', 'default', 'm1', 'dead', 1000);
    const r = resolveTarget({
      config: cfg, providers: new Map([[provider.id, provider]]),
      health, sessionId: SID,
      clientFactory: { getClient: () => client }, now: 2000,
      fallback: { provider, keyRef: 'default', model: provider.models[0]!, client },
    });
    expect(r.kind).toBe('all_dead');
    if (r.kind === 'all_dead') expect(r.reason).toContain('unavailable');
  });
});

describe('resolveTarget — [rev2] 两遍扫描', () => {
  it('第 1 遍命中: chain 首项 healthy → 选首项', () => {
    const { providers, client, cfg } = makeChain2();
    const r = resolveTarget({
      config: cfg, providers, health: createProviderHealthRegistry(),
      sessionId: SID, clientFactory: { getClient: () => client }, now: 1000,
    });
    expect(r.kind).toBe('target');
    if (r.kind === 'target') expect(r.target.providerId).toBe('p1');
  });

  it('第 1 遍跳 dead 项,第 2 遍命中后续 healthy 项(经第 1 遍找到 backup healthy)', () => {
    // p1 dead, p2 healthy → 第 1 遍扫到 p2(healthy)命中
    const { providers, client, cfg } = makeChain2();
    const health = createProviderHealthRegistry();
    health.markDead(SID, 'p1', 'default', 'm1', 'auth', 1000);
    const r = resolveTarget({
      config: cfg, providers, health, sessionId: SID,
      clientFactory: { getClient: () => client }, now: 2000,
    });
    expect(r.kind).toBe('target');
    if (r.kind === 'target') expect(r.target.providerId).toBe('p2');
  });

  it('[rev2 关键] 无 healthy 但有 degraded → 第 2 遍兜底选 degraded', () => {
    // p1 degraded, p2 degraded → 第 1 遍无 healthy 全跳;第 2 遍兜底选 p1(chain 顺序)
    const { providers, client, cfg } = makeChain2();
    const health = createProviderHealthRegistry();
    // 用 CFG={consecutiveToDegrade:2} 触达 degraded
    const r2 = createProviderHealthRegistry({ consecutiveToDegrade: 2, cooldownS: 30 });
    // p1 → degraded(3 次 escalate: 2 进 cooled_down, 第 3 次 → degraded)
    r2.escalate(SID, 'p1', 'default', 'm1', 'PROVIDER_OVERLOADED', 1000);
    r2.escalate(SID, 'p1', 'default', 'm1', 'PROVIDER_OVERLOADED', 2000); // cooled_down
    r2.escalate(SID, 'p1', 'default', 'm1', 'PROVIDER_OVERLOADED', 3000); // degraded
    // p2 同样 degraded
    r2.escalate(SID, 'p2', 'default', 'm1', 'PROVIDER_OVERLOADED', 1000);
    r2.escalate(SID, 'p2', 'default', 'm1', 'PROVIDER_OVERLOADED', 2000);
    r2.escalate(SID, 'p2', 'default', 'm1', 'PROVIDER_OVERLOADED', 3000);
    const r = resolveTarget({
      config: cfg, providers, health: r2, sessionId: SID,
      clientFactory: { getClient: () => client }, now: 4000,
    });
    expect(r.kind).toBe('target');
    if (r.kind === 'target') {
      // 第 2 遍按 chain 顺序返首个 degraded(p1)
      expect(r.target.providerId).toBe('p1');
    }
  });

  it('[rev2 关键] 第 1 遍有 healthy 时不走 degraded 兜底(优先选 healthy 项)', () => {
    // p1 degraded(降级), p2 healthy → 第 1 遍选 p2(healthy),不走 p1 degraded
    const { providers, client, cfg } = makeChain2();
    const r2 = createProviderHealthRegistry({ consecutiveToDegrade: 2, cooldownS: 30 });
    r2.escalate(SID, 'p1', 'default', 'm1', 'PROVIDER_OVERLOADED', 1000);
    r2.escalate(SID, 'p1', 'default', 'm1', 'PROVIDER_OVERLOADED', 2000);
    r2.escalate(SID, 'p1', 'default', 'm1', 'PROVIDER_OVERLOADED', 3000); // p1 degraded
    // p2 不动 healthy
    const r = resolveTarget({
      config: cfg, providers, health: r2, sessionId: SID,
      clientFactory: { getClient: () => client }, now: 4000,
    });
    expect(r.kind).toBe('target');
    if (r.kind === 'target') expect(r.target.providerId).toBe('p2');
  });

  it('cooled_down(未到期): 两遍都跳过;若无其他可用 → all_dead', () => {
    const { providers, client, cfg } = makeChain2();
    const r2 = createProviderHealthRegistry({ consecutiveToDegrade: 2, cooldownS: 30 });
    // 两 provider 都 cooled_down(未到期)
    r2.escalate(SID, 'p1', 'default', 'm1', 'PROVIDER_OVERLOADED', 1000);
    r2.escalate(SID, 'p1', 'default', 'm1', 'PROVIDER_OVERLOADED', 2000);
    r2.escalate(SID, 'p2', 'default', 'm1', 'PROVIDER_OVERLOADED', 1000);
    r2.escalate(SID, 'p2', 'default', 'm1', 'PROVIDER_OVERLOADED', 2000);
    const r = resolveTarget({
      config: cfg, providers, health: r2, sessionId: SID,
      clientFactory: { getClient: () => client }, now: 30000, // 未到期
    });
    expect(r.kind).toBe('all_dead');
  });

  it('全 dead → all_dead', () => {
    const p1 = makeProvider('p1');
    const client = makeClient();
    const cfg = {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      fallbackChain: [{ providerId: 'p1', keyRef: 'default', modelId: 'm1' }],
    };
    const health = createProviderHealthRegistry();
    health.markDead(SID, 'p1', 'default', 'm1', 'auth', 1000);
    const r = resolveTarget({
      config: cfg, providers: new Map([['p1', p1]]), health, sessionId: SID,
      clientFactory: { getClient: () => client }, now: 2000,
    });
    expect(r.kind).toBe('all_dead');
  });

  it('modelId 匹配: chain item 的 modelId 用于查 provider.models', () => {
    // p1 有 m1 + m2,chain 指定 m2 → 选 m2
    const p1 = makeProvider('p1');
    p1.models = [makeModel('m1'), makeModel('m2')];
    const client = makeClient();
    const cfg = {
      ...DEFAULT_LLM_REQUEST_CONFIG,
      fallbackChain: [{ providerId: 'p1', keyRef: 'default', modelId: 'm2' }],
    };
    const r = resolveTarget({
      config: cfg, providers: new Map([['p1', p1]]),
      health: createProviderHealthRegistry(), sessionId: SID,
      clientFactory: { getClient: () => client }, now: 1000,
    });
    expect(r.kind).toBe('target');
    if (r.kind === 'target') expect(r.target.model.modelId).toBe('m2');
  });
});

describe('resolveTarget — [rev2] session 隔离', () => {
  it('A session 把 p1 标 dead,B session 仍能选 p1(隔离)', () => {
    const { providers, client, cfg } = makeChain2();
    const health: ProviderHealthRegistry = createProviderHealthRegistry();
    // A session 标 p1 dead
    health.markDead('sess-a', 'p1', 'default', 'm1', 'auth', 1000);
    // B session resolveTarget → p1 healthy(隔离),选 p1
    const r = resolveTarget({
      config: cfg, providers, health, sessionId: 'sess-b',
      clientFactory: { getClient: () => client }, now: 2000,
    });
    expect(r.kind).toBe('target');
    if (r.kind === 'target') expect(r.target.providerId).toBe('p1');
  });

  it('A session degrade p1,B session p1 仍 healthy → 各自独立', () => {
    const { providers, client, cfg } = makeChain2();
    const health = createProviderHealthRegistry({ consecutiveToDegrade: 2, cooldownS: 30 });
    // A session degrade p1
    health.escalate('sess-a', 'p1', 'default', 'm1', 'PROVIDER_OVERLOADED', 1000);
    health.escalate('sess-a', 'p1', 'default', 'm1', 'PROVIDER_OVERLOADED', 2000);
    health.escalate('sess-a', 'p1', 'default', 'm1', 'PROVIDER_OVERLOADED', 3000); // degraded
    // B session resolveTarget → p1 仍 healthy(第 1 遍命中)
    const r = resolveTarget({
      config: cfg, providers, health, sessionId: 'sess-b',
      clientFactory: { getClient: () => client }, now: 4000,
    });
    expect(r.kind).toBe('target');
    if (r.kind === 'target') expect(r.target.providerId).toBe('p1');
  });
});

describe('allDeadToClassifiedError', () => {
  it('→ NETWORK category(不塌缩 LOOP_ERROR)', () => {
    const err = allDeadToClassifiedError('test reason');
    expect(err.category).toBe('NETWORK');
    expect(err.hints.retryable).toBe(false);
    expect(err.message).toContain('test reason');
  });
});
