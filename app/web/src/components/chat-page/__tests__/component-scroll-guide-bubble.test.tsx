// @vitest-environment jsdom
/**
 * component-scroll-guide-bubble 单测（v0.0.262）
 * 参考: specs/tech/version_logs/v0.0.262/change_plan.md 行 7
 *       specs/prd/version_logs/v0.0.262.scroll_guide_bubble/prd.md §2.2/§2.4/§3.1
 *
 * 覆盖：
 *   - 显隐：nearBottom=false + hasMessages → visible（opacity-100 / pointer-events-auto）
 *   - 显隐：nearBottom=true → 不可见（opacity-0 / pointer-events-none，仍在 DOM——不 unmount）
 *   - 显隐：hasMessages=false → 不可见（即使 nearBottom=false，空会话走空态分支）
 *   - 文案：runActive=true → 「新消息」；runActive=false → 「回到底部」（二元，runActive 只决定文案）
 *   - 交互：点击 → onScrollToBottom 调用
 *   - 可访问：button 语义 + aria-label（随 runActive 二元「查看新消息」/「回到底部」）
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ScrollGuideBubble } from '../component-scroll-guide-bubble';
import { initI18n } from '../../../i18n';

// 启动 i18next instance（zh-CN），让 useTranslation('chat') 能查 scrollGuide.* 表
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

describe('ScrollGuideBubble 显隐（visible = !nearBottom && hasMessages）', () => {
  it('nearBottom=false + hasMessages=true → visible（opacity-100 + pointer-events-auto）', () => {
    render(
      <ScrollGuideBubble nearBottom={false} runActive={false} hasMessages onScrollToBottom={() => {}} />,
    );
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('opacity-100');
    expect(btn.className).toContain('pointer-events-auto');
  });

  it('nearBottom=true → 不可见（opacity-0 + pointer-events-none，按钮仍在 DOM——不 unmount）', () => {
    render(
      <ScrollGuideBubble nearBottom runActive={false} hasMessages onScrollToBottom={() => {}} />,
    );
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('opacity-0');
    expect(btn.className).toContain('pointer-events-none');
  });

  it('hasMessages=false → 不可见（即使 nearBottom=false，空会话走空态分支）', () => {
    render(
      <ScrollGuideBubble nearBottom={false} runActive={false} hasMessages={false} onScrollToBottom={() => {}} />,
    );
    const btn = screen.getByRole('button');
    expect(btn.className).toContain('opacity-0');
    expect(btn.className).toContain('pointer-events-none');
  });
});

describe('ScrollGuideBubble 文案（runActive 二元，只决定文案不决定显隐）', () => {
  it('nearBottom=false + runActive=true → 「新消息」', () => {
    render(
      <ScrollGuideBubble nearBottom={false} runActive hasMessages onScrollToBottom={() => {}} />,
    );
    expect(screen.getByText('新消息')).toBeTruthy();
  });

  it('nearBottom=false + runActive=false → 「回到底部」', () => {
    render(
      <ScrollGuideBubble nearBottom={false} runActive={false} hasMessages onScrollToBottom={() => {}} />,
    );
    expect(screen.getByText('回到底部')).toBeTruthy();
  });
});

describe('ScrollGuideBubble 交互 + 可访问性', () => {
  it('点击 → onScrollToBottom 调用（恰好一次）', () => {
    const spy = vi.fn();
    render(
      <ScrollGuideBubble nearBottom={false} runActive={false} hasMessages onScrollToBottom={spy} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('button 语义：type=button（点击不提交表单）', () => {
    render(
      <ScrollGuideBubble nearBottom={false} runActive={false} hasMessages onScrollToBottom={() => {}} />,
    );
    const btn = screen.getByRole('button') as HTMLButtonElement;
    expect(btn.type).toBe('button');
  });

  it('aria-label 随 runActive 二元：true → 「查看新消息」/ false → 「回到底部」', () => {
    const { rerender } = render(
      <ScrollGuideBubble nearBottom={false} runActive hasMessages onScrollToBottom={() => {}} />,
    );
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('查看新消息');
    rerender(
      <ScrollGuideBubble nearBottom={false} runActive={false} hasMessages onScrollToBottom={() => {}} />,
    );
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('回到底部');
  });
});
