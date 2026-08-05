/**
 * academy 板块纯函数 UT —— line-diff LCS / score10 / toCreateTaskBody
 * 参考: specs/ui/components/academy-page/component-diff-viewer.md（diff 语义）
 *       specs/ui/components/academy-page/component-training-create-modal.md（body 映射）
 *
 * 覆盖 T2 新增的纯逻辑（不碰 HTTP/store/组件渲染）：
 *   - computeLineDiff：same/add/del 三态 + 计数 + 边界（空串/全异/单侧）
 *   - score10：0-1 → 0-10 一位小数；undefined 透传
 *   - toCreateTaskBody：simple⇒learning / multi⇒training；仅 multi 带 dataset/grader/maxTurns
 */
import { describe, it, expect } from 'vitest';
import { computeLineDiff } from '../line-diff';
import { score10 } from '../../../lib/academy-api';
import { toCreateTaskBody } from '../component-training-create-modal';

describe('computeLineDiff（LCS 行级 diff）', () => {
  it('完全相同 → 全 same，add/del = 0', () => {
    const r = computeLineDiff('a\nb\nc', 'a\nb\nc');
    expect(r.addCount).toBe(0);
    expect(r.delCount).toBe(0);
    expect(r.left).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
    expect(r.right).toEqual(r.left);
  });

  it('纯新增（base 空）→ 右侧全 add', () => {
    const r = computeLineDiff('', 'x\ny');
    expect(r.addCount).toBe(2);
    expect(r.delCount).toBe(0);
    expect(r.left).toEqual([]);
    expect(r.right).toEqual([
      { type: 'add', text: 'x' },
      { type: 'add', text: 'y' },
    ]);
  });

  it('纯删除（cand 空）→ 左侧全 del', () => {
    const r = computeLineDiff('x\ny', '');
    expect(r.addCount).toBe(0);
    expect(r.delCount).toBe(2);
    expect(r.left).toEqual([
      { type: 'del', text: 'x' },
      { type: 'del', text: 'y' },
    ]);
    expect(r.right).toEqual([]);
  });

  it('中间改一行 → 头尾 same，del+add 配对', () => {
    const r = computeLineDiff('keep1\nold-line\nkeep2', 'keep1\nnew-line\nkeep2');
    expect(r.delCount).toBe(1);
    expect(r.addCount).toBe(1);
    // 左侧：same / del / same
    expect(r.left).toEqual([
      { type: 'same', text: 'keep1' },
      { type: 'del', text: 'old-line' },
      { type: 'same', text: 'keep2' },
    ]);
    // 右侧：same / add / same
    expect(r.right).toEqual([
      { type: 'same', text: 'keep1' },
      { type: 'add', text: 'new-line' },
      { type: 'same', text: 'keep2' },
    ]);
  });

  it('末尾追加 → 前缀 same + 尾部 add', () => {
    const r = computeLineDiff('a', 'a\nb\nc');
    expect(r.delCount).toBe(0);
    expect(r.addCount).toBe(2);
    expect(r.left).toEqual([{ type: 'same', text: 'a' }]);
    expect(r.right).toEqual([
      { type: 'same', text: 'a' },
      { type: 'add', text: 'b' },
      { type: 'add', text: 'c' },
    ]);
  });

  it('计数守恒：left = same+del 行，right = same+add 行', () => {
    const r = computeLineDiff('1\n2\n3\n4', '1\nX\n3\n4\n5');
    const sameL = r.left.filter((l) => l.type === 'same').length;
    const delL = r.left.filter((l) => l.type === 'del').length;
    const sameR = r.right.filter((l) => l.type === 'same').length;
    const addR = r.right.filter((l) => l.type === 'add').length;
    expect(sameL + delL).toBe(r.left.length);
    expect(sameR + addR).toBe(r.right.length);
    expect(delL).toBe(r.delCount);
    expect(addR).toBe(r.addCount);
    expect(sameL).toBe(sameR); // same 行两侧一一对应
  });
});

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
