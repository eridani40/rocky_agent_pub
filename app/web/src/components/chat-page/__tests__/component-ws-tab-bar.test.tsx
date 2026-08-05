// @vitest-environment jsdom
/**
 * component-ws-tab-bar 单测
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §6.3
 *
 * 「长期记忆」「定时任务」tab 已移除（收纳进右上悬浮菜单弹层），ws-tab-bar 仅剩
 * 「工作区」单栏，无 tab 切换 state。
 * 验证单栏渲染 + actions（swap/refresh/collapse）功能正确。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentWsTabBar } from '../component-ws-tab-bar';

afterEach(() => cleanup());

function renderBar(overrides: Partial<Parameters<typeof ComponentWsTabBar>[0]> = {}) {
  return render(
    <ComponentWsTabBar
      onSwitchDir={() => {}}
      onRefresh={() => {}}
      onCollapse={() => {}}
      refreshing={false}
      {...overrides}
    />,
  );
}

describe('ComponentWsTabBar — 单栏「工作区」', () => {
  it('仅渲染工作区栏，无 memory/cron tab', () => {
    renderBar();
    // i18n 未初始化时渲染 raw key
    expect(screen.getByText('workspace.tab.workspace')).toBeTruthy();
    expect(screen.queryByText('workspace.tab.memory')).toBeNull();
  });

  it('.ws-tabs 容器含 overflow-hidden（窄宽度裁剪溢出，视觉基线不变）', () => {
    renderBar();
    const container = screen.getByText('workspace.tab.workspace').closest('.ws-tabs');
    expect(container).toBeTruthy();
    expect(container!.className).toContain('overflow-hidden');
  });

  it('视觉基线不变：字号 12px / 600 weight + border-b-2 + accent 色（恒 active）', () => {
    renderBar();
    const ws = screen.getByText('workspace.tab.workspace').closest('.ws-tab')!;
    expect(ws.className).toContain('text-[12px]');
    expect(ws.className).toContain('font-semibold');
    expect(ws.className).toContain('border-b-2');
    expect(ws.className).toContain('text-accent');
    expect(ws.className).toContain('border-accent');
  });

  it('actions：点 switch/refresh/collapse 均触发对应回调', () => {
    const onSwitchDir = vi.fn();
    const onRefresh = vi.fn();
    const onCollapse = vi.fn();
    renderBar({ onSwitchDir, onRefresh, onCollapse });
    fireEvent.click(screen.getByRole('button', { name: 'workspace.tab.switchDir' }));
    expect(onSwitchDir).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'workspace.tab.refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'workspace.tab.collapse' }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('refreshing=true → refresh 按钮 disabled', () => {
    renderBar({ refreshing: true });
    const btn = screen.getByRole('button', { name: 'workspace.tab.refresh' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
