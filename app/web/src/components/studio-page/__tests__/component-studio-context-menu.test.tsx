/**
 * @vitest-environment jsdom
 * component-studio-context-menu 单测 —— v0.0.168 抽出为共享 primitive
 * 参考: specs/ui/components/studio-page/component-studio-context-menu.md
 *       memory: dropdown-close-listener-defer-register（setTimeout 0 延迟挂关闭监听）
 *
 * 覆盖：
 * - 渲染：容器 + copy-id button 存在，fixed 定位在 (x, y)
 * - 点 copy-id → navigator.clipboard.writeText(sessionId) + onClose 触发
 * - Escape 键 → onClose
 * - window click / contextmenu → onClose（打开菜单同次事件不误关，setTimeout 延迟注册）
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { StudioContextMenu } from '../component-studio-context-menu';

const writeText = vi.fn();
beforeAll(async () => {
  await initI18n('zh-CN');
  Object.assign(navigator, { clipboard: { writeText } });
});
afterEach(() => {
  cleanup();
  writeText.mockReset();
});

/** 复制按钮（菜单唯一菜单项） */
const copyBtn = () => screen.getByRole('button', { name: '复制 Session ID' });

describe('StudioContextMenu — 基础渲染', () => {
  it('渲染容器 + copy-id button 存在；fixed 定位在 (x, y)', () => {
    render(<StudioContextMenu sessionId="sess-a" x={180} y={240} onClose={() => {}} />);
    const menu = copyBtn().parentElement as HTMLElement;
    expect(menu).toBeTruthy();
    expect(menu.style.left).toBe('180px');
    expect(menu.style.top).toBe('240px');
    expect(copyBtn()).toBeTruthy();
  });

  it('v0.0.168.1 修 BUG-001 同类：浮层 portal 到 document.body 直下（脱离祖先 transform 劫持）', () => {
    render(<StudioContextMenu sessionId="sess-a" x={180} y={240} onClose={() => {}} />);
    const menu = copyBtn().parentElement as HTMLElement;
    expect(menu.parentElement).toBe(document.body);
  });

  it('v0.0.168.1 portal 后：卸载 → 浮层从 body 清理干净（无 DOM 泄漏）', () => {
    const { unmount } = render(<StudioContextMenu sessionId="sess-a" x={10} y={20} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: '复制 Session ID' })).toBeTruthy();
    unmount();
    expect(screen.queryByRole('button', { name: '复制 Session ID' })).toBeNull();
  });
});

describe('StudioContextMenu — 交互', () => {
  it('点 copy-id → clipboard.writeText(sessionId) + onClose', () => {
    const onClose = vi.fn();
    writeText.mockResolvedValue(undefined);
    render(<StudioContextMenu sessionId="sess-x" x={10} y={20} onClose={onClose} />);
    fireEvent.click(copyBtn());
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('sess-x');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape → onClose', async () => {
    const onClose = vi.fn();
    render(<StudioContextMenu sessionId="sess-x" x={10} y={20} onClose={onClose} />);
    // 等 setTimeout(0) 挂 listener
    await waitFor(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('setTimeout(0) 延迟挂关闭监听：同次事件冒泡不误关（回归契约）', () => {
    // 关闭机制的核心不变量——菜单打开的同一次 click/contextmenu 事件冒泡到 window，
    // listener 尚未挂上（setTimeout 未 flush），不应触发 onClose。
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      render(<StudioContextMenu sessionId="sess-x" x={10} y={20} onClose={onClose} />);
      // fake timers 下 setTimeout(0) 未 flush → listener 还没挂
      // 手动派发一次 window click / contextmenu → 不应关闭菜单
      window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      window.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
      expect(onClose).not.toHaveBeenCalled();
      // 推进 setTimeout → listener 挂上 → 触发下一次 window click → 关闭
      act(() => {
        vi.runAllTimers();
        window.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
