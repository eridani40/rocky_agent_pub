/**
 * @vitest-environment jsdom
 * component-loading-status 重试态渲染单测
 * 参考: specs/ui/components/chat-page/_overview.md §4.10（重试态）
 *       specs/prd/version_logs/v0.0.144/03-run-spinner-retry.md
 *
 * 覆盖：
 *   - retryStatus 非空 → data-phase="retrying" + 文案「重试中 x/x」
 *   - 尾随 ！icon（role=img）；hover 显 message（tooltip content）
 *   - retryStatus 空 → 原 4 态零回归（无重试态，正常阶段文案）
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ComponentLoadingStatus } from '../component-loading-status';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

const retry = (attempt: number, maxAttempts: number, message = '模型限流') => ({ attempt, maxAttempts, message });

describe('component-loading-status → 重试态', () => {
  it('retryStatus 非空 → data-phase="retrying" + 重试文案「重试中 1/3」', () => {
    const { container } = render(<ComponentLoadingStatus phase="thinking" retryStatus={retry(1, 3)} />);
    const spinner = container.querySelector('[data-phase]')!;
    expect(spinner.getAttribute('data-phase')).toBe('retrying');
    expect(spinner.textContent).toContain('重试中 1/3');
  });

  it('尾随 ！icon（role=img）存在', () => {
    render(<ComponentLoadingStatus phase={null} retryStatus={retry(2, 3)} />);
    expect(screen.getByRole('img')).toBeTruthy();
  });

  it('hover ！icon → tooltip 显 message 内容', () => {
    render(<ComponentLoadingStatus phase={null} retryStatus={retry(2, 3, '认证失败，请检查 API Key')} />);
    const icon = screen.getByRole('img');
    fireEvent.mouseEnter(icon.parentElement ?? icon);
    const tip = screen.getByText('认证失败，请检查 API Key');
    expect(tip.textContent).toContain('认证失败，请检查 API Key');
  });

  it('重试态覆盖基础阶段文案（不显「思考中」，显「重试中」）', () => {
    const { container } = render(<ComponentLoadingStatus phase="thinking" retryStatus={retry(3, 3)} />);
    const spinner = container.querySelector('[data-phase]')!;
    expect(spinner.textContent).toContain('重试中 3/3');
    expect(spinner.textContent).not.toContain('思考中');
  });

  it('retryStatus 空 → 原 4 态零回归（无重试态，显阶段文案）', () => {
    const { container } = render(<ComponentLoadingStatus phase="thinking" retryStatus={null} />);
    const spinner = container.querySelector('[data-phase]')!;
    expect(spinner.getAttribute('data-phase')).toBe('thinking');
    expect(container.querySelector('[data-phase="retrying"]')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(spinner.textContent).toContain('思考中');
  });

  it('retryStatus 未传 → 原 4 态零回归', () => {
    const { container } = render(<ComponentLoadingStatus phase="answering" />);
    const spinner = container.querySelector('[data-phase]')!;
    expect(spinner.getAttribute('data-phase')).toBe('answering');
    expect(container.querySelector('[data-phase="retrying"]')).toBeNull();
  });
});
