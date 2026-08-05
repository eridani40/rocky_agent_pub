// @vitest-environment jsdom
/**
 * useSummary area-hook 单测（v0.0.94.component_refactor T2）
 * 参考: specs/tech/app/frontend/[P0]chat_area_hooks.md §2（无初始 GET，初值 null）
 *       specs/tech/app/frontend/[P0]lifecycle_data_shapes.md §2.2（Snapshot 形 + applySnapshot）
 *
 * 覆盖：
 *   - 初值 null（无初始 GET）
 *   - session_panel summary_task_update → applySnapshot(replace) 写 summaryTask
 *   - 其它 session_panel type 不影响 summaryTask
 *   - 切 session：cleanup unsubscribe（不 destroy 单例）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SummaryTaskStatus } from '../types';

const sse = vi.hoisted(() => ({
  handlers: {} as Record<string, (f: { data: unknown }) => void>,
  instances: 0,
  destroyed: 0,
  unsub: [] as string[],
}));
const singletonPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/sse-singleton'));

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

import { useSummary } from '../use-summary';
import type { SessionEvent } from '../../../store/session-slice-reducer';

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
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('useSummary — 初值 null（无初始 GET）', () => {
  it('mount 不发 GET /summary，初值 null（CompactBtn 按 idle 兜底）', async () => {
    const { result } = renderHook(() => useSummary('s1'));
    await settle();
    expect(result.current.summaryTask).toBeNull();
  });
});

describe('useSummary — session_panel summary_task_update', () => {
  it('summary_task_update → applySnapshot replace 写 summaryTask', async () => {
    const { result } = renderHook(() => useSummary('s1'));
    await settle();
    const st: SummaryTaskStatus = { status: 'running', runId: 'r1', startedAt: 't', error: null };
    pushPanel({ type: 'summary_task_update', sessionId: 's1', createdAt: 't1', data: st });
    expect(result.current.summaryTask).toEqual(st);
  });

  it('status 转 done 后再转 failed（连续 replace）', async () => {
    const { result } = renderHook(() => useSummary('s1'));
    await settle();
    pushPanel({ type: 'summary_task_update', sessionId: 's1', createdAt: 't1', data: { status: 'running', runId: 'r1', startedAt: 't', error: null } });
    expect(result.current.summaryTask?.status).toBe('running');
    pushPanel({ type: 'summary_task_update', sessionId: 's1', createdAt: 't2', data: { status: 'done', runId: 'r1', startedAt: 't', error: null } });
    expect(result.current.summaryTask?.status).toBe('done');
    pushPanel({ type: 'summary_task_update', sessionId: 's1', createdAt: 't3', data: { status: 'failed', runId: 'r1', startedAt: 't', error: 'boom' } });
    expect(result.current.summaryTask?.status).toBe('failed');
    expect(result.current.summaryTask?.error).toBe('boom');
  });

  it('其它 session_panel type 不影响 summaryTask', async () => {
    const { result } = renderHook(() => useSummary('s1'));
    await settle();
    pushPanel({ type: 'session_status_update', sessionId: 's1', createdAt: 't1', data: { state: 'idle', running: false, currentRunId: null } });
    pushPanel({ type: 'session_usage_update', sessionId: 's1', createdAt: 't2', data: {} as never });
    pushPanel({ type: 'messages_cleared', sessionId: 's1', createdAt: 't3', data: { sessionId: 's1' } });
    expect(result.current.summaryTask).toBeNull();
  });
});

describe('useSummary — 切 session cleanup', () => {
  it('unmount → unsubscribe session_panel（不 destroy 单例）', async () => {
    const { unmount } = renderHook(() => useSummary('s1'));
    await settle();
    expect(sse.handlers['session_panel']).toBeTruthy();
    unmount();
    expect(sse.unsub).toContain('session_panel');
    expect(sse.destroyed).toBe(0);
  });
});
