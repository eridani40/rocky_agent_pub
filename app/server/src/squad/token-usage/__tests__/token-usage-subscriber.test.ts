/**
 * TokenUsageSubscriber 单元测试 — per-field delta + 首见记 0 + subagent 跳过 + model 三级 fallback + 错误隔离
 * 参考: specs/tech/persistence/[P1]token_usage_stat.md §4（写入路径 + 不变量）
 *       states/v0.0.194/verify/test-plan.md T1 UT 范围
 *
 * 覆盖：
 *   - 首见记 0（不灌历史累计）：第一次 event delta 全 0，只更新 lastSeen
 *   - per-field delta：第二次 event diff(current, lastSeen)
 *   - subagent 跳过（parentSessionId 非空）
 *   - model 三级 fallback：session → squad → '__unknown__'
 *   - 错误隔离：statStore 抛错不传播
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setTokenUsageSubscriberDeps,
  notifyTokenUsageSubscriber,
  __resetTokenUsageSubscriberForTest,
  type TokenUsageSubscriberDeps,
} from '../token-usage-subscriber';
import type { SessionUsageView } from '../../../agent/session-store-types';
import type { TokenUsageStatStore, TokenUsageDelta, TokenUsageDimension } from '../../../persistence/token-usage-stat-store';

const SQUAD_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MEMBER_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const SESSION_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const PROVIDER_X = 'prov-x';
const MODEL_X = 'model-x';

/** mock session record（crud.get 返回形态） */
function mockSessionRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    squadId: SQUAD_ID,
    memberId: MEMBER_ID,
    providerId: PROVIDER_X,
    modelId: MODEL_X,
    ...overrides,
  };
}

/** mock SquadRecord（getSquad 返回形态） */
function mockSquadRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SQUAD_ID,
    modelDefault: 'squad-default-model',
    modelDefaultProviderId: 'squad-default-prov',
    timezone: 'Asia/Shanghai',
    ...overrides,
  };
}

/** 构造 mock deps + capture upsertDelta calls */
function makeMockDeps(sessionRecord?: Record<string, unknown>, squadRecord?: Record<string, unknown>): {
  deps: TokenUsageSubscriberDeps;
  calls: Array<{ dim: TokenUsageDimension; delta: TokenUsageDelta }>;
} {
  const calls: Array<{ dim: TokenUsageDimension; delta: TokenUsageDelta }> = [];
  const statStore = {
    upsertDelta: vi.fn(async (dim: TokenUsageDimension, delta: TokenUsageDelta) => {
      calls.push({ dim, delta });
    }),
  } as unknown as TokenUsageStatStore;
  const sessionStore = {
    crud: {
      get: () => sessionRecord,
    },
  } as unknown as TokenUsageSubscriberDeps['sessionStore'];
  const squadReader = {
    getSquad: () => squadRecord ?? mockSquadRecord(),
  };
  return { deps: { statStore, sessionStore, squadReader }, calls };
}

function makeView(total: Record<string, number>): SessionUsageView {
  return {
    current: {}, sub: {}, forked: {},
    total,
    ratio: 1,
    currentCacheRate: 0, subCacheRate: 0, forkedCacheRate: 0, totalCacheRate: 0,
  };
}

