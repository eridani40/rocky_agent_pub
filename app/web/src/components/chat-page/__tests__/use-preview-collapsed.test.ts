// @vitest-environment jsdom
/**
 * use-preview-collapsed 门三态 hook 单测（v0.0.329 D1）
 * 参考: specs/tech/version_logs/v0.0.329/change_plan.md D1（三态 hook 契约）
 *       specs/prd/version_logs/v0.0.329-region23-door.md §3.5（持久化）/§10（迁移授权）
 *
 * 覆盖：三态读写 + pv-door-<sid> 持久化 + 旧 pv-collapsed 迁移 + setCollapsed 桥接。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePreviewCollapsed, readPvDoor, writePvDoor, type DoorState } from '../use-preview-collapsed';

describe('readPvDoor / writePvDoor（v0.0.329 D1 持久化）', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('缺省（无任何 key）→ center', () => {
    expect(readPvDoor('s1')).toBe('center');
  });

  it('写 pv-door-<sid> → 读回同值（三态各自）', () => {
    for (const v of ['center', 'left', 'right'] as DoorState[]) {
      writePvDoor('s1', v);
      expect(readPvDoor('s1')).toBe(v);
    }
  });

  it('per-session 隔离：s1 与 s2 互不影响', () => {
    writePvDoor('s1', 'left');
    expect(readPvDoor('s1')).toBe('left');
    expect(readPvDoor('s2')).toBe('center');
  });

  it('坏值兜底 center（如 "abc" / "1" / 空串）', () => {
    localStorage.setItem('pv-door-s1', 'abc');
    expect(readPvDoor('s1')).toBe('center');
    localStorage.setItem('pv-door-s1', '');
    expect(readPvDoor('s1')).toBe('center');
  });

  it('迁移：无 pv-door 时旧 pv-collapsed="1" → right（用户无感）', () => {
    localStorage.setItem('pv-collapsed-s1', '1');
    expect(readPvDoor('s1')).toBe('right');
  });

  it('迁移：无 pv-door 时旧 pv-collapsed="0" → center', () => {
    localStorage.setItem('pv-collapsed-s1', '0');
    expect(readPvDoor('s1')).toBe('center');
  });

  it('迁移优先：已有 pv-door 时旧 pv-collapsed 不影响', () => {
    localStorage.setItem('pv-door-s1', 'left');
    localStorage.setItem('pv-collapsed-s1', '1');
    expect(readPvDoor('s1')).toBe('left');
  });

  it('writePvDoor 同步写旧 pv-collapsed（door!==center → "1"）保旧消费方兼容', () => {
    writePvDoor('s1', 'right');
    expect(localStorage.getItem('pv-collapsed-s1')).toBe('1');
    writePvDoor('s1', 'center');
    expect(localStorage.getItem('pv-collapsed-s1')).toBe('0');
    writePvDoor('s1', 'left');
    expect(localStorage.getItem('pv-collapsed-s1')).toBe('1');
  });
});

describe('usePreviewCollapsed（v0.0.329 D1 hook）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('初始 door=center、collapsed 派生=false', () => {
    const { result } = renderHook(() => usePreviewCollapsed('s1'));
    expect(result.current.door).toBe('center');
    expect(result.current.collapsed).toBe(false);
  });

  it('setDoor("right") → collapsed=true（派生）、写 pv-door + 旧 pv-collapsed="1"', () => {
    const { result } = renderHook(() => usePreviewCollapsed('s1'));
    act(() => result.current.setDoor('right'));
    expect(result.current.door).toBe('right');
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem('pv-door-s1')).toBe('right');
    expect(localStorage.getItem('pv-collapsed-s1')).toBe('1');
  });

  it('setDoor("left") → collapsed=true（派生）、写 pv-door="left"', () => {
    const { result } = renderHook(() => usePreviewCollapsed('s1'));
    act(() => result.current.setDoor('left'));
    expect(result.current.door).toBe('left');
    expect(result.current.collapsed).toBe(true);
    expect(localStorage.getItem('pv-door-s1')).toBe('left');
  });

  it('setDoor("center") → collapsed=false、写 pv-door="center" + 旧 key "0"', () => {
    const { result } = renderHook(() => usePreviewCollapsed('s1'));
    act(() => result.current.setDoor('right'));
    act(() => result.current.setDoor('center'));
    expect(result.current.door).toBe('center');
    expect(result.current.collapsed).toBe(false);
    expect(localStorage.getItem('pv-door-s1')).toBe('center');
    expect(localStorage.getItem('pv-collapsed-s1')).toBe('0');
  });

  it('旧签名桥接：setCollapsed(true) → door=right；setCollapsed(false) → door=center', () => {
    const { result } = renderHook(() => usePreviewCollapsed('s1'));
    act(() => result.current.setCollapsed(true));
    expect(result.current.door).toBe('right');
    act(() => result.current.setCollapsed(false));
    expect(result.current.door).toBe('center');
  });

  it('初始从 localStorage 恢复（pv-door 优先；旧 pv-collapsed 迁移）', () => {
    localStorage.setItem('pv-door-s1', 'left');
    const { result } = renderHook(() => usePreviewCollapsed('s1'));
    expect(result.current.door).toBe('left');
    expect(result.current.collapsed).toBe(true);

    // 新 session：旧 collapsed="1" 迁移为 right
    localStorage.setItem('pv-collapsed-s2', '1');
    const { result: r2 } = renderHook(() => usePreviewCollapsed('s2'));
    expect(r2.current.door).toBe('right');
    expect(r2.current.collapsed).toBe(true);
  });

  it('per-session 隔离：setDoor 只写当前 sid', () => {
    const { result } = renderHook(() => usePreviewCollapsed('s1'));
    act(() => result.current.setDoor('left'));
    expect(localStorage.getItem('pv-door-s1')).toBe('left');
    expect(localStorage.getItem('pv-door-s2')).toBeNull();
  });

  it('[329 blocking] sessionId 变化 → 重读新会话持久化门态（root 空串挂载 → 点进会话恢复 left）', () => {
    // 模拟：root 挂载 sid='' 固化为 center；s1 持久化为 left
    localStorage.setItem('pv-door-s1', 'left');
    const { result, rerender } = renderHook(({ sid }) => usePreviewCollapsed(sid), {
      initialProps: { sid: '' },
    });
    expect(result.current.door).toBe('center');
    // 点进会话 → sid 变化 → effect 重读 pv-door-s1=left
    rerender({ sid: 's1' });
    expect(result.current.door).toBe('left');
    expect(result.current.collapsed).toBe(true);
  });

  it('[329 blocking] sessionId 变化 → 各会话独立恢复各自门态（s1=left / s2=right 互不串扰）', () => {
    localStorage.setItem('pv-door-s1', 'left');
    localStorage.setItem('pv-door-s2', 'right');
    const { result, rerender } = renderHook(({ sid }) => usePreviewCollapsed(sid), {
      initialProps: { sid: 's1' },
    });
    expect(result.current.door).toBe('left');
    rerender({ sid: 's2' });
    expect(result.current.door).toBe('right');
    expect(result.current.collapsed).toBe(true);
    // 切回 s1 仍恢复 left
    rerender({ sid: 's1' });
    expect(result.current.door).toBe('left');
  });

  it('[329 blocking] sessionId 变化重读后 setDoor 写新会话 key（不污染旧会话）', () => {
    localStorage.setItem('pv-door-s1', 'left');
    const { result, rerender } = renderHook(({ sid }) => usePreviewCollapsed(sid), {
      initialProps: { sid: 's1' },
    });
    rerender({ sid: 's2' });
    act(() => result.current.setDoor('center'));
    expect(localStorage.getItem('pv-door-s2')).toBe('center');
    expect(localStorage.getItem('pv-door-s1')).toBe('left');
  });

  it('[329 blocking] 刷新恢复：pv-door=left 重新挂载 hook 恢复 left（PRD §3.5 验收 9）', () => {
    // 模拟刷新：先写 left，再全新挂载（同页面重载语义）
    localStorage.setItem('pv-door-s1', 'left');
    const { result, unmount } = renderHook(() => usePreviewCollapsed('s1'));
    expect(result.current.door).toBe('left');
    unmount();
    // 刷新 = 重新挂载，仍从 localStorage 恢复 left
    const { result: r2 } = renderHook(() => usePreviewCollapsed('s1'));
    expect(r2.current.door).toBe('left');
    expect(r2.current.collapsed).toBe(true);
  });
});
