/**
 * use-seat-menu —— 坐席卡（队长 mini 卡）/ 坐席行（mate 行）共享「更多」菜单机械 hook
 * 参考: specs/ui/components/studio-page/component-seat-card.md v1.4 §状态/交互
 *       specs/ui/components/studio-page/component-seat-card-menu.md §翻转契约
 *       specs/tech/version_logs/v0.0.170/change_plan.md（use-seat-menu 契约行）
 *       memory: dropdown-close-listener-defer-register（setTimeout 0 延迟挂关闭监听）
 *
 * 职责：菜单开关 state + 触发按钮 rect 定位（fixed 相对视口）+ flip-up 判定 +
 *   setTimeout(0) 延迟挂 window click/contextmenu/keydown(Escape) 关闭监听。
 *   队长 mini 卡与 mate 行两形态共用。
 * 边界：本 hook 不渲染弹层——渲染归组件（走 SeatCardMenu portal body）；
 *   itemCount 由 avail 三值算；avail 由 deriveMenuAvail（role/state/handler 组合硬规则）派生。
 */
import { useEffect, useRef, useState } from 'react';
import type { Member } from './squad-types';
import { deriveMenuAvail, deriveMenuOpenUp } from './component-seat-card-menu';

/** 触发按钮与菜单弹层的间距（px），向下加在按钮底 / 向上减在按钮顶 */
const MENU_GAP_PX = 4;

export interface UseSeatMenuParams {
  member: Member;
  isLeader: boolean;
  onEdit?: (member: Member) => void;
  onBench?: (member: Member) => void;
  onDeploy?: (memberId: string) => void;
}

/** 菜单锚点（fixed 视口坐标；openUp=true 向上展开） */
export interface SeatMenuPos {
  x: number;
  y: number;
  openUp: boolean;
}

/** 菜单项可用性（从 deriveMenuAvail 返回类型派生，避免改动菜单文件导出面） */
export type SeatMenuAvail = ReturnType<typeof deriveMenuAvail>;

export interface UseSeatMenu {
  menuOpen: boolean;
  menuPos: SeatMenuPos | null;
  moreBtnRef: React.RefObject<HTMLButtonElement | null>;
  avail: SeatMenuAvail;
  openMenu: () => void;
  closeMenu: () => void;
}

/**
 * 坐席「更多」菜单机械。
 * @returns menuOpen 菜单开关态 / menuPos 弹层锚点（null=未定位）/ moreBtnRef 触发按钮 ref /
 *   avail 菜单项可用性（含 anyAvailable，驱动更多按钮 disabled）/ openMenu / closeMenu
 */
export function useSeatMenu({ member, isLeader, onEdit, onBench, onDeploy }: UseSeatMenuParams): UseSeatMenu {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<SeatMenuPos | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const avail = deriveMenuAvail(member, isLeader, onEdit, onBench, onDeploy);

  // 关闭监听：setTimeout(0) 延迟挂，躲开「打开菜单的同一次 click」冒泡关闭 bug
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    const tid = window.setTimeout(() => {
      window.addEventListener('click', close);
      window.addEventListener('contextmenu', close);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      window.removeEventListener('click', close);
      window.removeEventListener('contextmenu', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  /** 打开菜单：按触发按钮 rect 定位；视口底部空间不足时 flip-up 向上展开 */
  const openMenu = () => {
    if (!avail.anyAvailable) return;
    const rect = moreBtnRef.current?.getBoundingClientRect();
    if (rect) {
      const itemCount = [avail.hasEdit, avail.hasBench, avail.hasDeploy].filter(Boolean).length;
      const openUp = deriveMenuOpenUp(rect.bottom, itemCount, window.innerHeight);
      setMenuPos({ x: rect.right, y: openUp ? rect.top - MENU_GAP_PX : rect.bottom + MENU_GAP_PX, openUp });
    }
    setMenuOpen(true);
  };

  const closeMenu = () => setMenuOpen(false);

  return { menuOpen, menuPos, moreBtnRef, avail, openMenu, closeMenu };
}
