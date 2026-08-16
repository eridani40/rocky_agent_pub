// @vitest-environment jsdom
/**
 * use-provider-quota-store.test.tsx — 全局额度 store 共享 hook 单测（v0.0.363 T2）
 * 参考: specs/tech/version_logs/v0.0.363/change_plan.md §1.5 + T1 冻结契约（commit 8a2266e50）
 *
 * 覆盖：
 *   ① 挂载：POST sync 触发（fire-and-forget）+ GET store 存量秒开
 *   ② SSE 帧到达 → byProvider 更新 + lastGood 只记成功项
 *   ③ 空 items 帧 → byProvider 保留旧值兜底 + lastSyncedAt 更新
 *   ④ 卸载 → unsubscribe；订阅晚于卸载到达 → 补偿回退
 *   ⑤ enabled=false → 零请求零订阅
 *   ⑥ GET 整体失败 → 保持既有 state（LastGood 语义）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const apiMocks = vi.hoisted(() => ({
  fetchProviderQuota: vi.fn(),
  syncProviderQuota: vi.fn(),
}));
/** 可控 SSE 订阅桩：捕获 handler 供测试推帧；记录 unsubscribe 调用 */
const sseState = vi.hoisted(() => ({
  handler: null as ((frame: { data: unknown }) => void) | null,
  unsubscribeCount: 0,
  /** 控制订阅 resolve 时机（测晚到补偿） */
  delaySubscribe: false as boolean,
}));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/api-client'));
const singletonPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/sse-singleton'));

vi.mock(apiPath, () => apiMocks);
vi.mock(singletonPath, () => ({
  getSseClient: () => ({
    subscribe: async (
      _topic: string,
      _group: string,
      handler: (frame: { data: unknown }) => void,
    ) => {
      if (sseState.delaySubscribe) {
        await new Promise((r) => setTimeout(r, 50));
      }
      sseState.handler = handler;
      return { unsubscribe: async () => { sseState.unsubscribeCount += 1; } };
    },
  }),
}));

import { useProviderQuotaStore } from '../use-provider-quota-store';
import type { QuotaSnapshot } from '../../../lib/api-client';

const snap = (id: string, overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  providerId: id,
  providerLabel: id.toUpperCase(),
  implId: 'kimi_coding_plan',
  kind: 'quota',
  tiers: [{ window: 'five_hour', usedPercent: 30 }],
  fetchedAt: 1,
  ...overrides,
});

const frame = (items: QuotaSnapshot[], lastSyncedAt: number | null) => ({
  topic: 'provider_quota',
  group: '_all',
  data: { items, lastSyncedAt },
  timestamp: new Date(0).toISOString(),
});

beforeEach(() => {
  apiMocks.fetchProviderQuota.mockReset();
  apiMocks.syncProviderQuota.mockReset();
  apiMocks.syncProviderQuota.mockResolvedValue(undefined);
  sseState.handler = null;
  sseState.unsubscribeCount = 0;
  sseState.delaySubscribe = false;
});

afterEach(() => {
  vi.clearAllTimers();
});

