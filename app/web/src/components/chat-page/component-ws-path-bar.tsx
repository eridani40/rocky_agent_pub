/**
 * component-ws-path-bar —— WorkspacePanel 路径栏（§6.4）
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §6.4（.ws-path 视觉基线）
 *       + §4.4.1（path-bar hover「打开文件夹」按钮）
 *       reqs/v0.0.17/mqnbr367-easy-opc-chat-v9a.html §225（CSS 视觉权威源）
 *
 * 职责：
 *   - 10px mono muted ellipsis 显示 workspaceDir 绝对路径，hover title 全路径
 *   - 右侧 hover「打开文件夹」按钮（testid `ws-path-open`），
 *     点击触发 onOpenRoot（复用父级 openWorkspaceItem 链路，path="."）。
 *     opacity 0/1 预留 22×22 空间零位移（布局稳定性 MANDATORY，对齐 §4.4 ws-tree-item 模式）。
 */
import { useTranslation } from 'react-i18next';
import { ExternalIcon } from './icons';

interface WsPathBarProps {
  /** 当前 workspaceDir（绝对路径） */
  workspaceDir: string;
  /** 当前 session id（保留供未来扩展，目前 onOpenRoot 已闭包封装 sessionId） */
  sessionId?: string;
  /** 点击「打开文件夹」按钮回调（POST open `{path:".", kind:"folder"}`） */
  onOpenRoot?: () => void;
}

/**
 * 路径栏。空字符串时显示占位「未设置」（避免 UI 崩）。
 * .ws-path 为 flex 容器（路径文本 + 右侧 hover 按钮槽位）。
 */
export function ComponentWsPathBar({ workspaceDir, sessionId, onOpenRoot }: WsPathBarProps) {
  const { t } = useTranslation('chat');
  const unset = t('workspace.unset');
  const openTitle = t('workspace.tree.openFolder');
  return (
    <div

      title={workspaceDir || unset}
      className="ws-path group text-[10px] text-muted font-mono pt-2.5 px-3 pb-1 whitespace-nowrap overflow-hidden text-ellipsis shrink-0 flex items-center gap-1"
    >
      <span className="flex-1 min-w-0 truncate">{workspaceDir || unset}</span>
      {/* hover「打开文件夹」按钮：opacity 0 默认，.ws-path:hover（group-hover）时 opacity 1；
          flex-shrink-0 预留 22×22 空间，按钮始终在 DOM 中（布局稳定性 MANDATORY：零位移） */}
      <button
        type="button"

        onClick={onOpenRoot}
        title={openTitle}
        aria-label={openTitle}
        className="ws-path-open flex-shrink-0 w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted bg-transparent border-none cursor-pointer opacity-0 group-hover:opacity-100 hover:bg-accent-surface hover:text-accent transition-[opacity,background,color] duration-[120ms]"
      >
        <ExternalIcon size={11} />
      </button>
    </div>
  );
}

export default ComponentWsPathBar;
