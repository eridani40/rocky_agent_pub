/**
 * component-preview-collapse-toggle —— 预览区收起/展开竖条手柄（[老板第三批反馈③] + 样式修正）
 *
 * VSCode 风格面板边缘 collapse handle：竖长条手柄、垂直居中、贴分隔线边缘、hover accent 高亮。
 *
 * 三栏顺序 chat(左) | 预览(中) | 工作区(右)。预览区收起=向右收掉贴右缘；展开=从右缘向左拉回。
 * 两种形态：
 *   - floating=false（收起态）：独立窄竖条（替代 aside），手柄 ← 垂直居中（向左拉回展开）
 *   - floating=true（展开态）：悬浮在 aside 左缘竖线上，手柄 → 垂直居中（向右收掉收起）
 *
 * 收起态时本组件作为预览区唯一渲染物（aside 宽=0 隐藏）。
 *
 * [329 视觉修复·方案 A] 收起态 rail 完整粗条：本体 bg-bg-warm（深一档，与 preview bg-surface 拉开，
 *   不再被吞）+ 左右双 border（border-l-[2px] border-r-[2px]），hover 升 surface-3（保持 hover 变深）。
 *   handle 保持 bg-surface 白底（对比深色 rail 更清晰），铁律：左把手贴线左/右把手贴线右不变。
 */
import { useTranslation } from 'react-i18next';
import { ChevronLeftIcon, ChevronRightIcon } from './icons';

interface ComponentPreviewCollapseToggleProps {
  /** 当前是否收起 */
  collapsed: boolean;
  /** 点击手柄回调（展开态=收起；收起态=展开） */
  onToggle: () => void;
  /** 是否悬浮在 aside 内（展开态=true）；false=独立渲染（收起态） */
  floating?: boolean;
  /**
   * [v0.0.329 门模型] chevron 方向覆盖（可选，默认 undefined=现行为）。
   * 现行为：floating→▶（贴线左）、rail→◀（贴线左）。center 态需「细线左◀」（floating 但朝左）、
   * left 态需「粗线右▶」（rail 但朝右），现有 floating/collapsed 组合凑不出 → 加本 prop 显式覆盖。
   * 组件形态零改（尺寸/hover/rail 结构不动），仅 chevron 方向 + 贴线侧由本 prop 决定。
   *   'right' → chevron ▶、贴线右侧；'left' → chevron ◀、贴线左侧。
   */
  direction?: 'left' | 'right';
  /** [v0.0.329 门模型] tooltip 覆盖（可选；缺省按 collapsed 用 expand/collapse） */
  tooltipKey?: string;
  /** [v0.0.329 门模型] data-testid 覆盖（可选；缺省 = 现行为 pv-collapse-collapse/expand）。center 态双把手需区分 */
  testid?: string;
}

/** 竖条手柄公共样式（VSCode 风格：窄竖长条胶囊形 + hover accent；[329 微调] 水平加粗 20%：7→8px） */
const HANDLE_BASE =
  'absolute top-1/2 -translate-y-1/2 z-[10] ' +
  'w-[8px] h-[44px] rounded-full ' +           // 竖长条胶囊形（水平加粗 20%）
  'flex items-center justify-center ' +          // 箭头居中
  'bg-surface border border-border ' +           // 默认浅色贴线
  'text-muted hover:bg-accent hover:text-white hover:border-accent ' + // hover 高亮
  'transition-colors cursor-pointer';

/**
 * 收起/展开竖条手柄。
 * 展开态：贴 aside 左缘竖线，垂直居中，→ 收起。
 * 收起态：独立窄竖条，手柄 ← 垂直居中，展开。
 */
export function ComponentPreviewCollapseToggle({ collapsed, onToggle, floating = false, direction, tooltipKey, testid }: ComponentPreviewCollapseToggleProps) {
  const { t } = useTranslation('chat');

  // [v0.0.329] chevron 方向 + 贴线侧：direction 显式覆盖 > 现行为（floating→▶贴左 / rail→◀贴左）
  const pointRight = direction ? direction === 'right' : floating;
  // 贴线侧（铁律：左把手贴线左、右把手贴线右）：
  //   direction='left' → 贴线左（-left-[8px]，把手右缘贴线，现行为；偏移=handle 宽 8px 同步）
  //   direction='right' → 贴线右：floating（aside 内）→ left-0（把手左缘贴线右）；
  //                        rail（独立粗条）→ -right-[8px]（把手左缘贴粗条右缘；偏移=handle 宽 8px 同步）
  const stickCls = direction === 'right'
    ? (floating ? ' left-0' : ' -right-[8px]')
    : ' -left-[8px]';
  const Chevron = pointRight ? ChevronRightIcon : ChevronLeftIcon;
  // tooltip：direction 覆盖（doorLeft/doorRight/doorCenter）> 现 expand/collapse
  const tipKey = tooltipKey ?? (collapsed ? 'workspace.preview.expand' : 'workspace.preview.collapse');

  // 收起态：独立窄竖条（替代 aside），线略粗
  if (!floating) {
    return (
      <div
        data-testid="pv-collapsed-rail"
        className="shrink-0 w-[7px] bg-bg-warm border-l-[2px] border-r-[2px] border-border flex flex-col items-center relative cursor-pointer hover:bg-surface-3 transition-colors"
        onClick={onToggle}
      >
        {/* 展开手柄：竖条垂直居中，贴竖线缘（默认贴左向左拉回；direction='right' 贴右朝右） */}
        <button
          type="button"
          data-testid={testid ?? 'pv-collapse-expand'}
          aria-label={t(tipKey)}
          title={t(tipKey)}
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          className={HANDLE_BASE + stickCls + ' shadow-sm'}
        >
          <Chevron size={12} />
        </button>
      </div>
    );
  }

  // 展开态：贴 aside 左缘竖线，垂直居中（默认 → 向右收掉；direction='left' 朝左）
  return (
    <button
      type="button"
      data-testid={testid ?? 'pv-collapse-collapse'}
      aria-label={t(tipKey)}
      title={t(tipKey)}
      onClick={onToggle}
      className={HANDLE_BASE + stickCls + ' shadow-sm'}
    >
      <Chevron size={12} />
    </button>
  );
}

export default ComponentPreviewCollapseToggle;
