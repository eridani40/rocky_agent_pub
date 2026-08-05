/**
 * @vitest-environment jsdom
 * component-model-picker-trigger 单测（v0.0.165 新增）
 * 参考: specs/ui/components/common/component-model-picker-trigger.md
 *
 * 覆盖：
 *   - 渲染 button 元素 + type=button + chevron SVG（aria-haspopup）
 *   - value=null → 显 placeholder + text-muted，无 IconBox
 *   - value 有 providerId → 显 modelLabel + IconBox（22px，hueBy providerId）
 *   - value 无 providerId（降级）→ 显 modelLabel 无 IconBox
 *   - disabled=true → onClick 不触发；opacity-60 + cursor-not-allowed
 *   - size='sm'/'md' 高度切换
 *   - title / ariaLabel / ariaExpanded / className 透传
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ModelPickerTrigger } from '../component-model-picker-trigger';

describe('ModelPickerTrigger — 渲染基础', () => {
  it('渲染 button 元素 + chevron SVG', () => {
    render(<ModelPickerTrigger onClick={() => {}} placeholder="选择模型" />);
    const btn = screen.getByRole('button', { name: '选择模型' }) as HTMLButtonElement;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.type).toBe('button');
    // chevron SVG
    expect(btn.querySelector('svg')).toBeTruthy();
    cleanup();
  });

  it('容器视觉基线：h-8 (md 默认) + border-2 + bg-surface + rounded-md（regulation 02 §7）', () => {
    render(<ModelPickerTrigger onClick={() => {}} placeholder="p" />);
    const btn = screen.getByRole('button', { name: 'p' });
    expect(btn.className).toContain('h-8');
    expect(btn.className).toContain('border-border-2');
    expect(btn.className).toContain('bg-surface');
    expect(btn.className).toContain('rounded-md');
    cleanup();
  });
});

describe('ModelPickerTrigger — value 三态', () => {
  it('value=null → 显 placeholder，text-muted，无 IconBox', () => {
    render(<ModelPickerTrigger onClick={() => {}} placeholder="未配置" />);
    const btn = screen.getByRole('button', { name: '未配置' });
    expect(btn.textContent).toContain('未配置');
    expect(btn.className).toContain('text-muted');
    // 无 IconBox（无 data-hue 节点）
    expect(btn.querySelector('[data-hue]')).toBeNull();
    cleanup();
  });

  it('value 含 providerId → 显 modelLabel + IconBox（22px，data-hue 来自 hash）', () => {
    render(
      <ModelPickerTrigger
        onClick={() => {}}
        value={{ providerId: 'p1', modelId: 'gpt-4o', modelLabel: 'OpenAI / GPT-4o' }}
      />,
    );
    const btn = screen.getByRole('button', { name: 'OpenAI / GPT-4o' });
    expect(btn.textContent).toContain('OpenAI / GPT-4o');
    // text-fg（非 muted）
    expect(btn.className).toContain('text-fg');
    expect(btn.className).not.toContain('text-muted');
    // IconBox 存在
    const icon = btn.querySelector('[data-hue]') as HTMLElement;
    expect(icon).toBeTruthy();
    // 22px 尺寸
    expect(icon.className).toContain('h-[22px]');
    expect(icon.className).toContain('w-[22px]');
    // data-hue 由 hash 派生（8 色之一）
    const hue = icon.getAttribute('data-hue');
    expect(['rose', 'orange', 'amber', 'green', 'teal', 'blue', 'violet', 'pink']).toContain(hue);
    cleanup();
  });

  it('value 无 providerId（降级）→ 显 modelLabel 无 IconBox（providers 未加载/被删场景）', () => {
    render(
      <ModelPickerTrigger
        onClick={() => {}}
        value={{ providerId: '', modelId: 'glm-5.2', modelLabel: 'glm-5.2' }}
      />,
    );
    const btn = screen.getByRole('button', { name: 'glm-5.2' });
    expect(btn.textContent).toContain('glm-5.2');
    // 降级：无 IconBox
    expect(btn.querySelector('[data-hue]')).toBeNull();
    cleanup();
  });
});

describe('ModelPickerTrigger — onClick + disabled', () => {
  it('点击 → onClick 触发', () => {
    const onClick = vi.fn();
    render(<ModelPickerTrigger onClick={onClick} placeholder="p" />);
    fireEvent.click(screen.getByRole('button', { name: 'p' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('disabled=true → 点击不触发 onClick + opacity-60 + cursor-not-allowed', () => {
    const onClick = vi.fn();
    render(<ModelPickerTrigger onClick={onClick} disabled placeholder="p" />);
    const btn = screen.getByRole('button', { name: 'p' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.className).toContain('opacity-60');
    expect(btn.className).toContain('cursor-not-allowed');
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    cleanup();
  });
});

describe('ModelPickerTrigger — size', () => {
  it("size='md'（缺省）→ h-8 + px-3 + gap-2", () => {
    render(<ModelPickerTrigger onClick={() => {}} placeholder="p" />);
    const btn = screen.getByRole('button', { name: 'p' });
    expect(btn.className).toContain('h-8');
    expect(btn.className).toContain('px-3');
    expect(btn.className).toContain('gap-2');
    cleanup();
  });

  it("size='sm' → h-[26px] + px-2 + gap-1.5", () => {
    render(<ModelPickerTrigger onClick={() => {}} size="sm" placeholder="p" />);
    const btn = screen.getByRole('button', { name: 'p' });
    expect(btn.className).toContain('h-[26px]');
    expect(btn.className).toContain('px-2');
    expect(btn.className).toContain('gap-1.5');
    cleanup();
  });
});

describe('ModelPickerTrigger — aria + title + className', () => {
  it('ariaLabel / title / ariaExpanded 透传到 button', () => {
    render(
      <ModelPickerTrigger
        onClick={() => {}}
        placeholder="p"
        ariaLabel="model label X"
        title="p / m"
        ariaExpanded={true}
      />,
    );
    const btn = screen.getByRole('button', { name: 'model label X' });
    expect(btn.getAttribute('aria-label')).toBe('model label X');
    expect(btn.getAttribute('title')).toBe('p / m');
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.getAttribute('aria-haspopup')).toBe('listbox');
    cleanup();
  });

  it('className 追加合并（不覆盖 bg/border/color 基础）', () => {
    render(
      <ModelPickerTrigger
        onClick={() => {}}
        placeholder="p"
        className="w-[180px] whitespace-nowrap"
      />,
    );
    const btn = screen.getByRole('button', { name: 'p' });
    expect(btn.className).toContain('w-[180px]');
    expect(btn.className).toContain('whitespace-nowrap');
    // 基础 bg-surface 仍在
    expect(btn.className).toContain('bg-surface');
    cleanup();
  });
});
