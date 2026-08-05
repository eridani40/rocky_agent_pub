/**
 * 坐标换算纯函数单测（Retina scale 链，含 scaleFactor≠2 多显示器）
 * 参考: specs/tech/agent/platform/[P1]computer_driver.md §5
 */
import { describe, it, expect } from 'vitest';
import { deriveScaleFactor, pixelToGlobalPoint } from '../coords';

describe('deriveScaleFactor', () => {
  it('width/windowBounds.w 推导（Retina 2x）', () => {
    expect(deriveScaleFactor(1280, { x: 0, y: 0, w: 640, h: 400 }, 999)).toBe(2);
  });

  it('多显示器混合 DPI（2.5x，不用 report 值）', () => {
    expect(deriveScaleFactor(1500, { x: 0, y: 0, w: 600, h: 400 }, 2)).toBe(2.5);
  });

  it('非 Retina 1x', () => {
    expect(deriveScaleFactor(640, { x: 0, y: 0, w: 640, h: 400 }, 1)).toBe(1);
  });

  it('无有效 windowBounds → 退回 reportedScaleFactor', () => {
    expect(deriveScaleFactor(0, undefined, 2)).toBe(2);
    expect(deriveScaleFactor(1280, { x: 0, y: 0, w: 0, h: 0 }, 1.5)).toBe(1.5);
  });

  it('report 值 ≤0 兜底 1', () => {
    expect(deriveScaleFactor(0, undefined, 0)).toBe(1);
  });
});

describe('pixelToGlobalPoint', () => {
  it('pixel/scaleFactor + windowBounds.origin（2x + 偏移）', () => {
    expect(pixelToGlobalPoint({ x: 640, y: 400 }, 2, { x: 0, y: 25, w: 640, h: 400 })).toEqual({ x: 320, y: 225 });
  });

  it('2.5x + origin(100,50)', () => {
    expect(pixelToGlobalPoint({ x: 750, y: 500 }, 2.5, { x: 100, y: 50, w: 600, h: 400 })).toEqual({ x: 400, y: 250 });
  });

  it('scaleFactor≤0 兜底 1（不除零）', () => {
    expect(pixelToGlobalPoint({ x: 10, y: 20 }, 0, { x: 5, y: 5, w: 100, h: 100 })).toEqual({ x: 15, y: 25 });
  });
});
