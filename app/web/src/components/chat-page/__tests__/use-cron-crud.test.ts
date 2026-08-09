// @vitest-environment jsdom
/**
 * useCronCrud 单测（v0.0.131 T6 / v0.0.303 SSE 实时化改造）
 * 参考: specs/tech/version_logs/v0.0.131/change_plan.md A 组 + G 组
 *       specs/tech/version_logs/v0.0.303/change_plan.md（SSE 订阅改造）
 *       app/web/src/components/chat-page/use-cron-crud.ts
 *       app/web/src/lib/__tests__/use-lifecycle.test.ts（startTimer→onTick fake timers 用法）
 *
 * 覆盖：
 *   - 挂载 GET 列表（listCronJobs 调用一次，jobs 写入）
 *   - toggle（enable/disable）后 refetch（重新 GET）
 *   - delete 后 refetch（重新 GET）
 *   - enabled=false（如群聊 hideCron）→ 零网络：listCronJobs 不调用，jobs 恒为 []
 *   - SSE 订阅：mount → subscribe session_panel；收到 session_cron_changed → reload（重新 GET）
 *   - 收到其他事件（session_usage_update）→ 不 reload
 *   - 5min 漂移兜底 timer：startTimer intervalMs=300000 到点触发 onTick 重新 GET
 *
 * mock 策略（MEMORY test-vitest-mock-absolute-path）：vi.hoisted + __dirname 派生绝对路径 mock cron-api，
 * sse-singleton mock（仿 use-usage.test.ts），useLifecycle 本身不 mock（真实跑）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { CronJobSummary } from '../../../lib/cron-api';
import type { SessionEvent } from '../../../store/session-slice-reducer';

const sse = vi.hoisted(() => ({
  handlers: {} as Record<string, (f: { data: unknown }) => void>,
  instances: 0,
  destroyed: 0,
  unsub: [] as string[],
}));
const apiMocks = vi.hoisted(() => ({
  listCronJobs: vi.fn(),
  createCronJob: vi.fn(),
  updateCronJob: vi.fn(),
  disableCronJob: vi.fn(),
  enableCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
}));
const singletonPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/sse-singleton'));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/cron-api'));

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

import { useCronCrud } from '../use-cron-crud';

function mkJob(id: string, enabled = true): CronJobSummary {
  return {
    id,
    sessionId: 's1',
    name: `job-${id}`,
    cron: '*/30 * * * *',
    tz: 'Asia/Shanghai',
    prompt: 'p',
    enabled,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastFiredAt: null,
    nextFireAt: enabled ? '2026-07-02T00:00:00.000Z' : null,
  };
}

/** 排空 hook 挂载后异步副作用（onInit await），act 内结算 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 推一帧到 session_panel（仿 use-usage.test.ts pushPanel） */
function pushPanel(evt: SessionEvent): void {
  act(() => sse.handlers['session_panel']?.({ data: evt }));
}

