/**
 * @vitest-environment jsdom
 * component-scope-switcher 单测（v0.0.67 只读化）
 * 参考: specs/ui/components/plugin-config-page/component-scope-switcher.md
 *
 * 核心覆盖（v0.0.67）：
 *   - dropdown 切换 scope 功能保留（只读查看不同 scope 配置）
 *   - 无「+ 新建 scope」入口（scope 代码声明，不可运行时创建）
 *   - 非 default 项无删除 icon（scope 代码声明，不可运行时删除）
 *   - 布局稳定性（dropdown absolute 定位）
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ComponentScopeSwitcher } from '../component-scope-switcher';
import { initI18n } from '../../../i18n';

// 启动 i18next instance
beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('ComponentScopeSwitcher（v0.0.67 只读：保留切换，删创建/删除）', () => {
  afterEach(() => cleanup());

  const scopes = [
    { id: 'default', name: 'Default', description: '默认基线 scope' },
    { id: 'custom', name: '快速对话' },
  ];

  it('渲染当前 scope name 按钮', () => {
    render(
      <ComponentScopeSwitcher
        scopes={scopes}
        currentScopeId="default"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Default' }).textContent).toBe('Default');
  });

  it('点 current 展开 dropdown，列所有 scope 项（含 default badge）', () => {
    render(
      <ComponentScopeSwitcher
        scopes={scopes}
        currentScopeId="default"
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    const listbox = screen.getByRole('listbox');
    expect(listbox).toBeTruthy();
    const options = within(listbox).getAllByRole('option');
    expect(options).toHaveLength(2);
    // default 项含「基线」badge
    expect(within(listbox).getByText('基线')).toBeTruthy();
  });

  it('[v0.0.67] dropdown 内无任何按钮（无删除 icon、无新建入口）', () => {
    render(
      <ComponentScopeSwitcher
        scopes={scopes}
        currentScopeId="default"
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    const listbox = screen.getByRole('listbox');
    // scope 代码声明不可删/不可创建 → dropdown 内只有 option，无 button
    expect(within(listbox).queryAllByRole('button')).toHaveLength(0);
    expect(within(listbox).queryByText(/新建/)).toBeNull();
  });

  it('点 dropdown 项 → onSelect(scopeId) 触发（只读切换查看 scope 配置）', () => {
    const onSelect = vi.fn();
    render(
      <ComponentScopeSwitcher
        scopes={scopes}
        currentScopeId="default"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    fireEvent.click(screen.getByRole('option', { name: '快速对话' }));
    expect(onSelect).toHaveBeenCalledWith('custom');
  });

  it('布局稳定性：dropdown 用 absolute 定位（className 含 absolute）', () => {
    render(
      <ComponentScopeSwitcher
        scopes={scopes}
        currentScopeId="default"
        onSelect={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Default' }));
    const dropdown = screen.getByRole('listbox');
    // absolute 定位是布局稳定性 MANDATORY 的关键（脱离常规流，不挤压下方 EP 区）
    expect(dropdown.className).toContain('absolute');
  });
});
