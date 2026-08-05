// @vitest-environment jsdom
/**
 * component-col-resize-handle 单测 —— T2 通用拖拽手柄 delta 算法（无死区）
 * 参考: specs/tech/version_logs/v0.0.182/change_plan.md §3（resize-handle 模块契约）
 *       specs/prd/version_logs/v0.0.182/change_log.md §3.1/§3.2（无死区核心 + delta 算法）
 *
 * 覆盖 acceptanceCriteria：
 *   - delta 算法无死区：到达静态/动态任一边界后反向拖动立即响应
 *   - side=left/right 双向正确
 *   - 拖拽中 body cursor/userSelect 锁定、mouseup 恢复
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComponentColResizeHandle } from '../component-col-resize-handle';

afterEach(() => {
  cleanup();
  // 复位 body style（跨用例隔离）
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  vi.restoreAllMocks();
});

/** 模拟一次完整拖拽：mousedown@startX → mousemove@toX → 触发 onResize 链 */
function dragFromTo(handle: HTMLElement, startX: number, toX: number) {
  fireEvent.mouseDown(handle, { clientX: startX });
  fireEvent.mouseMove(window, { clientX: toX });
}

describe('ComponentColResizeHandle —— delta 算法 + 方向', () => {
  it('side=right：鼠标左移（dx<0）→ 宽变大；鼠标右移（dx>0）→ 宽变小', () => {
    const onResize = vi.fn();
    render(
      <ComponentColResizeHandle
        side="right"
        currentWidth={300}
        minWidth={232}
        maxWidth={560}
        onResize={onResize}
      />,
    );
    const handle = screen.getByRole('separator');

    // 起点 500，左移到 450 → dx=-50 → 宽 = 300-(-50) = 350
    dragFromTo(handle, 500, 450);
    expect(onResize).toHaveBeenLastCalledWith(350);

    // 继续右移回 500 → dx=0 → 宽 = 300
    fireEvent.mouseMove(window, { clientX: 500 });
    expect(onResize).toHaveBeenLastCalledWith(300);
  });

  it('side=left：鼠标右移（dx>0）→ 宽变大；鼠标左移（dx<0）→ 宽变小', () => {
    const onResize = vi.fn();
    render(
      <ComponentColResizeHandle
        side="left"
        currentWidth={220}
        minWidth={180}
        maxWidth={400}
        onResize={onResize}
      />,
    );
    const handle = screen.getByRole('separator');

    // 起点 100，右移到 200 → dx=100 → 宽 = 220+100 = 320
    dragFromTo(handle, 100, 200);
    expect(onResize).toHaveBeenLastCalledWith(320);

    // 左移回 100 → dx=0 → 宽 = 220
    fireEvent.mouseMove(window, { clientX: 100 });
    expect(onResize).toHaveBeenLastCalledWith(220);
  });

  it('clamp 到 maxWidth：raw > max → max 截断（side=left，宽 350 拖到 9999）', () => {
    const onResize = vi.fn();
    render(
      <ComponentColResizeHandle
        side="left"
        currentWidth={350}
        minWidth={180}
        maxWidth={400}
        onResize={onResize}
      />,
    );
    const handle = screen.getByRole('separator');
    // dx=1000 → raw=1350 → clamp(180, 400, 1350) = 400
    dragFromTo(handle, 0, 1000);
    expect(onResize).toHaveBeenLastCalledWith(400);
  });

  it('clamp 到 minWidth：raw < min → min 截断（side=right，宽 250 拖到极右）', () => {
    const onResize = vi.fn();
    render(
      <ComponentColResizeHandle
        side="right"
        currentWidth={250}
        minWidth={232}
        maxWidth={560}
        onResize={onResize}
      />,
    );
    const handle = screen.getByRole('separator');
    // side=right：dx=1000（右移 1000）→ raw = 250-1000 = -750 → clamp(232, 560, -750) = 232
    dragFromTo(handle, 0, 1000);
    expect(onResize).toHaveBeenLastCalledWith(232);
  });

  it('无死区核心：到达静态上限后反向立即响应（不需松开重拖）', () => {
    const onResize = vi.fn();
    render(
      <ComponentColResizeHandle
        side="left"
        currentWidth={380}
        minWidth={180}
        maxWidth={400}
        onResize={onResize}
      />,
    );
    const handle = screen.getByRole('separator');

    // 起点 0：dx=100 → raw=480 → clamp=400（触顶，但 startRef 仍是 startWidth=380, startX=0）
    dragFromTo(handle, 0, 100);
    expect(onResize).toHaveBeenLastCalledWith(400);

    // mid-drag 反向：从 100 移回 50 → dx=50 → raw=380+50=430 → clamp=400（仍触顶）
    fireEvent.mouseMove(window, { clientX: 50 });
    expect(onResize).toHaveBeenLastCalledWith(400);

    // 继续反向：50 → 0 → dx=0 → raw=380（离开上限立即响应）
    fireEvent.mouseMove(window, { clientX: 0 });
    expect(onResize).toHaveBeenLastCalledWith(380);

    // 继续反向：0 → -50 → dx=-50 → raw=330（明显小于 max）
    fireEvent.mouseMove(window, { clientX: -50 });
    expect(onResize).toHaveBeenLastCalledWith(330);
  });

  it('无死区核心：到达静态下限后反向立即响应', () => {
    const onResize = vi.fn();
    render(
      <ComponentColResizeHandle
        side="left"
        currentWidth={200}
        minWidth={180}
        maxWidth={400}
        onResize={onResize}
      />,
    );
    const handle = screen.getByRole('separator');

    // 起点 0：左移到 -100 → dx=-100 → raw=100 → clamp=180（触底，startRef 仍 startWidth=200, startX=0）
    dragFromTo(handle, 0, -100);
    expect(onResize).toHaveBeenLastCalledWith(180);

    // mid-drag 反向：-100 → -50 → dx=-50 → raw=150 → clamp=180（仍触底）
    fireEvent.mouseMove(window, { clientX: -50 });
    expect(onResize).toHaveBeenLastCalledWith(180);

    // 继续反向：-50 → 50 → dx=50 → raw=250（离开下限立即响应）
    fireEvent.mouseMove(window, { clientX: 50 });
    expect(onResize).toHaveBeenLastCalledWith(250);
  });

  it('动态上限（maxWidth 可变）：maxWidth 缩小后再次 clamp 到新上限', () => {
    // 模拟场景 A：dragDynMax 变化导致 maxWidth 缩小（如 available 缩窄）
    const onResize = vi.fn();
    const { rerender } = render(
      <ComponentColResizeHandle
        side="left"
        currentWidth={380}
        minWidth={180}
        maxWidth={400}
        onResize={onResize}
      />,
    );
    const handle = screen.getByRole('separator');

    // 起点 0，拖到 dx=50 → raw=430 → clamp(180,400,430)=400
    dragFromTo(handle, 0, 50);
    expect(onResize).toHaveBeenLastCalledWith(400);

    // 重渲染：maxWidth 变小到 350（模拟 available 缩窄 → dragDynMax 变小）
    // 在 drag 期间 maxWidth 变化时，下一次 mousemove 用新 maxWidth clamp
    rerender(
      <ComponentColResizeHandle
        side="left"
        currentWidth={400}
        minWidth={180}
        maxWidth={350}
        onResize={onResize}
      />,
    );
    // 同一 drag（未 mouseup），继续 mousemove 用新 maxWidth clamp
    fireEvent.mouseMove(window, { clientX: 60 });
    // startRef 仍 {startX:0, startWidth:380}（mid-drag 不重捕获）
    // dx=60 → raw=380+60=440 → clamp(180,350,440)=350
    expect(onResize).toHaveBeenLastCalledWith(350);
  });
});

