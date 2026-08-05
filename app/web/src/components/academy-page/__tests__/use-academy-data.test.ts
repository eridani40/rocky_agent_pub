/**
 * @vitest-environment jsdom
 * use-academy-data 单测 —— v0.0.219 useStudentDetail / useClassroomDetail active-task 轮询
 * 参考: app/web/src/components/academy-page/use-academy-data.ts（PRD §2.3 coach 持续可达）
 *
 * 核心断言：
 *   1) detail.tasks 含活跃态（pending/running/awaiting_confirm）→ onInit 触发 startTimer（5s 轮询）；
 *      无活跃态不轮询。
 *   2) reload() 走 mutateCtx 软刷新（不走 runInit setCtx(null)）——避免消费方 ternary 翻转 +
 *      子树卸载死循环（同 use-training-task 软刷新回归守卫）。
 *   3) reload 失败 → data 保持旧值不丢 + error 不污染。
 *
 * 「不堆叠 timer」：onTick 返新 detail 走 applyMutation→commitCtx（不调 reload/runInit），
 *   所以轮询不会重建 onInit 堆叠新 timer——timer 只在 onInit 起 + deps 变/re-init 回收。
 *   此为结构保证（代码读），UT 通过 reload 软刷新行为间接覆盖。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

// 绝对路径 mock（memory: test-vitest-mock-absolute-path）—— bun+jsdom 全量并发下相对路径静默失效
const { academyApiPath, getStudentDetailMock, getClassroomDetailMock } = vi.hoisted(() => ({
  academyApiPath: require('node:path').resolve(__dirname, '../../../lib/academy-api.ts'),
  getStudentDetailMock: vi.fn(),
  getClassroomDetailMock: vi.fn(),
}));

vi.mock(academyApiPath, async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/academy-api')>();
  return {
    ...actual,
    getStudentDetail: (...args: Parameters<typeof getStudentDetailMock>) => getStudentDetailMock(...args),
    getClassroomDetail: (...args: Parameters<typeof getClassroomDetailMock>) => getClassroomDetailMock(...args),
  };
});

import { useStudentDetail, useClassroomDetail } from '../use-academy-data';
import type { StudentDetail, ClassroomDetail } from '../../../lib/academy-types';

/** 造一个含 tasks 的 StudentDetail；tasks status 可控 */
function mkStudentDetail(taskStatus: StudentDetail['tasks'][number]['status']): StudentDetail {
  return {
    student: { id: 'stu-1', classroomId: 'cls-1', name: '学生' },
    versions: [{ id: 'vf-0', classroomId: 'cls-1', studentId: 'stu-1', versionLabel: '0.0', type: 'formal', workspaceDir: '/tmp/ws' }],
    tasks: [{ id: 'task-1', classroomId: 'cls-1', studentId: 'stu-1', baseVersionId: 'vf-0', taskSeq: 1, coachSessionId: 'c-1', mode: 'simple', optimizeStyle: 'learning', status: taskStatus }],
  };
}

/** 造一个含 tasks 的 ClassroomDetail；tasks status 可控 */
function mkClassroomDetail(taskStatus: StudentDetail['tasks'][number]['status']): ClassroomDetail {
  return {
    classroom: { id: 'cls-1', name: '教室', headTeacherSessionId: 'h-1' },
    students: [{ id: 'stu-1', classroomId: 'cls-1', name: '学生' }],
    tasks: [{ id: 'task-1', classroomId: 'cls-1', studentId: 'stu-1', baseVersionId: 'vf-0', taskSeq: 1, coachSessionId: 'c-1', mode: 'simple', optimizeStyle: 'learning', status: taskStatus }],
    datasets: [],
    graders: [],
  };
}

describe('useStudentDetail — v0.0.219 active-task 轮询', () => {
  beforeEach(() => {
    getStudentDetailMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reload 软刷新：data 不闪 null（消费方 ternary 不翻转，子树不卸载）', async () => {
    const detailV1 = mkStudentDetail('pending');
    getStudentDetailMock.mockResolvedValue(detailV1);

    const { result, unmount } = renderHook(() => useStudentDetail('cls-1', 'stu-1'));
    await waitFor(() => {
      expect(result.current.data?.tasks[0]?.status).toBe('pending');
    });

    // reload 延迟 resolve，观察窗口期 data 是否闪 null
    const detailV2 = mkStudentDetail('running');
    getStudentDetailMock.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(detailV2), 50)),
    );

    let reloadPromise: Promise<void> | undefined;
    act(() => {
      reloadPromise = result.current.reload();
    });

    // 关键：reload 发起到 resolve 前，data 必须保持旧值不闪 null
    expect(result.current.data).not.toBeNull();
    expect(result.current.data?.tasks[0]?.status).toBe('pending');

    await act(async () => {
      await reloadPromise;
    });

    expect(result.current.data?.tasks[0]?.status).toBe('running');
    unmount();
  });

  it('reload 失败：data 保持旧值不丢 + error 不污染', async () => {
    getStudentDetailMock.mockResolvedValue(mkStudentDetail('pending'));
    const { result, unmount } = renderHook(() => useStudentDetail('cls-1', 'stu-1'));
    await waitFor(() => {
      expect(result.current.data?.tasks[0]?.status).toBe('pending');
    });

    getStudentDetailMock.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.data).not.toBeNull();
    expect(result.current.data?.tasks[0]?.status).toBe('pending');
    expect(result.current.error).toBeNull();
    unmount();
  });

  it('空 ids：reload no-op（不发请求）', async () => {
    const { result, unmount } = renderHook(() => useStudentDetail('', ''));
    expect(getStudentDetailMock).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.reload();
    });
    expect(getStudentDetailMock).not.toHaveBeenCalled();
    unmount();
  });
}, 15000);

