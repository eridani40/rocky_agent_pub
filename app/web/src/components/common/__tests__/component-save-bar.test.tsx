/**
 * @vitest-environment jsdom
 * component-save-bar 单测（v0.0.317 从 component-tab-save-bar 迁移 + variant prop）
 * 参考: specs/ui/components/app-dev-config-page/component-tab-save-bar.md
 *       specs/tech/version_logs/v0.0.317/change_plan.md D1
 *
 * 校验点：
 *   - status span 的 data-dirty 反映 dirty prop
 *   - dirty=false → 取消按钮 visibility:hidden（占位不位移）
 *   - dirty=true → 取消按钮可见
 *   - 点保存触发 onSave；点取消触发 onCancel
 *   - saving=true → 保存按钮禁用
 *   - variant='tab'（缺省）→ action-key = settings.tab.save/cancel
 *   - variant='detail' → action-key = settings.detail.save/cancel
 *   - TabSaveBar alias 向后兼容
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SaveBar, TabSaveBar } from '../component-save-bar';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('SaveBar — 基础功能（迁移自 TabSaveBar）', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('渲染 status + save + cancel', () => {
    const { container } = render(<SaveBar dirty={false} saving={false} onSave={() => {}} onCancel={() => {}} />);
    expect(container.querySelector('[data-dirty]')).toBeTruthy();
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
    expect(screen.getByText('取消').closest('button')).toBeTruthy();
  });

  it('data-dirty=false 当 dirty prop=false', () => {
    const { container } = render(<SaveBar dirty={false} saving={false} onSave={() => {}} onCancel={() => {}} />);
    expect(container.querySelector('[data-dirty]')!.getAttribute('data-dirty')).toBe('false');
  });

  it('data-dirty=true 当 dirty prop=true', () => {
    const { container } = render(<SaveBar dirty={true} saving={false} onSave={() => {}} onCancel={() => {}} />);
    expect(container.querySelector('[data-dirty]')!.getAttribute('data-dirty')).toBe('true');
  });

  it('dirty=false → 取消按钮 visibility:hidden（占位避免位移）', () => {
    render(<SaveBar dirty={false} saving={false} onSave={() => {}} onCancel={() => {}} />);
    const cancel = screen.getByText('取消').closest('button') as HTMLElement;
    expect(cancel.style.visibility).toBe('hidden');
  });

  it('dirty=true → 取消按钮 visibility:visible', () => {
    render(<SaveBar dirty={true} saving={false} onSave={() => {}} onCancel={() => {}} />);
    const cancel = screen.getByRole('button', { name: '取消' }) as HTMLElement;
    expect(cancel.style.visibility).toBe('visible');
  });

  it('点保存触发 onSave', () => {
    const onSave = vi.fn();
    render(<SaveBar dirty={true} saving={false} onSave={onSave} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '● 保存' }));
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('dirty=true 点取消触发 onCancel', () => {
    const onCancel = vi.fn();
    render(<SaveBar dirty={true} saving={false} onSave={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('saving=true → 保存按钮禁用', () => {
    render(<SaveBar dirty={true} saving={true} onSave={() => {}} onCancel={() => {}} />);
    const save = screen.getByRole('button', { name: '保存中…' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});

describe('SaveBar — variant prop（v0.0.317）', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it("variant 缺省 = 'tab' → action-key = settings.tab.save / settings.tab.cancel", () => {
    render(<SaveBar dirty={true} saving={false} onSave={() => {}} onCancel={() => {}} />);
    const saveBtn = screen.getByRole('button', { name: '● 保存' });
    const cancelBtn = screen.getByRole('button', { name: '取消' });
    expect(saveBtn.getAttribute('data-action-key')).toBe('settings.tab.save');
    expect(cancelBtn.getAttribute('data-action-key')).toBe('settings.tab.cancel');
  });

  it("variant='tab' 显式传 → action-key = settings.tab.save / settings.tab.cancel", () => {
    render(<SaveBar dirty={true} saving={false} onSave={() => {}} onCancel={() => {}} variant="tab" />);
    const saveBtn = screen.getByRole('button', { name: '● 保存' });
    const cancelBtn = screen.getByRole('button', { name: '取消' });
    expect(saveBtn.getAttribute('data-action-key')).toBe('settings.tab.save');
    expect(cancelBtn.getAttribute('data-action-key')).toBe('settings.tab.cancel');
  });

  it("variant='detail' → action-key = settings.detail.save / settings.detail.cancel", () => {
    render(<SaveBar dirty={true} saving={false} onSave={() => {}} onCancel={() => {}} variant="detail" />);
    const saveBtn = screen.getByRole('button', { name: '● 保存' });
    const cancelBtn = screen.getByRole('button', { name: '取消' });
    expect(saveBtn.getAttribute('data-action-key')).toBe('settings.detail.save');
    expect(cancelBtn.getAttribute('data-action-key')).toBe('settings.detail.cancel');
  });

  it('variant 不影响视觉/逻辑（dirty/saving/saved 全部正常）', () => {
    const { container } = render(
      <SaveBar dirty={true} saving={false} onSave={() => {}} onCancel={() => {}} variant="detail" />,
    );
    expect(container.querySelector('[data-dirty]')!.getAttribute('data-dirty')).toBe('true');
    const cancel = screen.getByRole('button', { name: '取消' }) as HTMLElement;
    expect(cancel.style.visibility).toBe('visible');
  });
});

describe('SaveBar — TabSaveBar alias 向后兼容', () => {
  afterEach(() => cleanup());

  it('TabSaveBar alias 渲染正常（与 SaveBar 等价）', () => {
    const { container } = render(
      <TabSaveBar dirty={true} saving={false} onSave={() => {}} onCancel={() => {}} />,
    );
    expect(container.querySelector('[data-dirty]')!.getAttribute('data-dirty')).toBe('true');
    expect(screen.getByRole('button', { name: '● 保存' })).toBeTruthy();
  });
});
