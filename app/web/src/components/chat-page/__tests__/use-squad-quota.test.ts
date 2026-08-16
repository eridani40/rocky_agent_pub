// @vitest-environment jsdom
/**
 * use-squad-quota.test.ts — 四源额度 hook 单元测试
 * 参考: states/v0.0.356/test-plan.md §2.1
 *
 * 覆盖：
 *   ① 四源 → CardVM（分组/状态点四态/余额型/无周档）
 *   ② 单源失败 lastGood 保留
 *   ③ 5min 轮询 + 卸载清理
 *   ④ tick 零网络（fetch 不再被调）
 *   ⑤ 午夜 hourCycle h23 case（00:30 命中 [0,23]）
 */
import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from 'vitest';
import { renderHook, waitFor, cleanup, act } from '@testing-library/react';
import { initI18n } from '../../../i18n';

const routingMocks = vi.hoisted(() => ({
  listModelRoutingPlans: vi.fn(),
  getModelRoutingStatus: vi.fn(),
}));
const apiMocks = vi.hoisted(() => ({
  fetchProviderQuota: vi.fn(),
  syncProviderQuota: vi.fn(),
  listProviders: vi.fn(),
}));
const routingPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../app-dev-config-page/model-routing-api'));
const apiClientPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/api-client'));
/** [v0.0.363] SSE 订阅桩：quota 源改共享 store（帧驱动），捕获 handler 供测试推帧 */
const singletonPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/sse-singleton'));
const sseStub = vi.hoisted(() => ({
  handler: null as ((frame: { topic?: string; group?: string; data: unknown; timestamp?: string }) => void) | null,
}));

vi.mock(routingPath, () => routingMocks);
vi.mock(apiClientPath, () => apiMocks);
vi.mock(singletonPath, () => ({
  getSseClient: () => ({
    subscribe: async (_t: string, _g: string, h: (frame: { data: unknown }) => void) => {
      sseStub.handler = h;
      return { unsubscribe: async () => {} };
    },
  }),
}));

import { useSquadQuota, type CardVM } from '../use-squad-quota';

const PLAN_ID = 'plan-1';

function mkPlan() {
  return {
    id: PLAN_ID,
    name: 'Test Plan',
    items: [
      { providerId: 'p1', modelId: 'm1', enabled: true, timeCondition: { hours: [] as number[] } },
      { providerId: 'p2', modelId: 'm2', enabled: true, timeCondition: { hours: [] as number[] } },
      { providerId: 'p3', modelId: 'm3', enabled: true, timeCondition: { hours: [] as number[] } },
    ],
  };
}

function mkStatus() {
  return {
    id: 's1',
    planId: PLAN_ID,
    items: [
      { providerId: 'p1', modelId: 'm1', circuitState: 'closed' as const, remainingSeconds: 0 },
      { providerId: 'p2', modelId: 'm2', circuitState: 'open' as const, remainingSeconds: 87 },
      { providerId: 'p3', modelId: 'm3', circuitState: 'half_open' as const, remainingSeconds: 0 },
    ],
  };
}

