/**
 * @vitest-environment jsdom
 * academy-col-widths 单测 —— ACADEMY_COL 三处 preset 契约锚点 + 旧 hook 存值兼容
 * 参考: specs/ui/components/academy-page/_overview.md §2（可拖宽列约定表）
 *
 * 覆盖：
 * - ACADEMY_COL 三处 preset 的 key / 默认 / 上下限（契约锚点，改动即断言失败提醒同步 spec）
 * - key 兼容：旧实现（use-resizable-col）持久化的值经 usePersistentWidth 读回（用户已存宽度不失效）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import { ACADEMY_COL } from '../academy-col-widths';
import { usePersistentWidth } from '../../common/use-persistent-width';

describe('ACADEMY_COL preset（契约锚点，改动须同步 spec _overview §2 表）', () => {
  it('班主任列 / 训练视图列 / 版本会话列表 三组常量', () => {
    expect(ACADEMY_COL.ht).toEqual({
      storageKey: 'academy-ht-col-width',
      defaultWidth: 480,
      minWidth: 320,
      maxWidth: 720,
    });
    expect(ACADEMY_COL.train).toEqual({
      storageKey: 'academy-train-col-width',
      defaultWidth: 520,
      minWidth: 380,
      maxWidth: 800,
    });
    expect(ACADEMY_COL.versionConv).toEqual({
      storageKey: 'academy-version-conv-width',
      defaultWidth: 240,
      minWidth: 180,
      maxWidth: 400,
    });
  });
});

describe('旧 hook 存值兼容（列宽收敛后 key 不变）', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('旧实现写入 academy-ht-col-width 的值被 usePersistentWidth(ACADEMY_COL.ht) 读回', () => {
    // 模拟旧版本 use-resizable-col 持久化的用户宽度
    localStorage.setItem('academy-ht-col-width', '600');
    const { result } = renderHook(() => usePersistentWidth(ACADEMY_COL.ht));
    expect(result.current.width).toBe(600);
  });
});
