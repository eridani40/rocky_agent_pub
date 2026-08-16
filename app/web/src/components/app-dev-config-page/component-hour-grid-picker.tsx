/**
 * component-hour-grid-picker — 时间条件弹层组件（v0.0.347 模型路由 UI v2）
 * 参考 specs/prd/model-routing-demo-v2.html（冻结视觉契约：弹层 + 草稿态 + 语义翻转 + footer）
 *       specs/tech/version_logs/v0.0.347/change_plan.md 决策⑫/⑬（草稿不写回 + 浅灰=关/深=开）
 *
 * 交互语义（demo v2）：
 *   - 弹层内容组件：父级条件渲染（每次打开重挂载 = draft 以 value 重建基线）
 *   - 格子点击 toggle + 拖拽连续段/多段加选全部操作 draft（确定前零写回）
 *   - 格子视觉语义翻转：浅灰（surface-2）= 关 / 深色（bg-fg）= 该小时可用；默认全灰
 *   - footer 左 = 校验错误或实时已选时段（fmtHours，与时钟 icon tooltip 同一格式化函数）
 *   - footer 右 = 「清除定时」（onClear = 全天可用）+「确定」（1-23 格校验合法才 onConfirm）
 *   - 0 格 errEmpty / 24 格 errFull：报错不关闭不回调（demo 文案逐字）
 *
 * 边界：hours 数据语义零变化（normalizeHours 输出仍是 0-23 白名单，[] = 全天）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface HourGridPickerProps {
  /** 打开弹层时的基线（既有 timeCondition.hours；无配置 = [] 全灰） */
  value: number[];
  /** 确定回调（1-23 格校验通过才触发；输出去重升序白名单） */
  onConfirm: (hours: number[]) => void;
  /** 清除定时的回调（语义 = 全天可用，hours 置空/移除 timeCondition 由父级处理） */
  onClear: () => void;
}

/** 提取 0-23 白名单小时数组（去重 + 升序 + 越界过滤）；输出语义不变 */
export function normalizeHours(raw: number[]): number[] {
  const set = new Set(raw.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23));
  return [...set].sort((a, b) => a - b);
}

/* —— 时段格式化纯函数（footer 与时钟 icon tooltip 共用，demo L486-505） —— */

/** 连续小时合并成 [start, end+1] 段列表（[21,22,23] → [[21,24]]） */
export function hoursToRanges(hours: number[]): Array<[number, number]> {
  const sorted = normalizeHours(hours);
  const first = sorted[0];
  if (first === undefined) return [];
  const ranges: Array<[number, number]> = [];
  let start = first;
  let prev = first;
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    if (cur === undefined) break;
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    ranges.push([start, prev + 1]);
    start = cur;
    prev = cur;
  }
  ranges.push([start, prev + 1]);
  return ranges;
}

/** 段列表 → 文本（[[21,24]] → "21:00-24:00"，多段逗号分隔） */
export function formatRanges(ranges: Array<[number, number]>): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return ranges.map(([s, e]) => `${pad(s)}:00-${pad(e)}:00`).join(', ');
}

/** 小时数组 → 时段文本（footer / tooltip 共用；空数组 = ''） */
export function fmtHours(hours: number[]): string {
  const ranges = hoursToRanges(hours);
  return ranges.length > 0 ? formatRanges(ranges) : '';
}

/** 拖拽状态（select=加选连续段；unselect=减选连续段） */
interface DragState {
  start: number;
  last: number;
  mode: 'select' | 'unselect';
}

