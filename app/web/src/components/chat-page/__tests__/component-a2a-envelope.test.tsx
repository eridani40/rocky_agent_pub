// @vitest-environment jsdom
/**
 * component-a2a-envelope 单测
 * 参考: specs/tech/version_logs/v0.0.295/change_plan.md (in 方向)
 *       specs/tech/version_logs/v0.0.310/change_plan.md (out 方向扩展)
 *
 * 覆盖：
 *   in 方向（默认）：收起/展开切换 + from {senderName}
 *   out 方向：sending/done/error 三态 + to {senderName}
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentA2aEnvelope } from '../component-a2a-envelope';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

describe('ComponentA2aEnvelope in 方向（默认）', () => {
  it('收起态（默认）：显示 senderName，不显示正文', () => {
    render(
      <ComponentA2aEnvelope senderName="captain">
        {'Hello from captain'}
      </ComponentA2aEnvelope>,
    );
    // senderName 可见（在 "from captain" 文本节点内）
    expect(screen.getByText(/captain/)).toBeTruthy();
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

describe('ComponentA2aEnvelope out 方向 [v0.0.310]', () => {
  it('out + sending：显示 targetName + 发送中，不可展开', () => {
    render(
      <ComponentA2aEnvelope direction="out" senderName="coder" status="sending">
        {'pending body'}
      </ComponentA2aEnvelope>,
    );
    // targetName 可见（在 "to coder" 文本节点内）
    expect(screen.getByText(/coder/)).toBeTruthy();
    // 发送中文案可见
    const sendingText = screen.queryByText('发送中...', { exact: false });
    expect(sendingText).toBeTruthy();
    // 正文不可见
    expect(screen.queryByTestId('a2a-envelope-body')).toBeNull();
  });

  it('[v0.0.311] out + sending + targetName 未解析（"..."）→ 隐藏 to 前缀，只显示发送中', () => {
    render(
      <ComponentA2aEnvelope direction="out" senderName="..." status="sending">
        {'pending'}
      </ComponentA2aEnvelope>,
    );
    // 不显示 "to ..." 文本（丑的占位符）
    expect(screen.queryByText(/to \.\.\./)).toBeNull();
    // 发送中文案可见
    expect(screen.getByText('发送中...', { exact: false })).toBeTruthy();
    // 正文不可见
    expect(screen.queryByTestId('a2a-envelope-body')).toBeNull();
  });

  it('out + done：显示 targetName，可展开看正文', () => {
    render(
      <ComponentA2aEnvelope direction="out" senderName="leader" status="done">
        {'Message sent successfully'}
      </ComponentA2aEnvelope>,
    );
    // targetName 可见
    expect(screen.getByText(/leader/)).toBeTruthy();
    // 收起态无正文
    expect(screen.queryByTestId('a2a-envelope-body')).toBeNull();
    // 展开后有正文
    const toggle = screen.getByTestId('a2a-envelope-toggle');
    fireEvent.click(toggle);
    expect(screen.queryByTestId('a2a-envelope-body')).not.toBeNull();
  });

  it('[v0.0.311] out + done：markdown 内容走 markdown 渲染（加粗→<strong>，与 in 方向对称）', () => {
    render(
      <ComponentA2aEnvelope direction="out" senderName="leader" status="done">
        {'**重要消息** 和 `code`'}
      </ComponentA2aEnvelope>,
    );
    const toggle = screen.getByTestId('a2a-envelope-toggle');
    fireEvent.click(toggle);
    const body = screen.getByTestId('a2a-envelope-body');
    // markdown 加粗 → <strong>（证明走 PrimitiveMarkdownView，不是纯文本）
    expect(body.querySelector('strong')).toBeTruthy();
    expect(body.querySelector('strong')?.textContent).toBe('重要消息');
    // 行内代码 → <code>
    expect(body.querySelector('code')).toBeTruthy();
  });

  it('out + error：显示 targetName + 发送失败 pill，可展开看 errorContent', () => {
    render(
      <ComponentA2aEnvelope direction="out" senderName="architect" status="error" errorContent={'Target not found'}>
        {'should not show in error'}
      </ComponentA2aEnvelope>,
    );
    // targetName 可见
    expect(screen.getByText(/architect/)).toBeTruthy();
    // 发送失败 pill 可见
    const failPill = screen.queryByText('发送失败', { exact: false });
    expect(failPill).toBeTruthy();
    // 展开后显示 errorContent
    const toggle = screen.getByTestId('a2a-envelope-toggle');
    fireEvent.click(toggle);
    expect(screen.queryByTestId('a2a-envelope-body')).not.toBeNull();
  });
});

// ============================================================
// [v0.0.311] onToggle 回调验证（外部据此控制时间戳渲染）
// ============================================================
describe('ComponentA2aEnvelope onToggle 回调 [v0.0.311]', () => {
  it('in 方向：展开时 onToggle(true)，收起时 onToggle(false)', () => {
    let toggleState: boolean | null = null;
    render(
      <ComponentA2aEnvelope senderName="coder" onToggle={(exp) => (toggleState = exp)}>
        {'body'}
      </ComponentA2aEnvelope>,
    );
    const toggle = screen.getByTestId('a2a-envelope-toggle');
    fireEvent.click(toggle);
    expect(toggleState).toBe(true);
    fireEvent.click(toggle);
    expect(toggleState).toBe(false);
  });

  it('out + sending：不可展开，onToggle 不触发', () => {
    const onToggle = vi.fn();
    render(
      <ComponentA2aEnvelope direction="out" senderName="coder" status="sending" onToggle={onToggle}>
        {'body'}
      </ComponentA2aEnvelope>,
    );
    const toggle = screen.getByTestId('a2a-envelope-toggle');
    fireEvent.click(toggle);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('out + done：展开时 onToggle(true)', () => {
    const onToggle = vi.fn();
    render(
      <ComponentA2aEnvelope direction="out" senderName="coder" status="done" onToggle={onToggle}>
        {'body'}
      </ComponentA2aEnvelope>,
    );
    const toggle = screen.getByTestId('a2a-envelope-toggle');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
