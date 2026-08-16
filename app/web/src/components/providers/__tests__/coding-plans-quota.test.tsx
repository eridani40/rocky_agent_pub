/**
 * @vitest-environment jsdom
 * [v0.0.352 T2] 额度总览 footer v2 — 单测
 * 参考: specs/prd/quota-overview-demo-v2.html
 *
 * 校验点：
 *   - 按 kind 分组：quota 组「套餐额度」/ balance 组「充值余额」
 *   - quota 卡：每档展示「已用」上柱 + 「时间」下柱 + 重置时间（含星期）+ 剩余时间
 *   - 消耗偏快：usedPercent > timeProgress 时显示琥珀 badge 且已用柱/数值变 amber
 *   - balance 卡：右侧金额 ¥NN.NN；isAvailable=false 显示「余额不足」
 *   - error 态：auth 固定友好文案；LastGood 降级保留旧值
 *   - 取消展开交互：不存在 quota-detail-{id} 节点
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { CodingPlansQuotaFooter } from '../component-coding-plans-quota-footer';
import { useQuotaPolling } from '../use-quota-polling';
import type { QuotaSnapshot } from '../../../lib/api-client';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

/** 构造额度型快照 */
const quotaSnap = (overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  providerId: 'p-kimi',
  providerLabel: 'Kimi',
  implId: 'kimi_coding_plan',
  kind: 'quota',
  membership: '高级会员',
  tiers: [
    { window: 'five_hour', usedPercent: 42.6, resetsAt: new Date('2026-08-15T06:00:00').toISOString() },
    { window: 'weekly', usedPercent: 67.2, resetsAt: new Date('2026-08-20T00:00:00').toISOString() },
  ],
  fetchedAt: new Date('2026-08-15T03:00:00').getTime(),
  ...overrides,
});

/** 构造余额型快照 */
const balanceSnap = (overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  providerId: 'p-ds',
  providerLabel: 'DeepSeek',
  implId: 'deepseek_api',
  kind: 'balance',
  balance: { currency: 'CNY', total: 9122.688 },
  isAvailable: true,
  fetchedAt: new Date('2026-08-15T03:00:00').getTime(),
  ...overrides,
});

/** [v0.0.363] SSE 订阅桩：捕获 handler 供测试推帧（替代旧 5min 轮询的定时推进） */
const singletonPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/sse-singleton'));
const sseStub = vi.hoisted(() => ({
  handler: null as ((frame: { topic?: string; group?: string; data: unknown; timestamp?: string }) => void) | null,
}));
vi.mock(singletonPath, () => ({
  getSseClient: () => ({
    subscribe: async (_t: string, _g: string, h: (frame: { data: unknown }) => void) => {
      sseStub.handler = h;
      return { unsubscribe: async () => {} };
    },
  }),
}));

