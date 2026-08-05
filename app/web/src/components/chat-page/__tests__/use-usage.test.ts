// @vitest-environment jsdom
/**
 * useUsage area-hook 单测（v0.0.94.component_refactor T2）
 * 参考: specs/tech/app/frontend/[P0]chat_area_hooks.md §2 / §4.1（事件流解耦）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.2（Snapshot 形 + applySnapshot）
 *
 * 覆盖：
 *   - 初始 GET /usage 拉基线
 *   - GET 失败 → usage=null 占位
 *   - session_panel session_usage_update → applySnapshot(replace) 写新 usage
 *   - 其它 session_panel type（status/summary/messages_cleared/workspace/read）不影响 usage
 *   - 切 session：cleanup unsubscribe（不 destroy 单例）
 *   - 同引用 usage_update 幂等（applySnapshot 同引用返原值，React 跳过渲染）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SessionUsageView } from '../types';

const sse = vi.hoisted(() => ({
  handlers: {} as Record<string, (f: { data: unknown }) => void>,
  instances: 0,
  destroyed: 0,
  unsub: [] as string[],
}));
const apiMocks = vi.hoisted(() => ({
  getSessionUsage: vi.fn(),
}));
const singletonPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/sse-singleton'));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'));

vi.mock(singletonPath, () => {
  let subIdCounter = 0;
  class FakeSseClient {
    constructor() {
      sse.instances++;
    }
    async connect() {
      /* no-op */
    }
    async subscribe(topic: string, _group: string, handler: (f: { data: unknown }) => void) {
      sse.handlers[topic] = handler;
      const subId = `sub-${++subIdCounter}-${topic}`;
      return { subId, topic, group: _group, unsubscribe: async () => { sse.unsub.push(topic); } };
    }
    async unsubscribe(handle: { subId?: string } | string) {
      const subId = typeof handle === 'string' ? handle : handle?.subId;
      if (subId) sse.unsub.push(subId);
    }
    destroy() {
      sse.destroyed++;
    }
  }
  let singleton: FakeSseClient | null = null;
  return {
    getSseClient: () => {
      if (!singleton) singleton = new FakeSseClient();
      return singleton;
    },
    _resetSseSingletonForTest: () => {
      if (singleton) singleton.destroy();
      singleton = null;
    },
  };
});
vi.mock(apiPath, () => apiMocks);

import { useUsage } from '../use-usage';
import type { SessionEvent } from '../../../store/session-slice-reducer';

function mkUsage(used: number): SessionUsageView {
  return {
    current: { input_total_tokens: used },
    sub: {}, forked: {}, total: { input_total_tokens: used },
    ratio: 1,
    currentCacheRate: 0, subCacheRate: 0, forkedCacheRate: 0, totalCacheRate: 0,
  } as SessionUsageView;
}
function pushPanel(evt: SessionEvent): void {
  act(() => sse.handlers['session_panel']?.({ data: evt }));
}
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  sse.handlers = {};
  sse.instances = 0;
  sse.destroyed = 0;
  sse.unsub = [];
  apiMocks.getSessionUsage.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('useUsage — 初始 GET /usage', () => {
  it('mount 拉 usage 基线', async () => {
    const u = mkUsage(100);
    apiMocks.getSessionUsage.mockResolvedValue(u);
    const { result } = renderHook(() => useUsage('s1'));
    await settle();
    expect(apiMocks.getSessionUsage).toHaveBeenCalledWith('s1');
    expect(result.current.usage).toEqual(u);
  });

  it('GET 失败 → usage=null 占位', async () => {
    apiMocks.getSessionUsage.mockRejectedValue(new Error('net'));
    const { result } = renderHook(() => useUsage('s1'));
    await settle();
    expect(result.current.usage).toBeNull();
  });
});

describe('useUsage — session_panel session_usage_update', () => {
  it('session_usage_update → applySnapshot replace 写新 usage', async () => {
    apiMocks.getSessionUsage.mockResolvedValue(mkUsage(100));
    const { result } = renderHook(() => useUsage('s1'));
    await settle();
    const u2 = mkUsage(500);
    pushPanel({ type: 'session_usage_update', sessionId: 's1', createdAt: 't1', data: u2 });
    expect(result.current.usage).toEqual(u2);
  });

  it('其它 session_panel type 不影响 usage', async () => {
    const u = mkUsage(100);
    apiMocks.getSessionUsage.mockResolvedValue(u);
    const { result } = renderHook(() => useUsage('s1'));
    await settle();
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't1', data: { state: 'idle', running: false, currentRunId: null } });
    pushPanel({ type: 'summary_task_update', sessionId: 's1', createdAt: 't2', data: { status: 'done', runId: 'r1', startedAt: null, error: null } });
    pushPanel({ type: 'messages_cleared', sessionId: 's1', createdAt: 't3', data: { sessionId: 's1' } });
    expect(result.current.usage).toEqual(u);
  });
});

describe('useUsage — 切 session cleanup', () => {
  it('unmount → unsubscribe session_panel（不 destroy 单例）', async () => {
    const { unmount } = renderHook(() => useUsage('s1'));
    await settle();
    expect(sse.handlers['session_panel']).toBeTruthy();
    unmount();
    expect(sse.unsub).toContain('session_panel');
    expect(sse.destroyed).toBe(0);
  });
});
