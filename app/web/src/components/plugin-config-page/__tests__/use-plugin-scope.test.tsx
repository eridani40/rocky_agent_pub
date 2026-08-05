/**
 * @vitest-environment jsdom
 * use-plugin-scope hook 单测（v0.0.67 起仅读路径，v0.0.71 D3 嵌套数据源）
 * 参考: reqs/[working] v0.0.67.plugin_config_refactor/design.md §3 D4（写端点删，配置只读化）
 *       specs/tech/version_logs/v0.0.71/change_plan.md 模块 9（嵌套 groups[].points[].activated）
 *
 * v0.0.67 重构后核心覆盖：
 *   - currentScopeId 默认 'default'
 *   - handleSelectScope → setCurrentScopeId + refreshInventory（GET ?scopeId）—— 唯一保留下来的 handler
 *   - activatedPoints 从 v0.0.71 嵌套结构 inv.groups[].points[].activated 聚合（不再走 extImpls[].pointActivated）
 *   - scopeItems 从 inv.scopes 映射（scopeId → id）
 *
 * 实现注意：用 vi.spyOn 而非 vi.mock（vi.mock 在并发跑测试时被其他文件预加载的原始模块缓存绕过，
 * 导致 mock 不生效；spyOn 在本文件内可靠隔离）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as apiClient from '../../../lib/api-client';
import { usePluginScope } from '../use-plugin-scope';
import type { PluginInventory } from '../../../lib/api-client';

const baseInv: PluginInventory = {
  plugins: [],
  groups: [
    {
      groupId: 'g1',
      points: [
        {
          pointId: 'ep_a',
          activated: false,
          impls: [
            { pluginId: 'p1', pointId: 'ep_a', implId: 'i1', type: 'exclusive', enabled: true, pluginEnabled: true },
          ],
        },
        {
          pointId: 'ep_b',
          activated: true,
          impls: [
            { pluginId: 'p2', pointId: 'ep_b', implId: 'i2', type: 'list', enabled: true, pluginEnabled: true },
          ],
        },
      ],
    },
  ],
  scopes: [
    { scopeId: 'default', name: 'Default', createdAt: '' },
    { scopeId: 'custom', name: '快速对话', createdAt: '2026-06-27T00:00:00Z' },
  ],
};

/** 安装 spy 并返回（类型由实现推断，避免显式签名不兼容 vi.spyOn 泛型） */
function setupSpies() {
  return {
    getInventory: vi.spyOn(apiClient, 'getPluginInventory').mockResolvedValue(baseInv),
  };
}

describe('usePluginScope hook — v0.0.67 起仅读路径', () => {
  let spies: ReturnType<typeof setupSpies>;

  beforeEach(() => {
    spies = setupSpies();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('默认 currentScopeId = "default"；activatedPoints 聚合 points[].activated；scopeItems 映射 scopeId→id', () => {
    const setInv = vi.fn();
    const setError = vi.fn();
    const { result } = renderHook(() => usePluginScope({ inv: baseInv, setInv, setError }));
    expect(result.current.currentScopeId).toBe('default');
    expect(result.current.activatedPoints.has('ep_a')).toBe(false);
    expect(result.current.activatedPoints.has('ep_b')).toBe(true);
    expect(result.current.scopeItems).toEqual([
      { id: 'default', name: 'Default', description: undefined },
      { id: 'custom', name: '快速对话', description: undefined },
    ]);
  });

  it('handleSelectScope → setCurrentScopeId + getPluginInventory(scopeId)', async () => {
    const setInv = vi.fn();
    const setError = vi.fn();
    const { result } = renderHook(() => usePluginScope({ inv: baseInv, setInv, setError }));
    await act(async () => {
      result.current.handleSelectScope('custom');
    });
    expect(result.current.currentScopeId).toBe('custom');
    expect(spies.getInventory).toHaveBeenCalledWith('custom');
    expect(setInv).toHaveBeenCalledWith(baseInv);
  });

  it('[v0.0.71 D3] 兜底：旧 inventory 无 points[] 字段 → activatedPoints 空集合（不再视作全激活）', () => {
    // 嵌套结构改型后，「缺 points[]」视为无激活信息（空集合）。
    // 与旧 pointActivated fallback 语义不同（旧版视全激活），新版需后端必返 points[]。
    const legacyInv: PluginInventory = {
      plugins: [],
      // 强制类型断言以模拟旧版无 points[] 形状（运行时 group.points = undefined）
      groups: [{ groupId: 'g', points: undefined } as unknown as PluginInventory['groups'][number]],
    };
    const { result } = renderHook(() => usePluginScope({ inv: legacyInv, setInv: vi.fn(), setError: vi.fn() }));
    expect(result.current.activatedPoints.size).toBe(0);
  });
});