describe('ComponentColResizeHandle —— 拖拽期间 body 锁定 + mouseup 恢复', () => {
  it('mousedown → body cursor=col-resize + userSelect=none', () => {
    const onResize = vi.fn();
    render(
      <ComponentColResizeHandle
        side="right"
        currentWidth={300}
        minWidth={232}
        maxWidth={560}
        onResize={onResize}
      />,
    );
    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 500 });
    expect(document.body.style.cursor).toBe('col-resize');
    expect(document.body.style.userSelect).toBe('none');
  });

  it('mouseup → body 恢复 + onResizeEnd 触发', () => {
    const onResize = vi.fn();
    const onResizeEnd = vi.fn();
    render(
      <ComponentColResizeHandle
        side="right"
        currentWidth={300}
        minWidth={232}
        maxWidth={560}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
      />,
    );
    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 500 });
    expect(document.body.style.cursor).toBe('col-resize');

    fireEvent.mouseUp(window);
    expect(document.body.style.cursor).toBe('');
    expect(document.body.style.userSelect).toBe('');
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it('onDragStart 在 mousedown 时触发（调用方挂 setDragging）', () => {
    const onDragStart = vi.fn();
    render(
      <ComponentColResizeHandle
        side="left"
        currentWidth={220}
        minWidth={180}
        maxWidth={400}
        onResize={vi.fn()}
        onDragStart={onDragStart}
      />,
    );
    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 100 });
    expect(onDragStart).toHaveBeenCalledTimes(1);
  });
});

describe('ComponentColResizeHandle —— 视觉/语义 props', () => {
  it('side=right → 手柄贴 panel 左缘（-left-0.5）；side=left → 贴右缘（-right-0.5）', () => {
    const { rerender } = render(
      <ComponentColResizeHandle
        side="right"
        currentWidth={300}
        minWidth={232}
        maxWidth={560}
        onResize={vi.fn()}
      />,
    );
    let handle = screen.getByRole('separator');
    expect(handle.className).toContain('-left-0.5');
    expect(handle.className).not.toContain('-right-0.5');

    rerender(
      <ComponentColResizeHandle
        side="left"
        currentWidth={220}
        minWidth={180}
        maxWidth={400}
        onResize={vi.fn()}
      />,
    );
    handle = screen.getByRole('separator');
    expect(handle.className).toContain('-right-0.5');
    expect(handle.className).not.toContain('-left-0.5');
  });
});
