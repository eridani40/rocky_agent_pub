/**
 * icons —— chat-page 内联 SVG 图标集（无依赖，对齐设计稿 v9a Icon 集）
 * 参考: reqs/v0.0.8/easy-opc-chat-v9a.html Icon 字典
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

export function ChevronIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function WrenchIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

export function SendIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function PlusIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function BrainIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M9.5 2A2.5 2.5 0 0112 4.5v15a2.5 2.5 0 01-4.96.44 2.5 2.5 0 01-2.96-3.08 3 3 0 01-.34-5.58 2.5 2.5 0 011.32-4.24 2.5 2.5 0 014.44-1.04zM14.5 2A2.5 2.5 0 0012 4.5v15a2.5 2.5 0 004.96.44 2.5 2.5 0 002.96-3.08 3 3 0 00.34-5.58 2.5 2.5 0 00-1.32-4.24A2.5 2.5 0 0014.5 2z" />
    </svg>
  );
}

export function ChatIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
    </svg>
  );
}

export function ZapIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

export function FileIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

export function CheckIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/** 关闭/X 形 icon —— enqueue-view 取消按钮（design v9a .queue-remove） */
export function CloseIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

/** 实心方块停止 icon —— abort-btn（design §4.11b，非 send 箭头） */
export function StopIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      {...rest}
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/** compress icon —— CompactBtn（design §146-148 .topbar-btn + v9a Icon dict 'compress'） */
export function CompressIcon({ size = 15, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M8 3v3a2 2 0 01-2 2H3M21 8h-3a2 2 0 01-2-2V3M3 16h3a2 2 0 012 2v3M16 21v-3a2 2 0 012-2h3" />
    </svg>
  );
}

/** alert/warning icon —— run-finish error 态 ⚠️ 标记（§4.13 line 229）
 * 惊叹号三角，stroke 风格对齐其他 icon（currentColor 继承父色） */
export function AlertIcon({ size = 11, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

/** trash icon —— ClearBtn（design §148 .topbar-btn.danger + v9a Icon dict 'trash'） */
export function TrashIcon({ size = 15, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  );
}

// ============================================================
// WorkspacePanel 图标集（对齐 design v9a.html Icon dict：
// folder / folderOpen / swap / external / chevronLeft / chevronRight / refresh）
// ============================================================

/** chevron-left icon —— ws-rail 展开按钮（design §6.6） */
export function ChevronLeftIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/** chevron-right icon —— ws-tab 收起按钮 + ws-twisty 折叠态（design §6.5） */
export function ChevronRightIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

/** folder icon —— ws-ico dir 折叠态（design §6.5，gold 色） */
export function FolderIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
    </svg>
  );
}

/** folder-open icon —— ws-ico dir 展开态（design §6.5） */
export function FolderOpenIcon({ size = 13, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M3 7a2 2 0 012-2h4l2 3h8a2 2 0 012 2v1H5a2 2 0 00-2 2z" />
      <path d="M3 19l2-8h17l-2 8z" />
    </svg>
  );
}

/** swap icon —— ws-switch-btn 切换工作区目录（design §6.3 Icon dict 'swap'） */
export function SwapIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M17 1l4 4-4 4" />
      <path d="M3 6h18M7 23l-4-4 4-4" />
      <path d="M21 18H3" />
    </svg>
  );
}

/** external icon —— ws-act hover 打开文件/文件夹（design §6.5，外链 icon） */
export function ExternalIcon({ size = 11, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </svg>
  );
}

/** refresh icon —— ws-refresh-btn（design §6.3 Icon dict 'refresh'） */
export function RefreshIcon({ size = 14, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M23 4v6h-6" />
      <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
    </svg>
  );
}

/** clock icon —— 「定时任务」tab（cron tab entry，clock 形 icon）
 * 圆形表盘 + 时针分针，stroke 风格对齐其他 icon */
export function ClockIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  );
}

/** star icon —— 「skills」悬浮菜单项（四角星，对齐 skill 卡片 logo 星形，stroke 风格） */
export function StarIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M12 2L14 10 22 12 14 14 12 22 10 14 2 12 10 10Z" />
    </svg>
  );
}

/** todo icon —— 「待办」悬浮菜单项（v0.0.223：左侧勾选 + 右侧清单行，stroke 风格对齐 StarIcon） */
export function TodoIcon({ size = 16, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M10 6h11" />
      <path d="M10 12h11" />
      <path d="M10 18h11" />
      <path d="M3 6l1.5 1.5L7 5" />
      <path d="M3 12l1.5 1.5L7 11" />
      <path d="M3 18l1.5 1.5L7 17" />
    </svg>
  );
}

/** pin icon —— conv-item 置顶标记（v0.0.231：图钉形，stroke 风格对齐其他 icon，currentColor 继承父色） */
export function PinIcon({ size = 12, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V16a1 1 0 001 1h12a1 1 0 001-1v-.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 002-2H6a2 2 0 002 2h1z" />
    </svg>
  );
}
