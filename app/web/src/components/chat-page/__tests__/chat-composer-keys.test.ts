/**
 * chat-composer-keys（resolveEnterAction）单测
 * 参考: specs/ui/components/chat-page/chat-composer.md §发送 / §状态-交互
 *
 * 覆盖：
 *   - 纯 Enter（无修饰键 + 非 IME）→ 'send'
 *   - Shift+Enter / Cmd+Enter / Ctrl+Enter → 'newline'
 *   - IME 组词中（isComposing / keyCode 229）→ 'ignore'
 *   - 非 Enter 键 → 'ignore'
 *   - 修饰键 + IME 同时存在 → 'ignore'（IME 优先，不发送、不换行）
 */
import { describe, it, expect } from 'vitest';
import { resolveEnterAction } from '../chat-composer-keys';

/** 构造键盘事件（最小可测字段） */
function keyEvent(
  key: string,
  opts: {
    shiftKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  } = {},
): KeyboardEvent {
  return {
    key,
    shiftKey: opts.shiftKey ?? false,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    isComposing: opts.isComposing ?? false,
    keyCode: opts.keyCode ?? 13, // Enter 默认 keyCode
  } as unknown as KeyboardEvent;
}

describe('resolveEnterAction — 纯 Enter（无修饰键）', () => {
  it('Enter 无修饰键 非 IME → send', () => {
    expect(resolveEnterAction(keyEvent('Enter'))).toBe('send');
  });

  it('Enter keyCode 13 但 key 不是 Enter → ignore（防御性，key 字段为准）', () => {
    expect(resolveEnterAction(keyEvent('a'))).toBe('ignore');
  });
});

describe('resolveEnterAction — 修饰键 → newline', () => {
  it('Shift+Enter → newline', () => {
    expect(resolveEnterAction(keyEvent('Enter', { shiftKey: true }))).toBe('newline');
  });

  it('Cmd+Enter（metaKey）→ newline', () => {
    expect(resolveEnterAction(keyEvent('Enter', { metaKey: true }))).toBe('newline');
  });

  it('Ctrl+Enter → newline', () => {
    expect(resolveEnterAction(keyEvent('Enter', { ctrlKey: true }))).toBe('newline');
  });

  it('Shift+Cmd+Enter（多修饰键同时按）→ newline（任一修饰键即 newline）', () => {
    expect(resolveEnterAction(keyEvent('Enter', { shiftKey: true, metaKey: true }))).toBe('newline');
  });

  it('Shift+Ctrl+Enter → newline', () => {
    expect(resolveEnterAction(keyEvent('Enter', { shiftKey: true, ctrlKey: true }))).toBe('newline');
  });
});

describe('resolveEnterAction — IME guard → ignore', () => {
  it('Enter + isComposing=true → ignore（IME 组词中，不发送不换行）', () => {
    expect(resolveEnterAction(keyEvent('Enter', { isComposing: true }))).toBe('ignore');
  });

  it('Enter + keyCode 229 → ignore（IME 复合输入标准 keyCode）', () => {
    expect(resolveEnterAction(keyEvent('Enter', { keyCode: 229 }))).toBe('ignore');
  });

  it('Shift+Enter + isComposing=true → ignore（IME 优先于修饰键）', () => {
    // IME 组词期间用户按 Shift+Enter 通常是确认候选词，不应触发换行/发送
    expect(resolveEnterAction(keyEvent('Enter', { shiftKey: true, isComposing: true }))).toBe('ignore');
  });

  it('Cmd+Enter + isComposing=true → ignore（IME 优先）', () => {
    expect(resolveEnterAction(keyEvent('Enter', { metaKey: true, isComposing: true }))).toBe('ignore');
  });
});

describe('resolveEnterAction — 非 Enter 键 → ignore', () => {
  it('Shift → ignore', () => {
    expect(resolveEnterAction(keyEvent('Shift'))).toBe('ignore');
  });

  it('a → ignore', () => {
    expect(resolveEnterAction(keyEvent('a'))).toBe('ignore');
  });

  it('Escape → ignore（Esc 关闭 popover 由外层 handleKeyDown 处理，不在本函数职责）', () => {
    expect(resolveEnterAction(keyEvent('Escape'))).toBe('ignore');
  });

  it('Backspace → ignore（Tiptap 默认 pill 删除行为）', () => {
    expect(resolveEnterAction(keyEvent('Backspace'))).toBe('ignore');
  });

  it('ArrowDown → ignore（方向键，Tiptap 默认）', () => {
    expect(resolveEnterAction(keyEvent('ArrowDown'))).toBe('ignore');
  });
});
