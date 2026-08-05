/**
 * @vitest-environment jsdom
 * section-group-list 单测：渲染容器 + 逐项 + 选中高亮 + onSelect 转发
 * 参考: specs/ui/components/common/section-group-list.md
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SectionGroupList } from '../section-group-list';

describe('SectionGroupList', () => {
  afterEach(() => cleanup());

  const groups = [{ groupId: 'appearance' }, { groupId: 'llm_request' }, { groupId: 'providers' }];

  it('渲染容器 + 每项 button（文本为 groupId）', () => {
    const { container } = render(<SectionGroupList groups={groups} selected="appearance" onSelect={() => {}} />);
    expect(container.firstElementChild).toBeTruthy();
    expect(screen.getByRole('button', { name: 'appearance' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'llm_request' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'providers' })).toBeTruthy();
  });

  it('选中项 data-active=true，其余 false', () => {
    render(<SectionGroupList groups={groups} selected="llm_request" onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: 'appearance' }).getAttribute('data-active')).toBe('false');
    expect(screen.getByRole('button', { name: 'llm_request' }).getAttribute('data-active')).toBe('true');
    expect(screen.getByRole('button', { name: 'providers' }).getAttribute('data-active')).toBe('false');
  });

  it('点击某项 → onSelect(groupId) 触发', () => {
    const onSelect = vi.fn();
    render(<SectionGroupList groups={groups} selected="appearance" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'providers' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('providers');
  });

  it('空 groups 时容器仍渲染（无子项）', () => {
    const { container } = render(<SectionGroupList groups={[]} selected="" onSelect={() => {}} />);
    expect(container.firstElementChild).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
