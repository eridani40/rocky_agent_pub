/**
 * preview-icons —— 预览区悬浮按钮图标集（feather stroke 风格，从 icons.tsx 抽离控行数）
 *
 * 与 icons.tsx 同一套 base() stroke 风格（strokeWidth=2, strokeLinecap='round'）。
 * 图标：编辑(PencilIcon=feather edit-2) / 保存(SaveIcon) / 撤销(UndoIcon) / 格式化(AlignIcon) / 校验(CheckSquareIcon=feather check-circle)
 * v0.0.323：PencilIcon/CheckSquareIcon 仅替换 SVG path（edit-2 / check-circle），组件名不变（消费方零连锁）。
 */
import type { SVGProps } from 'react';

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

const base = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
});

/** edit-2 —— 悬浮按钮「编辑」（feather edit-2 方框笔；组件名保留 PencilIcon 不改） */
export function PencilIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

/** save —— 悬浮按钮「保存」（feather save 软盘） */
export function SaveIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
      <path d="M17 21v-8H7v8" />
      <path d="M7 3v5h8" />
    </svg>
  );
}

/** undo —— 悬浮按钮「撤销」（feather corner-up-left 回旋箭头） */
export function UndoIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 016 6v2" />
    </svg>
  );
}

/** align-left —— 悬浮按钮「格式化」（feather align-left） */
export function AlignIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M17 10H3" />
      <path d="M21 6H3" />
      <path d="M21 14H3" />
      <path d="M17 18H3" />
    </svg>
  );
}

/** check-circle —— 悬浮按钮「校验」（feather check-circle 圆勾；组件名保留 CheckSquareIcon 不改） */
export function CheckSquareIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4L12 14.01l-3-3" />
    </svg>
  );
}

/** globe —— 悬浮按钮「浏览器打开」（feather globe 地球仪；v0.0.325） */
export function GlobeIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
