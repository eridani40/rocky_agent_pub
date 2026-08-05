// @vitest-environment jsdom
/**
 * component-clear-confirm-modal 单测（v0.0.16 §3.4）
 * 参考: specs/ui/components/chat-page/component-usage-panel.md §3.4（ClearBtn + 确认 modal）
 *
 * 覆盖：
 *   - open=false 不渲染
 *   - open=true 渲染 modal + 确认/取消按钮
 *   - 点取消 → onCancel（不调 onConfirm）
 *   - 点确认 → onConfirm（不调 onCancel）
 *   - 点 overlay 背景 → onCancel
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentClearConfirmModal } from '../component-clear-confirm-modal';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：clear-confirm-modal 内部用 useTranslation 查 chat.clearConfirm.* + common.action.cancel
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

describe('ComponentClearConfirmModal（§3.4）', () => {
  it('open=false → 不渲染', () => {
    const { container } = render(
      <ComponentClearConfirmModal open={false} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(screen.queryByText('清空会话')).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('open=true → 渲染 modal + 确认清空 + 取消按钮', () => {
    render(<ComponentClearConfirmModal open={true} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('清空会话')).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认清空' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });

  it('点取消 → onCancel 调用，onConfirm 不调用', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ComponentClearConfirmModal open={true} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('点确认清空 → onConfirm 调用，onCancel 不调用', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ComponentClearConfirmModal open={true} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '确认清空' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('点 overlay 背景 → onCancel（点 panel 内部不关）', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ComponentClearConfirmModal open={true} onConfirm={onConfirm} onCancel={onCancel} />);
    // overlay = modal 容器本身（fixed inset-0），通过标题定位 panel 再取外层 overlay
    const overlay = screen.getByText('清空会话').closest('.fixed')!;
    fireEvent.click(overlay);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('含标题「清空会话」+ 说明文案', () => {
    render(<ComponentClearConfirmModal open={true} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText('清空会话')).toBeTruthy();
    expect(screen.getByText(/操作不可撤销/)).toBeTruthy();
  });
});
