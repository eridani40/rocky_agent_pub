/**
 * component-ws-tab-bar —— WorkspacePanel header（actions）
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §2（子组件分层）
 *       + §6.3（.ws-header / .ws-tabs / .ws-tab.active / .ws-actions / .ws-icon-btn）
 *       reqs/v0.0.17/mqnbr367-easy-opc-chat-v9a.html §214-220（CSS 视觉权威源）
 *
 * ws-panel 仅剩「工作区」单栏（记忆/定时任务已收纳进右上悬浮菜单，见 component-chat-float-menu），
 * 无 tab 切换 state。
 *
 * 职责：
 *   - tab：「工作区」（folder icon，恒 active，无切换语义）
 *   - actions：切换目录 swap + 刷新 refresh + 收起 chevron-right，均 26×26 hover bg-warm .ws-icon-btn
 */
import { useTranslation } from 'react-i18next';
import { ChevronRightIcon, FolderIcon, RefreshIcon, SwapIcon } from './icons';

interface WsTabBarProps {
  /** 点切换目录（POST pick-directory → PUT 切目录） */
  onSwitchDir: () => void;
  /** 点刷新（重置 tree + GET 顶层） */
  onRefresh: () => void;
  /** 点收起（panel 折叠为 36px 窄栏） */
  onCollapse: () => void;
  /** loading 期间禁用刷新按钮 */
  refreshing: boolean;
}

/**
 * ws-tab-bar：单一「工作区」栏 + swap/refresh/collapse actions（均恒渲染，无 tab 分支）。
 */
export function ComponentWsTabBar({
  onSwitchDir,
  onRefresh,
  onCollapse,
  refreshing,
}: WsTabBarProps) {
  const { t } = useTranslation('chat');
  return (
    <div className="ws-header flex items-center justify-between pt-2 px-2 gap-1 shrink-0">
      {/* tab：仅剩「工作区」，恒 active（无其余 tab 可切，非交互元素） */}
      <div className="ws-tabs flex gap-0.5 overflow-hidden">
        <div

          className="ws-tab flex items-center gap-[5px] px-3 py-1.5 pb-2 text-[12px] font-semibold border-b-2 whitespace-nowrap shrink-0 text-accent border-accent"
        >
          <FolderIcon size={12} />
          <span>{t('workspace.tab.workspace')}</span>
        </div>
      </div>
      {/* actions：工作区内容恒渲染 —— swap + refresh + 共享 collapse */}
      <div className="ws-actions flex gap-0.5">
        <button
          type="button"

          onClick={onSwitchDir}
          title={t('workspace.tab.switchDir')}
          aria-label={t('workspace.tab.switchDir')}
          className="ws-icon-btn w-[26px] h-[26px] rounded-md flex items-center justify-center text-muted bg-transparent border-none cursor-pointer hover:bg-bg-warm hover:text-fg-2 transition-all"
        >
          <SwapIcon size={14} />
        </button>
        <button
          type="button"

          onClick={onRefresh}
          disabled={refreshing}
          title={t('workspace.tab.refresh')}
          aria-label={t('workspace.tab.refresh')}
          className="ws-icon-btn w-[26px] h-[26px] rounded-md flex items-center justify-center text-muted bg-transparent border-none cursor-pointer hover:bg-bg-warm hover:text-fg-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {refreshing ? (
            <span
              aria-hidden
              className="inline-block w-[12px] h-[12px] border-[1.5px] border-border-strong border-t-accent rounded-full animate-spin"
            />
          ) : (
            <RefreshIcon size={14} />
          )}
        </button>
        <button
          type="button"

          onClick={onCollapse}
          title={t('workspace.tab.collapse')}
          aria-label={t('workspace.tab.collapse')}
          className="ws-icon-btn w-[26px] h-[26px] rounded-md flex items-center justify-center text-muted bg-transparent border-none cursor-pointer hover:bg-bg-warm hover:text-fg-2 transition-all"
        >
          <ChevronRightIcon size={15} />
        </button>
      </div>
    </div>
  );
}

export default ComponentWsTabBar;
