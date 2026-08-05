/**
 * @vitest-environment jsdom
 * primitive-key-input 单测：受控值 + onChange + desc 副文本
 * 参考: specs/ui/components/framework/primitive-key-input.md
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { KeyInput } from '../key-input';

describe('KeyInput', () => {
  afterEach(() => cleanup());

  it('渲染受控 value 的文本输入框', () => {
    render(<KeyInput value="hello" onChange={() => {}} />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('hello');
    expect(input.tagName).toBe('INPUT');
    expect(input.type).toBe('text');
  });

  it('输入 → onChange 触发，参数为新值', () => {
    const onChange = vi.fn();
    render(<KeyInput value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'world' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('world');
  });

  it('desc 提供时渲染副文本', () => {
    render(<KeyInput value="" onChange={() => {}} desc="主题名称" />);
    expect(screen.getByText('主题名称')).toBeTruthy();
  });
});
