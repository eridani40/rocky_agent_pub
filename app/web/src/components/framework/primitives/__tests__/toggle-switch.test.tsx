/**
 * @vitest-environment jsdom
 * primitive-toggle-switch 单测：受控值传递 + 点击翻转 + 无障碍属性
 * 参考: specs/ui/components/framework/primitive-toggle-switch.md
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ToggleSwitch } from '../toggle-switch';

describe('ToggleSwitch', () => {
  afterEach(() => cleanup());

  it('渲染 role=switch + aria-checked 反映 value', () => {
    const { rerender } = render(<ToggleSwitch value={false} onChange={() => {}} />);
    const el = screen.getByRole('switch');
    expect(el.getAttribute('aria-checked')).toBe('false');
    expect(el.getAttribute('data-enabled')).toBe('false');

    rerender(<ToggleSwitch value={true} onChange={() => {}} />);
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('switch').getAttribute('data-enabled')).toBe('true');
  });

  it('点击 → onChange(!value)：从 false 翻为 true', () => {
    const onChange = vi.fn();
    render(<ToggleSwitch value={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('点击 → onChange(!value)：从 true 翻为 false', () => {
    const onChange = vi.fn();
    render(<ToggleSwitch value={true} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('label 渲染为 aria-label', () => {
    render(<ToggleSwitch value={false} onChange={() => {}} label="启用 foo" />);
    const el = screen.getByRole('switch');
    expect(el.getAttribute('aria-label')).toBe('启用 foo');
  });

  it('受控：value 变化不自动触发 onChange（父级驱动）', () => {
    const onChange = vi.fn();
    const { rerender } = render(<ToggleSwitch value={false} onChange={onChange} />);
    rerender(<ToggleSwitch value={true} onChange={onChange} />);
    // 仅父级 rerender，不应自动回调
    expect(onChange).not.toHaveBeenCalled();
  });
});
