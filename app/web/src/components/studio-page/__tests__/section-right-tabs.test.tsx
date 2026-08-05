// @vitest-environment jsdom
/**
 * section-right-tabs 单测（v0.0.63 F5：退化为薄 wrapper）
 * 参考: specs/prd/version_logs/v0.0.63.ui_opt.md §3.5（F5 双重 tab bar 重复修复 + UC-3.5.1/2）
 *       specs/tech/version_logs/v0.0.63.ui_opt/change_log.md §6（薄 wrapper 目标形态）
 *
 * 覆盖（P6 关键路径）：
 *   - 渲染 <SectionWorkspacePanel>（ws-panel 出现 1 次，sessionId 透传）
 *   - 不渲染重复的 tab bar（wrapper 仅含 ws-panel 一个子节点）
 *   - 不渲染原 collapse btn（wrapper 内无额外按钮）
 *   - 保留 aside wrapper + data-workspace-semantic 标记
 *   - workspaceSemantic='team' / 'personal' 均透传到 wrapper attr
 *
 * 隔离：mock SectionWorkspacePanel 为简单 stub（避免侵入 chat-api/store/SSE 等）
 *   —— stub 内含「工作区」按钮，验证 tab bar 唯一性。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

// vi.mock 用绝对路径（MEMORY: bun+jsdom 并发下相对路径静默失效）
const wsPanelPath = vi.hoisted(() =>
  require('node:path').resolve(__dirname, '../../chat-page/section-workspace-panel'),
);
vi.mock(wsPanelPath, () => ({
  SectionWorkspacePanel: ({ sessionId }: { sessionId: string }) => (
    <div data-session-id={sessionId}>
      <button>工作区</button>
    </div>
  ),
}));

import { SectionRightTabs } from '../section-right-tabs';

afterEach(() => cleanup());

describe('SectionRightTabs — 薄 wrapper（F5）', () => {
  it('渲染 <SectionWorkspacePanel>（ws-panel 出现且仅一次，sessionId 透传）', () => {
    const { container } = render(<SectionRightTabs sessionId="sl" workspaceSemantic="team" />);

    const wsPanels = container.querySelectorAll('[data-session-id]');
    expect(wsPanels.length).toBe(1);
    expect(wsPanels[0]!.getAttribute('data-session-id')).toBe('sl');
  });

  it('不渲染重复的 tab bar（wrapper 仅含 ws-panel 一个子节点）', () => {
    const { container } = render(<SectionRightTabs sessionId="sl" workspaceSemantic="team" />);

    // aside wrapper 只有 ws-panel 一个直接子节点（无自造 tab bar 兄弟节点）
    const aside = container.querySelector('aside')!;
    expect(aside.children.length).toBe(1);
  });

  it('不渲染原 collapse btn（wrapper 内仅 ws-panel 的「工作区」一个按钮）', () => {
    render(<SectionRightTabs sessionId="sl" workspaceSemantic="team" />);

    // 无 collapse/expand 等额外按钮——全部按钮仅 ws-panel 内部一个
    expect(screen.getAllByRole('button').length).toBe(1);
  });

  it('保留 aside wrapper', () => {
    const { container } = render(<SectionRightTabs sessionId="sl" workspaceSemantic="team" />);

    expect(container.querySelector('aside')).toBeTruthy();
  });

  it('保留 data-workspace-semantic 标记（team / personal 透传）', () => {
    const { container, rerender } = render(<SectionRightTabs sessionId="sl" workspaceSemantic="team" />);
    expect(container.querySelector('aside')!.getAttribute('data-workspace-semantic')).toBe('team');

    rerender(<SectionRightTabs sessionId="sl" workspaceSemantic="personal" />);
    expect(container.querySelector('aside')!.getAttribute('data-workspace-semantic')).toBe('personal');
  });

  it('tab bar 唯一：「工作区」tab 出现 1 次（来自内部 ws-panel，wrapper 不重复造）', () => {
    render(<SectionRightTabs sessionId="sl" workspaceSemantic="team" />);

    expect(screen.getAllByRole('button', { name: '工作区' }).length).toBe(1);
  });
});

// ── 4 透传 props（renderWidth/dragMaxWidth/onLayoutChange/onDragModeChange） ──
// 参考: specs/tech/version_logs/v0.0.182/change_plan.md §3 studio 模块行
//        specs/ui/components/studio-page/section-right-tabs.md §3 注（v1.4）

// 重 mock SectionWorkspacePanel：捕获 4 props（原 mock 仅解构 sessionId）
const wsPanelCapture = vi.hoisted(() => ({
  lastProps: null as null | Record<string, unknown>,
}));
vi.mock(wsPanelPath, () => ({
  SectionWorkspacePanel: (props: Record<string, unknown>) => {
    wsPanelCapture.lastProps = props;
    return (
      <div data-session-id={props.sessionId as string}>
        <button>工作区</button>
      </div>
    );
  },
}));

describe('SectionRightTabs [v0.0.182] 4 透传 props', () => {
  afterEach(() => {
    cleanup();
    wsPanelCapture.lastProps = null;
  });

  it('4 可选 props 原样透传 SectionWorkspacePanel（renderWidth/dragMaxWidth/onLayoutChange/onDragModeChange）', () => {
    const onLayoutChange = vi.fn();
    const onDragModeChange = vi.fn();
    render(
      <SectionRightTabs
        sessionId="sl"
        workspaceSemantic="team"
        renderWidth={300}
        dragMaxWidth={480}
        onLayoutChange={onLayoutChange}
        onDragModeChange={onDragModeChange}
      />,
    );

    expect(wsPanelCapture.lastProps).toBeTruthy();
    expect(wsPanelCapture.lastProps!.sessionId).toBe('sl');
    expect(wsPanelCapture.lastProps!.renderWidth).toBe(300);
    expect(wsPanelCapture.lastProps!.dragMaxWidth).toBe(480);
    expect(wsPanelCapture.lastProps!.onLayoutChange).toBe(onLayoutChange);
    expect(wsPanelCapture.lastProps!.onDragModeChange).toBe(onDragModeChange);
  });

  it('4 可选 props 缺省 → ws-panel 收到 undefined（向后兼容既有消费方）', () => {
    render(<SectionRightTabs sessionId="sl" workspaceSemantic="team" />);

    expect(wsPanelCapture.lastProps).toBeTruthy();
    expect(wsPanelCapture.lastProps!.sessionId).toBe('sl');
    expect(wsPanelCapture.lastProps!.renderWidth).toBeUndefined();
    expect(wsPanelCapture.lastProps!.dragMaxWidth).toBeUndefined();
    expect(wsPanelCapture.lastProps!.onLayoutChange).toBeUndefined();
    expect(wsPanelCapture.lastProps!.onDragModeChange).toBeUndefined();
  });

  it('wrapper aside 结构零改动（flex shrink-0 min-w-0 className + data-workspace-semantic）', () => {
    const { container } = render(<SectionRightTabs sessionId="sl" workspaceSemantic="team" renderWidth={300} />);

    const aside = container.querySelector('aside')!;
    expect(aside.tagName).toBe('ASIDE');
    expect(aside.className).toContain('flex');
    expect(aside.className).toContain('shrink-0');
    expect(aside.className).toContain('min-w-0');
    expect(aside.getAttribute('data-workspace-semantic')).toBe('team');
  });
});
