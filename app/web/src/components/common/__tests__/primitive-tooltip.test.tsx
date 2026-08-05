// @vitest-environment jsdom
/**
 * primitive-tooltip 单测（v0.0.25 §4.13 首用方）
 * 参考: specs/ui/components/common/primitive-tooltip.md
 *
 * 覆盖：
 *   - 默认隐藏，hover trigger 后显示 tooltip（role=tooltip）
 *   - mouse leave 后隐藏
 *   - 键盘 focus trigger 后显示（tabIndex=0）
 *   - blur 后隐藏
 *   - 纯文本 content 时 trigger 设 HTML title（a11y 兜底）
 *   - Esc 键关闭
 *   - triggers=['hover'] 时不响应 focus
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PrimitiveTooltip } from '../primitive-tooltip';

afterEach(() => cleanup());

describe('PrimitiveTooltip（§primitive-tooltip）', () => {
  // PrimitiveTooltip 在 children 外层包一层 span 挂 trigger props（tabIndex/title/事件）。
  // 测试通过 children 的文本找到子节点，再 .parentElement 拿到包裹 span（trigger 实际承载 props 的节点）。
  function wrapperOf(childText: string): HTMLElement {
    return screen.getByText(childText).parentElement as HTMLElement;
  }

  it('默认隐藏（无 tooltip 节点）', () => {
    render(
      <PrimitiveTooltip content="详情">
        <span>⚠️</span>
      </PrimitiveTooltip>,
    );
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('hover trigger → 显示 tooltip + content 文本', () => {
    render(
      <PrimitiveTooltip content="hello detail">
        <span>t</span>
      </PrimitiveTooltip>,
    );
    fireEvent.mouseEnter(wrapperOf('t'));
    expect(screen.getByRole('tooltip')).not.toBeNull();
    expect(screen.getByRole('tooltip').textContent).toBe('hello detail');
  });

  it('mouse leave → 隐藏', () => {
    render(
      <PrimitiveTooltip content="x">
        <span>t</span>
      </PrimitiveTooltip>,
    );
    fireEvent.mouseEnter(wrapperOf('t'));
    expect(screen.getByRole('tooltip')).not.toBeNull();
    fireEvent.mouseLeave(wrapperOf('t'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('键盘 focus trigger → 显示；blur → 隐藏', () => {
    render(
      <PrimitiveTooltip content="kbd">
        <span>t</span>
      </PrimitiveTooltip>,
    );
    const wrapper = wrapperOf('t');
    // trigger 可聚焦（tabIndex=0）
    expect(wrapper.getAttribute('tabindex')).toBe('0');
    fireEvent.focus(wrapper);
    expect(screen.getByRole('tooltip').textContent).toBe('kbd');
    fireEvent.blur(wrapper);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('纯文本 content → trigger 设 HTML title（a11y 兜底）', () => {
    render(
      <PrimitiveTooltip content="a11y text">
        <span>t</span>
      </PrimitiveTooltip>,
    );
    expect(wrapperOf('t').getAttribute('title')).toBe('a11y text');
  });

  it('非文本 content（节点）→ 不设 title', () => {
    render(
      <PrimitiveTooltip content={<span>node</span>}>
        <span>t</span>
      </PrimitiveTooltip>,
    );
    expect(wrapperOf('t').getAttribute('title')).toBeNull();
  });

  it('visible 时按 Esc → 隐藏', () => {
    render(
      <PrimitiveTooltip content="esc test">
        <span>t</span>
      </PrimitiveTooltip>,
    );
    fireEvent.mouseEnter(wrapperOf('t'));
    expect(screen.getByRole('tooltip')).not.toBeNull();
    // Esc 关闭（window keydown）
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('triggers=["hover"] → 不响应 focus（tabIndex 不设）', () => {
    render(
      <PrimitiveTooltip content="x" triggers={['hover']}>
        <span>t</span>
      </PrimitiveTooltip>,
    );
    const wrapper = wrapperOf('t');
    expect(wrapper.getAttribute('tabindex')).toBeNull();
    fireEvent.focus(wrapper);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
