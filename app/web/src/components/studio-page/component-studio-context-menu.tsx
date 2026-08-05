/**
 * component-studio-context-menu —— studio 复制 Session ID 右键浮层菜单（v0.0.168 抽出为共享 primitive）
 * 参考: specs/ui/components/studio-page/component-studio-context-menu.md
 *       memory: dropdown-close-listener-defer-register（setTimeout 0 延迟挂关闭监听）
 *       memory: css-pointer-events-inherits-dom-not-position（祖先 transform/pointer-events 劫持 fixed 定位）
 *
 * 历史来源：v0.0.129 首版内嵌在 `section-studio-sidebar.tsx`（挂 chat 树节点右键）；v0.0.168 侧栏树删除，
 *   触发点迁到坐席卡与首页群聊入口卡，本组件抽出为共享 primitive（seats-panel 持 state + 渲染）。
 *
 * 职责：fixed 定位浮层（左上锚点 x/y）+ 单菜单项「复制 Session ID」→ writeText + 关闭。
 *   window `click`/`contextmenu`/`Escape` 三事件关闭；**setTimeout(0) 延迟挂 listener** — 躲开
 *   打开菜单的**同次**事件冒泡到 window 立刻触发关闭（一开就关 bug）。
 * 边界：纯展示 + close 回调上抛；state（sessionId/x/y）由父级持（seats-panel）。
 *
 * 渲染层级契约（v0.0.168.1 修 BUG-001 同类风险）：
 *   走 createPortal(document.body) 挂到 body 直下——脱离 seats-panel / 坐席卡祖先链。
 *   缘由与 `SeatCardMenu` 同：坐席卡 hover 加 `transform: translateY(-1px)`，
 *   会成为 `position: fixed` 后代的 containing block 劫持视口定位。虽然本菜单 state
 *   宿主在 seats-panel（非坐席卡内），但右键触发的鼠标位置可能仍在卡上处于 hover 中，
 *   同类问题存在；一并 portal 消除风险。
 */
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

export interface StudioContextMenuProps {
  /** 目标 sessionId（写入剪贴板值） */
  sessionId: string;
  /** 弹层锚点屏幕坐标 x（父级由 event.clientX 传入） */
  x: number;
  /** 弹层锚点屏幕坐标 y（父级由 event.clientY 传入） */
  y: number;
  /** 关闭回调（关闭事件 / 点复制 / Escape 都会调） */
  onClose: () => void;
}

/**
 * 复制 Session ID 右键浮层菜单。
 * 视觉基线（`component-studio-context-menu.md`）：`bg-surface + border border-border + rounded-md + shadow-md +
 *   py-1 min-w-[160px]`；菜单项 `w-full text-left px-3 py-1.5 text-[12px] text-fg hover:bg-bg-warm`。
 * z-index：`z-50`（对齐 v0.0.129 sidebar 内嵌实现），非 `--z-popover`（保留和 sidebar 旧值一致，避免视觉回归）。
 */
export function StudioContextMenu({ sessionId, x, y, onClose }: StudioContextMenuProps): ReactNode {
  const { t } = useTranslation('studio');
  // 关闭监听：setTimeout(0) 延迟挂，躲同次事件冒泡关闭 bug（memory dropdown-close-listener-defer-register）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const tid = window.setTimeout(() => {
      window.addEventListener('click', onClose);
      window.addEventListener('contextmenu', onClose);
      window.addEventListener('keydown', onKey);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      window.removeEventListener('click', onClose);
      window.removeEventListener('contextmenu', onClose);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // SSR / 非 DOM 环境防护（Electron/jsdom 均有 document；防御性 null）
  if (typeof document === 'undefined') return null;

  const menu = (
    <div

      className="fixed z-50 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-md shadow-md py-1 min-w-[160px]"
      style={{ left: x, top: y }}
    >
      <button
        type="button"

        onClick={() => {
          navigator.clipboard.writeText(sessionId);
          onClose();
        }}
        className="w-full text-left px-3 py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg-warm)] transition-colors"
      >
        {t('sidebar.copySessionId')}
      </button>
    </div>
  );

  return createPortal(menu, document.body);
}

export default StudioContextMenu;
