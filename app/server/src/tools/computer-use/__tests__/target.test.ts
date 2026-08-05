/**
 * resolveTarget / resolveDrag 单测 —— element_index 主 / coordinate 辅（window-relative 三段式换算）
 * 参考: app/server/src/tools/computer-use/target.ts
 *       change_plan_v2_batch2 §B2.1 决策C（windowPoint=pixel/scale → +windowBounds.origin）
 */
import { describe, it, expect } from 'vitest';
import { resolveTarget, resolveDrag, resolveAxOptions } from '../target';

describe('resolveTarget', () => {
  it('element_index → {elementIndex}（优先，忽略 x,y）', () => {
    expect(resolveTarget({ element_index: 5, x: 10, y: 20 }, 2)).toEqual({ elementIndex: 5 });
  });

  it('element_index 非整数 → 落到 coordinate 或 null', () => {
    expect(resolveTarget({ element_index: 1.5 }, 2)).toBeNull();
  });

  it('x,y + scaleFactor=2 + 无 windowBounds → {coordinate: pixel/2}（origin=0）', () => {
    expect(resolveTarget({ x: 640, y: 400 }, 2)).toEqual({ coordinate: { x: 320, y: 200 } });
  });

  it('x,y + scaleFactor=2 + windowBounds origin(50,60) → 三段式偏移', () => {
    // windowPoint = pixel/2；globalPoint = windowPoint + origin
    expect(resolveTarget({ x: 640, y: 400 }, 2, { x: 50, y: 60, w: 100, h: 80 })).toEqual({
      coordinate: { x: 370, y: 260 },
    });
  });

  it('x,y + scaleFactor 缺省 → 视为 1（point=pixel）', () => {
    expect(resolveTarget({ x: 100, y: 50 }, undefined)).toEqual({ coordinate: { x: 100, y: 50 } });
  });

  it('scaleFactor<=0 → 兜底 1', () => {
    expect(resolveTarget({ x: 100, y: 50 }, 0)).toEqual({ coordinate: { x: 100, y: 50 } });
  });

  it('二者皆缺 → null', () => {
    expect(resolveTarget({}, 2)).toBeNull();
    expect(resolveTarget({ x: 10 }, 2)).toBeNull(); // 只有 x 无 y
  });
});

describe('resolveDrag', () => {
  it('四坐标 + scaleFactor=2 + windowBounds origin(10,20) → 两 PixelPoint 三段式', () => {
    // from: (100/2+10, 200/2+20)=(60,120)；to: (300/2+10, 400/2+20)=(160,220)
    expect(
      resolveDrag({ from_x: 100, from_y: 200, to_x: 300, to_y: 400 }, 2, { x: 10, y: 20, w: 0, h: 0 }),
    ).toEqual({ from: { x: 60, y: 120 }, to: { x: 160, y: 220 } });
  });

  it('无 windowBounds + scaleFactor=1 → 原样透传', () => {
    expect(resolveDrag({ from_x: 5, from_y: 6, to_x: 7, to_y: 8 }, 1)).toEqual({
      from: { x: 5, y: 6 },
      to: { x: 7, y: 8 },
    });
  });

  it('任一坐标缺失 → null', () => {
    expect(resolveDrag({ from_x: 10, from_y: 20, to_x: 30 }, 2)).toBeNull();
    expect(resolveDrag({}, 2)).toBeNull();
  });
});

describe('resolveAxOptions（v0.0.160 text_limit "max" 支持）', () => {
  it('text_limit 数字 → 透传 number', () => {
    expect(resolveAxOptions({ text_limit: 500 })).toEqual({ textLimit: 500 });
  });

  it('text_limit "max" → 透传 "max"（对齐 Swift SnapshotTextLimit.max）', () => {
    expect(resolveAxOptions({ text_limit: 'max' })).toEqual({ textLimit: 'max' });
  });

  it('text_limit 其他字符串 → 忽略（保守，防 LLM 传 "unlimited"/"none" 等无效值）', () => {
    expect(resolveAxOptions({ text_limit: 'unlimited' })).toEqual({});
    expect(resolveAxOptions({ text_limit: '' })).toEqual({});
  });

  it('全字段透传（app + text_limit "max" + max_tree_nodes + max_tree_depth）', () => {
    expect(
      resolveAxOptions({ app: 'Notes', text_limit: 'max', max_tree_nodes: 100, max_tree_depth: 8 }),
    ).toEqual({ app: 'Notes', textLimit: 'max', maxNodes: 100, maxDepth: 8 });
  });

  it('空 input → 空 opts（走 addon 默认）', () => {
    expect(resolveAxOptions({})).toEqual({});
  });
});