describe('useProviderQuotaStore — 挂载双请求', () => {
  it('POST sync 触发（fire-and-forget）+ GET 存量秒开', async () => {
    apiMocks.fetchProviderQuota.mockResolvedValue({ items: [snap('p1')], lastSyncedAt: 100 });
    const { result } = renderHook(() => useProviderQuotaStore());
    await waitFor(() => expect(result.current.byProvider.size).toBe(1));
    expect(apiMocks.syncProviderQuota).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchProviderQuota).toHaveBeenCalledTimes(1);
    expect(result.current.byProvider.get('p1')?.providerId).toBe('p1');
    expect(result.current.lastSyncedAt).toBe(100);
    expect(result.current.lastGood.get('p1')).toBeTruthy();
  });

  it('POST sync 失败静默（GET 存量仍可用）', async () => {
    apiMocks.syncProviderQuota.mockRejectedValue(new Error('net'));
    apiMocks.fetchProviderQuota.mockResolvedValue({ items: [snap('p1')], lastSyncedAt: 100 });
    const { result } = renderHook(() => useProviderQuotaStore());
    await waitFor(() => expect(result.current.byProvider.size).toBe(1));
  });

  it('空窗 {items:[], lastSyncedAt:null} → 初始空态不误置 lastGood', async () => {
    apiMocks.fetchProviderQuota.mockResolvedValue({ items: [], lastSyncedAt: null });
    const { result } = renderHook(() => useProviderQuotaStore());
    await waitFor(() => expect(apiMocks.fetchProviderQuota).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.byProvider.size).toBe(0);
    expect(result.current.lastSyncedAt).toBeNull();
  });

  it('帧先到后 GET 空窗响应晚到 → 数据与 lastSyncedAt 都保旧（竞态保序兜底）', async () => {
    // GET 挂起（模拟慢响应），帧先到
    let resolveGet!: (v: { items: QuotaSnapshot[]; lastSyncedAt: number | null }) => void;
    apiMocks.fetchProviderQuota.mockReturnValue(new Promise((r) => { resolveGet = r; }));
    const { result } = renderHook(() => useProviderQuotaStore());
    await waitFor(() => expect(sseState.handler).not.toBeNull());
    await act(async () => {
      sseState.handler?.(frame([snap('p1')], 200));
    });
    expect(result.current.byProvider.size).toBe(1);
    expect(result.current.lastSyncedAt).toBe(200);
    // GET 空窗响应晚到：byProvider 保旧值（applyRound 空 items 不动）+ lastSyncedAt 不被 null 重置
    await act(async () => {
      resolveGet({ items: [], lastSyncedAt: null });
    });
    expect(result.current.byProvider.size).toBe(1);
    expect(result.current.lastSyncedAt).toBe(200);
  });
});

describe('useProviderQuotaStore — SSE 帧到达', () => {
  it('帧 items 覆盖 byProvider；error 项进 byProvider 不进 lastGood', async () => {
    apiMocks.fetchProviderQuota.mockResolvedValue({ items: [snap('p1')], lastSyncedAt: 100 });
    const { result } = renderHook(() => useProviderQuotaStore());
    await waitFor(() => expect(result.current.byProvider.size).toBe(1));
    await act(async () => {
      sseState.handler?.(frame([snap('p1', { tiers: [{ window: 'five_hour', usedPercent: 99 }] }), snap('p2', { error: { kind: 'auth', message: 'x' } })], 200));
    });
    expect(result.current.byProvider.size).toBe(2); // error 项也记录（错误态也是状态）
    expect(result.current.byProvider.get('p2')?.error?.kind).toBe('auth');
    expect(result.current.lastGood.has('p2')).toBe(false); // lastGood 只记成功项
    expect(result.current.lastGood.get('p1')?.tiers?.[0]?.usedPercent).toBe(99);
    expect(result.current.lastSyncedAt).toBe(200);
  });

  it('空 items 帧 → byProvider 保留旧值 + lastSyncedAt 更新', async () => {
    apiMocks.fetchProviderQuota.mockResolvedValue({ items: [snap('p1')], lastSyncedAt: 100 });
    const { result } = renderHook(() => useProviderQuotaStore());
    await waitFor(() => expect(result.current.byProvider.size).toBe(1));
    await act(async () => {
      sseState.handler?.(frame([], 300));
    });
    expect(result.current.byProvider.size).toBe(1); // 保留兜底
    expect(result.current.lastSyncedAt).toBe(300);
  });

  it('全 error 帧 → byProvider 更新但 lastGood 沿用上轮成功值', async () => {
    apiMocks.fetchProviderQuota.mockResolvedValue({ items: [snap('p1')], lastSyncedAt: 100 });
    const { result } = renderHook(() => useProviderQuotaStore());
    await waitFor(() => expect(result.current.byProvider.size).toBe(1));
    await act(async () => {
      sseState.handler?.(frame([snap('p1', { error: { kind: 'network', message: 'y' } })], 200));
    });
    expect(result.current.byProvider.get('p1')?.error?.kind).toBe('network');
    expect(result.current.lastGood.get('p1')?.error).toBeUndefined(); // lastGood 保留旧成功值
  });
});

