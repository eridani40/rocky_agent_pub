/**
 * @vitest-environment jsdom
 * component-hour-grid-picker 单测（v0.0.347 UI v2：弹层 + 草稿态 + 语义翻转）。
 * 参考 specs/prd/model-routing-demo-v2.html（冻结视觉契约：footer/颜色翻转/校验）
 *       specs/tech/version_logs/v0.0.347/change_plan.md 决策⑫/⑬
 *
 * 校验点：
 *   - 24 格渲染 + 基线回显（draft 初值 = normalizeHours(value)，默认全灰=关）
 *   - 拖拽连续段 / 单击 toggle / 多段加选 / 反向减选（全部操作 draft，确定前零写回）
 *   - footer 左：校验错误 或 实时已选时段（fmtHours）；空 = 「未选择」
 *   - 确定：1-23 格 → onConfirm；0 格 errEmpty / 24 格 errFull（报错不回调不关闭）
 *   - 格子操作清除上次校验错误
 *   - 清除定时 → onClear
 *   - 纯函数：fmtHours/hoursToRanges/formatRanges/normalizeHours
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { initI18n } from '../../../i18n';
import { HourGridPicker, normalizeHours, hoursToRanges, formatRanges, fmtHours } from '../component-hour-grid-picker';

beforeAll(async () => {
  await initI18n('zh-CN');
});

/** 找某小时的 cell（data-testid="hour-cell-{h}"） */
function cellFor(hour: number): HTMLElement {
  const el = document.querySelector(`[data-testid="hour-cell-${hour}"]`);
  if (!el) throw new Error(`cell not found for hour ${hour}`);
  return el as HTMLElement;
}

/** 模拟拖拽：mousedown from → mouseenter to → mouseup（松在网格容器上） */
function drag(from: number, to: number) {
  fireEvent.mouseDown(cellFor(from), { clientX: 0, clientY: 0 });
  fireEvent.mouseEnter(cellFor(to));
  fireEvent.mouseUp(screen.getByTestId('hour-grid'));
}

/** 单击某格 */
function clickCell(hour: number) {
  fireEvent.mouseDown(cellFor(hour), { clientX: 0, clientY: 0 });
  fireEvent.mouseUp(screen.getByTestId('hour-grid'));
}

/** 断言 hours 集合选中（语义翻转：data-selected=true = 深色开） */
function expectSelected(hours: number[]) {
  for (const h of hours) expect(cellFor(h).getAttribute('data-selected')).toBe('true');
}

/** 渲染并返回回调 spy */
function renderPicker(value: number[] = []) {
  const onConfirm = vi.fn();
  const onClear = vi.fn();
  render(<HourGridPicker value={value} onConfirm={onConfirm} onClear={onClear} />);
  return { onConfirm, onClear };
}

