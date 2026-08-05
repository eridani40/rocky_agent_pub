/**
 * component-ws-file-tree —— WorkspacePanel 文件树（§4.3 lazy 加载，递归渲染）
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §3.4（懒加载策略）
 *       + §4.3（文件夹展开/收起）+ §6.5（.ws-tree 滚动容器）
 *
 * 职责：递归渲染 ws-tree-item（顶层 tree + 每个展开目录的 childrenCache[path]）。
 *   - 展开文件夹时若 childrenCache[path] 未加载 → onExpand(path) 触发 GET 子目录
 *   - stalePaths 含 path 时展开触发重新 GET（清缓存）
 *   - 收起保留缓存（§4.3）
 *
 * 数据流：组件只负责渲染 + 触发回调；reducer 在父 section-workspace-panel 维护。
 */
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkspaceState, WsTreeNode } from './workspace-types';
import { ComponentWsTreeItem } from './component-ws-tree-item';

interface WsFileTreeProps {
  state: WorkspaceState;
  /** 展开文件夹（父组件按 lazy 策略拉子目录） */
  onExpand: (path: string) => void;
  /** 收起文件夹（保留缓存） */
  onCollapse: (path: string) => void;
  /** 点 hover「打开」按钮 → POST open */
  onOpen: (node: WsTreeNode) => void;
  /** stale 路径触发 re-fetch（父组件 effect 监听 stalePaths + 已展开 → GET） */
  onStaleRefetch: (parentPath: string) => void;
}

/**
 * 渲染顶层 tree + 递归展开目录。
 * stale refetch：监听 stalePaths，对其中已展开的父目录触发 onStaleRefetch（父 reducer 拉）。
 */
export function ComponentWsFileTree({
  state,
  onExpand,
  onCollapse,
  onOpen,
  onStaleRefetch,
}: WsFileTreeProps) {
  // 记录上次已触发的 stale refetch（避免重复请求；reducer 标 stale 后 effect 拉完清 stale）
  const refetchedRef = useRef<Set<string>>(new Set());
  const { t } = useTranslation('chat');

  // stale refetch：stalePaths 中已展开的父目录 → 触发 GET（spec §3.2 已展开父目录局部刷新）
  useEffect(() => {
    for (const parent of state.stalePaths) {
      // 顶层（parent=''）按是否加载过 tree 决定；子目录按 expanded 判断。
      // root 永远视为展开（顶层 tree 在 workspace tab 激活时始终渲染）：
      // 不用 state.tree.length>0 当 proxy——空 workspace（tree=[]）会被误判为未展开，
      // stale re-fetch 永不触发 → 新增文件不显示。
      const isExpanded = parent === '' ? true : state.expanded[parent] === true;
      if (isExpanded && !refetchedRef.current.has(parent)) {
        refetchedRef.current.add(parent);
        onStaleRefetch(parent);
      }
    }
    // 清理：stalePaths 已移除的 parent 从 refetchedRef 清掉（下次再 stale 可再触发）
    const next = new Set<string>();
    for (const r of refetchedRef.current) {
      if (state.stalePaths.has(r)) next.add(r);
    }
    refetchedRef.current = next;
  }, [state.stalePaths, state.expanded, state.tree.length, onStaleRefetch]);

  return (
    <div className="ws-tree flex-1 overflow-y-auto p-1.5 pb-3">
      {state.loading && state.tree.length === 0 ? (
        <div className="flex justify-center py-4">
          <span

            aria-label={t('workspace.tree.loading')}
            className="inline-block w-[14px] h-[14px] border-2 border-border-strong border-t-accent rounded-full animate-spin"
          />
        </div>
      ) : (
        <TreeLevel
          items={state.tree}
          depth={0}
          state={state}
          onExpand={onExpand}
          onCollapse={onCollapse}
          onOpen={onOpen}
        />
      )}
    </div>
  );
}

/** 递归渲染一层（顶层 depth=0；子目录从 childrenCache 取） */
interface TreeLevelProps {
  items: WsTreeNode[];
  depth: number;
  state: WorkspaceState;
  onExpand: (path: string) => void;
  onCollapse: (path: string) => void;
  onOpen: (node: WsTreeNode) => void;
}

function TreeLevel({ items, depth, state, onExpand, onCollapse, onOpen }: TreeLevelProps) {
  return (
    <>
      {items.map((node) => {
        const expanded = state.expanded[node.path] === true;
        const loading = state.loadingChildren[node.path] === true;
        const children = state.childrenCache[node.path];
        return (
          <div key={node.path}>
            <ComponentWsTreeItem
              node={node}
              depth={depth}
              expanded={expanded}
              loading={loading}
              onToggleExpand={(path) => {
                if (expanded) {
                  onCollapse(path);
                } else {
                  onExpand(path);
                }
              }}
              onOpen={onOpen}
            />
            {/* 展开文件夹时递归渲染子层（children 已加载） */}
            {expanded && node.type === 'dir' && children && children.length > 0 && (
              <TreeLevel
                items={children}
                depth={depth + 1}
                state={state}
                onExpand={onExpand}
                onCollapse={onCollapse}
                onOpen={onOpen}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export default ComponentWsFileTree;