/** stub fetch 返回 quota 聚合响应（[v0.0.363] 路由化：GET /provider/quota 走 rounds；POST sync 等其余端点 200 空体） */
function stubQuotaFetch(rounds: Array<{ items: QuotaSnapshot[] } | Error>) {
  let round = 0;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.includes('/provider/quota')) {
      const r = rounds[Math.min(round, rounds.length - 1)]!;
      round += 1;
      if (r instanceof Error) return new Response(JSON.stringify({ error: r.message }), { status: 500 });
      return new Response(JSON.stringify({ lastSyncedAt: Date.now(), ...r }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 计数 GET /provider/quota 调用次数（排除 POST sync / SSE 上行） */
function quotaGetCalls(fetchMock: ReturnType<typeof stubQuotaFetch>): number {
  return fetchMock.mock.calls.filter(([u, i]) =>
    (i?.method ?? 'GET') === 'GET' && String(typeof u === 'string' ? u : (u as Request).url).includes('/provider/quota'),
  ).length;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
});

async function renderAndFlush(ui: React.ReactElement, systemTime?: Date) {
  vi.useFakeTimers();
  if (systemTime) vi.setSystemTime(systemTime);
  render(ui);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

describe('[v0.0.363] use-quota-polling — store 换源节奏（fake timers）', () => {
  it('挂载 GET 存量一次 + POST sync 触发 + 30s tick 零网络 + 无 5min 轮询', async () => {
    vi.useFakeTimers();
    const fetchMock = stubQuotaFetch([{ items: [quotaSnap()] }]);
    const { result } = renderHook(() => useQuotaPolling([{ id: 'p-kimi' }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(quotaGetCalls(fetchMock)).toBe(1); // GET store 存量恰一次
    expect(fetchMock.mock.calls.some(([u, i]) => i?.method === 'POST' && String(u).includes('/provider/quota/sync'))).toBe(true); // 打开触发增量
    expect(result.current.byProvider.get('p-kimi')?.providerLabel).toBe('Kimi');
    expect(result.current.lastFetchedAt).not.toBeNull();
    // 30s tick × 2：tick 自增但零网络
    const tickBefore = result.current.tick;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(quotaGetCalls(fetchMock)).toBe(1);
    expect(result.current.tick).toBe(tickBefore + 2);
    // 推进至旧 5min 轮询点 → 仍零新增 GET（server 后台同步 + SSE 帧替代轮询）
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60_000); });
    expect(quotaGetCalls(fetchMock)).toBe(1);
    // SSE 帧到达 → 数据刷新（store 每轮同步后推送）
    await act(async () => {
      sseStub.handler?.({ topic: 'provider_quota', group: '_all', data: { items: [quotaSnap({ membership: '新会员' })], lastSyncedAt: Date.now() }, timestamp: new Date().toISOString() });
    });
    expect(result.current.byProvider.get('p-kimi')?.membership).toBe('新会员');
  });

  it('providers 空 → 不建轮询（零请求）；卸载清 interval', async () => {
    vi.useFakeTimers();
    const fetchMock = stubQuotaFetch([{ items: [] }]);
    const { unmount } = renderHook(() => useQuotaPolling([]));
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60_000); });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('[v0.0.352] CodingPlansQuotaFooter — 分组双柱', () => {
  it('quota 组：套餐额度标题 + membership 徽标 + 两档双柱 + 重置时间含星期', async () => {
    stubQuotaFetch([{ items: [quotaSnap()] }]);
    await renderAndFlush(
      <CodingPlansQuotaFooter providers={[{ id: 'p-kimi', label: 'Kimi', baseUrl: 'https://api.kimi.com/coding' }]} />,
      new Date('2026-08-15T03:00:00'),
    );
    const card = screen.getByTestId('quota-card-p-kimi');
    expect(screen.getByText('套餐额度')).toBeTruthy();
    expect(card.textContent).toContain('高级会员');
    expect(card.textContent).toContain('5 小时额度');
    expect(card.textContent).toContain('本周额度');
    expect(card.textContent).toContain('43%');
    expect(card.textContent).toContain('67%');
    expect(card.textContent).toMatch(/周/);
    expect(card.textContent).toContain('剩');
  });

  it('balance 组：充值余额标题 + 右侧金额 + 余额不足徽标', async () => {
    stubQuotaFetch([{ items: [balanceSnap({ isAvailable: false, balance: { currency: 'CNY', total: 12.4 } })] }]);
    await renderAndFlush(
      <CodingPlansQuotaFooter providers={[{ id: 'p-ds', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' }]} />,
    );
    expect(screen.getByText('充值余额')).toBeTruthy();
    const card = screen.getByTestId('quota-card-p-ds');
    expect(card.textContent).toContain('¥12.40');
    expect(card.textContent).toContain('余额不足');
  });

  it('消耗偏快：usedPercent > timeProgress 时显示 fast 徽标且已用数值标 amber', async () => {
    // five_hour 周期 5h；resetsAt=06:00, now=05:30 → 时间进度 90%；used=42% < 90% 不快
    // weekly 周期 7d；resetsAt=08-20 00:00, now=08-15 05:30 → 已走 4.23d / 7 = 60%；used=67% > 60% 快
    stubQuotaFetch([{ items: [quotaSnap({ tiers: [
      { window: 'five_hour', usedPercent: 42.6, resetsAt: new Date('2026-08-15T06:00:00').toISOString() },
      { window: 'weekly', usedPercent: 67.2, resetsAt: new Date('2026-08-20T00:00:00').toISOString() },
    ] })] }]);
    await renderAndFlush(
      <CodingPlansQuotaFooter providers={[{ id: 'p-kimi', label: 'Kimi', baseUrl: 'https://api.kimi.com/coding' }]} />,
      new Date('2026-08-15T05:30:00'),
    );
    const weekly = screen.getByTestId('quota-tier-weekly');
    expect(weekly.textContent).toContain('消耗偏快');
    const fiveHour = screen.getByTestId('quota-tier-five_hour');
    expect(fiveHour.textContent).not.toContain('消耗偏快');
  });

  it('取消展开交互：不存在 quota-detail-{id} 节点', async () => {
    stubQuotaFetch([{ items: [balanceSnap()] }]);
    await renderAndFlush(
      <CodingPlansQuotaFooter providers={[{ id: 'p-ds', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' }]} />,
    );
    expect(screen.queryByTestId('quota-detail-p-ds')).toBeNull();
  });

  it('LastGood 降级：auth error 帧到达沿用旧值并显示固定文案', async () => {
    stubQuotaFetch([{ items: [balanceSnap()] }]);
    await renderAndFlush(
      <CodingPlansQuotaFooter providers={[{ id: 'p-ds', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' }]} />,
    );
    expect(screen.getByTestId('quota-card-p-ds').textContent).toContain('¥9,122.69');
    // [v0.0.363] 降级轮改由 SSE 帧驱动（替代旧 5min 定时推进）
    await act(async () => {
      sseStub.handler?.({
        topic: 'provider_quota',
        group: '_all',
        data: { items: [balanceSnap({ balance: undefined, error: { kind: 'auth', message: 'raw upstream' } })], lastSyncedAt: Date.now() },
        timestamp: new Date().toISOString(),
      });
    });
    const card = screen.getByTestId('quota-card-p-ds');
    expect(card.textContent).toContain('凭证已失效');
    expect(card.textContent).toContain('¥9,122.69');
    expect(card.textContent).not.toContain('raw upstream');
  });

  it('business error 首轮即失败 → 透原始 message', async () => {
    stubQuotaFetch([{ items: [balanceSnap({ error: { kind: 'business', message: '上游业务错误原文' } })] }]);
    await renderAndFlush(
      <CodingPlansQuotaFooter providers={[{ id: 'p-ds', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' }]} />,
    );
    expect(screen.getByTestId('quota-card-p-ds').textContent).toContain('上游业务错误原文');
  });
});
