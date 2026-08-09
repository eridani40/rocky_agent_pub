// @vitest-environment jsdom
/**
 * component-a2a-envelope 单测（v0.0.295）
 * 参考: specs/tech/version_logs/v0.0.295/change_plan.md
 *
 * 覆盖：
 *   - 收起态（默认）：显示 senderName，不显示正文
 *   - 点击展开：显示正文（a2a-envelope-body 出现）
 *   - 再点收起：正文消失
 *   - aria-expanded 反映展开状态
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentA2aEnvelope } from '../component-a2a-envelope';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

describe('ComponentA2aEnvelope 收起/展开切换', () => {
  it('收起态（默认）：显示 senderName，不显示正文', () => {
    render(
      <ComponentA2aEnvelope senderName="captain">
        {'Hello from captain'}
      </ComponentA2aEnvelope>,
    );
    // senderName 可见
    expect(screen.getByText('captain')).toBeTruthy();
    // 正文不可见
    expect(screen.queryByTestId('a2a-envelope-body')).toBeNull();
    // aria-expanded=false
    const toggle = screen.getByTestId('a2a-envelope-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('点击展开：显示正文（a2a-envelope-body 出现）', () => {
    render(
      <ComponentA2aEnvelope senderName="worker">
        {'Message body text'}
      </ComponentA2aEnvelope>,
    );
    const toggle = screen.getByTestId('a2a-envelope-toggle');
    fireEvent.click(toggle);
    // 正文出现
    const body = screen.queryByTestId('a2a-envelope-body');
    expect(body).not.toBeNull();
    // aria-expanded=true
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('再点收起：正文消失', () => {
    render(
      <ComponentA2aEnvelope senderName="alice">
        {'Toggle me'}
      </ComponentA2aEnvelope>,
    );
    const toggle = screen.getByTestId('a2a-envelope-toggle');
    // 展开
    fireEvent.click(toggle);
    expect(screen.queryByTestId('a2a-envelope-body')).not.toBeNull();
    // 收起
    fireEvent.click(toggle);
    expect(screen.queryByTestId('a2a-envelope-body')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});
