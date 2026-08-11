// @vitest-environment jsdom
/**
 * component-ws-resize-handle [v0.0.182] 改薄 wrapper 单测
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §4.2（[v0.0.182] delta 算法升级）
 *       specs/tech/version_logs/v0.0.182/change_plan.md §3（ws-resize-handle 改薄 wrapper）
 *
 * 覆盖 acceptanceCriteria：
 *   - 保 role=separator + i18n workspace.resize.* （ET 锚点）
 *   - delta 算法（side=right：鼠标左移 dx<0 → 宽变大）继承自 ComponentColResizeHandle
 *   - 父注入 props 正确透传：currentWidth / maxWidth / onResize / onDragStart / onResizeEnd
 *   - maxWidth clamp：min(WS_WIDTH_MAX, maxWidth ?? WS_WIDTH_MAX)
 */
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentWsResizeHandle } from '../component-ws-resize-handle';
import { initI18n } from '../../../i18n';
import { WS_WIDTH_MAX, WS_WIDTH_MIN } from '../../../lib/layout-width-engine';

beforeAll(async () => {
  await initI18n('zh-CN');
});

afterEach(() => {
  cleanup();
  // 复位 body style（跨用例隔离）
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  vi.restoreAllMocks();
});

describe('ComponentWsResizeHandle [v0.0.182] 薄 wrapper', () => {
  it('渲染 separator 手柄（ET 锚点）', () => {
    render(
      <ComponentWsResizeHandle currentWidth={272} onResize={() => {}} />,
    );
    expect(screen.getByRole('separator')).toBeTruthy();
  });

  it('挂 role=separator + aria-orientation=vertical（无障碍契约）', () => {
    render(
      <ComponentWsResizeHandle currentWidth={272} onResize={() => {}} />,
    );
    const handle = screen.getByRole('separator');
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('i18n workspace.resize.ariaLabel / title 注入', () => {
    render(
      <ComponentWsResizeHandle currentWidth={272} onResize={() => {}} />,
    );
    const handle = screen.getByRole('separator');
    // zh-CN chat.json workspace.resize.ariaLabel = 「拖动调节工作区宽度」
    expect(handle.getAttribute('aria-label')).toBe('拖动调节工作区宽度');
    expect(handle.getAttribute('title')).toBe('拖动调节宽度');
  });

  it('side=right：鼠标左移（dx<0）→ 宽变大；鼠标右移（dx>0）→ 宽变小', () => {
    const onResize = vi.fn();
    render(
      <ComponentWsResizeHandle currentWidth={300} onResize={onResize} />,
    );
    const handle = screen.getByRole('separator');
    // 起点 500，左移到 450 → dx=-50 → 宽 = 300-(-50) = 350
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 450 });
    expect(onResize).toHaveBeenLastCalledWith(350);

    // 继续右移回 500 → dx=0 → 宽 = 300
    fireEvent.mouseMove(window, { clientX: 500 });
    expect(onResize).toHaveBeenLastCalledWith(300);
  });

  it('clamp 到静态下限 WS_WIDTH_MIN=232：raw<232 → 232', () => {
    const onResize = vi.fn();
    render(
      <ComponentWsResizeHandle currentWidth={250} onResize={onResize} />,
    );
    const handle = screen.getByRole('separator');
    // dx=1000（右移 1000）→ raw = 250-1000 = -750 → clamp(232, 560, -750) = 232
    fireEvent.mouseDown(handle, { clientX: 0 });
    fireEvent.mouseMove(window, { clientX: 1000 });
    expect(onResize).toHaveBeenLastCalledWith(WS_WIDTH_MIN);
  });

  it('clamp 到静态上限 WS_WIDTH_MAX=1600：raw>1600 → 1600', () => {
    const onResize = vi.fn();
    render(
      <ComponentWsResizeHandle currentWidth={540} onResize={onResize} />,
    );
    const handle = screen.getByRole('separator');
    // dx=-2000（左移 2000）→ raw = 540-(-2000) = 2540 → clamp(232, 1600, 2540) = 1600
    fireEvent.mouseDown(handle, { clientX: 2000 });
    fireEvent.mouseMove(window, { clientX: 0 });
    expect(onResize).toHaveBeenLastCalledWith(WS_WIDTH_MAX);
  });

  it('动态上限：maxWidth=400 → clamp 到 400 赢（min(560, 400)=400）', () => {
    const onResize = vi.fn();
    render(
      <ComponentWsResizeHandle
        currentWidth={380}
        maxWidth={400}
        onResize={onResize}
      />,
    );
    const handle = screen.getByRole('separator');
    // 起点 100，左移到 -200 → dx=-300 → raw = 380-(-300)=680
    // clamp(232, min(560, 400)=400, 680) = 400（动态上限赢）
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: -200 });
    expect(onResize).toHaveBeenLastCalledWith(400);
  });

  it('onDragStart 在 mousedown 触发（父挂 setDragging("right")）', () => {
    const onDragStart = vi.fn();
    render(
      <ComponentWsResizeHandle
        currentWidth={272}
        onResize={() => {}}
        onDragStart={onDragStart}
      />,
    );
    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 500 });
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });

  it('onResizeEnd 在 mouseup 触发（父 persist + setDragging(null)）', () => {
    const onResizeEnd = vi.fn();
    render(
      <ComponentWsResizeHandle
        currentWidth={272}
        onResize={() => {}}
        onResizeEnd={onResizeEnd}
      />,
    );
    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 500 });
    fireEvent.mouseUp(window);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it('mousedown → body cursor=col-resize + userSelect=none（继承通用手柄行为）', () => {
    render(
      <ComponentWsResizeHandle currentWidth={272} onResize={() => {}} />,
    );
    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 500 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
  });
});
