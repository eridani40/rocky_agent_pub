/**
 * @vitest-environment jsdom
 * component-abort-btn 单测（圆环+方框视觉 + sessionState 减速）
 * 参考: specs/ui/components/chat-page/_overview.md §4.11b（圆环+方框视觉）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.7（两层状态 UI）
 *
 * 覆盖：
 *   - sessionState 默认 'running' / 传 'interrupting' → data-session-state + animation-duration 切换
 *   - 圆环视觉：外圈旋转环（border + animate-spin）+ 中心实心方框（stop icon）
 *   - 防连点本地态（点击后 disabled）
 *   - onAbort 回调
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentAbortBtn } from '../component-abort-btn';

afterEach(() => cleanup());

describe('component-abort-btn 圆环+方框视觉', () => {
  it('不传 sessionState → 默认 running（data-session-state=running）', () => {
    render(<ComponentAbortBtn sessionId="s1" onAbort={() => {}} />);
    const btn = screen.getByRole('button', { name: 'abort.ariaLabel' });
    expect(btn.getAttribute('data-session-state')).toBe('running');
  });

  it('sessionState=running → animation-duration=1s（正常速度）', () => {
    render(<ComponentAbortBtn sessionId="s1" sessionState="running" onAbort={() => {}} />);
    const btn = screen.getByRole('button', { name: 'abort.ariaLabel' });
    // 按钮自身 style.animationDuration（用于内部 disabled 态过渡）
    expect(btn.style.animationDuration).toBe('1s');
    // 外圈旋转环的 animationDuration（实际承载旋转动画的元素）
    const ring = btn.querySelector('span[aria-hidden="true"]');
    expect(ring).toBeTruthy();
    expect((ring as HTMLElement).style.animationDuration).toBe('1s');
  });

  it('sessionState=interrupting → animation-duration=2.5s（减速视觉反馈）', () => {
    render(<ComponentAbortBtn sessionId="s1" sessionState="interrupting" onAbort={() => {}} />);
    const btn = screen.getByRole('button', { name: 'abort.ariaLabel' });
    expect(btn.getAttribute('data-session-state')).toBe('interrupting');
    expect(btn.style.animationDuration).toBe('2.5s');
    const ring = btn.querySelector('span[aria-hidden="true"]');
    expect((ring as HTMLElement).style.animationDuration).toBe('2.5s');
  });

  it('圆环视觉：含外圈旋转环（border + animate-spin 类）', () => {
    render(<ComponentAbortBtn sessionId="s1" onAbort={() => {}} />);
    const btn = screen.getByRole('button', { name: 'abort.ariaLabel' });
    const ring = btn.querySelector('span[aria-hidden="true"]');
    expect(ring).toBeTruthy();
    expect(ring?.className).toContain('animate-spin');
    expect(ring?.className).toContain('rounded-full');
    expect(ring?.className).toContain('border-t-[var(--color-accent)]');
  });

  it('点击 → onAbort 收到 sessionId + 按钮立即 disabled（防连点）', () => {
    let aborted = '';
    render(<ComponentAbortBtn sessionId="s9" onAbort={(sid) => (aborted = sid)} />);
    const btn = screen.getByRole('button', { name: 'abort.ariaLabel' }) as HTMLButtonElement;
    fireEvent.click(btn);
    expect(aborted).toBe('s9');
    expect(btn.disabled).toBe(true);
  });

  it('disabled 后再点击 → 不触发 onAbort（防连点）', () => {
    let count = 0;
    render(<ComponentAbortBtn sessionId="s9" onAbort={() => count++} />);
    const btn = screen.getByRole('button', { name: 'abort.ariaLabel' }) as HTMLButtonElement;
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(count).toBe(1); // 只触发一次
  });
});
