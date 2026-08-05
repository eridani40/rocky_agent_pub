/**
 * component-icon-box —— 彩色浅底图标盒 primitive（common，跨页复用）
 * 参考: specs/ui/components/common/component-icon-box.md
 *       specs/ui/regulation/02-components.md §4（Icon-box 彩色小图标底规则）
 *       specs/ui/regulation/01-tokens.md §1.7（8 色 palette + 浅底权威表）
 *       specs/tech/version_logs/v0.0.165/change_plan.md §7
 *
 * 职责：
 *   32px（可 22/24 缩放）圆角 md 方块，浅底 `--hue-*-bg` + 主色 `--hue-*` 线性图标。
 *   同一 `hueBy` 恒同色（复用 `lib/hue-hash` 单例，INV-5）。
 * 用途：skill logo / plugin icon / model provider icon / 团队入口 icon / 坐席卡统计图标 等。
 * 边界：纯展示、无交互；不依赖业务 store；所有颜色走 token 不硬编码。
 */
import type { ReactNode, CSSProperties } from 'react';
import { hashHueName, type HuePaletteName } from '../../lib/hue-hash';

/** 可选尺寸档：22（trigger 内）/ 24（panel 列表项）/ 32（默认，卡片 logo）/ 34（统计条大 icon） */
export type IconBoxSize = 22 | 24 | 32 | 34;

export interface IconBoxProps {
  /**
   * hash key：同一 hueBy 恒返同色（skill.name / plugin.id / provider.id 等稳定 id）。
   * 传 `hue` 显式覆盖 hash 结果（8 palette 名之一）。
   */
  hueBy?: string;
  /** 显式指定 palette 名（覆盖 hueBy hash 结果，用于设计稿定色场景） */
  hue?: HuePaletteName;
  /** 图标节点（≤ 图标盒宽高，通常传内联 SVG，用 currentColor 继承主色） */
  icon?: ReactNode;
  /** 首字母兜底（无 icon 时显；对齐 avatar 语义），空则不渲兜底文字 */
  fallbackText?: string;
  /** 尺寸档；默认 32 */
  size?: IconBoxSize;
  /** testid（默认 'icon-box'） */
  testId?: string;
  /** 额外 className（消费方细调 margin/位置等，不覆盖 bg/color） */
  className?: string;
}

/** 尺寸档 → wh + rounded + text 类 */
function sizeClasses(size: IconBoxSize): string {
  if (size === 22) return 'h-[22px] w-[22px] rounded-md text-[11px]';
  if (size === 24) return 'h-6 w-6 rounded-md text-[12px]';
  if (size === 34) return 'h-[34px] w-[34px] rounded-lg text-[15px]';
  return 'h-8 w-8 rounded-md text-[13px]'; // 32 默认
}

/**
 * IconBox primitive。
 * 消费方例：
 *   <IconBox hueBy="skill:read_file" icon={<StarIcon/>}/>
 *   <IconBox hue="green" icon={<UsersIcon/>} size={34}/>
 *   <IconBox hueBy="alpha" fallbackText="A" size={24}/>
 */
export function IconBox({
  hueBy,
  hue,
  icon,
  fallbackText,
  size = 32,
  className,
}: IconBoxProps): ReactNode {
  // 决定 palette 名：显式 hue 优先，否则 hash(hueBy)，都无则 rose 兜底
  const paletteName: HuePaletteName = hue ?? (hueBy ? hashHueName(hueBy) : 'rose');
  const style: CSSProperties = {
    background: `var(--hue-${paletteName}-bg)`,
    color: `var(--hue-${paletteName})`,
  };
  const base = 'inline-flex items-center justify-center shrink-0 font-semibold font-sans';
  const cls = `${base} ${sizeClasses(size)}${className ? ' ' + className : ''}`;
  return (
    <span

      data-hue={paletteName}
      className={cls}
      style={style}
    >
      {icon ?? fallbackText ?? null}
    </span>
  );
}

export default IconBox;
