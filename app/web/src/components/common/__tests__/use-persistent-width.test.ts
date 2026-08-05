/**
 * @vitest-environment jsdom
 * use-persistent-width 单测 —— 通用列宽 clamp + localStorage 持久化（common 层）
 * 参考: specs/ui/components/academy-page/_overview.md §2（可拖宽列约定）
 *
 * 覆盖（自 academy use-resizable-col.test.ts 随迁）：
 * - clampColWidth：越界收敛 / 非有限数回退
 * - readColWidth：缺失 / 坏值 / 越界 / storage 抛异常 → 一律安全回退
 * - usePersistentWidth：初始读 storage；onResize 只改 state 不写盘；onResizeEnd 才 persist（写最新值）
 * - key 兼容：旧实现（use-resizable-col）写入的同 key 值可直接读回（用户已存宽度不失效）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import {
  clampColWidth,
  readColWidth,
  usePersistentWidth,
  writeColWidth,
} from '../use-persistent-width';

const KEY = 'test-col-width';

describe('clampColWidth（列宽 clamp 纯函数）', () => {
  it('区间内原值返回', () => {
    expect(clampColWidth(500, 320, 720, 480)).toBe(500);
  });
  it('越下限 → min；越上限 → max', () => {
    expect(clampColWidth(10, 320, 720, 480)).toBe(320);
    expect(clampColWidth(9999, 320, 720, 480)).toBe(720);
  });
  it('NaN / Infinity → fallback', () => {
    expect(clampColWidth(Number.NaN, 320, 720, 480)).toBe(480);
    expect(clampColWidth(Number.POSITIVE_INFINITY, 320, 720, 480)).toBe(480);
  });
});

describe('readColWidth / writeColWidth（localStorage 持久化）', () => {
  beforeEach(() => localStorage.clear());

  it('key 不存在 → default', () => {
    expect(readColWidth(KEY, 480, 320, 720)).toBe(480);
  });
  it('存有效值 → 原值', () => {
    writeColWidth(KEY, 600);
    expect(readColWidth(KEY, 480, 320, 720)).toBe(600);
  });
  it('存坏值（非数字）→ default', () => {
    localStorage.setItem(KEY, 'not-a-number');
    expect(readColWidth(KEY, 480, 320, 720)).toBe(480);
  });
  it('存越界值 → clamp 到区间', () => {
    writeColWidth(KEY, 5000);
    expect(readColWidth(KEY, 480, 320, 720)).toBe(720);
    writeColWidth(KEY, 1);
    expect(readColWidth(KEY, 480, 320, 720)).toBe(320);
  });
  it('storage 抛异常（隐私模式）→ default，不外抛', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readColWidth(KEY, 480, 320, 720)).toBe(480);
    spy.mockRestore();
    const spyW = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => writeColWidth(KEY, 500)).not.toThrow();
    spyW.mockRestore();
  });
  it('key 兼容：旧实现裸 setItem 写入的字符串数字可读回（迁移不丢用户宽度）', () => {
    // 模拟旧版本（use-resizable-col）直接写入的持久值
    localStorage.setItem(KEY, '640');
    expect(readColWidth(KEY, 480, 320, 720)).toBe(640);
  });
});

describe('usePersistentWidth（列宽 state hook）', () => {
  const opts = { storageKey: KEY, defaultWidth: 480, minWidth: 320, maxWidth: 720 };
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('初始宽取 localStorage 值（clamp 后）', () => {
    writeColWidth(KEY, 600);
    const { result } = renderHook(() => usePersistentWidth(opts));
    expect(result.current.width).toBe(600);
    expect(result.current.minWidth).toBe(320);
    expect(result.current.maxWidth).toBe(720);
  });

  it('无持久值 → 默认宽', () => {
    const { result } = renderHook(() => usePersistentWidth(opts));
    expect(result.current.width).toBe(480);
  });

  it('onResize 更新 state 且再次 clamp，但不写 localStorage', () => {
    const { result } = renderHook(() => usePersistentWidth(opts));
    act(() => result.current.onResize(9999));
    expect(result.current.width).toBe(720);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('onResizeEnd 持久化最新宽度', () => {
    const { result } = renderHook(() => usePersistentWidth(opts));
    act(() => result.current.onResize(550));
    act(() => result.current.onResizeEnd());
    expect(localStorage.getItem(KEY)).toBe('550');
    // 重新挂载读回持久值
    const second = renderHook(() => usePersistentWidth(opts));
    expect(second.result.current.width).toBe(550);
  });
});
