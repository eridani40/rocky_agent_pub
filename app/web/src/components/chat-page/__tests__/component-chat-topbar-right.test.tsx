/**
 * @vitest-environment jsdom
 * component-chat-topbar-right 单测 —— topbar 右侧复合（UsagePanel + CompactBtn + ClearBtn）
 * 参考: specs/ui/components/chat-page/_overview.md §4.4
 *
 * 覆盖：
 * ① 默认（hideClear=false）→ 渲 usage panel + compact + clear（三件套齐全）
 * ② hideClear=true → 仅 usage + compact（无 clear，readOnly 分支用）
 * ③ onCompact 点击触发回调
 * ④ onClear 点击触发回调
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { ComponentChatTopbarRight } from '../component-chat-topbar-right';

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  cleanup();
});
afterEach(() => {
  cleanup();
});

describe('ComponentChatTopbarRight（topbar 右侧复合）', () => {
  it('① 默认（hideClear=false）→ 三件套齐全', () => {
    render(
      <ComponentChatTopbarRight
        usage={null}
        summaryTask={null}
        sessionBusy={false}
        onCompact={() => {}}
        onClear={() => {}}
      />,
    );
    // usage panel（展开按钮存在）+ compact + clear
    expect(screen.getByRole('button', { name: '展开用量' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '压缩上下文 (Compact)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '清空会话 (Clear)' })).toBeTruthy();
  });

  it('② hideClear=true → 无 clear（readOnly 分支用，subagent 不可清空）', () => {
    render(
      <ComponentChatTopbarRight
        usage={null}
        summaryTask={null}
        sessionBusy={false}
        onCompact={() => {}}
        onClear={() => {}}
        hideClear
      />,
    );
    expect(screen.queryByRole('button', { name: '清空会话 (Clear)' })).toBeNull();
    // usage + compact 仍渲
    expect(screen.getByRole('button', { name: '展开用量' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '压缩上下文 (Compact)' })).toBeTruthy();
  });

  it('③ 点 compact → onCompact 回调', () => {
    const onCompact = vi.fn();
    render(
      <ComponentChatTopbarRight
        usage={null}
        summaryTask={null}
        sessionBusy={false}
        onCompact={onCompact}
        onClear={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '压缩上下文 (Compact)' }));
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it('④ 点 clear → onClear 回调', () => {
    const onClear = vi.fn();
    render(
      <ComponentChatTopbarRight
        usage={null}
        summaryTask={null}
        sessionBusy={false}
        onCompact={() => {}}
        onClear={onClear}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '清空会话 (Clear)' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
