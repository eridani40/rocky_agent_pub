// @vitest-environment jsdom
/**
 * component-preview-floating-actions 单测（v0.0.323 胶囊容器改造）
 * 参考: specs/tech/version_logs/v0.0.323/change_plan.md
 *
 * 覆盖：
 *   - 容器：胶囊样式（rounded-xl border bg-surface p-1 shadow-sm）+ 常驻显示（无 opacity-0/group-hover）
 *   - 只读态：仅「编辑」按钮（title/aria-label=编辑）
 *   - 编辑态按钮顺序：保存 → 撤销 → 格式化（仅 structured）→ 校验（仅 structured）
 *   - 非 structured：无格式化/校验按钮（保存+撤销仍在）
 *   - 按钮样式：容器内风格（h-8 w-8 rounded-lg，无自带 border/bg-surface/shadow）；
 *     保存按钮保留主色调（bg-accent）+ saving 时 disabled + title=保存中…
 *   - 图标 size 统一 16；新图标 path（edit-2 / check-circle）
 *   - 点击回调透传（onEdit/onSave/onUndo/onFormat/onValidate）
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { ComponentPreviewFloatingActions, type FloatingActionsProps } from '../component-preview-floating-actions';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

function makeProps(overrides: Partial<FloatingActionsProps> = {}): FloatingActionsProps {
  return {
    mode: 'edit',
    saving: false,
    isStructured: true,
    isHtml: false,
    onEdit: vi.fn(),
    onSave: vi.fn(),
    onUndo: vi.fn(),
    onFormat: vi.fn(),
    onValidate: vi.fn(),
    onOpenInBrowser: vi.fn(),
    ...overrides,
  };
}

describe('胶囊容器', () => {
  it('带胶囊样式且常驻显示（无 opacity-0 / group-hover）', () => {
    render(<ComponentPreviewFloatingActions {...makeProps()} />);
    const box = screen.getByTestId('pv-floating-actions');
    expect(box.className).toContain('rounded-xl');
    expect(box.className).toContain('border-border');
    expect(box.className).toContain('bg-surface');
    expect(box.className).toContain('shadow-sm');
    expect(box.className).not.toContain('opacity-0');
    expect(box.className).not.toContain('group-hover');
  });
});

describe('只读态', () => {
  it('仅渲染「编辑」按钮（title + aria-label = 编辑）', () => {
    const props = makeProps({ mode: 'view' });
    render(<ComponentPreviewFloatingActions {...props} />);
    const btn = screen.getByTestId('pv-float-edit');
    expect(btn.getAttribute('title')).toBe('编辑');
    expect(btn.getAttribute('aria-label')).toBe('编辑');
    expect(screen.queryByTestId('pv-float-save')).toBeNull();
    expect(screen.queryByTestId('pv-float-undo')).toBeNull();
    fireEvent.click(btn);
    expect(props.onEdit).toHaveBeenCalledTimes(1);
  });

  it('[v0.0.325] isHtml=true → 第 2 位渲染「浏览器打开」按钮', () => {
    const props = makeProps({ mode: 'view', isHtml: true });
    render(<ComponentPreviewFloatingActions {...props} />);
    const btn = screen.getByTestId('pv-float-open-browser');
    expect(btn.getAttribute('title')).toBe('浏览器打开');
    expect(btn.getAttribute('aria-label')).toBe('浏览器打开');
    // 点击 → onOpenInBrowser 回调
    fireEvent.click(btn);
    expect(props.onOpenInBrowser).toHaveBeenCalledTimes(1);
  });

  it('[v0.0.325] isHtml=false → 不渲染浏览器按钮', () => {
    render(<ComponentPreviewFloatingActions {...makeProps({ mode: 'view', isHtml: false })} />);
    expect(screen.queryByTestId('pv-float-open-browser')).toBeNull();
  });

  it('[v0.0.325] 编辑态 isHtml=true → 不渲染浏览器按钮（仅 view 态）', () => {
    render(<ComponentPreviewFloatingActions {...makeProps({ mode: 'edit', isHtml: true })} />);
    expect(screen.queryByTestId('pv-float-open-browser')).toBeNull();
  });

  it('[v0.0.325] 只读态按钮顺序：编辑 → 浏览器打开（仅 isHtml）', () => {
    render(<ComponentPreviewFloatingActions {...makeProps({ mode: 'view', isHtml: true })} />);
    const box = screen.getByTestId('pv-floating-actions');
    const ids = Array.from(box.querySelectorAll('button')).map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual(['pv-float-edit', 'pv-float-open-browser']);
  });
});

describe('编辑态按钮顺序', () => {
  it('structured：保存 → 撤销 → 格式化 → 校验', () => {
    render(<ComponentPreviewFloatingActions {...makeProps()} />);
    const box = screen.getByTestId('pv-floating-actions');
    const ids = Array.from(box.querySelectorAll('button')).map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual(['pv-float-save', 'pv-float-undo', 'pv-float-format', 'pv-float-validate']);
  });

  it('非 structured：仅 保存 → 撤销（无格式化/校验）', () => {
    render(<ComponentPreviewFloatingActions {...makeProps({ isStructured: false })} />);
    const box = screen.getByTestId('pv-floating-actions');
    const ids = Array.from(box.querySelectorAll('button')).map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual(['pv-float-save', 'pv-float-undo']);
  });

  it('tooltip：保存/撤销/格式化/校验 title + aria-label 正确', () => {
    render(<ComponentPreviewFloatingActions {...makeProps()} />);
    expect(screen.getByTestId('pv-float-save').getAttribute('title')).toBe('保存');
    expect(screen.getByTestId('pv-float-undo').getAttribute('title')).toBe('撤销');
    expect(screen.getByTestId('pv-float-format').getAttribute('title')).toBe('格式化');
    expect(screen.getByTestId('pv-float-format').getAttribute('aria-label')).toBe('格式化');
    expect(screen.getByTestId('pv-float-validate').getAttribute('title')).toBe('校验');
    expect(screen.getByTestId('pv-float-validate').getAttribute('aria-label')).toBe('校验');
  });

  it('saving=true：保存按钮 disabled 且 title=保存中…', () => {
    render(<ComponentPreviewFloatingActions {...makeProps({ saving: true })} />);
    const btn = screen.getByTestId('pv-float-save') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('title')).toBe('保存中…');
  });

  it('回调透传：save/undo/format/validate', () => {
    const props = makeProps();
    render(<ComponentPreviewFloatingActions {...props} />);
    fireEvent.click(screen.getByTestId('pv-float-save'));
    fireEvent.click(screen.getByTestId('pv-float-undo'));
    fireEvent.click(screen.getByTestId('pv-float-format'));
    fireEvent.click(screen.getByTestId('pv-float-validate'));
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onUndo).toHaveBeenCalledTimes(1);
    expect(props.onFormat).toHaveBeenCalledTimes(1);
    expect(props.onValidate).toHaveBeenCalledTimes(1);
  });
});

describe('按钮样式与图标', () => {
  it('容器内风格：h-8 w-8 rounded-lg；按钮无自带 border/bg-surface/shadow', () => {
    render(<ComponentPreviewFloatingActions {...makeProps()} />);
    for (const id of ['pv-float-undo', 'pv-float-format', 'pv-float-validate']) {
      const cls = screen.getByTestId(id).className;
      expect(cls).toContain('h-8');
      expect(cls).toContain('w-8');
      expect(cls).toContain('rounded-lg');
      expect(cls).not.toContain('border-border');
      expect(cls).not.toContain('bg-surface');
      expect(cls).not.toContain('shadow-sm');
    }
  });

  it('保存按钮保留主色调 bg-accent', () => {
    render(<ComponentPreviewFloatingActions {...makeProps()} />);
    expect(screen.getByTestId('pv-float-save').className).toContain('bg-accent');
  });

  it('图标 size 统一 16', () => {
    render(<ComponentPreviewFloatingActions {...makeProps()} />);
    const box = screen.getByTestId('pv-floating-actions');
    for (const svg of Array.from(box.querySelectorAll('svg'))) {
      expect(svg.getAttribute('width')).toBe('16');
      expect(svg.getAttribute('height')).toBe('16');
    }
  });

  it('新图标 path：编辑=feather edit-2（方框笔）', () => {
    render(<ComponentPreviewFloatingActions {...makeProps({ mode: 'view' })} />);
    const svg = screen.getByTestId('pv-float-edit').querySelector('svg')!;
    expect(svg.innerHTML).toContain('M11 4H4a2 2 0 0 0-2 2v14');
    expect(svg.innerHTML).toContain('M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15');
  });

  it('新图标 path：校验=feather check-circle（圆勾）', () => {
    render(<ComponentPreviewFloatingActions {...makeProps()} />);
    const svg = screen.getByTestId('pv-float-validate').querySelector('svg')!;
    expect(svg.innerHTML).toContain('M22 11.08V12a10 10 0 1 1-5.93-9.14');
    expect(svg.innerHTML).toContain('M22 4L12 14.01l-3-3');
  });
});
