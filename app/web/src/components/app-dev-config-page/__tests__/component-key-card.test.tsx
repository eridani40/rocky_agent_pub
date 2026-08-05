/**
 * @vitest-environment jsdom
 * component-key-card 单测：按 key.type 路由 primitive 控件 + onChange 上抛
 * 参考: specs/ui/components/app-dev-config-page/component-key-card.md
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentKeyCard, type KeyInfo } from '../component-key-card';

describe('ComponentKeyCard', () => {
  afterEach(() => cleanup());

  it('渲染卡片 label', () => {
    const ki: KeyInfo = { key: 'theme', type: 'enum', value: 'dark', options: ['dark', 'light'] };
    render(<ComponentKeyCard keyInfo={ki} onChange={() => {}} />);
    expect(screen.getByText('theme').textContent).toBe('theme');
  });

  it('type=string → 渲染文本输入框，输入触发 onChange', () => {
    const ki: KeyInfo = { key: 'name', type: 'string', value: 'abc' };
    const onChange = vi.fn();
    render(<ComponentKeyCard keyInfo={ki} onChange={onChange} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('abc');
    fireEvent.change(input, { target: { value: 'xyz' } });
    expect(onChange).toHaveBeenCalledWith('xyz');
  });

  it('type=number → 渲染数字输入框，输入数字触发 onChange(number)，空串上抛空串', () => {
    const ki: KeyInfo = { key: 'stall_timeout_s', type: 'number', value: 30 };
    const onChange = vi.fn();
    render(<ComponentKeyCard keyInfo={ki} onChange={onChange} />);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(String(input.value)).toBe('30');
    fireEvent.change(input, { target: { value: '45' } });
    expect(onChange).toHaveBeenCalledWith(45);
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith('');
  });

  it('type=enum → 渲染选项卡片组，点卡片触发 onChange', () => {
    const ki: KeyInfo = { key: 'theme', type: 'enum', value: 'dark', options: ['dark', 'light'] };
    const onChange = vi.fn();
    render(<ComponentKeyCard keyInfo={ki} onChange={onChange} />);
    // 当前选中卡（dark）aria-pressed
    expect(screen.getByRole('button', { name: 'dark' }).getAttribute('aria-pressed')).toBe('true');
    // 点 light 卡 → 上抛 'light'
    fireEvent.click(screen.getByRole('button', { name: 'light' }));
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('type=boolean → 渲染开关，点开关翻转触发 onChange', () => {
    const ki: KeyInfo = { key: 'enabled', type: 'boolean', value: false };
    const onChange = vi.fn();
    render(<ComponentKeyCard keyInfo={ki} onChange={onChange} />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('desc 存在时渲染说明文本', () => {
    const ki: KeyInfo = { key: 'x', type: 'string', value: '', desc: '说明文本' };
    render(<ComponentKeyCard keyInfo={ki} onChange={() => {}} />);
    expect(screen.getByText('说明文本')).toBeTruthy();
  });
});
