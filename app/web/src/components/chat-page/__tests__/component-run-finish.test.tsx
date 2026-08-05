// @vitest-environment jsdom
/**
 * component-run-finish 单测（§4.13 改版）
 * 参考: specs/ui/components/chat-page/_overview.md §4.13（error ⚠️ icon + displayReason + tooltip detail）
 *
 * 覆盖：
 *   - 非 error stopReason：分隔线 + 文案（muted/gold/sage）
 *   - error 态：⚠️ icon + displayReason + code pill
 *   - error 有 detail → hover ⚠️ icon 显示 tooltip-content = detail
 *   - error 无 code → 不渲染 code pill
 *   - 组件单一职责：自身不读 sessionRunning（门控由父层 message-stream）
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentRunFinish } from '../component-run-finish';
import type { RunFinish } from '../types';
import { initI18n } from '../../../i18n';

// 启动 i18next instance（zh-CN），让 ErrorRow 内 useTranslation('error') 能查 locale 表
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

/** 非 error 形态：分隔线行中间的原因 span（div.flex 的第二个子元素） */
function getReasonSpan(container: HTMLElement): HTMLElement {
  return container.querySelector('div.flex')!.children[1] as HTMLElement;
}

describe('ComponentRunFinish 非 error 形态（§4.13）', () => {
  it('no_tool_call → 「✓ 已完成」muted（单个 ✓，无重复对号）', () => {
    const { container } = render(<ComponentRunFinish finish={{ stopReason: 'no_tool_call' }} />);
    const reason = getReasonSpan(container);
    expect(reason.textContent).toBe('✓ 已完成');
    expect(reason.className).toContain('text-muted');
    // 无 error icon / code pill
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('span[class*="danger-bg"]')).toBeNull();
  });

  it('max_iterations → gold 警告（无 ✓ 前缀）', () => {
    const { container } = render(<ComponentRunFinish finish={{ stopReason: 'max_iterations' }} />);
    const reason = getReasonSpan(container);
    expect(reason.textContent).toContain('已达最大迭代数');
    expect(reason.textContent).not.toContain('✓');
    expect(reason.className).toContain('text-[var(--color-gold)]');
  });

  it('doom_loop → gold 警告', () => {
    const { container } = render(<ComponentRunFinish finish={{ stopReason: 'doom_loop' }} />);
    expect(getReasonSpan(container).textContent).toContain('死循环');
  });

  it('tool_pending → sage「等待输入」（无 ✓ 前缀）', () => {
    const { container } = render(<ComponentRunFinish finish={{ stopReason: 'tool_pending' }} />);
    const reason = getReasonSpan(container);
    expect(reason.textContent).toContain('等待输入');
    expect(reason.textContent).not.toContain('✓');
    expect(reason.className).toContain('text-[var(--color-sage)]');
  });

  it('interrupted → muted「已中断」（无 ✓ 前缀）', () => {
    const { container } = render(<ComponentRunFinish finish={{ stopReason: 'interrupted' }} />);
    const reason = getReasonSpan(container);
    expect(reason.textContent).toContain('已中断');
    expect(reason.textContent).not.toContain('✓');
  });
});

describe('ComponentRunFinish error 形态（§4.13 改版）', () => {
  const errorFinish: RunFinish = {
    stopReason: 'error',
    error: {
      category: 'PROVIDER_OVERLOADED',
      displayReason: '服务商过载，请稍后重试',
      detail: 'anthropic 529 overloaded_error',
      code: 'PROVIDER_OVERLOADED',
    },
  };

  it('渲染 ⚠️ icon + displayReason + code pill', () => {
    const { container } = render(<ComponentRunFinish finish={errorFinish} />);
    expect(screen.getByRole('img')).not.toBeNull();
    expect(container.querySelector('span.truncate')!.textContent).toBe('服务商过载，请稍后重试');
    expect(screen.getByText('PROVIDER_OVERLOADED').textContent).toBe('PROVIDER_OVERLOADED');
  });

  it('hover ⚠️ icon → tooltip-content 显示 detail', () => {
    render(<ComponentRunFinish finish={errorFinish} />);
    // 初始隐藏
    expect(screen.queryByText('anthropic 529 overloaded_error')).toBeNull();
    // PrimitiveTooltip 在 icon span 外层包一层 span 挂事件，hover 需派发到包裹 span（parentElement）
    fireEvent.mouseEnter(screen.getByRole('img').parentElement as HTMLElement);
    expect(screen.getByText('anthropic 529 overloaded_error').textContent).toBe('anthropic 529 overloaded_error');
  });

  it('无 code → 不渲染 code pill', () => {
    const { container } = render(
      <ComponentRunFinish
        finish={{
          stopReason: 'error',
          error: { category: 'AUTH_INVALID', displayReason: '认证失败', detail: '401 invalid key' },
        }}
      />,
    );
    expect(container.querySelector('span[class*="danger-bg"]')).toBeNull();
    // displayReason 走 locale 查表：AUTH_INVALID → error.llm.authInvalid = '认证失败，请检查 API Key'
    expect(container.querySelector('span.truncate')!.textContent).toBe('认证失败，请检查 API Key');
  });

  it('无 detail → tooltip 内容退化为 displayReason', () => {
    render(
      <ComponentRunFinish
        finish={{
          stopReason: 'error',
          error: { category: 'RATE_LIMITED', displayReason: '模型限流' },
        }}
      />,
    );
    // hover 前仅主文案 1 处（span.truncate）
    expect(screen.getAllByText('模型限流，请稍后重试').length).toBe(1);
    fireEvent.mouseEnter(screen.getByRole('img').parentElement as HTMLElement);
    // hover 后 tooltip 追加第 2 处（fallback 走 localizedReason：RATE_LIMITED → error.llm.rateLimited）
    expect(screen.getAllByText('模型限流，请稍后重试').length).toBe(2);
  });
});