describe('useProviderQuotaStore — 清理与守卫', () => {
  it('卸载 → unsubscribe 恰一次', async () => {
    apiMocks.fetchProviderQuota.mockResolvedValue({ items: [], lastSyncedAt: null });
    const { unmount } = renderHook(() => useProviderQuotaStore());
    await waitFor(() => expect(sseState.handler).not.toBeNull());
    unmount();
    await act(async () => { await Promise.resolve(); });
    expect(sseState.unsubscribeCount).toBe(1);
  });

  it('订阅晚于卸载到达 → 补偿 unsubscribe（资源开闭成对）', async () => {
    sseState.delaySubscribe = true;
    apiMocks.fetchProviderQuota.mockResolvedValue({ items: [], lastSyncedAt: null });
    const { unmount } = renderHook(() => useProviderQuotaStore());
    unmount();
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    expect(sseState.handler).not.toBeNull();
    expect(sseState.unsubscribeCount).toBe(1); // 晚到句柄被补偿回收
  });

  it('订阅晚于 enabled 翻转（未卸载）到达 → 同样补偿 unsubscribe + 帧不再 setState', async () => {
    sseState.delaySubscribe = true;
    apiMocks.fetchProviderQuota.mockResolvedValue({ items: [], lastSyncedAt: null });
    const { result, rerender } = renderHook(({ enabled }: { enabled: boolean }) => useProviderQuotaStore(enabled), {
      initialProps: { enabled: true },
    });
    // 翻转到 false：cleanup 已跑（handle 仍 pending 为 null），aliveRef 仍 true（未卸载）
    rerender({ enabled: false });
    await act(async () => { await new Promise((r) => setTimeout(r, 80)); });
    expect(sseState.handler).not.toBeNull();
    expect(sseState.unsubscribeCount).toBe(1); // 晚到句柄被补偿回收（cancelled flag 兜底）
    // 晚到订阅的 handler 帧不再穿透 setState
    await act(async () => {
      sseState.handler?.(frame([snap('p1')], 1));
    });
    expect(result.current.byProvider.size).toBe(0);
  });

  it('卸载后帧到达 → 不再 setState（handler 静默丢弃）', async () => {
    apiMocks.fetchProviderQuota.mockResolvedValue({ items: [], lastSyncedAt: null });
    const { result, unmount } = renderHook(() => useProviderQuotaStore());
    await waitFor(() => expect(sseState.handler).not.toBeNull());
    unmount();
    await act(async () => {
      sseState.handler?.(frame([snap('p9')], 1));
    });
    expect(result.current.byProvider.size).toBe(0);
  });

  it('enabled=false → 零请求零订阅', async () => {
    const { result } = renderHook(() => useProviderQuotaStore(false));
    await act(async () => { await Promise.resolve(); });
    expect(apiMocks.syncProviderQuota).not.toHaveBeenCalled();
    expect(apiMocks.fetchProviderQuota).not.toHaveBeenCalled();
    expect(sseState.handler).toBeNull();
    expect(result.current.lastSyncedAt).toBeNull();
  });
});

describe('useProviderQuotaStore — GET 失败兜底', () => {
  it('GET reject → 保持既有 state（LastGood 语义）', async () => {
    apiMocks.fetchProviderQuota.mockRejectedValue(new Error('500'));
    const { result } = renderHook(() => useProviderQuotaStore());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.byProvider.size).toBe(0);
    expect(result.current.lastSyncedAt).toBeNull();
  });
});
