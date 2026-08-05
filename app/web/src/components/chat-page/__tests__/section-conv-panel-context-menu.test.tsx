// @vitest-environment jsdom
/**
 * section-conv-panel 右键浮层菜单单测（v0.0.129）
 * 参考: specs/ui/components/chat-page/_overview.md §4.1（conv-panel 右键菜单：复制 Session ID）
 *
 * 覆盖：
 *   - 右键会话项 → 浮层菜单出现（testid conv-context-menu）+ copy-id button 可见 + 定位
 *   - 点 copy-id → navigator.clipboard.writeText(sessionId) + 浮层关闭
 *   - Escape / window click 关闭
 *   - 打开菜单的同一次 contextmenu 事件不立即关闭菜单（延迟注册回归——用户实测 bug）
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { SectionConvPanel } from '../section-conv-panel';
import type { Session } from '../types';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

// mock navigator.clipboard.writeText（jsdom 默认无 clipboard）
const writeText = vi.fn();
beforeAll(() => {
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
  writeText.mockReset();
});

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: '会话 1',
    status: 'active',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-27T00:00:00.000Z',
    ...overrides,
  };
}

function renderPanel(session: Session) {
  return render(
    <SectionConvPanel
      sessions={[session]}
      activeId={null}
      childrenByParent={{}}
      onSelect={() => {}}
      onSelectSub={() => {}}
      onCreate={() => {}}
      onDelete={() => {}}
    />,
  );
}

/** 通过标题定位 conv-item 行容器 */
function getConvItem(): HTMLElement {
  return screen.getByText('会话 1', { selector: '[title]' }).closest('div.group') as HTMLElement;
}

/** 右键浮层菜单容器（copy-id 按钮的外层 fixed div）；未打开返 null */
function queryMenu(): HTMLElement | null {
  const btn = screen.queryByRole('button', { name: '复制 Session ID' });
  return btn ? (btn.closest('div.fixed') as HTMLElement) : null;
}

describe('SectionConvPanel 右键菜单（v0.0.129）', () => {
  it('右键会话项 → 浮层菜单出现（testid + copy-id + 定位）', () => {
    renderPanel(mkSession({ id: 's1' }));
    expect(queryMenu()).toBeNull();
    fireEvent.contextMenu(getConvItem(), { clientX: 150, clientY: 200 });
    const menu = queryMenu();
    expect(menu).toBeTruthy();
    expect((menu as HTMLElement).style.left).toBe('150px');
    expect((menu as HTMLElement).style.top).toBe('200px');
    expect(screen.getByRole('button', { name: '复制 Session ID' })).toBeTruthy();
  });

  it('点 copy-id → clipboard.writeText(sessionId) + 浮层关闭', async () => {
    renderPanel(mkSession({ id: 's1' }));
    fireEvent.contextMenu(getConvItem(), { clientX: 10, clientY: 10 });
    writeText.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole('button', { name: '复制 Session ID' }));
    expect(writeText).toHaveBeenCalledWith('s1');
    await waitFor(() => {
      expect(queryMenu()).toBeNull();
    });
  });

  it('Escape 关闭浮层', async () => {
    renderPanel(mkSession({ id: 's1' }));
    fireEvent.contextMenu(getConvItem(), { clientX: 10, clientY: 10 });
    expect(queryMenu()).toBeTruthy();
    // 等 window listener 延迟注册完成（setTimeout 0）再按 Escape
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(queryMenu()).toBeNull();
    });
  });

  it('浮层打开时 window click 关闭', async () => {
    renderPanel(mkSession({ id: 's1' }));
    fireEvent.contextMenu(getConvItem(), { clientX: 10, clientY: 10 });
    expect(queryMenu()).toBeTruthy();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => {
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await waitFor(() => {
      expect(queryMenu()).toBeNull();
    });
  });

  it('打开菜单的同一次 contextmenu 事件不立即关闭菜单（延迟注册回归）', () => {
    // 回归：window contextmenu listener 若同步注册，则打开菜单的这次事件冒泡到
    // window 会立刻触发 close，菜单一开就关（用户实测 bug）。修法=setTimeout 延迟注册。
    vi.useFakeTimers();
    try {
      renderPanel(mkSession({ id: 's1' }));
      // 右键打开菜单（这次 contextmenu 事件会冒泡到 window）
      fireEvent.contextMenu(getConvItem(), { clientX: 30, clientY: 40 });
      // 模拟同一次事件冒泡到 window：listener 尚未注册（setTimeout 未 flush）→ 菜单应仍在
      act(() => {
        window.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });
      expect(queryMenu()).toBeTruthy();
      // flush setTimeout → listener 注册完成，此后新的 window contextmenu 才关闭
      act(() => {
        vi.runAllTimers();
      });
      act(() => {
        window.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      });
      expect(queryMenu()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
