/**
 * @vitest-environment jsdom
 * component-loading-status 单测（on-message spinner）
 * 参考: specs/ui/components/chat-page/_overview.md §4.10（on-message spinner）
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.7（两层状态 UI）
 *
 * 覆盖：
 *   - 4 阶段 phase 文案正确（thinking/answering/tool_calling/tool_executing）
 *   - null phase 兜底 thinking
 *   - 浮动 absolute 定位移除（不再有 absolute left-10 bottom-[72px] 类）
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ComponentLoadingStatus } from '../component-loading-status';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：phase 文案走 chat.loading.<phase>
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

describe('component-loading-status → on-message spinner', () => {
  it('phase=thinking → data-phase=thinking + 文案「思考中…」', () => {
    const { container } = render(<ComponentLoadingStatus phase="thinking" />);
    const phase = container.querySelector('[data-phase="thinking"]')!;
    expect(phase).toBeTruthy();
    expect(phase.textContent).toContain('思考中');
  });

  it('phase=answering → 文案「生成回答…」', () => {
    const { container } = render(<ComponentLoadingStatus phase="answering" />);
    expect(container.querySelector('[data-phase="answering"]')!.textContent).toContain('生成回答');
  });

  it('phase=tool_calling → 文案「调用工具…」', () => {
    const { container } = render(<ComponentLoadingStatus phase="tool_calling" />);
    expect(container.querySelector('[data-phase="tool_calling"]')!.textContent).toContain('调用工具');
  });

  it('phase=tool_executing → 文案「执行中…」', () => {
    const { container } = render(<ComponentLoadingStatus phase="tool_executing" />);
    expect(container.querySelector('[data-phase="tool_executing"]')!.textContent).toContain('执行中');
  });

  it('phase=null → 兜底 thinking（spinner 仍转）', () => {
    // run 启动后到第一个具体事件之前，phase 暂无具体值；spinner 继续转，兜底 thinking
    const { container } = render(<ComponentLoadingStatus phase={null} />);
    expect(container.querySelector('[data-phase="thinking"]')).toBeTruthy();
  });

  it('data-phase 属性反映当前 phase', () => {
    const { container, rerender } = render(<ComponentLoadingStatus phase="answering" />);
    expect(container.querySelector('[data-phase]')!.getAttribute('data-phase')).toBe('answering');
    rerender(<ComponentLoadingStatus phase="tool_calling" />);
    expect(container.querySelector('[data-phase]')!.getAttribute('data-phase')).toBe('tool_calling');
  });

  it('浮动 absolute 定位移除（不再有 absolute / left-10 / bottom-[72px]）', () => {
    const { container } = render(<ComponentLoadingStatus phase="thinking" />);
    const spinner = container.querySelector('[data-phase]')!;
    // 改版后是流内（贴 ComponentMessageStream 末尾），不再是 absolute 浮动
    expect(spinner.className).not.toContain('absolute');
    expect(spinner.className).not.toContain('left-10');
    expect(spinner.className).not.toContain('bottom-[72px]');
    expect(spinner.className).not.toContain('z-10');
  });

  it('含 spinner 旋转环（border + animate-spin）', () => {
    const { container } = render(<ComponentLoadingStatus phase="thinking" />);
    const spinner = container.querySelector('[data-phase]')!;
    const ring = spinner.querySelector('span.animate-spin');
    expect(ring).toBeTruthy();
    expect(ring?.className).toContain('rounded-full');
    expect(ring?.className).toContain('border-t-[var(--color-accent)]');
  });
});
