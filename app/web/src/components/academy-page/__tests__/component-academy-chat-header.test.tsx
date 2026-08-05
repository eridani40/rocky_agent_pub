/**
 * @vitest-environment jsdom
 * component-academy-chat-header 单测 —— academy 会话身份 header（纯展示）
 * 参考: specs/ui/components/academy-page/component-academy-chat-header.md
 *
 * 覆盖：
 * - avatar 字 + 标题渲染；avatarBg 缺省 var(--brand-grad)、显式传入生效
 * - statusLine / tag 可选：传入渲染、缺省不渲
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ComponentAcademyChatHeader } from '../component-academy-chat-header';

afterEach(() => cleanup());

describe('ComponentAcademyChatHeader', () => {
  it('渲 avatar 字 + 标题；statusLine / tag 传入时渲染', () => {
    render(
      <ComponentAcademyChatHeader
        avatarText="教"
        avatarBg="linear-gradient(135deg,#3b82f6,#8b5cf6)"
        title="教练"
        statusLine={<div>● 工作中</div>}
        tag="academy-coach"
      />,
    );
    expect(screen.getByText('教')).toBeTruthy();
    expect(screen.getByText('教练')).toBeTruthy();
    expect(screen.getByText('● 工作中')).toBeTruthy();
    expect(screen.getByText('academy-coach')).toBeTruthy();
    expect((screen.getByText('教') as HTMLElement).style.background).toContain('linear-gradient');
  });

  it('statusLine / tag 缺省不渲；avatarBg 缺省 var(--brand-grad)', () => {
    const { container } = render(<ComponentAcademyChatHeader avatarText="S" title="Subagent" />);
    expect(screen.getByText('S')).toBeTruthy();
    expect(screen.getByText('Subagent')).toBeTruthy();
    // 无 tag → 不出现 mono tag span
    expect(container.querySelector('.font-mono')).toBeNull();
    expect((screen.getByText('S') as HTMLElement).style.background).toBe('var(--brand-grad)');
  });
});
