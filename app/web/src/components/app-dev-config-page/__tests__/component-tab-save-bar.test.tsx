/**
 * @vitest-environment jsdom
 * component-tab-save-bar 单测（v0.0.89 新增）
 * 参考: specs/ui/components/app-dev-config-page/component-tab-save-bar.md
 *
 * 校验点：
 *   - status span 的 data-dirty 反映 dirty prop
 *   - dirty=false → 取消按钮 visibility:hidden（占位不位移）
 *   - dirty=true → 取消按钮可见
 *   - 点保存触发 onSave；点取消触发 onCancel
 *   - saving=true → 保存按钮禁用
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TabSaveBar } from '../component-tab-save-bar';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('TabSaveBar', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('渲染 status + save + cancel', () => {
    const { container } = render(<TabSaveBar dirty={false} saving={false} onSave={() => {}} onCancel={() => {}} />);
    expect(container.querySelector('[data-dirty]')).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
    // dirty=false 时取消按钮 visibility:hidden（accessible name 被剥离，按文案定位）
    expect(screen.getByText('取消').closest('button')).toBeTruthy();
  });

  it('data-dirty=false 当 dirty prop=false', () => {
    const { container } = render(<TabSaveBar dirty={false} saving={false} onSave={() => {}} onCancel={() => {}} />);
    expect(container.querySelector('[data-dirty]')!.getAttribute('data-dirty')).toBe('false');
  });

  it('data-dirty=true 当 dirty prop=true', () => {
    const { container } = render(<TabSaveBar dirty={true} saving={false} onSave={() => {}} onCancel={() => {}} />);
    expect(container.querySelector('[data-dirty]')!.getAttribute('data-dirty')).toBe('true');
  });

  it('dirty=false → 取消按钮 visibility:hidden（占位避免位移）', () => {
    render(<TabSaveBar dirty={false} saving={false} onSave={() => {}} onCancel={() => {}} />);
    const cancel = screen.getByText('取消').closest('button') as HTMLElement;
    expect(cancel.style.visibility).toBe('hidden');
  });

  it('dirty=true → 取消按钮 visibility:visible', () => {
    render(<TabSaveBar dirty={true} saving={false} onSave={() => {}} onCancel={() => {}} />);
    const cancel = screen.getByRole('button', { name: '取消' }) as HTMLElement;
    expect(cancel.style.visibility).toBe('visible');
  });

  it('点保存触发 onSave', () => {
    const onSave = vi.fn();
    render(<TabSaveBar dirty={true} saving={false} onSave={onSave} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '● 保存' }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('dirty=true 点取消触发 onCancel', () => {
    const onCancel = vi.fn();
    render(<TabSaveBar dirty={true} saving={false} onSave={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('saving=true → 保存按钮禁用', () => {
    render(<TabSaveBar dirty={true} saving={true} onSave={() => {}} onCancel={() => {}} />);
    const save = screen.getByRole('button', { name: '保存中…' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});
