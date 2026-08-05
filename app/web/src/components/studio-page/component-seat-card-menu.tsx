/**
 * component-seat-card-menu —— 坐席卡「更多」菜单弹层（v0.0.168 拆分自 component-seat-card）
 * 参考: specs/ui/components/studio-page/component-seat-card-menu.md v1.2
 *       memory: dropdown-close-listener-defer-register（setTimeout 0 延迟挂关闭监听）
 *       memory: css-pointer-events-inherits-dom-not-position（祖先 transform/pointer-events 劫持 fixed 定位）
 *
 * 职责：fixed 定位 popover，按 role/state 组合渲染编辑/bench/deploy 菜单项。
 *   leader 菜单**无 bench 项**（硬规则）；deploy 仅 benched；bench 仅 !leader && deployed。
 *   本组件不管开关状态，父级控（open 布尔 + anchor 位置由父级 rect 计算传入）；仅关按钮 stop-propagation。
 * 边界：纯展示 + 回调；hooks 归父级。
 *
 * 翻转契约（flip-up）：
 *   卡片位于视口底部时菜单向下展开会超出视口。父级 openMenu 依据 deriveMenuOpenUp
 *   判定方向：openUp=true 时 anchor.y 传「按钮顶 - 4」，本组件 transform 上移 100%；
 *   否则保持「按钮底 + 4」向下展开。定位计算仍全部在父级做，本组件只按 anchor.openUp 渲染。
 * 渲染层级契约（v0.0.168.1 修 BUG-001）：
 *   走 createPortal(document.body) 挂到 body 直下——脱离卡片祖先链。
 *   缘由：SeatCard 卡片 hover 加 `-translate-y-px`（transform）。按 CSS 规范，
 *   任何 `transform !== none` 的祖先都会成为其 `position: fixed` 后代的 containing block，
 *   劫持视口相对定位——菜单跟随卡片偏移错位、点不到；hover 消失才复位显示。
 *   portal 到 body 后 fixed 恒相对视口，anchor 坐标（由父级 getBoundingClientRect 拿到）不需换算。
 */
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Member } from './squad-types';

export interface SeatCardMenuProps {
  member: Member;
  isLeader: boolean;
  /**
   * 弹层锚点（父级用触发按钮 getBoundingClientRect 计算的屏幕坐标）。
   * openUp=true → 向上展开：y = 按钮顶 - 4，transform 上移 100%；缺省/ false → 向下展开。
   */
  anchor: { x: number; y: number; openUp?: boolean };
  onEdit?: (member: Member) => void;
  onBench?: (member: Member) => void;
  onDeploy?: (memberId: string) => void;
  /** 菜单项点击后回调父级关菜单 */
  onClose: () => void;
}

/** 菜单高度估算常量：每项约 29px（px-3 py-1.5 + text-[12.5px]）+ 容器 py-1 共 8px */
const MENU_ITEM_HEIGHT = 29;
const MENU_CONTAINER_PY = 8;
/** 安全封顶：菜单项至多 3 个（edit + bench/deploy 互斥），防估算值漂移 */
const MENU_MAX_HEIGHT = 3 * MENU_ITEM_HEIGHT + MENU_CONTAINER_PY;
/** 触发按钮与菜单的间距 / 距视口底边的安全余量 */
const MENU_GAP = 4;
const VIEWPORT_MARGIN = 8;

/** 估算菜单总高度（按可见项数，封顶安全值） */
export function estimateMenuHeight(itemCount: number): number {
  return Math.min(itemCount * MENU_ITEM_HEIGHT + MENU_CONTAINER_PY, MENU_MAX_HEIGHT);
}

/**
 * 翻转判定：「按钮底 + 间距 + 菜单估算高」超出「视口高 - 余量」时向上展开。
 * 纯函数，供父级 openMenu 计算 anchor（UT 直接覆盖 true/false 两分支）。
 */
export function deriveMenuOpenUp(rectBottom: number, itemCount: number, viewportHeight: number): boolean {
  return rectBottom + MENU_GAP + estimateMenuHeight(itemCount) > viewportHeight - VIEWPORT_MARGIN;
}

/** 菜单项渲染判定 */
interface MenuAvail {
  hasEdit: boolean;
  hasBench: boolean;
  hasDeploy: boolean;
}
export function deriveMenuAvail(
  member: Member,
  isLeader: boolean,
  onEdit?: (m: Member) => void,
  onBench?: (m: Member) => void,
  onDeploy?: (id: string) => void,
): MenuAvail & { anyAvailable: boolean } {
  const hasEdit = !!onEdit;
  const hasBench = !isLeader && member.state === 'deployed' && !!onBench;
  const hasDeploy = member.state === 'benched' && !!onDeploy;
  return { hasEdit, hasBench, hasDeploy, anyAvailable: hasEdit || hasBench || hasDeploy };
}

/** SeatCardMenu —— 坐席卡菜单弹层（fixed，右对齐锚点 x） */
export function SeatCardMenu({
  member,
  isLeader,
  anchor,
  onEdit,
  onBench,
  onDeploy,
  onClose,
}: SeatCardMenuProps): ReactNode {
  const { t } = useTranslation('studio');
  const avail = deriveMenuAvail(member, isLeader, onEdit, onBench, onDeploy);
  if (!avail.anyAvailable) return null;

  const runAndClose = (fn: () => void) => {
    fn();
    onClose();
  };

  // SSR / 非 DOM 环境防护（Electron/jsdom 均有 document，实际不会命中；防御性 null）
  if (typeof document === 'undefined') return null;

  const menu = (
    <div

      role="menu"
      // React 合成 stopPropagation 同时 stopPropagation 底层 native 事件——阻止 window
      // 关闭监听在「菜单容器内点击」时误关（父级 window click/contextmenu listener 是 close 菜单）。
      // portal 到 body 后 React 依然按 Fiber 树派发合成事件，stopPropagation 语义不变。
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      className="fixed bg-surface border border-border rounded-md shadow-md py-1 min-w-[160px]"
      style={{
        left: anchor.x,
        top: anchor.y,
        // 向下展开：仅左移 100% 右对齐；向上展开：再上移 100% 使菜单底边贴 anchor.y
        transform: anchor.openUp ? 'translate(-100%, -100%)' : 'translateX(-100%)',
        zIndex: 'var(--z-popover)' as unknown as number,
      }}
    >
      {avail.hasEdit && (
        <button
          type="button"
          role="menuitem"
          data-action-key="studio.member.edit"
          onClick={() => runAndClose(() => onEdit!(member))}
          className="w-full text-left px-3 py-1.5 text-[12.5px] text-fg hover:bg-surface-2 transition-colors"
        >
          {t('seats.menu.edit')}
        </button>
      )}
      {avail.hasBench && (
        <button
          type="button"
          role="menuitem"
          data-action-key="studio.member.bench"
          onClick={() => runAndClose(() => onBench!(member))}
          className="w-full text-left px-3 py-1.5 text-[12.5px] text-fg hover:bg-surface-2 transition-colors"
        >
          {t('seats.menu.bench')}
        </button>
      )}
      {avail.hasDeploy && (
        <button
          type="button"
          role="menuitem"
          data-action-key="studio.member.deploy"
          onClick={() => runAndClose(() => onDeploy!(member.id))}
          className="w-full text-left px-3 py-1.5 text-[12.5px] text-fg hover:bg-surface-2 transition-colors"
        >
          {t('seats.menu.deploy')}
        </button>
      )}
    </div>
  );

  return createPortal(menu, document.body);
}

export default SeatCardMenu;
