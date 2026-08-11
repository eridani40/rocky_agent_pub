/**
 * component-ws-tree-item —— WorkspacePanel 文件树单条 item（§4.3 + §4.4 + §6.5）
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §4.3（文件夹展开/收起）
 *       + §4.4（item hover 打开按钮，布局稳定性 MANDATORY）
 *       + §6.5（视觉基线 .ws-item / .ws-twisty / .ws-ico / .ws-name / .ws-act）
 *       reqs/v0.0.17/mqnbr367-easy-opc-chat-v9a.html §227-239（CSS 视觉权威源）
 *
 * 职责：渲染单条节点（文件夹可展开 / 文件 hover 打开）。
 *   - twisty：仅文件夹 + hasChildren=true 显示；点击触发 onToggleExpand
 *   - [v0.0.320 D7] 文件夹 item 本体点击 → toggle 展开/收起（与 twisty 同语义防双发：
 *     item onClick 与 twisty onClick 各自 stopPropagation，互不触发）
 *   - icon：文件夹 gold（展开变 folderOpen）；文件 muted
 *   - name：12.5px ellipsis
 *   - hover「打开」按钮 .ws-act：默认 opacity 0，item hover opacity 1（绝对空间预留不位移）
 *   - 缩进：paddingLeft = 6 + depth * 14（§6.5 末段）
 *
 * 数据流（§3.4 lazy）：
 *   - hasChildren=true 时显示 twisty；点击触发 onToggleExpand(path) → 父组件按 lazy 策略拉子目录
 *   - hasChildren=false（文件 / 空目录）twisty placeholder（保持对齐）
 */
import { useTranslation } from 'react-i18next';
import type { WsTreeNode } from './workspace-types';
import { encodePathForTestid } from './workspace-types';
import {
  ChevronRightIcon,
  ExternalIcon,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
} from './icons';

interface WsTreeItemProps {
  node: WsTreeNode;
  /** 深度（0 = 顶层） */
  depth: number;
  /** 当前是否展开（文件夹） */
  expanded: boolean;
  /** 子目录是否 loading（显示 ws-tree-loading spinner） */
  loading?: boolean;
  /** toggle 展开/收起（点 twisty；文件无） */
  onToggleExpand: (path: string) => void;
  /** 点 hover「打开」按钮 → POST open（kind 由 node.type 派生 file/folder） */
  onOpen: (node: WsTreeNode) => void;
}

/**
 * 渲染单条 ws-tree-item。布局稳定性：ws-act 用 opacity 切换（绝对空间预留），
 * 不因 hover 出现/消失导致 name 位移（§4.4 MANDATORY）。
 */
export function ComponentWsTreeItem({
  node,
  depth,
  expanded,
  loading = false,
  onToggleExpand,
  onOpen,
}: WsTreeItemProps) {
  const isDir = node.type === 'dir';
  const hasTwisty = isDir && node.hasChildren;
  const testidPath = encodePathForTestid(node.path);
  const { t } = useTranslation(['common', 'chat']);
  const toggleLabel = expanded ? t('common:action.collapse') : t('common:action.expand');
  const openLabel = isDir ? t('chat:workspace.tree.openFolder') : t('chat:workspace.tree.openFile');

  return (
    <div
      // [v0.0.320 D7] 文件夹 item 本体点击 → toggle 展开/收起（与 twisty 同语义）；
      //   文件 item 本体点击 → onOpen（五路分流，消费端已改预览区）。
      //   防双发：twisty / hover 打开按钮 onClick 均 stopPropagation，互不触发 item onClick。
      role="button"
      aria-label={openLabel}
      title={openLabel}
      onClick={() => {
        if (isDir) onToggleExpand(node.path);
        else onOpen(node);
      }}
      className="ws-item group flex items-center gap-1 h-[26px] pr-2 rounded-md relative hover:bg-bg-warm cursor-pointer"
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      {/* twisty（仅文件夹 + hasChildren 显示；其余 placeholder 对齐，§6.5 .ws-twisty.placeholder） */}
      {hasTwisty ? (
        <span

          role="button"
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(node.path);
          }}
          className={'ws-twisty w-[14px] h-[14px] flex items-center justify-center text-muted cursor-pointer shrink-0' + (expanded ? ' open' : '')}
        >
          <ChevronRightIcon
            size={10}
            style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}
          />
        </span>
      ) : (
        <span className="ws-twisty w-[14px] h-[14px] shrink-0 invisible" aria-hidden />
      )}

      {/* icon：文件夹 gold（展开变 folderOpen）/ 文件 muted（§6.5 .ws-ico） */}
      <span className={'ws-ico inline-flex shrink-0 relative ' + (isDir ? 'dir text-gold' : 'file text-muted')}>
        {isDir ? (
          expanded ? <FolderOpenIcon size={13} /> : <FolderIcon size={13} />
        ) : (
          <FileIcon size={13} />
        )}
        {/* [v0.0.263] symlink 角标：absolute 叠加图标右上角（不占位，不推动 name 位移）；
            title 由外层 item 提供（含 linkTarget），此处仅视觉标记 */}
        {node.isSymlink && (
          <span
            data-testid={`symlink-badge-${testidPath}`}
            aria-hidden
            className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-accent border border-surface pointer-events-none"
          />
        )}
      </span>

      {/* name（§6.5 .ws-name，12.5px ellipsis）；[v0.0.263] symlink hover tooltip 显示目标绝对路径 */}
      <span
        title={node.isSymlink && node.linkTarget ? t('chat:workspace.tree.symlinkTooltip', { target: node.linkTarget }) : undefined}
        className="ws-name flex-1 min-w-0 text-[12.5px] text-fg-2 whitespace-nowrap overflow-hidden text-ellipsis"
      >
        {node.name}
      </span>

      {/* loading spinner（lazy GET 子目录时显示 ws-tree-loading，§4.3） */}
      {loading && (
        <span

          aria-label={t('chat:workspace.tree.loading')}
          className="inline-block w-[10px] h-[10px] border-[1.5px] border-border-strong border-t-accent rounded-full animate-spin shrink-0 mr-1"
        />
      )}

      {/* hover「打开」按钮 .ws-act（§4.4 布局稳定性：opacity 切换不位移，group-hover 驱动） */}
      <button
        type="button"

        onClick={(e) => {
          e.stopPropagation();
          onOpen(node);
        }}
        title={openLabel}
        aria-label={openLabel}
        className="ws-act w-[22px] h-[22px] rounded-[5px] flex items-center justify-center text-muted bg-transparent border-none cursor-pointer opacity-0 group-hover:opacity-100 hover:bg-accent-surface hover:text-accent shrink-0 transition-[opacity,background,color] duration-[120ms]"
      >
        <ExternalIcon size={11} />
      </button>
    </div>
  );
}

export default ComponentWsTreeItem;