/** 弹层 DnD 事件阻断（决策⑭：防外层行拖拽劫持把弹层拖走） */
const stopDnd = (e: React.DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

/**
 * HourGridPicker 组件（弹层内容，v2 重写）。
 * 受控基线 + onConfirm/onClear 回调；关闭由父级管理（父级条件渲染控制挂载）。
 */
export function HourGridPicker({ value, onConfirm, onClear }: HourGridPickerProps) {
  const { t } = useTranslation('app-dev-config');
  // 草稿态：打开时拷贝基线；所有格子操作只改 draft，确定前零写回
  const [draft, setDraft] = useState<number[]>(() => normalizeHours(value));
  const [error, setError] = useState<'errEmpty' | 'errFull' | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const selectedSet = useMemo(() => new Set(draft), [draft]);

  // 兜底清拖拽态：拖出网格松开（grid onMouseUp 收不到）后 dragRef 残留，
  // 鼠标无按键移回格子会被 handleMouseEnter 误判为继续拖拽扩段 —— document mouseup 统一清
  useEffect(() => {
    const clear = () => {
      dragRef.current = null;
    };
    document.addEventListener('mouseup', clear);
    return () => document.removeEventListener('mouseup', clear);
  }, []);

  /** 应用一段连续范围（start..last 闭区间）到草稿 */
  const applyRange = (start: number, last: number, mode: 'select' | 'unselect') => {
    const [lo, hi] = start <= last ? [start, last] : [last, start];
    const next = new Set(selectedSet);
    for (let h = lo; h <= hi; h++) {
      if (mode === 'select') next.add(h);
      else next.delete(h);
    }
    setDraft(normalizeHours([...next]));
    setError(null); // 任何格子操作清除上次校验错误
  };

  /** mousedown 起点：未选中 → 加选；已选中 → 减选。阻止原生拖拽/文字选中 + 不冒泡（决策⑭） */
  const handleMouseDown = (e: React.MouseEvent, h: number) => {
    e.preventDefault();
    e.stopPropagation();
    const mode: DragState['mode'] = selectedSet.has(h) ? 'unselect' : 'select';
    dragRef.current = { start: h, last: h, mode };
    applyRange(h, h, mode);
  };

  /** mouseenter 扩展连续段（拖拽中） */
  const handleMouseEnter = (h: number) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.last !== h) {
      applyRange(drag.start, h, drag.mode);
      drag.last = h;
    }
  };

  /** 确定校验：1-23 格（0 格无效 / 24 格=全天应清除定时）；合法才回调（demo 文案逐字） */
  const handleConfirm = () => {
    if (draft.length === 0) {
      setError('errEmpty');
      return;
    }
    if (draft.length === 24) {
      setError('errFull');
      return;
    }
    onConfirm(normalizeHours(draft));
  };

  return (
    <div
      data-testid="hour-popover-body"
      draggable={false}
      onDragStart={stopDnd}
      onDragOver={stopDnd}
      onDrop={stopDnd}
    >
      {/* header（demo 文案逐字） */}
      <div className="mb-2.5 text-[12px] text-muted">{t('modelRouting.time.popoverHeader')}</div>
      {/* 24 格网格（0-23）：浅灰=关（该小时不可用）/ 深色=开（该小时可用） */}
      <div
        data-testid="hour-grid"
        className="select-none"
        onMouseUp={() => {
          dragRef.current = null;
        }}
        style={{ display: 'grid', gridTemplateColumns: 'repeat(24, minmax(0, 1fr))', gap: 3 }}
      >
        {Array.from({ length: 24 }, (_, h) => {
          const on = selectedSet.has(h);
          return (
            <div
              key={h}
              data-hour={h}
              data-testid={`hour-cell-${h}`}
              data-selected={on ? 'true' : 'false'}
              role="gridcell"
              aria-selected={on}
              aria-label={`${String(h).padStart(2, '0')}:00-${String(h + 1).padStart(2, '0')}:00`}
              className={
                'flex h-[26px] cursor-pointer select-none items-center justify-center rounded font-mono text-[9px] transition-colors ' +
                (on ? 'bg-fg font-medium text-bg' : 'bg-surface-2 text-muted hover:bg-surface-3')
              }
              onMouseDown={(e) => handleMouseDown(e, h)}
              onMouseEnter={() => handleMouseEnter(h)}
            >
              {String(h).padStart(2, '0')}
            </div>
          );
        })}
      </div>
      {/* footer：左 = 校验错误或实时已选时段；右 = 清除定时 + 确定 */}
      <div className="mt-3 flex items-center gap-2">
        {error ? (
          <span data-testid="hour-grid-error" className="mr-auto text-[11px] text-danger">
            {t(`modelRouting.time.${error}`)}
          </span>
        ) : (
          <span
            data-testid="hour-grid-selected"
            className={
              'mr-auto truncate font-mono text-[11px] ' +
              (draft.length > 0 ? 'text-fg-2' : 'text-muted-2')
            }
          >
            {fmtHours(draft) || t('modelRouting.time.unselected')}
          </span>
        )}
        <button
          type="button"
          data-testid="hour-grid-clear-time"
          data-action-key="settings.models.plan.time-clear-schedule"
          className="rounded border border-border-2 px-3 py-1 text-[12px] text-fg-2 hover:border-danger hover:text-danger"
          onClick={onClear}
        >
          {t('modelRouting.time.clearSchedule')}
        </button>
        <button
          type="button"
          data-testid="hour-grid-confirm"
          data-action-key="settings.models.plan.time-confirm"
          className="rounded bg-fg px-4 py-1 text-[12px] font-medium text-bg hover:bg-fg-hover"
          onClick={handleConfirm}
        >
          {t('modelRouting.time.confirm')}
        </button>
      </div>
    </div>
  );
}

export default HourGridPicker;
