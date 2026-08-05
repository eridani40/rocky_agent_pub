/**
 * @vitest-environment jsdom
 * ChatTopbarBackBtn 单测 —— 共享 chat-topbar 返回按钮 primitive
 * 参考: specs/ui/components/chat-page/component-chat-topbar-back-btn.md
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { ChatTopbarBackBtn } from '../component-chat-topbar-back-btn';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

describe('ChatTopbarBackBtn', () => {
  it('渲染 ChevronLeftIcon + 中文文案「返回」', () => {
    render(<ChatTopbarBackBtn onClick={() => {}} />);
    const btn = screen.getByRole('button', { name: /返回/ });
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('返回');
    // ChevronLeftIcon svg 内联（stroke=currentColor）
    expect(btn.querySelector('svg')).toBeTruthy();
  });

  it('onClick 触发 → 回调收到调用', () => {
    const onClick = vi.fn();
    render(<ChatTopbarBackBtn onClick={onClick} />);
    fireEvent.click(screen.getByRole('button', { name: /返回/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('ghost 型样式：h-8 px-2 rounded-md + hover 类', () => {
    render(<ChatTopbarBackBtn onClick={() => {}} />);
    const btn = screen.getByRole('button', { name: /返回/ });
    expect(btn.className).toContain('h-8');
    expect(btn.className).toContain('px-2');
    expect(btn.className).toContain('rounded-md');
    expect(btn.className).toContain('hover:bg-bg-warm');
    expect(btn.className).toContain('text-muted-2');
  });
});
