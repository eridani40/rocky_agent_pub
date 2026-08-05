// @vitest-environment jsdom
/**
 * component-ws-path-bar 单测 —— hover「打开文件夹」按钮 + click onOpenRoot
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §4.4.1 + §6.4
 * 验证：按钮始终在 DOM（布局稳定性 MANDATORY，opacity 0 预留零位移）+ 点击触发 onOpenRoot。
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentWsPathBar } from '../component-ws-path-bar';
import { initI18n } from '../../../i18n';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => cleanup());

describe('ComponentWsPathBar — hover 打开文件夹按钮', () => {
  it('打开文件夹按钮始终在 DOM（布局稳定性：opacity 0 预留零位移）', () => {
    render(
      <ComponentWsPathBar
        workspaceDir="/tmp/session-1"
        sessionId="s1"
        onOpenRoot={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: '打开文件夹' });
    expect(btn).toBeTruthy();
    // opacity 0 默认（按钮存在但视觉隐藏，预留 22×22 空间不位移）
    expect(btn.className).toContain('opacity-0');
    // group-hover:opacity-100 切换可见，不靠 display:none ↔ block
    expect(btn.className).toContain('group-hover:opacity-100');
    // flex-shrink:0 预留空间
    expect(btn.className).toContain('flex-shrink-0');
  });

  it('点击打开文件夹按钮触发 onOpenRoot 一次', () => {
    const onOpenRoot = vi.fn();
    render(
      <ComponentWsPathBar
        workspaceDir="/tmp/session-1"
        sessionId="s1"
        onOpenRoot={onOpenRoot}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '打开文件夹' }));
    expect(onOpenRoot).toHaveBeenCalledTimes(1);
  });

  it('未传 onOpenRoot 时点击不抛错（防御）', () => {
    render(<ComponentWsPathBar workspaceDir="/tmp/x" sessionId="s1" />);
    expect(() => fireEvent.click(screen.getByRole('button', { name: '打开文件夹' }))).not.toThrow();
  });

  it('.ws-path 容器为 flex（路径文本 + 按钮槽位），文本 span flex-1 + truncate', () => {
    const { container } = render(
      <ComponentWsPathBar
        workspaceDir="/tmp/session-1"
        sessionId="s1"
        onOpenRoot={() => {}}
      />,
    );
    const path = container.querySelector('.ws-path')!;
    expect(path.className).toContain('flex');
    const span = path.querySelector('span');
    expect(span).toBeTruthy();
    expect(span!.className).toContain('flex-1');
    expect(span!.className).toContain('truncate');
  });

  it('workspaceDir 为空时显示占位「未设置」+ title 走占位', () => {
    const { container } = render(<ComponentWsPathBar workspaceDir="" sessionId="s1" onOpenRoot={() => {}} />);
    const path = container.querySelector('.ws-path')!;
    expect(path.textContent).toContain('未设置');
  });
});
