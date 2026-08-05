/**
 * @vitest-environment jsdom
 * component-icon-box 单测 —— IconBox primitive 视觉 + hash 派生色
 * 参考: specs/ui/components/common/component-icon-box.md
 *       specs/ui/regulation/02-components.md §4
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { IconBox } from '../component-icon-box';
import { hashHueName, HUE_PALETTE } from '../../../lib/hue-hash';

afterEach(() => cleanup());

/** IconBox 渲染单个 span[data-hue]，用 container 查询定位 */
function boxOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-hue]') as HTMLElement;
}

describe('IconBox 基础渲染', () => {
  it('默认 32px 尺寸（h-8 w-8 rounded-md）', () => {
    const { container } = render(<IconBox hueBy="a" />);
    const box = boxOf(container);
    expect(box.tagName).toBe('SPAN');
    expect(box.className).toContain('h-8');
    expect(box.className).toContain('w-8');
    expect(box.className).toContain('rounded-md');
  });

  it('渲染 icon 节点（内联 SVG，用 currentColor 继承主色）', () => {
    const { container } = render(
      <IconBox
        hueBy="a"
        icon={<svg width="16" height="16" />}
      />,
    );
    expect(container.querySelector('svg')).toBeTruthy();
  });

  it('无 icon 时显 fallbackText', () => {
    render(<IconBox hueBy="a" fallbackText="R" />);
    expect(screen.getByText('R')).toBeTruthy();
  });

  it('无 icon 无 fallback → 空内容', () => {
    const { container } = render(<IconBox hueBy="a" />);
    expect(boxOf(container).textContent).toBe('');
  });
});

describe('IconBox 尺寸档', () => {
  it('size=22：22×22', () => {
    const { container } = render(<IconBox hueBy="a" size={22} />);
    expect(boxOf(container).className).toContain('h-[22px]');
  });

  it('size=24：24×24（h-6）', () => {
    const { container } = render(<IconBox hueBy="a" size={24} />);
    expect(boxOf(container).className).toContain('h-6');
  });

  it('size=34：34×34 + rounded-lg（统计条大图标）', () => {
    const { container } = render(<IconBox hueBy="a" size={34} />);
    const box = boxOf(container);
    expect(box.className).toContain('h-[34px]');
    expect(box.className).toContain('rounded-lg');
  });
});

describe('IconBox 色派生（hueBy hash / hue 显式）', () => {
  it('hueBy hash 派生：同 hueBy 恒同色（--hue-{name}-bg + --hue-{name}）', () => {
    const { container } = render(<IconBox hueBy="skill:read_file" />);
    const box = boxOf(container);
    const name = hashHueName('skill:read_file');
    expect(box.style.background).toBe(`var(--hue-${name}-bg)`);
    expect(box.style.color).toBe(`var(--hue-${name})`);
    // data-hue 便于断言 palette 名
    expect(box.getAttribute('data-hue')).toBe(name);
    expect(HUE_PALETTE.includes(name)).toBe(true);
  });

  it('hue 显式覆盖 hash（设计稿定色场景）', () => {
    const { container } = render(<IconBox hue="green" hueBy="whatever" />);
    const box = boxOf(container);
    expect(box.style.background).toBe('var(--hue-green-bg)');
    expect(box.style.color).toBe('var(--hue-green)');
    expect(box.getAttribute('data-hue')).toBe('green');
  });

  it('hueBy 未传 + hue 未传 → rose 兜底', () => {
    const { container } = render(<IconBox />);
    const box = boxOf(container);
    expect(box.style.background).toBe('var(--hue-rose-bg)');
    expect(box.getAttribute('data-hue')).toBe('rose');
  });

  it('同 hueBy 两处渲染色一致（hash 稳定性）', () => {
    const r1 = render(<IconBox hueBy="stable" />);
    const bg1 = boxOf(r1.container).style.background;
    cleanup();
    const r2 = render(<IconBox hueBy="stable" />);
    const bg2 = boxOf(r2.container).style.background;
    expect(bg2).toBe(bg1);
  });
});

describe('IconBox className 合并', () => {
  it('外部 className 追加，不覆盖 bg/color inline style', () => {
    const { container } = render(<IconBox hueBy="a" className="ml-2 shadow-sm" />);
    const box = boxOf(container);
    expect(box.className).toContain('ml-2');
    expect(box.className).toContain('shadow-sm');
    // bg/color 仍在 inline style
    expect(box.style.background).toContain('var(--hue-');
  });
});
