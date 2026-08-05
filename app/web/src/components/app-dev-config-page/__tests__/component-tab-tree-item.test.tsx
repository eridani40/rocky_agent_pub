/**
 * @vitest-environment jsdom
 * component-tab-tree-item 单测（v0.0.89 新增）
 * 参考: specs/ui/components/app-dev-config-page/component-tab-tree-item.md
 *
 * 校验点：
 *   - data-active 反映 active prop（true/false）
 *   - 点击触发 onSelect（受控）
 *   - label 正确渲染
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TabTreeItem } from '../component-tab-tree-item';

describe('TabTreeItem', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('渲染 label 按钮', () => {
    render(<TabTreeItem tabId="general" label="通用" active={true} onSelect={() => {}} />);
    const btn = screen.getByRole('button', { name: '通用' });
    expect(btn.textContent).toContain('通用');
  });

  it('data-active=true 当 active prop=true', () => {
    render(<TabTreeItem tabId="models" label="模型" active={true} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: '模型' }).getAttribute('data-active')).toBe('true');
  });

  it('data-active=false 当 active prop=false', () => {
    render(<TabTreeItem tabId="tools" label="工具" active={false} onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: '工具' }).getAttribute('data-active')).toBe('false');
  });

  it('点击触发 onSelect', () => {
    const onSelect = vi.fn();
    render(<TabTreeItem tabId="memory" label="记忆" active={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: '记忆' }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
});
