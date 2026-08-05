/**
 * @vitest-environment jsdom
 * use-training-task 单测 —— 验证软刷新 reload 不 nullify ctx（软刷新回归守卫）
 * 参考: app/web/src/components/academy-page/use-training-task.ts（reload 软刷新注释）
 *
 * 核心断言：reload() 走 mutateCtx 软刷新，不走 useLifecycle.runInit 的
 *   setCtx(null) 路径。runInit setCtx(null) 会 nullify ctx → page-academy 的
 *   `data && studentDetail ? <Observe> : <Loading>` 翻转 → SectionTrainingObserve
 *   卸载 → SectionChatSession（coach 列）卸载 → useMessages destroy → remount → INIT 死循环。
 *   软刷新保留 ctx（仅覆盖新值），消费方 ternary 不翻转，子树不卸载，循环从源头断开。
 *
 * 覆盖：
 *   - 初始加载：onInit 拉详情 + data 填充
 *   - reload 软刷新：data 不闪 null（关键回归）+ 新值写入
 *   - reload 失败：data 保持旧值不丢 + error 不污染
 *   - 空 taskId：reload no-op（不发请求）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// 绝对路径 mock（memory: test-vitest-mock-absolute-path）—— bun+jsdom 全量并发下相对路径静默失效
const { academyApiPath, getTrainingTaskDetailMock } = vi.hoisted(() => ({
  academyApiPath: require('node:path').resolve(__dirname, '../../../lib/academy-api.ts'),
  getTrainingTaskDetailMock: vi.fn(),
}));

vi.mock(academyApiPath, () => ({
  getTrainingTaskDetail: (...args: Parameters<typeof getTrainingTaskDetailMock>) =>
    getTrainingTaskDetailMock(...args),
}));

import { useTrainingTask } from '../use-training-task';
import type { TrainingTaskDetail } from '../../../lib/academy-types';

/** 造一个 minimal TrainingTaskDetail（仅本 hook 关心的字段） */
function mkDetail(
  tid: string,
  status: TrainingTaskDetail['task']['status'],
  coachSessionId = 'coach-session-1',
): TrainingTaskDetail {
  return {
    task: {
      id: tid,
      classroomId: 'cls-1',
      studentId: 'stu-1',
      baseVersionId: 'ver-1',
      taskSeq: 1,
      coachSessionId,
      mode: 'simple',
      optimizeStyle: 'learning',
      status,
    },
    turns: [],
    baselineScore: undefined,
    history: [],
  };
}

describe('useTrainingTask', () => {
  beforeEach(() => {
    getTrainingTaskDetailMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('初始加载：pending 任务 → data 填充', async () => {
    // 用 mockResolvedValue（非 Once）—— onTick 轮询 4s 后也会调，mock 保持同值不干扰断言
    const detail = mkDetail('task-1', 'pending');
    getTrainingTaskDetailMock.mockResolvedValue(detail);

    const { result, unmount } = renderHook(() => useTrainingTask('task-1'));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });
    expect(result.current.data?.task.id).toBe('task-1');
    expect(result.current.loading).toBe(false);
    unmount();
  });

  it('reload 软刷新：data 不闪 null（v0.0.210 核心回归守卫）', async () => {
    // 初始 detail（pending）
    const detailV1 = mkDetail('task-1', 'pending');
    getTrainingTaskDetailMock.mockResolvedValue(detailV1);

    const { result, unmount } = renderHook(() => useTrainingTask('task-1'));

    // 等初始加载完成
    await waitFor(() => {
      expect(result.current.data?.task.status).toBe('pending');
    });

    // reload 后的新 detail（running）
    const detailV2 = mkDetail('task-1', 'running');
    // reload 延迟 resolve（模拟网络延迟——窗口期内观察 data 是否闪 null）
    getTrainingTaskDetailMock.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(detailV2), 50)),
    );

    // 调 reload（软刷新），不 await——在 promise resolve 前观察 data
    let reloadPromise: Promise<void> | undefined;
    act(() => {
      reloadPromise = result.current.reload();
    });

    // 关键断言：reload 发起到 resolve 前，data 必须保持旧值不闪 null。
    //   useLifecycle.reload（runInit）会在此窗口 setCtx(null) → data=null → 消费方卸载子树。
    //   软刷新不 nullify，data 保持 detailV1。
    expect(result.current.data).not.toBeNull();
    expect(result.current.data?.task.status).toBe('pending');

    // 等 reload 完成
    await act(async () => {
      await reloadPromise;
    });

    // reload 后 data 更新为新值（软刷新写回成功）
    expect(result.current.data).not.toBeNull();
    expect(result.current.data?.task.status).toBe('running');
    unmount();
  });

  it('reload 失败：data 保持旧值不丢 + error 不污染', async () => {
    const detailV1 = mkDetail('task-1', 'pending');
    getTrainingTaskDetailMock.mockResolvedValue(detailV1);

    const { result, unmount } = renderHook(() => useTrainingTask('task-1'));

    await waitFor(() => {
      expect(result.current.data?.task.status).toBe('pending');
    });

    // reload 抛错
    getTrainingTaskDetailMock.mockRejectedValueOnce(new Error('network down'));

    await act(async () => {
      await result.current.reload();
    });

    // data 保持旧值（软刷新 catch 静默，不覆盖不丢）
    expect(result.current.data).not.toBeNull();
    expect(result.current.data?.task.status).toBe('pending');
    expect(result.current.error).toBeNull();
    unmount();
  });

  it('空 taskId：reload no-op（不发请求）', async () => {
    const { result, unmount } = renderHook(() => useTrainingTask(''));

    // 空 taskId → onInit 返 null（不调 getTrainingTaskDetail）
    expect(getTrainingTaskDetailMock).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.reload();
    });

    // reload 也是 no-op
    expect(getTrainingTaskDetailMock).not.toHaveBeenCalled();
    unmount();
  });
}, 15000);