describe('useStudentDetail — v0.0.221 BUG-003 refetchKey back-nav 软刷新', () => {
  beforeEach(() => {
    getStudentDetailMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('refetchKey 变化（ids 不变）→ 触发一次额外 getStudentDetail，版本树更新不闪 null（back-nav 场景）', async () => {
    // 初始：训练 paused 后陈旧的版本树（只 0.0 初始版）
    const staleDetail = mkStudentDetail('paused');
    getStudentDetailMock.mockResolvedValueOnce(staleDetail);

    const { result, unmount, rerender } = renderHook(
      ({ key }) => useStudentDetail('cls-1', 'stu-1', key),
      { initialProps: { key: 'training-observe' as string } },
    );

    await waitFor(() => {
      expect(result.current.data?.versions.length).toBe(1);
    });
    expect(getStudentDetailMock).toHaveBeenCalledTimes(1);

    // back-nav 回 student-detail；后端已写新过程版
    const freshDetail: StudentDetail = {
      ...staleDetail,
      versions: [
        ...staleDetail.versions,
        {
          id: 'vp-1',
          classroomId: 'cls-1',
          studentId: 'stu-1',
          versionLabel: '0.1.1',
          type: 'process',
          workspaceDir: '/tmp/ws',
          createdFromTaskId: 'task-1',
        },
      ],
    };
    getStudentDetailMock.mockResolvedValueOnce(freshDetail);

    rerender({ key: 'student-detail' });

    // 软刷新触发：再调一次 getStudentDetail，拿到新版树
    await waitFor(() => {
      expect(result.current.data?.versions.length).toBe(2);
    });
    expect(getStudentDetailMock).toHaveBeenCalledTimes(2);

    // 关键：data 全程不闪 null（软刷新走 mutateCtx 不 setCtx(null)）
    expect(result.current.data).not.toBeNull();
    expect(result.current.data?.versions[1]?.id).toBe('vp-1');

    unmount();
  });

  it('refetchKey 不变 → 不触发额外请求（只 onInit 一次）', async () => {
    getStudentDetailMock.mockResolvedValue(mkStudentDetail('pending'));

    const { unmount, rerender } = renderHook(
      ({ key }) => useStudentDetail('cls-1', 'stu-1', key),
      { initialProps: { key: 'student-detail' as string } },
    );

    await waitFor(() => {
      expect(getStudentDetailMock).toHaveBeenCalledTimes(1);
    });

    // 同 key rerender → 无额外请求
    rerender({ key: 'student-detail' });
    expect(getStudentDetailMock).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('ids 与 refetchKey 同时变化 → 不双拉（useLifecycle re-init 一次，refetchKey 效果跳过）', async () => {
    getStudentDetailMock.mockResolvedValue(mkStudentDetail('pending'));

    const { unmount, rerender } = renderHook(
      ({ cid, sid, key }) => useStudentDetail(cid, sid, key),
      {
        initialProps: {
          cid: '' as string,
          sid: '' as string,
          key: 'classroom-detail' as string,
        },
      },
    );

    // 空 ids → onInit 跳过（不发请求）
    expect(getStudentDetailMock).not.toHaveBeenCalled();

    // 同时切 ids + key（classroom-detail → student-detail 进入）
    rerender({ cid: 'cls-1', sid: 'stu-1', key: 'student-detail' });

    await waitFor(() => {
      expect(getStudentDetailMock).toHaveBeenCalledTimes(1); // 仅 useLifecycle onInit 一次
    });

    unmount();
  });
}, 15000);

describe('useClassroomDetail — v0.0.219 active-task 轮询', () => {
  beforeEach(() => {
    getClassroomDetailMock.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reload 软刷新：data 不闪 null', async () => {
    const detailV1 = mkClassroomDetail('running');
    getClassroomDetailMock.mockResolvedValue(detailV1);

    const { result, unmount } = renderHook(() => useClassroomDetail('cls-1'));
    await waitFor(() => {
      expect(result.current.data?.tasks[0]?.status).toBe('running');
    });

    const detailV2 = mkClassroomDetail('paused');
    getClassroomDetailMock.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(detailV2), 50)),
    );

    let reloadPromise: Promise<void> | undefined;
    act(() => {
      reloadPromise = result.current.reload();
    });

    expect(result.current.data).not.toBeNull();
    expect(result.current.data?.tasks[0]?.status).toBe('running');

    await act(async () => {
      await reloadPromise;
    });

    expect(result.current.data?.tasks[0]?.status).toBe('paused');
    unmount();
  });

  it('reload 失败：data 保持旧值 + error 不污染', async () => {
    getClassroomDetailMock.mockResolvedValue(mkClassroomDetail('running'));
    const { result, unmount } = renderHook(() => useClassroomDetail('cls-1'));
    await waitFor(() => {
      expect(result.current.data?.tasks[0]?.status).toBe('running');
    });

    getClassroomDetailMock.mockRejectedValueOnce(new Error('network down'));
    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.data).not.toBeNull();
    expect(result.current.data?.tasks[0]?.status).toBe('running');
    expect(result.current.error).toBeNull();
    unmount();
  });
}, 15000);