describe('HourGridPicker — 渲染与草稿操作', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('渲染 24 小时格（0-23），默认全灰 = 全部关', () => {
    renderPicker();
    expect(screen.getByTestId('hour-popover-body')).toBeTruthy();
    for (let h = 0; h < 24; h++) {
      expect(cellFor(h).getAttribute('data-selected')).toBe('false');
    }
  });

  it('基线回显：value=[2,3] → 2/3 深（开），其余灰（关）', () => {
    renderPicker([2, 3]);
    expectSelected([2, 3]);
    expect(cellFor(4).getAttribute('data-selected')).toBe('false');
  });

  it('拖拽连续段 2→5 → draft=[2,3,4,5]，footer 实时显示 02:00-06:00', () => {
    renderPicker();
    drag(2, 5);
    expectSelected([2, 3, 4, 5]);
    expect(screen.getByTestId('hour-grid-selected').textContent).toBe('02:00-06:00');
  });

  it('单击未选中格 → 该格开；再单击 → 关', () => {
    renderPicker();
    clickCell(7);
    expectSelected([7]);
    clickCell(7);
    expect(cellFor(7).getAttribute('data-selected')).toBe('false');
  });

  it('多段加选：基线 [2,3] 再拖 10→12 → footer 显示两段', () => {
    renderPicker([2, 3]);
    drag(10, 12);
    expectSelected([2, 3, 10, 11, 12]);
    expect(screen.getByTestId('hour-grid-selected').textContent).toBe('02:00-04:00, 10:00-13:00');
  });

  it('已选段内反向拖拽减选：[2,3,4] 从 4 拖到 2 → 全关 + footer「未选择」', () => {
    renderPicker([2, 3, 4]);
    drag(4, 2);
    for (const h of [2, 3, 4]) expect(cellFor(h).getAttribute('data-selected')).toBe('false');
    expect(screen.getByTestId('hour-grid-selected').textContent).toBe('未选择');
  });

  it('草稿隔离：格子操作不触发 onConfirm（确定才写回）', () => {
    const { onConfirm } = renderPicker([2, 3]);
    drag(10, 12);
    clickCell(20);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('HourGridPicker — 确定校验与回调', () => {
  beforeEach(() => cleanup());
  afterEach(() => cleanup());

  it('确定：拖 1→3 → onConfirm([1,2,3])（去重升序白名单）', () => {
    const { onConfirm } = renderPicker();
    drag(1, 3);
    fireEvent.click(screen.getByTestId('hour-grid-confirm'));
    expect(onConfirm).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('确定 0 格 → errEmpty 显示且不回调', () => {
    const { onConfirm } = renderPicker();
    fireEvent.click(screen.getByTestId('hour-grid-confirm'));
    expect(screen.getByTestId('hour-grid-error').textContent).toContain('至少选择 1 个小时');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('确定 24 格（全选）→ errFull 显示且不回调', () => {
    const { onConfirm } = renderPicker();
    drag(0, 23);
    fireEvent.click(screen.getByTestId('hour-grid-confirm'));
    expect(screen.getByTestId('hour-grid-error').textContent).toContain('全选');
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('报错后任意格子操作 → 错误清除，footer 恢复已选时段', () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('hour-grid-confirm')); // errEmpty
    expect(screen.getByTestId('hour-grid-error')).toBeTruthy();
    clickCell(5);
    expect(screen.queryByTestId('hour-grid-error')).toBeNull();
    expect(screen.getByTestId('hour-grid-selected').textContent).toBe('05:00-06:00');
  });

  it('清除定时 → onClear 调用', () => {
    const { onClear } = renderPicker([2, 3]);
    fireEvent.click(screen.getByTestId('hour-grid-clear-time'));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('时段格式化纯函数（footer / tooltip 共用）', () => {
  it('fmtHours：[21,22,23] → "21:00-24:00"（24 补零）', () => {
    expect(fmtHours([21, 22, 23])).toBe('21:00-24:00');
  });

  it('fmtHours：多段逗号分隔；空数组 → ""', () => {
    expect(fmtHours([2, 3, 10, 11, 12])).toBe('02:00-04:00, 10:00-13:00');
    expect(fmtHours([])).toBe('');
  });

  it('hoursToRanges：连续合并 + 断段拆分（[start, end+1) 语义）', () => {
    expect(hoursToRanges([2, 3, 10, 11])).toEqual([[2, 4], [10, 12]]);
    expect(hoursToRanges([])).toEqual([]);
    expect(hoursToRanges([21, 22, 23])).toEqual([[21, 24]]);
  });

  it('formatRanges：两位补零 + ", " 连接', () => {
    expect(formatRanges([[2, 4], [10, 12]])).toBe('02:00-04:00, 10:00-12:00');
  });

  it('normalizeHours：去重 + 升序 + 0-23 白名单过滤（语义零变化）', () => {
    expect(normalizeHours([5, 2, 5, 25, -1])).toEqual([2, 5]);
    expect(normalizeHours([23, 0, 12])).toEqual([0, 12, 23]);
  });
});