beforeEach(() => {
  sse.handlers = {};
  sse.instances = 0;
  sse.destroyed = 0;
  sse.unsub = [];
  apiMocks.listCronJobs.mockReset().mockResolvedValue([]);
  apiMocks.disableCronJob.mockReset().mockResolvedValue({ id: 'j1', enabled: false });
  apiMocks.enableCronJob.mockReset().mockResolvedValue({ id: 'j1', enabled: true });
  apiMocks.deleteCronJob.mockReset().mockResolvedValue({ id: 'j1', deleted: true });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('useCronCrud — 挂载 GET 列表', () => {
  it('mount → listCronJobs(sessionId) 调用一次，jobs 写入', async () => {
    const jobs = [mkJob('j1'), mkJob('j2', false)];
    apiMocks.listCronJobs.mockResolvedValue(jobs);
    const { result } = renderHook(() => useCronCrud('s1'));
    await settle();
    expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(1);
    expect(apiMocks.listCronJobs).toHaveBeenCalledWith('s1');
    expect(result.current.jobs).toEqual(jobs);
    expect(result.current.loading).toBe(false);
  });
});

describe('useCronCrud — toggle/delete 后 refetch', () => {
  it('handleToggle（enabled=true → disable）后重新 GET（refetch）', async () => {
    const job = mkJob('j1', true);
    apiMocks.listCronJobs.mockResolvedValue([job]);
    const { result } = renderHook(() => useCronCrud('s1'));
    await settle();
    expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.handleToggle(job);
    });
    expect(apiMocks.disableCronJob).toHaveBeenCalledWith('s1', 'j1');
    // refetch = 再 GET 一次
    expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(2);
  });

  it('handleToggle（enabled=false → enable）调用正确端点', async () => {
    const job = mkJob('j1', false);
    apiMocks.listCronJobs.mockResolvedValue([job]);
    const { result } = renderHook(() => useCronCrud('s1'));
    await settle();
    await act(async () => {
      await result.current.handleToggle(job);
    });
    expect(apiMocks.enableCronJob).toHaveBeenCalledWith('s1', 'j1');
    expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(2);
  });

  it('handleDelete 后重新 GET（refetch）', async () => {
    const job = mkJob('j1');
    apiMocks.listCronJobs.mockResolvedValue([job]);
    const { result } = renderHook(() => useCronCrud('s1'));
    await settle();
    await act(async () => {
      await result.current.handleDelete(job);
    });
    expect(apiMocks.deleteCronJob).toHaveBeenCalledWith('s1', 'j1');
    expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(2);
  });
});

describe('useCronCrud — enabled=false 零网络', () => {
  it('enabled:false（群聊 hideCron）→ listCronJobs 不调用，jobs 恒为 []', async () => {
    const { result } = renderHook(() => useCronCrud('s1', { enabled: false }));
    await settle();
    expect(apiMocks.listCronJobs).not.toHaveBeenCalled();
    expect(result.current.jobs).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});

describe('useCronCrud — SSE 订阅 + session_cron_changed → reload', () => {
  it('mount → subscribe session_panel', async () => {
    renderHook(() => useCronCrud('s1'));
    await settle();
    expect(sse.handlers['session_panel']).toBeTruthy();
  });

  it('收到 session_cron_changed → reload（listCronJobs 再次调用）', async () => {
    apiMocks.listCronJobs.mockResolvedValue([mkJob('j1')]);
    renderHook(() => useCronCrud('s1'));
    await settle();
    expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(1);

    pushPanel({ type: 'session_cron_changed', sessionId: 's1', createdAt: 't1', data: {} });
    await settle();

    // SSE session_cron_changed → reload → 重新 GET
    expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(2);
  });

  it('收到其他事件（session_usage_update）→ 不 reload', async () => {
    apiMocks.listCronJobs.mockResolvedValue([mkJob('j1')]);
    renderHook(() => useCronCrud('s1'));
    await settle();
    expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(1);

    pushPanel({ type: 'session_usage_update', sessionId: 's1', createdAt: 't2', data: { current: 0, sub: {}, forked: {}, total: 0 } as never });
    await settle();

    // 其他事件不应触发 reload
    expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(1);
  });
});

describe('useCronCrud — 5min 漂移兜底 timer', () => {
  it('startTimer(intervalMs=300000) 到点触发 onTick 重新 GET', async () => {
    vi.useFakeTimers();
    try {
      apiMocks.listCronJobs.mockResolvedValue([mkJob('j1')]);
      renderHook(() => useCronCrud('s1'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(1);

      // 未到 5min：不触发
      await act(async () => {
        await vi.advanceTimersByTimeAsync(299_000);
      });
      expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(1);

      // 到 5min：onTick 触发第二次 GET
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enabled:false 时不声明 timer（推进 5min 无新增 GET）', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useCronCrud('s1', { enabled: false }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000);
      });
      expect(apiMocks.listCronJobs).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
