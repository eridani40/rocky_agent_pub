/**
 * academy 板块纯函数 UT —— score10 / toCreateTaskBody
 * 参考: specs/ui/components/academy-page/component-training-create-modal.md（body 映射）
 *
 * 覆盖纯逻辑（不碰 HTTP/store/组件渲染）：
 *   - score10：0-1 → 0-10 一位小数；undefined 透传
 *   - toCreateTaskBody：simple⇒learning / multi⇒training；仅 multi 带 dataset/grader/maxTurns
 *
 * [v0.0.305] computeLineDiff 测试已随 line-diff.ts 死代码一并删除。
 */
import { describe, it, expect } from 'vitest';
import { score10 } from '../../../lib/academy-api';
import { toCreateTaskBody } from '../component-training-create-modal';

describe('score10（engine 0-1 → demo 十分制）', () => {
  it('undefined 透传（引擎无分不显）', () => {
    expect(score10(undefined)).toBeUndefined();
  });
  it('0 → 0；1 → 10', () => {
    expect(score10(0)).toBe(0);
    expect(score10(1)).toBe(10);
  });
  it('一位小数四舍五入（0.82 → 8.2；0.626 → 6.3）', () => {
    expect(score10(0.82)).toBe(8.2);
    expect(score10(0.626)).toBe(6.3);
  });
});

describe('toCreateTaskBody（demo 表单 → API body）', () => {
  it('simple ⇒ optimizeStyle=learning，不带 dataset/grader/maxTurns', () => {
    const body = toCreateTaskBody('ver_1', {
      mode: 'simple',
      directive: '优化 SQL 教学',
      datasetId: 'ds_x', // simple 下即便有值也不发
      graderId: 'gr_x',
      maxTurns: 5,
    });
    expect(body).toEqual({
      baseVersionId: 'ver_1',
      mode: 'simple',
      optimizeStyle: 'learning',
      directive: '优化 SQL 教学',
    });
    expect('datasetId' in body).toBe(false);
    expect('graderId' in body).toBe(false);
    expect('maxTurns' in body).toBe(false);
  });

  it('multi ⇒ optimizeStyle=training，带 dataset/grader/maxTurns', () => {
    const body = toCreateTaskBody('ver_2', {
      mode: 'multi',
      directive: '多轮提升',
      datasetId: 'ds_1',
      graderId: 'gr_1',
      maxTurns: 8,
    });
    expect(body).toEqual({
      baseVersionId: 'ver_2',
      mode: 'multi',
      optimizeStyle: 'training',
      directive: '多轮提升',
      datasetId: 'ds_1',
      graderId: 'gr_1',
      maxTurns: 8,
    });
  });
});
