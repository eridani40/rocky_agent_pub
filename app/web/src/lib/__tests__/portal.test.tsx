// @vitest-environment jsdom
/**
 * Portal 单测（v0.0.135）
 * 参考: specs/ui/components/chat-page/_layering.md §3 Invariant A
 *
 * 覆盖：
 *   - children portaled 到 overlay-root（不在父容器内，在 body 下 overlay-root 内）
 *   - 透明无包装层（children 直接是 overlay-root 的子节点，无中间 div）
 *   - children=null 安全（不渲染任何东西）
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Portal } from '../portal';

describe('Portal（_layering.md §3A）', () => {
  beforeEach(() => {
    document.getElementById('overlay-root')?.remove();
    vi.resetModules();
    cleanup();
  });

  it('children 渲染到 overlay-root（不在父容器内）', async () => {
    const { getOverlayRoot } = await import('../overlay-root');
    const { container } = render(
      <Portal>
        <div>hello</div>
      </Portal>,
    );
    // 父容器为空（children 被 portal 走）
    expect(container.firstChild).toBeNull();
    // overlay-root 下有 children
    const root = getOverlayRoot()!;
    expect(root.querySelector('div')).not.toBeNull();
    expect(root.textContent).toContain('hello');
  });

  it('透明无包装层：children 直接是 overlay-root 子节点', async () => {
    const { getOverlayRoot } = await import('../overlay-root');
    render(
      <Portal>
        <div>hi</div>
      </Portal>,
    );
    const root = getOverlayRoot()!;
    // overlay-root 的第一个子节点就是 children 本体（非中间 wrapper div）
    expect(root.children.length).toBe(1);
    expect(root.firstElementChild?.textContent).toBe('hi');
  });

  it('children=null 安全：不渲染任何东西', async () => {
    const { container } = render(<Portal>{null}</Portal>);
    expect(container.firstChild).toBeNull();
  });
});
