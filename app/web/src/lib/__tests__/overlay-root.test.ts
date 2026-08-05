// @vitest-environment jsdom
/**
 * overlay-root 单测（v0.0.135）
 * 参考: specs/ui/components/chat-page/_layering.md §3 Invariant A
 *
 * 覆盖：
 *   - idempotent：重复调用返回同一节点，不重复创建
 *   - 懒创建：调用前 document.body 无 #overlay-root；首次调用后挂 body 下
 *   - 容器样式：position/pointer-events/z-index 透明容器契约
 *   - 复用既有节点：热更新/重复挂载场景不重建
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getOverlayRoot } from '../overlay-root';

describe('getOverlayRoot（_layering.md §3A）', () => {
  beforeEach(() => {
    // 清理：缓存 + DOM 节点都重置，测 idempotent 不靠前次副作用
    document.getElementById('overlay-root')?.remove();
    // 重置模块缓存（cachedRoot 私有变量）——通过 vi.resetModules + 重新 import 实现
    vi.resetModules();
  });

  it('首次调用懒创建 #overlay-root 挂 body 下', async () => {
    const { getOverlayRoot } = await import('../overlay-root');
    expect(document.getElementById('overlay-root')).toBeNull();
    const root = getOverlayRoot();
    expect(root).not.toBeNull();
    expect(root!.id).toBe('overlay-root');
    expect(document.body.contains(root)).toBe(true);
  });

  it('idempotent：重复调用返回同一节点', async () => {
    const { getOverlayRoot } = await import('../overlay-root');
    const a = getOverlayRoot();
    const b = getOverlayRoot();
    const c = getOverlayRoot();
    expect(a).toBe(b);
    expect(b).toBe(c);
    // document.body 下仅一个 #overlay-root（不重复创建）
    expect(document.querySelectorAll('#overlay-root').length).toBe(1);
  });

  it('复用既有节点：外部预创建则不重建', async () => {
    // 模拟热更新残留：DOM 上已有 #overlay-root
    const pre = document.createElement('div');
    pre.id = 'overlay-root';
    document.body.appendChild(pre);
    const { getOverlayRoot } = await import('../overlay-root');
    const got = getOverlayRoot();
    expect(got).toBe(pre);
    // 没有新建第二个
    expect(document.querySelectorAll('#overlay-root').length).toBe(1);
  });

  it('容器透明契约：absolute/pointer-events:none/z=var(--z-modal)', async () => {
    const { getOverlayRoot } = await import('../overlay-root');
    const root = getOverlayRoot()!;
    expect(root.style.position).toBe('absolute');
    // jsdom 读回 .style.top 归一化为 '0px'（赋值时写 '0'，DOM 序列化补单位）
    expect(root.style.top).toBe('0px');
    expect(root.style.left).toBe('0px');
    expect(root.style.width).toBe('100%');
    expect(root.style.height).toBe('100%');
    expect(root.style.pointerEvents).toBe('none');
    expect(root.style.zIndex).toBe('var(--z-modal)');
  });
});
