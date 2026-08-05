/**
 * @vitest-environment jsdom
 * component-group-list-item 单测：渲染 + active 视觉 + 点击 onSelect
 * 参考: specs/ui/components/common/component-group-list-item.md
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentGroupListItem } from '../component-group-list-item';

describe('ComponentGroupListItem', () => {
  afterEach(() => cleanup());

  it('渲染 button 元素 + 文本为 groupId', () => {
    render(<ComponentGroupListItem groupId="appearance" active={false} onSelect={() => {}} />);
    const el = screen.getByRole('button', { name: 'appearance' });
    expect(el.textContent).toBe('appearance');
  });

  it('active=true → data-active=true + aria-current=true', () => {
    render(<ComponentGroupListItem groupId="g1" active={true} onSelect={() => {}} />);
    const el = screen.getByRole('button', { name: 'g1' });
    expect(el.getAttribute('data-active')).toBe('true');
    expect(el.getAttribute('aria-current')).toBe('true');
  });

  it('active=false → data-active=false + 无 aria-current', () => {
    render(<ComponentGroupListItem groupId="g1" active={false} onSelect={() => {}} />);
    const el = screen.getByRole('button', { name: 'g1' });
    expect(el.getAttribute('data-active')).toBe('false');
    expect(el.getAttribute('aria-current')).toBeNull();
  });

  it('点击 → onSelect 触发', () => {
    const onSelect = vi.fn();
    render(<ComponentGroupListItem groupId="g1" active={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'g1' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('多个 groupId 独立渲染（不同项不冲突）', () => {
    render(
      <>
        <ComponentGroupListItem groupId="g1" active={true} onSelect={() => {}} />
        <ComponentGroupListItem groupId="g2" active={false} onSelect={() => {}} />
      </>
    );
    expect(screen.getByRole('button', { name: 'g1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'g2' })).toBeTruthy();
  });
});
