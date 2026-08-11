/**
 * @vitest-environment jsdom
 * useTabDirtyAggregator 单测（v0.0.316 新增；v0.0.316-fix 方案 B 适配）
 * 参考: specs/tech/version_logs/v0.0.316/fix-aggregator-dirty-report.md
 *
 * 范围：
 *   - reportDirty：section dirty 变化上报 → dirtyMap 更新 → isDirty 反映
 *   - register：注册 section handle（save/reset）
 *   - isDirty：任一 section dirty → true；全部 clean → false（走 state dirtyMap）
 *   - saveAll：只调 dirty section 的 save，Promise.allSettled 汇总
 *   - resetAll：调全部 section 的 reset + 清 dirtyMap
 *   - unmount（register 返回 null）→ section handle 从 aggregator 移除
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTabDirtyAggregator, type SectionSaveHandle } from '../use-tab-dirty-aggregator';

/** 造一个 mock SectionSaveHandle（v0.0.316-fix: 只有 save/reset，无 isDirty） */
function makeHandle(saveFn?: () => Promise<void>, resetFn?: () => void): SectionSaveHandle {
  return {
    save: saveFn ?? vi.fn().mockResolvedValue(undefined),
    reset: resetFn ?? vi.fn(),
  };
}

describe('useTabDirtyAggregator', () => {
  it('初始无 section → isDirty=false', () => {
    const { result } = renderHook(() => useTabDirtyAggregator());
    expect(result.current.isDirty()).toBe(false);
  });

  it('reportDirty 上报一个 dirty → isDirty=true（state 驱动）', () => {
    const { result } = renderHook(() => useTabDirtyAggregator());
    act(() => {
      result.current.reportDirty('web_search', true);
    });
    expect(result.current.isDirty()).toBe(true);
  });

  it('reportDirty 上报一个 clean + 一个 dirty → isDirty=true（any 语义）', () => {
    const { result } = renderHook(() => useTabDirtyAggregator());
    act(() => {
      result.current.reportDirty('web_search', false);
      result.current.reportDirty('bash', true);
    });
    expect(result.current.isDirty()).toBe(true);
  });

  it('全部 reportDirty clean → isDirty=false', () => {
    const { result } = renderHook(() => useTabDirtyAggregator());
    act(() => {
      result.current.reportDirty('web_search', false);
      result.current.reportDirty('bash', false);
    });
    expect(result.current.isDirty()).toBe(false);
  });

  it('saveAll 只调 dirty section 的 save', async () => {
    const { result } = renderHook(() => useTabDirtyAggregator());
    const dirtySave = vi.fn().mockResolvedValue(undefined);
    const cleanSave = vi.fn().mockResolvedValue(undefined);
    // 注册 handle
    act(() => {
      result.current.register('web_search')(makeHandle(cleanSave));
      result.current.register('bash')(makeHandle(dirtySave));
    });
    // 只有 bash dirty
    act(() => {
      result.current.reportDirty('web_search', false);
      result.current.reportDirty('bash', true);
    });
    let res;
    await act(async () => {
      res = await result.current.saveAll();
    });
    expect(dirtySave).toHaveBeenCalledTimes(1);
    expect(cleanSave).not.toHaveBeenCalled();
    expect(res!.ok).toBe(true);
    expect(res!.failed).toEqual([]);
  });

  it('saveAll 部分 section reject → ok=false, failed 含 key', async () => {
    const { result } = renderHook(() => useTabDirtyAggregator());
    const okSave = vi.fn().mockResolvedValue(undefined);
    const failSave = vi.fn().mockRejectedValue(new Error('network'));
    act(() => {
      result.current.register('web_search')(makeHandle(okSave));
      result.current.register('bash')(makeHandle(failSave));
    });
    act(() => {
      result.current.reportDirty('web_search', true);
      result.current.reportDirty('bash', true);
    });
    let res;
    await act(async () => {
      res = await result.current.saveAll();
    });
    expect(res!.ok).toBe(false);
    expect(res!.failed).toContain('bash');
    expect(res!.failed).not.toContain('web_search');
  });

  it('resetAll 调全部 section 的 reset + 清 dirtyMap', () => {
    const { result } = renderHook(() => useTabDirtyAggregator());
    const reset1 = vi.fn();
    const reset2 = vi.fn();
    act(() => {
      result.current.register('web_search')(makeHandle(undefined, reset1));
      result.current.register('bash')(makeHandle(undefined, reset2));
      result.current.reportDirty('web_search', true);
      result.current.reportDirty('bash', false);
    });
    expect(result.current.isDirty()).toBe(true);
    act(() => {
      result.current.resetAll();
    });
    expect(reset1).toHaveBeenCalledTimes(1);
    expect(reset2).toHaveBeenCalledTimes(1);
    // resetAll 清 dirtyMap → isDirty=false
    expect(result.current.isDirty()).toBe(false);
  });

  it('register 返回 null（unmount）→ section handle 从 aggregator 移除', () => {
    const { result } = renderHook(() => useTabDirtyAggregator());
    act(() => {
      result.current.register('web_search')(makeHandle());
    });
    // handle 注册不影响 dirtyMap（dirty 走 reportDirty）
    expect(result.current.isDirty()).toBe(false);
    // unmount（ref null）
    act(() => {
      result.current.register('web_search')(null);
    });
    expect(result.current.isDirty()).toBe(false);
  });

  it('reportDirty 相同值不重复 setState（无变化不触发 re-render）', () => {
    const { result } = renderHook(() => useTabDirtyAggregator());
    act(() => {
      result.current.reportDirty('web_search', true);
    });
    expect(result.current.isDirty()).toBe(true);
    // 再次上报相同值 → dirtyMap 不变
    act(() => {
      result.current.reportDirty('web_search', true);
    });
    expect(result.current.isDirty()).toBe(true);
    // 切回 false
    act(() => {
      result.current.reportDirty('web_search', false);
    });
    expect(result.current.isDirty()).toBe(false);
  });
});
