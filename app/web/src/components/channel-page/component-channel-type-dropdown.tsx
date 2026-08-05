/**
 * component-channel-type-dropdown —— 渠道类型单选自定义下拉
 * 参考: specs/ui/components/channel-page/component-channel-type-dropdown.md
 *       specs/ui/components/_conventions.md §10（单选禁原生 <select> v0.0.7+ 硬规则）
 *       specs/ui/components/_conventions.md §11（popover 绝对定位脱离流，不挤压下方字段）
 *
 * 职责：trigger button（当前选中 label + ▾）+ popover listbox（role=option）。
 * 只单选、无 nullable（必选一项）、无多选 chip——比 component-board-selector-dropdown 简单。
 *
 * 交互契约：
 *  - 键盘：关闭态 Enter/Space/ArrowDown 展开；展开态 ↑↓ 移动 activeIdx、Enter 选中、Esc 关闭
 *  - 外部点击关闭（document mousedown listener，仅 open 时挂载）
 *  - disabled 锁定（编辑态 implId 不可改）→ trigger disabled 态
 */
import { useEffect, useRef, useState } from 'react';

/** 单选项 */
export interface ChannelTypeOption {
  value: string;
  label: string;
}

interface Props {
  /** 当前选中 value（必在 options 中；不在则 trigger 回退显 value 原文） */
  value: string;
  /** 可选项列表 */
  options: ChannelTypeOption[];
  /** 选中某项回调（组件内自动关 popover） */
  onChange: (v: string) => void;
  /** 锁定（编辑态 implId 不可改） */
  disabled?: boolean;
}

/**
 * 渲染渠道类型单选下拉。
 */
export function ComponentChannelTypeDropdown({
  value,
  options,
  onChange,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // 外部点击关闭 popover（仅 open 时挂载，卸载摘监听）
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 当前选中 label（value 不在 options 中时回退显 value 原文）
  const selectedLabel = options.find((o) => o.value === value)?.label ?? value;

  /** 键盘导航：↑↓ 移动 activeIdx；Enter 选中；Esc / Space 展开 */
  function onKeyDown(e: React.KeyboardEvent) {
    if (disabled) return;
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
      setActiveIdx((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = options[activeIdx];
      if (opt) {
        onChange(opt.value);
        setOpen(false);
      }
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-action-key="channel.instance.select-type"
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-border-2 bg-surface px-[12px] py-[8px] text-left text-fg text-[13px] outline-none hover:border-accent/60 focus:border-accent focus:ring-2 focus:ring-accent/30 disabled:opacity-60 disabled:hover:border-border-2"
      >
        <span className="truncate">{selectedLabel}</span>
        <span aria-hidden className="text-muted-2">▾</span>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 right-0 z-30 mt-1 max-h-[280px] overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-md"
        >
          {options.map((opt, idx) => {
            const selected = opt.value === value;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={selected}

                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors ' +
                  (selected ? 'bg-accent/8 text-accent' : 'text-fg-2 hover:bg-surface-2')
                }
              >
                <span className="w-3" aria-hidden>
                  {selected ? '✓' : ''}
                </span>
                <span className="flex-1 truncate">{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ComponentChannelTypeDropdown;