function mkQuota() {
  return {
    items: [
      {
        providerId: 'p1',
        providerLabel: 'MiniMax',
        kind: 'tiers',
        isAvailable: true,
        tiers: [
          { window: 'five_hour' as const, usedPercent: 30, resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
          { window: 'weekly' as const, usedPercent: 55, resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString() },
        ],
      },
      {
        providerId: 'p2',
        providerLabel: 'DeepSeek',
        kind: 'balance',
        isAvailable: false,
        balance: { currency: 'CNY', total: 9118.81 },
      },
    ],
  };
}

function mkProviders() {
  return [
    { id: 'p1', label: 'MiniMax', baseUrl: 'https://api.minimax.chat' },
    { id: 'p2', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
    { id: 'p3', label: 'OpenAI', baseUrl: 'https://api.openai.com' },
  ];
}

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-08-15T10:00:00+08:00'));
  routingMocks.listModelRoutingPlans.mockResolvedValue([mkPlan()]);
  routingMocks.getModelRoutingStatus.mockResolvedValue(mkStatus());
  apiMocks.fetchProviderQuota.mockResolvedValue(mkQuota());
  apiMocks.syncProviderQuota.mockResolvedValue(undefined);
  apiMocks.listProviders.mockResolvedValue(mkProviders());
  sseStub.handler = null;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useSquadQuota — 四源 → CardVM', () => {
  it('组合 plan/status/quota/providers 为卡片；余额型按 kind=balance 识别', async () => {
    const { result } = renderHook(() => useSquadQuota(PLAN_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const cards = result.current.cards;
    expect(cards).toHaveLength(3);

    const p1 = cards.find((c: CardVM) => c.providerId === 'p1')!;
    expect(p1.providerLabel).toBe('MiniMax');
    expect(p1.modelId).toBe('m1');
    expect(p1.state).toBe('working');
    expect(p1.snapshot).toBeTruthy();
    expect(p1.baseUrl).toBe('https://api.minimax.chat');

    const p2 = cards.find((c: CardVM) => c.providerId === 'p2')!;
    expect(p2.snapshot?.kind).toBe('balance');
    expect(p2.state).toBe('open');
    expect(p2.remainingSeconds).toBe(87);

    const p3 = cards.find((c: CardVM) => c.providerId === 'p3')!;
    expect(p3.state).toBe('half');
  });

  it('状态点合并：off-window 优先级高于熔断', async () => {
    // 将 p1 时间条件设为仅允许 2-23；当前时间午夜 00:30 → 命中 off-window
    vi.setSystemTime(new Date('2026-08-15T00:30:00+08:00'));
    const plan = mkPlan();
    plan.items[0]!.timeCondition = { hours: [2, 23] };
    routingMocks.listModelRoutingPlans.mockResolvedValue([plan]);

    const { result } = renderHook(() => useSquadQuota(PLAN_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const p1 = result.current.cards.find((c: CardVM) => c.providerId === 'p1')!;
    expect(p1.state).toBe('off');
    expect(p1.offWindow).toBe(true);
  });

  it('无周额度套餐只显示 five_hour 档', async () => {
    apiMocks.fetchProviderQuota.mockResolvedValue({
      items: [
        {
          providerId: 'p1',
          providerLabel: 'MiniMax',
          kind: 'tiers',
          isAvailable: true,
          tiers: [{ window: 'five_hour', usedPercent: 30, resetsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() }],
        },
      ],
    });

    const { result } = renderHook(() => useSquadQuota(PLAN_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const p1 = result.current.cards.find((c: CardVM) => c.providerId === 'p1')!;
    expect(p1.snapshot?.tiers).toHaveLength(1);
    expect(p1.snapshot?.tiers?.[0]?.window).toBe('five_hour');
  });
});

describe('useSquadQuota — lastGood 保留', () => {
  it('quota 帧带 error 项时 snapshot 沿用 lastGood 成功值（quota 失败 fail-silent 不进 error）', async () => {
    apiMocks.fetchProviderQuota.mockResolvedValue(mkQuota());
    const { result } = renderHook(() => useSquadQuota(PLAN_ID));
    await waitFor(() => expect(result.current.cards.some((c: CardVM) => c.snapshot)).toBe(true));

    // [v0.0.363] 降级轮改由 SSE 帧驱动：p2 变 error 项 → snapshot 沿用 store lastGood 旧值
    const badRound = { items: [
      { ...mkQuota().items[0]!, error: { kind: 'auth' as const, message: 'auth gone' } },
      {
        providerId: 'p2', providerLabel: 'DeepSeek', kind: 'balance' as const, isAvailable: false,
        balance: undefined, error: { kind: 'network' as const, message: 'quota 500' }, fetchedAt: 1,
      },
    ], lastSyncedAt: Date.now() };
    await act(async () => {
      sseStub.handler?.({ topic: 'provider_quota', group: '_all', data: badRound, timestamp: new Date().toISOString() });
    });

    const p2 = result.current.cards.find((c: CardVM) => c.providerId === 'p2')!;
    expect(p2.snapshot?.balance?.total).toBe(9118.81); // lastGood 旧值兜底
    expect(result.current.error).not.toBe('quota 500'); // quota 失败 fail-silent（不炸弹层）
  });

  it('status 源失败进 error 提示（三源轮询语义保留）', async () => {
    routingMocks.getModelRoutingStatus.mockRejectedValueOnce(new Error('status 503'));
    const { result } = renderHook(() => useSquadQuota(PLAN_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe('status 503');
    // cards 仍用 lastGood/降级数据渲染（不空屏）
    expect(result.current.cards.length).toBeGreaterThan(0);
  });
});

describe('useSquadQuota — 轮询与清理', () => {
  it('5 分钟后触发新一轮 fetch；卸载后停止轮询', async () => {
    const { result, unmount } = renderHook(() => useSquadQuota(PLAN_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const initial = routingMocks.listModelRoutingPlans.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });
    expect(routingMocks.listModelRoutingPlans.mock.calls.length).toBeGreaterThan(initial);

    unmount();
    const afterUnmount = routingMocks.listModelRoutingPlans.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    });
    expect(routingMocks.listModelRoutingPlans.mock.calls.length).toBe(afterUnmount);
  });

  it('tick 每秒推进但不再触发 fetch', async () => {
    const { result } = renderHook(() => useSquadQuota(PLAN_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const fetchCount = apiMocks.fetchProviderQuota.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 1000);
    });
    expect(apiMocks.fetchProviderQuota.mock.calls.length).toBe(fetchCount);
  });
});

describe('useSquadQuota — hourHit h23', () => {
  it('午夜 00:30 用 hourCycle h23 输出 0，命中 [0,23]', async () => {
    vi.setSystemTime(new Date('2026-08-15T00:30:00+08:00'));
    const plan = mkPlan();
    plan.items[0]!.timeCondition = { hours: [0, 23] };
    routingMocks.listModelRoutingPlans.mockResolvedValue([plan]);

    const { result } = renderHook(() => useSquadQuota(PLAN_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const p1 = result.current.cards.find((c: CardVM) => c.providerId === 'p1')!;
    expect(p1.state).toBe('working');
  });

  it('离散白名单：1:00 不在 [0,2] 中，应判定 off-window', async () => {
    vi.setSystemTime(new Date('2026-08-15T01:00:00+08:00'));
    const plan = mkPlan();
    plan.items[0]!.timeCondition = { hours: [0, 2] };
    routingMocks.listModelRoutingPlans.mockResolvedValue([plan]);

    const { result } = renderHook(() => useSquadQuota(PLAN_ID));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const p1 = result.current.cards.find((c: CardVM) => c.providerId === 'p1')!;
    expect(p1.state).toBe('off');
    expect(p1.offWindow).toBe(true);
  });
});
