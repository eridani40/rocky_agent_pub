// @vitest-environment jsdom
/**
 * section-workspace-panel 三栏接线 4 可选 props 单测
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §4.2（delta 算法升级）
 *
 * 覆盖 acceptanceCriteria：
 *   - 4 可选 props 全可选：未传时既有行为不变（渲染 ws-panel + 拖宽走内部 width state）
 *   - renderWidth 优先于内部 width state（aside style.width = renderWidth ?? width）
 *   - report effect：仅 width/collapsed 值变化时上报 {settingWidth, collapsed}
 *   - onDragModeChange(true) 在 mousedown 拖拽时触发；onDragModeChange(false) 在 mouseup 触发
 *
 * mock 策略：vi.hoisted + __dirname 派生绝对路径 mock chat-api。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { initI18n } from '../../../i18n';

const { getWorkspaceTreeMock, watchMock, unwatchMock, chatApiPath } = vi.hoisted(() => ({
  getWorkspaceTreeMock: vi.fn(),
  watchMock: vi.fn(),
  unwatchMock: vi.fn(),
  chatApiPath: require('node:path').resolve(__dirname, '../../../lib/chat-api.ts'),
}));

vi.mock(chatApiPath, () => ({
  getWorkspaceTree: (...args: unknown[]) => getWorkspaceTreeMock(...args),
  openWorkspaceItem: vi.fn(async () => ({ ok: true })),
  pickWorkspaceDirectory: vi.fn(async () => ({ path: null })),
  updateSession: vi.fn(async () => ({})),
  watchWorkspaceDir: (...args: unknown[]) => watchMock(...args),
  unwatchWorkspaceDir: (...args: unknown[]) => unwatchMock(...args),
}));

import { SectionWorkspacePanel } from '../section-workspace-panel';
import { useChatStore } from '../../../store/chat-slice';

const ROOT_TREE = {
  workspaceDir: '/tmp/ws',
  tree: [
    { name: 'readme.md', path: 'readme.md', type: 'file' as const, hasChildren: false },
  ],
};

beforeAll(async () => {
  await initI18n('zh-CN');
});

beforeEach(() => {
  getWorkspaceTreeMock.mockReset();
  watchMock.mockReset();
  unwatchMock.mockReset();
  getWorkspaceTreeMock.mockResolvedValue(ROOT_TREE);
  watchMock.mockResolvedValue({ ok: true });
  unwatchMock.mockResolvedValue({ ok: true });
  useChatStore.getState().setLastWorkspaceEvent(null);
});

afterEach(() => {
  cleanup();
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
});

/** ws-panel aside 容器（异步等待挂载） */
async function findPanel(container: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => expect(container.querySelector('.ws-panel')).toBeTruthy());
  return container.querySelector('.ws-panel') as HTMLElement;
}

describe('SectionWorkspacePanel 4 可选 props + 三栏接线', () => {
  it('未传 4 可选 props → ws-panel 渲染、既有行为不变', async () => {
    const { container } = render(<SectionWorkspacePanel sessionId="sess-1" />);
    const panel = await findPanel(container);
    expect(panel).toBeTruthy();
    // ws-resize 手柄仍在（薄 wrapper）
    expect(screen.getByLabelText('拖动调节工作区宽度')).toBeTruthy();
    // style.width = 内部 width state（默认 272，readWsWidth）
    // jsdom 下 localStorage 空回退默认 272
    expect(panel.style.width).toBe('272px');
  });

  it('renderWidth 优先：传 renderWidth=350 → aside style.width="350px"', async () => {
    const { container } = render(<SectionWorkspacePanel sessionId="sess-1" renderWidth={350} />);
    const panel = await findPanel(container);
    expect(panel.style.width).toBe('350px');
  });

  it('report effect：mount + width/collapsed 值变化时上报 {settingWidth, collapsed}', async () => {
    const onLayoutChange = vi.fn();
    const { container } = render(
      <SectionWorkspacePanel sessionId="sess-1" onLayoutChange={onLayoutChange} />,
    );
    await findPanel(container);
    // mount 后 effect 首跑：上报初始 {settingWidth:272, collapsed:false}
    await waitFor(() => {
      expect(onLayoutChange).toHaveBeenCalledWith({ settingWidth: 272, collapsed: false });
    });
  });

  it('onDragModeChange(true) 在 mousedown 拖拽时触发', async () => {
    const onDragModeChange = vi.fn();
    render(
      <SectionWorkspacePanel
        sessionId="sess-1"
        renderWidth={300}
        onDragModeChange={onDragModeChange}
      />,
    );
    const handle = await screen.findByLabelText('拖动调节工作区宽度');
    fireEvent.mouseDown(handle, { clientX: 500 });
    expect(onDragModeChange).toHaveBeenCalledWith(true);
  });

  it('onDragModeChange(false) 在 mouseup 触发（拖拽结束）', async () => {
    const onDragModeChange = vi.fn();
    render(
      <SectionWorkspacePanel
        sessionId="sess-1"
        renderWidth={300}
        onDragModeChange={onDragModeChange}
      />,
    );
    const handle = await screen.findByLabelText('拖动调节工作区宽度');
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseUp(window);
    // true 在 mousedown，false 在 mouseup（两次调用）
    expect(onDragModeChange).toHaveBeenNthCalledWith(1, true);
    expect(onDragModeChange).toHaveBeenNthCalledWith(2, false);
  });

  it('收起态：仍渲染 ws-rail + collapsed 上报', async () => {
    // 预置 localStorage 使初始 collapsed=true
    localStorage.setItem('ws-collapsed-sess-1', 'true');
    const onLayoutChange = vi.fn();
    render(
      <SectionWorkspacePanel sessionId="sess-1" onLayoutChange={onLayoutChange} />,
    );
    // ws-rail 展开按钮（aria-label 展开工作区面板）
    await screen.findByLabelText('展开工作区面板');
    // collapsed=true 上报
    await waitFor(() => {
      expect(onLayoutChange).toHaveBeenCalledWith(
        expect.objectContaining({ collapsed: true }),
      );
    });
    localStorage.removeItem('ws-collapsed-sess-1');
  });

  it('拖拽时 currentWidth = renderWidth ?? width（renderWidth=300 时用 300）', async () => {
    const onResize = vi.fn();
    // 通过 onLayoutChange 截获内部 width state 变化
    render(
      <SectionWorkspacePanel
        sessionId="sess-1"
        renderWidth={300}
        onLayoutChange={(r) => onResize(r.settingWidth)}
      />,
    );
    const handle = await screen.findByLabelText('拖动调节工作区宽度');
    // 起点 500，左移到 450 → dx=-50 → 宽=300-(-50)=350
    // onLayoutChange 会上报新 settingWidth（350）= 内部 setWidth 触发的值
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 450 });
    await waitFor(() => {
      expect(onResize).toHaveBeenCalledWith(350);
    });
  });

  it('i18n workspace.resize.* 仍正确注入（ET 锚点 i18n key 不变）', async () => {
    render(<SectionWorkspacePanel sessionId="sess-1" />);
    const handle = await screen.findByLabelText('拖动调节工作区宽度');
    expect(handle.getAttribute('aria-label')).toBe('拖动调节工作区宽度');
    expect(handle.getAttribute('title')).toBe('拖动调节宽度');
  });
});
