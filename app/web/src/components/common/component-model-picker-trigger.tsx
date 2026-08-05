/**
 * component-model-picker-trigger —— 模型选择「收起态」trigger primitive（跨页复用）
 * 参考: specs/ui/components/common/component-model-picker-trigger.md
 *       specs/ui/regulation/02-components.md §7（模型选择面板全局统一契约）
 *       specs/tech/version_logs/v0.0.165/change_plan.md §7
 *
 * 职责：
 *   白底 border-2 边 radius-md，内含 22px IconBox（provider hash 色）+ mono 名 + 下拉箭头。
 * 边界：受控 onClick 展开／收起由消费方管理；纯展示；不含 hover preview / 外部点击关闭；无 hex。
 * 单文件 ≤120 行。
 */
import type { ReactNode } from 'react';
import { IconBox } from './component-icon-box';

/** 尺寸档；'md'=32px（默认，符合 regulation 02 §7）；'sm'=26px（备用，chat-input 场景未来可用） */
export type TriggerSize = 'sm' | 'md';

export interface ModelPickerTriggerProps {
  /** 当前选中项；null → 显 placeholder，不渲 IconBox；`providerId` 缺省/空串 → 不渲 IconBox（value 已配但 provider 未加载/已删——降级到纯文本 trigger） */
  value?: {
    providerId?: string;
    modelId: string;
    modelLabel: string;
  } | null;
  placeholder?: string;
  disabled?: boolean;
  onClick: () => void;
  /** aria-label（accessibility，通常传全 modelLabel 或「未配置」） */
  ariaLabel?: string;
  /** hover title（长 modelId 全名） */
  title?: string;
  /** 尺寸档；默认 'md' = h32 */
  size?: TriggerSize;
  /** 额外容器 className（消费方细调宽度/位置；不覆盖 bg/border/color） */
  className?: string;
  ariaHaspopup?: 'listbox' | 'menu' | 'true';
  ariaExpanded?: boolean;
  /** data-action-key 透传（ET 稳定定位锚点，命名规范见 specs/ui/components/_conventions.md §12） */
  actionKey?: string;
}

/** 下拉箭头 SVG（inline，不引 chat-page/icons 避免层级反向） */
function ChevronDownSvg() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-[13px] h-[13px] text-muted shrink-0"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** 尺寸档 → h + px + gap 类 */
function sizeClasses(size: TriggerSize): string {
  if (size === 'sm') return 'h-[26px] px-2 gap-1.5';
  return 'h-8 px-3 gap-2'; // md 默认
}

/**
 * ModelPickerTrigger —— 模型选择收起态 primitive。
 * 消费方例：
 *   <ModelPickerTrigger
 *     value={{providerId: p.id, modelId: m.modelId, modelLabel: `${p.label} / ${m.label}`}}
 *     onClick={() => setOpen(v=>!v)}
 *
 *     ariaLabel={label}
 *     ariaExpanded={open}
 *   />
 */
export function ModelPickerTrigger({
  value,
  placeholder,
  disabled,
  onClick,
  ariaLabel,
  title,
  size = 'md',
  className,
  ariaHaspopup = 'listbox',
  ariaExpanded,
  actionKey,
}: ModelPickerTriggerProps): ReactNode {
  const isEmpty = !value;
  const label = isEmpty ? placeholder ?? '' : value!.modelLabel;
  const base =
    'inline-flex items-center rounded-md border border-border-2 bg-surface hover:bg-surface-2 transition-colors text-left';
  const tone = isEmpty ? 'text-muted' : 'text-fg';
  const disabledCls = disabled ? ' opacity-60 cursor-not-allowed' : '';
  const cls =
    `${base} ${sizeClasses(size)} ${tone}${disabledCls}` + (className ? ' ' + className : '');

  return (
    <button
      type="button"
      data-action-key={actionKey}
      onClick={() => {
        if (!disabled) onClick();
      }}
      disabled={disabled}
      aria-haspopup={ariaHaspopup}
      aria-expanded={ariaExpanded}
      aria-label={ariaLabel}
      title={title}
      className={cls}
    >
      {!isEmpty && value!.providerId && (
        <IconBox hueBy={value!.providerId} size={22} />
      )}
      <span className="font-mono text-[13px] whitespace-nowrap overflow-hidden text-ellipsis flex-1 min-w-0">
        {label}
      </span>
      <ChevronDownSvg />
    </button>
  );
}

export default ModelPickerTrigger;
