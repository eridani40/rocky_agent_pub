/**
 * component-shared-selector —— 通用 native 选择器原语（ChoiceCards + Dropdown + SelectorOption）
 * 参考: specs/ui/components/_conventions.md §10（禁原生 select；choice 卡 / 自定义下拉）
 *
 * 职责：为实体字段编辑（panorama 等）提供禁原生 `<select>` 的双形态选择器：
 *   - ChoiceCards：≤4 单选的 choice 卡（accent 边框 + 浅底 + 勾）
 *   - Dropdown：>4 选项 / 多选的自定义下拉（trigger + popover + 键盘导航 + 外部点击关闭）
 *   - SelectorOption：通用选项 shape（value/label/hint）
 *
 * 边界：纯受控展示组件，不拉数据、不调 API；选项数据全部来自父组件预处理。
 * 多选环检测、required 校验等由调用方/后端兜底。
 */
import { useEffect, useMemo, useRef, useState } from 'react';

/** 通用选项 shape（value + 渲染主文案 label + 可选副标 hint） */
export interface SelectorOption {
  /** 选项值（实体 id / enum 值 / member ulid 等） */
  value: string;
  /** 渲染主文案 */
  label: string;
  /** 副标（如 progress / 野生标记） */
  hint?: string;
}

/** 「无值」固定 value（与 store null 对齐；nullable=true 时置顶该选项） */
export const NULL_VALUE = '__null__';

interface ChoiceCardsProps {
  value: string | null;
  options: SelectorOption[];
  nullable?: boolean;
  onChange: (v: string | null) => void;
  /** ET 稳定语义锚点 data-action-key（渲到每个选项按钮，同 key 多项靠文案区分；命名见 _conventions §12） */
  actionKey?: string;
}

/** choice 卡形态（≤4 单选；selected accent 边框 + 浅底 + 勾；nullable 时置顶「无」选项） */
export function ChoiceCards({ value, options, nullable, onChange, actionKey }: ChoiceCardsProps) {
  const fullOptions = useMemo<SelectorOption[]>(
    () => (nullable ? [{ value: NULL_VALUE, label: '（野生 / 无）', hint: '不挂 KR' }, ...options] : options),
    [options, nullable],
  );
  const current = value ?? NULL_VALUE;
  return (
    <div className="flex flex-wrap gap-1.5">
      {fullOptions.map((opt) => {
        const selected = opt.value === current;
        return (
          <button
            key={opt.value}
            type="button"
            data-action-key={actionKey}
            data-selected={selected ? 'true' : 'false'}
            onClick={() => onChange(opt.value === NULL_VALUE ? null : opt.value)}
            className={
              'inline-flex items-center gap-1 rounded-md border px-2.5 py-1 font-mono text-[11.5px] transition-colors ' +
              (selected
                ? 'border-accent bg-accent/8 text-accent'
                : 'border-border-2 bg-surface-2 text-fg-2 hover:border-accent/60')
            }
          >
            {selected && <span aria-hidden>✓</span>}
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}

interface DropdownProps {
  value: string | string[] | null;
  options: SelectorOption[];
  multiple?: boolean;
  nullable?: boolean;
  onChange: (v: string | string[] | null) => void;
  /** ET 稳定语义锚点 data-action-key：trigger 渲 `{actionKey}`、选项渲 `{actionKey}-option`
   *  （命名见 _conventions §12；同 key 多选项靠文案区分），缺省不渲染 */
  actionKey?: string;
}

/** 自定义下拉（trigger 按钮 + popover 列表 + 键盘导航 + 外部点击关闭；多选 trigger 区 chip 回显） */
export function Dropdown({ value, options, multiple, nullable, onChange, actionKey }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // 外部点击关闭 popover
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const fullOptions = useMemo<SelectorOption[]>(
    () => (nullable ? [{ value: NULL_VALUE, label: '（野生 / 不挂 KR）', hint: '野生需求' }, ...options] : options),
    [options, nullable],
  );

  const selectedValues = useMemo<Set<string>>(() => {
    if (multiple) return new Set(Array.isArray(value) ? value : []);
    return new Set(value ? [value as string] : []);
  }, [value, multiple]);

  /** trigger 区显示：单选 = 选项 label；多选 = chip 列表 */
  const triggerLabel = useMemo(() => {
    if (multiple) {
      const arr = Array.isArray(value) ? value : [];
      if (arr.length === 0) return '选择…';
      return arr
        .map((v) => fullOptions.find((o) => o.value === v)?.label ?? v)
        .filter((s) => s !== '（野生 / 不挂 KR）')
        .join(', ');
    }
    if (!value) return nullable ? '（野生 / 不挂 KR）' : '选择…';
    return fullOptions.find((o) => o.value === value)?.label ?? (value as string);
  }, [value, multiple, nullable, fullOptions]);

  /** 切换某选项 */
  function toggle(optValue: string) {
    const real = optValue === NULL_VALUE ? null : optValue;
    if (multiple) {
      const arr = Array.isArray(value) ? [...value] : [];
      const key = optValue === NULL_VALUE ? NULL_VALUE : optValue;
      const idx = arr.indexOf(key);
      if (idx >= 0) arr.splice(idx, 1);
      else arr.push(key);
      onChange(arr);
    } else {
      onChange(real);
      setOpen(false);
    }
  }

  /** 键盘导航：↑↓ 移动 activeIdx；Enter 选中；Esc 关闭 */
  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(fullOptions.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = fullOptions[activeIdx];
      if (opt) toggle(opt.value);
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-action-key={actionKey}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border-2 bg-surface-2 px-3 py-2 text-left font-mono text-[12.5px] text-fg hover:border-accent/60 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
      >
        <span className="truncate">{triggerLabel}</span>
        <span aria-hidden className="text-muted-2">▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 z-30 mt-1 max-h-[280px] overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-md"
        >
          {multiple && Array.isArray(value) && value.length > 0 && (
            <div className="flex flex-wrap gap-1 border-b border-border px-2 py-1.5">
              {value.map((v) => {
                const opt = fullOptions.find((o) => o.value === v);
                return (
                  <span
                    key={v}
                    className="inline-flex items-center gap-1 rounded-sm bg-accent/12 px-1.5 py-0.5 font-mono text-[11px] text-accent"
                  >
                    {opt?.label ?? v}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(v);
                      }}
                      className="text-accent/70 hover:text-accent"
                      aria-label={`移除 ${opt?.label ?? v}`}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {fullOptions.map((opt, idx) => {
            const selected = selectedValues.has(opt.value);
            const isWild = opt.value === NULL_VALUE;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}
                data-action-key={actionKey ? `${actionKey}-option` : undefined}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => toggle(opt.value)}
                className={
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-[12px] transition-colors ' +
                  (selected ? 'bg-accent/8 text-accent' : 'text-fg-2 hover:bg-surface-2') +
                  (isWild ? ' italic text-muted' : '')
                }
              >
                <span className="w-3" aria-hidden>
                  {selected ? '✓' : ''}
                </span>
                <span className="flex-1 truncate">{opt.label}</span>
                {opt.hint && <span className="text-[10px] text-muted-2">{opt.hint}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
