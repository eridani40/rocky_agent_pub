/**
 * @vitest-environment jsdom
 * primitive-key-boolean 单测：受控值 + 翻转 + 复用 ToggleSwitch
 * 参考: specs/ui/components/framework/primitive-key-boolean.md
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { KeyBoolean } from '../key-boolean';

describe('KeyBoolean', () => {
  afterEach(() => cleanup());

  it('渲染 role=switch（内部 ToggleSwitch）', () => {
    render(<KeyBoolean value={false} onChange={() => {}} />);
    const el = screen.getByRole('switch');
    expect(el.getAttribute('aria-checked')).toBe('false');
  });

  it('点击 → onChange(!value)：从 false 翻为 true', () => {
    const onChange = vi.fn();
    render(<KeyBoolean value={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('点击 → onChange(!value)：从 true 翻为 false', () => {
    const onChange = vi.fn();
    render(<KeyBoolean value={true} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('desc 提供时渲染副文本', () => {
    render(<KeyBoolean value={false} onChange={() => {}} desc="启用某特性" />);
    expect(screen.getByText('启用某特性')).toBeTruthy();
  });
});
