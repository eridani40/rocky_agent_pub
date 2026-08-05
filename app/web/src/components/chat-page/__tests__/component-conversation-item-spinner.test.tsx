// @vitest-environment jsdom
/**
 * component-conversation-item running spinner + suspended「?」单测
 * 参考: specs/ui/components/chat-page/_overview.md §4.2（running spinner + suspended「?」）
 *
 * 覆盖 acceptanceCriteria：
 *   - state='running' → spinner 渲染（SpinnerRing）
 *   - state='interrupting' → spinner 仍渲染（仍属 running 态）
 *   - state='suspended' → suspended-mark「?」渲染，spinner 不渲染
 *   - state='idle' / 'interrupted' / 'error' / undefined → 均不渲染
 *   - 与 unread 红点错位共存（INV-9）
 *   - 槽位不再常驻：idle 态不渲染 14×14 占位，仅 running/suspended 时渲染
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { ComponentConversationItem } from '../component-conversation-item';
import type { Session } from '../types';
import { initI18n } from '../../../i18n';

// 启动 i18next instance：conv-item 内部用 useTranslation 查 common.timeAgo.*
beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-spinner',
    title: '父会话',
    status: 'active',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-28T00:00:00.000Z',
    ...overrides,
  };
}

function renderItem(session: Session) {
  return render(
    <ComponentConversationItem
      session={session}
      active={false}
      onSelect={() => {}}
      onSelectSub={() => {}}
      onDelete={() => {}}
      onContextMenu={() => {}}
    />,
  );
}

describe('ComponentConversationItem running spinner + suspended「?」', () => {
  it("state='running' → 渲染 spinner，不渲染 suspended-mark", () => {
    const { container } = renderItem(mkSession({ id: 's-run', state: 'running' }));
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.querySelector('[aria-label="suspended"]')).toBeNull();
  });

  it("state='interrupting' → 仍渲染 spinner（interrupting 属 running 态）", () => {
    const { container } = renderItem(mkSession({ id: 's-int', state: 'interrupting' }));
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(container.querySelector('[aria-label="suspended"]')).toBeNull();
  });

  it("state='suspended' → 渲染 suspended-mark「?」，spinner 不渲染（loop 已退出）", () => {
    const { container } = renderItem(mkSession({ id: 's-sus', state: 'suspended' }));
    const mark = container.querySelector('[aria-label="suspended"]');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toContain('?');
    expect(container.querySelector('.animate-spin')).toBeNull();
  });

  it("state='idle' → spinner 和「?」均不渲染", () => {
    const { container } = renderItem(mkSession({ id: 's-idle', state: 'idle' }));
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('[aria-label="suspended"]')).toBeNull();
  });

  it("state='interrupted' → spinner 和「?」均不渲染（terminated 态）", () => {
    const { container } = renderItem(mkSession({ id: 's-stop', state: 'interrupted' }));
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('[aria-label="suspended"]')).toBeNull();
  });

  it("state='error' → spinner 和「?」均不渲染（terminated 态）", () => {
    const { container } = renderItem(mkSession({ id: 's-err', state: 'error' }));
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('[aria-label="suspended"]')).toBeNull();
  });

  it("state 缺省（undefined）→ spinner 和「?」均不渲染（向后兼容旧 session）", () => {
    const { container } = renderItem(mkSession({ id: 's-undef' }));
    expect(container.querySelector('.animate-spin')).toBeNull();
    expect(container.querySelector('[aria-label="suspended"]')).toBeNull();
  });

  it('INV-9 错位共存：state=running + unread=true → spinner + 红点同时存在（不同 DOM）', () => {
    // active=false 触发红点显（unread && !active）；state=running 触发 spinner
    const { container } = renderItem(mkSession({ id: 's-both', state: 'running', unread: true }));
    const spinner = container.querySelector('.animate-spin');
    const dot = container.querySelector('span.absolute');
    expect(spinner).not.toBeNull();
    expect(dot).not.toBeNull();
    // 不同 DOM 节点（错位共存，spinner 在 title 左 / 红点在右上角）
    expect(spinner).not.toBe(dot);
  });

  it('INV-9 错位共存：state=suspended + unread=true → 「?」+ 红点同时存在', () => {
    const { container } = renderItem(mkSession({ id: 's-sus-both', state: 'suspended', unread: true }));
    const mark = container.querySelector('[aria-label="suspended"]');
    const dot = container.querySelector('span.absolute');
    expect(mark).not.toBeNull();
    expect(dot).not.toBeNull();
    expect(mark).not.toBe(dot);
  });

  it('槽位不再常驻：idle 态无 14×14 占位，title 贴左为 title row 首个子元素', () => {
    // idle 态：槽位 span 不渲染，title 与下方时间行左对齐
    const { container } = renderItem(mkSession({ id: 's-slot', state: 'idle' }));
    const titleRow = container.querySelector('.min-w-0');
    expect(titleRow).not.toBeNull();
    const slot = titleRow?.querySelector('span:first-child');
    expect(slot).not.toBeNull();
    // 首个子元素即 title 本身（无 shrink-0 占位槽；title span 带 title 属性）
    expect(slot?.className).not.toContain('shrink-0');
    expect(slot?.getAttribute('title')).toBe('父会话');
  });

  it('running 态仍渲染 14×14 槽位（spinner 占位尺寸不变）', () => {
    const { container } = renderItem(mkSession({ id: 's-slot-run', state: 'running' }));
    const titleRow = container.querySelector('.min-w-0');
    const slot = titleRow?.querySelector('span:first-child');
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain('shrink-0');
    expect(slot?.className).toContain('w-[14px]');
    expect(slot?.className).toContain('h-[14px]');
  });
});
