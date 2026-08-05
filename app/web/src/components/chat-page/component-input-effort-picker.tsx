/**
 * component-input-effort-picker —— chat-input-bar 按钮行内的 effort 推理强度选择器（4 档）
 * 参考: specs/ui/components/chat-page/component-input-effort-picker.md
 *       specs/prd/version_logs/v0.0.148/change_log.md §1.3（UI 落点）
 *
 * 几何/交互模式复用 component-input-model-picker（21px trigger + hover 预览 + click 菜单 +
 *   absolute 脱流 + z-popover）。差异：effort 是简单 enum（无 model 的 default 哨兵双语义），
 *   菜单是扁平 4 项列表，当前档直接 selected 高亮，无顶部「默认项 + 全量列表」分割。
 *
 * 职责：
 *   - 21px 纯图标 trigger（ZapIcon size=12，按钮行次左位）
 *   - hover → 单行预览菜单（testid effort-picker-preview）：当前档 selected 高亮
 *   - click → 完整菜单（testid effort-picker-menu）：4 档平铺
 *   - 选中调 onChange(level) → caller 调 updateSession 透传 session.effort
 *
 * 边界：subagent readOnly 分支由父级不挂载；session running 时 disabled 但仍可见。
 *   单文件 ≤300 行。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ZapIcon } from './icons';
import { CHAT_ACTION_BTN_CLS } from './action-button-styles';
import { PickerMenuHeader } from './picker-menu-header';

/** effort 4 档 canonical 语义键（对齐后端 Session.effort） */
export type EffortLevel = 'default' | 'low' | 'high' | 'max';

/** 4 档顺序（菜单渲染顺序，default 在首） */
const EFFORT_LEVELS: EffortLevel[] = ['default', 'low', 'high', 'max'];

interface InputEffortPickerProps {
  /** 当前 effort 档位（null/undefined 视为 'default' 缺省） */
  effort: EffortLevel | null;
  /** session running 时 disabled（仍可见，不响应点击，同 ModelPicker） */
  disabled?: boolean;
  /** 选中变更上抛（caller 调 updateSession 透传） */
  onChange: (level: EffortLevel) => void;
}

/**
 * preview 与 menu 共用的容器 className（与 model-picker 完全一致，spec §5）：
 *   w-max 内容自适应 + max-w-[480px] 安全上限 + max-h 400px 可滚；
 *   展开方向左上方（absolute bottom-full right-0 mb-1）；z=`--z-popover`。
 */
const PICKER_PANEL_CLS =
  'absolute bottom-full right-0 mb-1 z-[var(--z-popover)] w-max max-w-[480px] max-h-[400px] overflow-y-auto bg-surface-2 border border-border rounded-md shadow-lg py-1';

/** 菜单项 className（与 model-picker 同款：w-full 整行可点 + text-left 左对齐 + truncate） */
const PICKER_ITEM_CLS = 'block w-full px-3 py-1.5 text-sm text-left truncate';

/**
 * InputEffortPicker：effort 4 档选择 trigger + hover 预览 / click 菜单。
 * 纯 enum（无 providers / 无 fetch），档位文案走 i18n（chat ns）。
 */
export function InputEffortPicker({ effort, disabled, onChange }: InputEffortPickerProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 当前生效档（null/undefined → 'default' 缺省）
  const current: EffortLevel = effort ?? 'default';
  const currentLabel = t(`effort.level.${current}`);

  // 点外部关闭 click 菜单
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const handleSelect = (level: EffortLevel) => {
    onChange(level);
    setOpen(false);
  };

  // trigger 色调：default 缺省 = text-fg；具体档（low/high/max）= text-accent 强调
  const triggerTone = current === 'default' ? 'text-fg' : 'text-accent';
  const ariaLabel = t('effort.pickerAria', { level: currentLabel });

  return (
    <div
      ref={wrapRef}
      className="relative shrink-0 z-[var(--z-popover)]"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        data-action-key="chat.effort.open"
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={
          CHAT_ACTION_BTN_CLS +
          ' rounded-md transition-colors ' +
          (disabled ? 'opacity-60 cursor-not-allowed text-muted' : `hover:bg-bg-warm ${triggerTone}`)
        }
      >
        <ZapIcon size={12} />
      </button>

      {/* click 完整菜单（与 hover 预览互斥） */}
      {open && (
        <div role="listbox" className={PICKER_PANEL_CLS}>
          <PickerMenuHeader title={t('pickerTitle.effort')} />
          {EFFORT_LEVELS.map((level) => {
            const selected = level === current;
            const label = t(`effort.level.${level}`);
            return (
              <button
                key={level}
                type="button"
                data-action-key="chat.effort.select"
                onClick={() => handleSelect(level)}
                className={
                  PICKER_ITEM_CLS +
                  ' hover:bg-bg-warm ' +
                  (selected ? 'text-accent font-medium' : 'text-fg')
                }
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* hover 预览单条菜单（仅在未 click 展开 + hovered 时显；样式同 menu） */}
      {!open && hovered && (
        <div role="listbox" className={PICKER_PANEL_CLS}>
          <div className={PICKER_ITEM_CLS + ' cursor-default text-accent font-medium'}>
            {currentLabel}
          </div>
        </div>
      )}
    </div>
  );
}

export default InputEffortPicker;