describe('TokenUsageSubscriber', () => {
  beforeEach(() => {
    __resetTokenUsageSubscriberForTest();
  });

  it('首见记 0：第一次 event delta 全 0，只更新 lastSeen', async () => {
    const { deps, calls } = makeMockDeps(mockSessionRecord());
    setTokenUsageSubscriberDeps(deps);

    await notifyTokenUsageSubscriber(SESSION_ID, makeView({
      input_no_cache: 1000, input_cache_read: 500, output_response: 2000, llmCallCount: 5,
    }), '2026-07-23T06:00:00Z');

    expect(calls).toHaveLength(1);
    // 首见：delta 全 0（不灌历史累计）
    expect(calls[0]!.delta.input_no_cache).toBe(0);
    expect(calls[0]!.delta.cache_read).toBe(0);
    expect(calls[0]!.delta.llmCallCount).toBe(0);
    // hour 桶按 Asia/Shanghai 格式化（UTC 06:00 = CST 14:00）
    expect(calls[0]!.dim.hour).toBe('2026-07-23 14');
  });

  it('per-field delta：第二次 event diff(current, lastSeen)', async () => {
    const { deps, calls } = makeMockDeps(mockSessionRecord());
    setTokenUsageSubscriberDeps(deps);

    // 第一次（首见记 0）— view.total 用 Usage 字段名（input_cache_read 等）
    await notifyTokenUsageSubscriber(SESSION_ID, makeView({
      input_no_cache: 100, input_cache_read: 50, llmCallCount: 1,
    }), '2026-07-23T06:00:00Z');
    // 第二次（delta = current - lastSeen）
    await notifyTokenUsageSubscriber(SESSION_ID, makeView({
      input_no_cache: 150, input_cache_read: 80, output_response: 200, llmCallCount: 3,
    }), '2026-07-23T06:30:00Z');

    expect(calls).toHaveLength(2);
    expect(calls[1]!.delta.input_no_cache).toBe(50); // 150-100
    expect(calls[1]!.delta.cache_read).toBe(30); // 80-50（input_cache_read → cache_read）
    expect(calls[1]!.delta.output_response).toBe(200); // 200-0
    expect(calls[1]!.delta.llmCallCount).toBe(2); // 3-1
  });

  it('subagent 跳过（parentSessionId 非空）', async () => {
    const { deps, calls } = makeMockDeps(mockSessionRecord({ parentSessionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }));
    setTokenUsageSubscriberDeps(deps);

    await notifyTokenUsageSubscriber(SESSION_ID, makeView({ input_no_cache: 100 }), '2026-07-23T06:00:00Z');
    expect(calls).toHaveLength(0); // subagent → 跳过
  });

  it('非 studio session 跳过（无 squadId/memberId）', async () => {
    const { deps, calls } = makeMockDeps(mockSessionRecord({ squadId: undefined, memberId: undefined }));
    setTokenUsageSubscriberDeps(deps);

    await notifyTokenUsageSubscriber(SESSION_ID, makeView({ input_no_cache: 100 }), '2026-07-23T06:00:00Z');
    expect(calls).toHaveLength(0);
  });

  it('model 三级 fallback level 1：session 显式 providerId/modelId', async () => {
    const { deps, calls } = makeMockDeps(
      mockSessionRecord({ providerId: PROVIDER_X, modelId: MODEL_X }),
    );
    setTokenUsageSubscriberDeps(deps);

    await notifyTokenUsageSubscriber(SESSION_ID, makeView({ input_no_cache: 100 }), '2026-07-23T06:00:00Z');
    expect(calls[0]!.dim.providerId).toBe(PROVIDER_X);
    expect(calls[0]!.dim.modelId).toBe(MODEL_X);
  });

  it('model 三级 fallback level 2：session 无 → squad.modelDefault/modelDefaultProviderId', async () => {
    const { deps, calls } = makeMockDeps(
      mockSessionRecord({ providerId: undefined, modelId: undefined }),
      mockSquadRecord({ modelDefault: 'squad-default-model', modelDefaultProviderId: 'squad-default-prov' }),
    );
    setTokenUsageSubscriberDeps(deps);

    await notifyTokenUsageSubscriber(SESSION_ID, makeView({ input_no_cache: 100 }), '2026-07-23T06:00:00Z');
    expect(calls[0]!.dim.providerId).toBe('squad-default-prov');
    expect(calls[0]!.dim.modelId).toBe('squad-default-model');
  });

  it('model 三级 fallback level 3：session + squad 都无 → __unknown__', async () => {
    const { deps, calls } = makeMockDeps(
      mockSessionRecord({ providerId: undefined, modelId: undefined }),
      mockSquadRecord({ modelDefault: undefined, modelDefaultProviderId: undefined }),
    );
    setTokenUsageSubscriberDeps(deps);

    await notifyTokenUsageSubscriber(SESSION_ID, makeView({ input_no_cache: 100 }), '2026-07-23T06:00:00Z');
    expect(calls[0]!.dim.providerId).toBe('__unknown__');
    expect(calls[0]!.dim.modelId).toBe('__unknown__');
  });

  it('错误隔离：statStore.upsertDelta 抛错不传播（不崩主对话）', async () => {
    const statStore = {
      upsertDelta: vi.fn().mockRejectedValue(new Error('sqlite write fail')),
    } as unknown as TokenUsageStatStore;
    const sessionStore = {
      crud: { get: () => mockSessionRecord() },
    } as unknown as TokenUsageSubscriberDeps['sessionStore'];
    const squadReader = { getSquad: () => mockSquadRecord() };
    setTokenUsageSubscriberDeps({ statStore, sessionStore, squadReader });

    // 不应抛错（错误隔离）
    await expect(
      notifyTokenUsageSubscriber(SESSION_ID, makeView({ input_no_cache: 100 }), '2026-07-23T06:00:00Z'),
    ).resolves.toBeUndefined();
  });

  it('未注入 subscriber deps：静默 no-op（不抛错）', async () => {
    // 不调 setTokenUsageSubscriberDeps
    await expect(
      notifyTokenUsageSubscriber(SESSION_ID, makeView({ input_no_cache: 100 }), '2026-07-23T06:00:00Z'),
    ).resolves.toBeUndefined();
  });
});
