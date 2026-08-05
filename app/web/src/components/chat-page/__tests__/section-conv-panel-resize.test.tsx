// @vitest-environment jsdom
/**
 * section-conv-panel 可拖宽接线单测
 * 参考: specs/ui/components/chat-page/_overview.md §4.1（可拖契约：180~400 默认 220）
 *
 * 覆盖 acceptanceCriteria：
 *   - 未传 onConvResize → 不挂拖宽手柄（纯展示消费方）
 *   - 传 onConvResize → 渲染 ComponentColResizeHandle（side=left、min=180、max=min(400,dragMaxWidth??400)）
 *   - 渲染宽受控：renderWidth 优先，未传回退 CONV_WIDTH_DEFAULT=220
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SectionConvPanel } from '../section-conv-panel';
import type { Session } from '../types';
import { initI18n } from '../../../i18n';
import { CONV_WIDTH_DEFAULT } from '../../../lib/layout-width-engine';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

interface RenderOpts {
  renderWidth?: number;
  dragMaxWidth?: number;
  onConvResize?: (w: number) => void;
  onConvDragStart?: () => void;
  onConvResizeEnd?: () => void;
}

function renderPanel(opts: RenderOpts = {}) {
  const handlers = {
    onConvResize: opts.onConvResize ?? vi.fn(),
    onConvDragStart: opts.onConvDragStart,
    onConvResizeEnd: opts.onConvResizeEnd,
  };
  const utils = render(
    <SectionConvPanel
      sessions={[mkSession({ id: 's1' })]}
      activeId={null}
      childrenByParent={{}}
      onSelect={() => {}}
      onSelectSub={() => {}}
      onCreate={() => {}}
      onDelete={() => {}}
      renderWidth={opts.renderWidth}
      dragMaxWidth={opts.dragMaxWidth}
      onConvResize={handlers.onConvResize}
      onConvDragStart={handlers.onConvDragStart}
      onConvResizeEnd={handlers.onConvResizeEnd}
    />,
  );
  return { ...utils, handlers };
}

/** conv-panel aside 容器 */
function getPanel(container: HTMLElement): HTMLElement {
  return container.querySelector('aside.border-r') as HTMLElement;
}

describe('SectionConvPanel 可拖宽接线', () => {
  it('未传 onConvResize → 不渲染拖宽手柄（向后兼容：纯展示消费方）', () => {
    const { container } = render(
      <SectionConvPanel
        sessions={[mkSession({ id: 's1' })]}
        activeId={null}
        childrenByParent={{}}
        onSelect={() => {}}
        onSelectSub={() => {}}
        onCreate={() => {}}
        onDelete={() => {}}
      />,
    );
    // panel 仍在 + 新建按钮 + 列表
    expect(getPanel(container)).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建会话' })).toBeTruthy();
    // 无 role=separator（拖宽手柄未挂载）
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('传 onConvResize → 渲染手柄（side=left，贴 panel 右缘 -right-0.5）', () => {
    renderPanel();
    const handle = screen.getByRole('separator');
    expect(handle).toBeTruthy();
    // side=left → class 含 -right-0.5（贴 panel 右缘）
    expect(handle.className).toContain('-right-0.5');
    expect(handle.className).not.toContain('-left-0.5');
  });

  it('渲染宽受控：renderWidth=350 → panel style.width="350px"', () => {
    const { container } = renderPanel({ renderWidth: 350 });
    expect(getPanel(container).style.width).toBe('350px');
  });

  it('未传 renderWidth → panel style.width 回退 CONV_WIDTH_DEFAULT=220', () => {
    const { container } = renderPanel();
    expect(getPanel(container).style.width).toBe(`${CONV_WIDTH_DEFAULT}px`);
  });

  it('panel className 含 relative（手柄 absolute 定位上下文）', () => {
    const { container } = renderPanel();
    const panel = getPanel(container);
    expect(panel.className).toContain('relative');
    // 旧的 w-[220px] 已删（不再硬编码宽度）
    expect(panel.className).not.toContain('w-[220px]');
  });

  it('dragMaxWidth=300 → 手柄 maxWidth clamp 到 300（min(400, 300)=300）', () => {
    const onResize = vi.fn();
    renderPanel({ onConvResize: onResize, dragMaxWidth: 300 });
    const handle = screen.getByRole('separator');
    // currentWidth 默认 220（CONV_WIDTH_DEFAULT）；mousedown@100 → mousemove@450 → dx=350 → raw=220+350=570
    // clamp(180, min(400, 300), 570) → clamp(180, 300, 570) = 300（动态上限赢）
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 450 });
    expect(onResize).toHaveBeenLastCalledWith(300);
  });

  it('未传 dragMaxWidth → 手柄 maxWidth 回退 CONV_WIDTH_MAX=400', () => {
    const onResize = vi.fn();
    renderPanel({ onConvResize: onResize });
    const handle = screen.getByRole('separator');
    // currentWidth=220；mousedown@0 → mousemove@300 → dx=300 → raw=520
    // clamp(180, 400, 520) = 400（静态上限赢）
    fireEvent.mouseDown(handle, { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: 300 });
    expect(onResize).toHaveBeenLastCalledWith(400);
  });

  it('onConvDragStart 在 mousedown 触发（父挂 setDragging("left")）', () => {
    const onConvDragStart = vi.fn();
    renderPanel({ onConvDragStart });
    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 100 });
    expect(onConvDragStart).toHaveBeenCalledTimes(1);
  });

  it('onConvResizeEnd 在 mouseup 触发（父 persist localStorage + setDragging(null)）', () => {
    const onConvResizeEnd = vi.fn();
    renderPanel({ onConvResizeEnd });
    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseUp(window);
    expect(onConvResizeEnd).toHaveBeenCalledTimes(1);
  });

  it('右键会话项弹 context menu（复制 Session ID）', () => {
    renderPanel();
    // 右键触发浮层
    const item = screen.getByText('会话 1', { selector: '[title]' }).closest('div.group') as HTMLElement;
    fireEvent.contextMenu(item, { clientX: 10, clientY: 10 });
    expect(screen.getByRole('button', { name: '复制 Session ID' })).toBeTruthy();
  });
});
