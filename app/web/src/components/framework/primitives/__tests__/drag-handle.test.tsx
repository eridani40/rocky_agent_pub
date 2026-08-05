/**
 * @vitest-environment jsdom
 * primitive-drag-handle 单测：渲染 + draggable 属性 + 自定义 testId
 * 参考: specs/ui/components/framework/primitive-drag-handle.md
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { DragHandle } from '../drag-handle';
import { initI18n } from '../../../../i18n';

// [v0.0.62 i18n] 组件 useTranslation(framework) 需 i18n 实例就绪
beforeAll(async () => {
  await initI18n('zh-CN');
});

describe('DragHandle', () => {
  afterEach(() => cleanup());

  it('渲染 draggable=true + aria-label', () => {
    render(<DragHandle />);
    const el = screen.getByLabelText('拖拽排序');
    // jsdom 对 draggable 属性渲染为字符串 'true'
    expect(el.getAttribute('draggable')).toBe('true');
  });

  it('渲染 grip 图标 svg（6 个圆点）', () => {
    const { container } = render(<DragHandle />);
    const svg = container.querySelector('svg');
    expect(svg).toBeTruthy();
    const circles = container.querySelectorAll('circle');
    // grip 图标：2 列 x 3 行 = 6 个圆点
    expect(circles.length).toBe(6);
  });
});
