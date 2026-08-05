// @vitest-environment jsdom
/**
 * useCronCrud 单测（v0.0.131 T6）
 * 参考: specs/tech/version_logs/v0.0.131/change_plan.md A 组 + G 组
 *       app/web/src/components/chat-page/use-cron-crud.ts
 *       app/web/src/lib/__tests__/use-lifecycle.test.ts（startTimer→onTick fake timers 用法）
 *
 * 覆盖：
 *   - 挂载 GET 列表（listCronJobs 调用一次，jobs 写入）
 *   - toggle（enable/disable）后 refetch（重新 GET）
 *   - delete 后 refetch（重新 GET）
 *   - enabled=false（如群聊 hideCron）→ 零网络：listCronJobs 不调用，jobs 恒为 []
 *   - 60s poll 声明：onTick 到点重新 GET（startTimer intervalMs=60000 生效）
 *
 * mock 策略（MEMORY test-vitest-mock-absolute-path）：vi.hoisted + __dirname 派生绝对路径 mock cron-api，
 * useLifecycle 本身不 mock（真实跑，验证 hook 端到端行为，含 60s timer）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { CronJobSummary } from '../../../lib/cron-api';

const apiMocks = vi.hoisted(() => ({
  listCronJobs: vi.fn(),
  createCronJob: vi.fn(),
  updateCronJob: vi.fn(),
  disableCronJob: vi.fn(),
  enableCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
}));
const apiPath = vi.hoisted(() => require('node:path').resolve(__dirname, '../../../lib/cron-api'));

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

beforeEach(() => {
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

describe('useCronCrud — 60s poll 声明', () => {
  it('startTimer(intervalMs=60000) 到点触发 onTick 重新 GET', async () => {
    vi.useFakeTimers();
    try {
      apiMocks.listCronJobs.mockResolvedValue([mkJob('j1')]);
      renderHook(() => useCronCrud('s1'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(1);

      // 未到 60s：不触发
      await act(async () => {
        await vi.advanceTimersByTimeAsync(59_000);
      });
      expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(1);

      // 到 60s：onTick 触发第二次 GET
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(apiMocks.listCronJobs).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('enabled:false 时不声明 timer（推进 60s 无新增 GET）', async () => {
    vi.useFakeTimers();
    try {
      renderHook(() => useCronCrud('s1', { enabled: false }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(apiMocks.listCronJobs).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
