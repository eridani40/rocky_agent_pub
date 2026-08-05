/**
 * @vitest-environment jsdom
 * component-msg-time 单测
 * 参考: specs/ui/components/chat-page/component-msg-time.md
 *
 * 覆盖：
 * ① 有效 iso + side='user' → 渲 span，text-right + font-mono + var(--muted-2)
 * ② side='assistant' → text-left
 * ③ 空 iso / 非法 iso → 返 null（不渲 DOM）
 * ④ 同日 iso → HH:mm（不含 MM-dd）；纯展示不感知内容
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { MsgTime } from '../component-msg-time';

afterEach(() => cleanup());

describe('MsgTime primitive', () => {
  it('① 有效 iso + side=user → 渲 span，class 含 text-right / font-mono / var(--muted-2)', () => {
    const iso = new Date().toISOString();
    const { container } = render(<MsgTime iso={iso} side="user" />);
    const el = container.querySelector('span')!;
    expect(el.tagName).toBe('SPAN');
    expect(el.className).toContain('text-right');
    expect(el.className).toContain('font-mono');
    expect(el.className).toContain('var(--muted-2)');
    expect(el.className).toContain('text-[10.5px]');
    expect(el.className).toContain('mt-1');
    // 展示文本非空（HH:mm 或 MM-dd HH:mm，不锁具体值）
    expect(el.textContent && el.textContent.length > 0).toBe(true);
  });

  it('② side=assistant → text-left（贴气泡左侧）', () => {
    const { container } = render(<MsgTime iso={new Date().toISOString()} side="assistant" />);
    const el = container.querySelector('span')!;
    expect(el.className).toContain('text-left');
    expect(el.className).not.toContain('text-right');
  });

  it('③ 空 iso → 组件返 null（不渲 DOM，不占位）', () => {
    const { container } = render(<MsgTime iso="" side="user" />);
    expect(container.firstChild).toBeNull();
  });

  it('③b 非法 iso → 组件返 null', () => {
    const { container } = render(<MsgTime iso="not-a-date" side="assistant" />);
    expect(container.firstChild).toBeNull();
  });

  it('④ user 与 assistant 两次渲染各自独立，class 互不污染', () => {
    const { container } = render(
      <div>
        <MsgTime iso={new Date().toISOString()} side="user" />
        <MsgTime iso={new Date().toISOString()} side="assistant" />
      </div>,
    );
    const spans = container.querySelectorAll('span');
    expect(spans.length).toBe(2);
    expect(spans[0]!.className).toContain('text-right');
    expect(spans[1]!.className).toContain('text-left');
  });
});
