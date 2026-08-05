/**
 * section-workspace-panel —— WorkspacePanel 容器（§1 + §4 + §8）
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §1/§3/§4/§8
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 契约）
 *
 * 职责：collapsed/expanded 双态 + width state（per session localStorage）+ GET tree（lazy）+
 *   SSE file_changed/dir_changed 处理（经 chat-slice fan-out）+ isBuiltinEditable 命中文件拦截走内置 editor（v0.0.241 扩到 12 格式）。
 * reducer 在 workspace-reducer.ts；localStorage 在 workspace-storage.ts；
 * 顶层 tree GET 走 useLifecycle 四方法（onInit fetch + signal.aborted + deps=[sessionId]）。
 */
import { useCallback, useEffect, useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WsTreeNode, WorkspaceTreeResponse } from './workspace-types';
import { initWorkspaceState, wsReducer } from './workspace-reducer';
import {
  WS_RAIL_WIDTH,
  readWsCollapsed,
  readWsWidth,
  writeWsCollapsed,
  writeWsWidth,
} from './workspace-storage';
import { ComponentWsTabBar } from './component-ws-tab-bar';
import { ComponentWsPathBar } from './component-ws-path-bar';
import { ComponentWsFileTree } from './component-ws-file-tree';
import { ComponentWsResizeHandle } from './component-ws-resize-handle';
import { ComponentWsFileEditor, type WsFileTarget } from './component-ws-file-editor';
import { getFileFormat, isBuiltinEditable } from '../../lib/file-format';
import { ChevronLeftIcon } from './icons';
import {
  getWorkspaceTree,
  openWorkspaceItem,
  pickWorkspaceDirectory,
  updateSession,
} from '../../lib/chat-api';
import { expandedPathsByDepth } from '../../store/workspace-slice-reducer';
import { useLifecycle } from '../../lib/use-lifecycle';
import { useWorkspaceWatch } from './use-workspace-watch';
import { useWorkspaceEventEffect } from './use-workspace-event-effect';

interface SectionWorkspacePanelProps {
  sessionId: string;
  // ── [v0.0.182] 三栏引擎接线（4 可选 props，未传回退内部 state；既有 UT/studio 消费零破坏） ──
  /** 父引擎钳制后的渲染宽（优先于内部 width state） */
  renderWidth?: number;
  /** 拖宽动态上限（dragDynMax(available, leftCurrent)，缺省回退静态 WS_WIDTH_MAX） */
  dragMaxWidth?: number;
  /** 上报 {settingWidth, collapsed}（父用回收设定宽 + 切场景 B 时 hold） */
  onLayoutChange?: (report: { settingWidth: number; collapsed: boolean }) => void;
  /** 拖拽模式切换（父挂 setDragging('right') 进场景 A） */
  onDragModeChange?: (dragging: boolean) => void;
}

/**
 * WorkspacePanel 容器。collapsed/width 由内部 localStorage per session 持久化；
 * workspace state 自包含（workspaceDir / tree / childrenCache / expanded / loading / stalePaths）。
 * 仅「工作区」单栏内容（记忆/定时任务已移至右上悬浮菜单），无 tab 切换 state。
 */
export function SectionWorkspacePanel({
  sessionId,
  renderWidth,
  dragMaxWidth,
  onLayoutChange,
  onDragModeChange,
}: SectionWorkspacePanelProps) {
  const { t } = useTranslation('chat');
  const [state, dispatch] = useReducer(wsReducer, sessionId, initWorkspaceState);
  // 懒监听接线（v0.0.139）：clientId 稳定 + 根 watch/release-all + handleExpand/handleCollapse 用的 watchPath/unwatchPath
  const { watchPath, unwatchPath } = useWorkspaceWatch(sessionId);
  const [collapsed, setCollapsed] = useReducer(
    (_: boolean, v: boolean) => {
      writeWsCollapsed(sessionId, v);
      return v;
    },
    sessionId,
    readWsCollapsed,
  );
  // width 仅在内存中（拖宽过程频繁 setState）；localStorage 持久化由 resize-handle mouseup 回调触发（避免每帧写盘）
  const [width, setWidth] = useReducer((_: number, v: number) => v, sessionId, readWsWidth);
  const persistWidth = useCallback(() => {
    writeWsWidth(sessionId, width);
  }, [sessionId, width]);
  // [v0.0.182] resize end = persist localStorage + 通知父退出场景 A（onDragModeChange(false)）
  const handleResizeEnd = useCallback(() => {
    persistWidth();
    onDragModeChange?.(false);
  }, [persistWidth, onDragModeChange]);

  // [v0.0.182] report effect：仅 width/collapsed 值变化时上报 {settingWidth, collapsed}
  //   切 session width 不变则不重报（width useReducer init per sid，page-chat 无 key remount → 现状 quirk 一致）
  useEffect(() => {
    onLayoutChange?.({ settingWidth: width, collapsed });
  }, [width, collapsed, onLayoutChange]);

  // 切 session：同步 dispatch fresh（重置 reducer state + 标 loading，保旧 'fresh' 语义）
  // onInit 内禁 dispatch（不变量②）；fetch 由 useLifecycle deps=[sessionId] 管信号
  useEffect(() => {
    dispatch({ type: 'fresh' });
  }, [sessionId]);

  // 拉顶层 tree 走 useLifecycle（onInit fetch + signal.aborted 校验 + deps=[sessionId] 重 onInit）
  const { ctx: rootTree, error: treeError } = useLifecycle<WorkspaceTreeResponse>({
    onInit: async ({ signal }) => {
      const res = await getWorkspaceTree(sessionId);
      // 不变量②：fetch 后必须 signal.aborted 校验（杜绝 setState on unmounted）
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return res;
    },
    deps: [sessionId],
  });

  // root tree ctx 变化 → dispatch tree-loaded（ctx 为 null 跳过，避免误清空 state）
  useEffect(() => {
    if (rootTree) {
      dispatch({
        type: 'tree-loaded',
        payload: { dir: rootTree.workspaceDir, tree: rootTree.tree },
      });
    }
  }, [rootTree]);

  // fetch 失败日志（保旧 console.warn 行为；useLifecycle 已吞 AbortError，仅真实错误落此）
  useEffect(() => {
    if (treeError) console.warn('getWorkspaceTree failed:', treeError);
  }, [treeError]);

  // 展开文件夹（lazy：未加载/stale → GET 子目录）；懒监听（§4.3.1）：watch(path) 与 GET 并行，缓存命中与否都发
  const handleExpand = useCallback(
    async (path: string) => {
      dispatch({ type: 'toggle-expand', payload: { path, force: true } });
      watchPath(path);
      if (state.childrenCache[path] && !state.stalePaths.has(path)) return; // 缓存命中
      dispatch({ type: 'loading-children', payload: { path, loading: true } });
      try {
        const res = await getWorkspaceTree(sessionId, { parent: path });
        dispatch({ type: 'children-loaded', payload: { path, children: res.tree } });
      } catch (e) {
        console.warn('expand getWorkspaceTree failed:', e);
        dispatch({ type: 'loading-children', payload: { path, loading: false } });
      }
    },
    [sessionId, state.childrenCache, state.stalePaths, watchPath],
  );

  const handleCollapse = useCallback(
    (path: string) => {
      dispatch({ type: 'toggle-expand', payload: { path, force: false } });
      unwatchPath(path);
    },
    [unwatchPath],
  );

  // stale re-fetch（ws-file-tree 监听 stalePaths + 已展开 → 调本函数）
  const handleStaleRefetch = useCallback(
    async (parentPath: string) => {
      try {
        const res = await getWorkspaceTree(sessionId, parentPath ? { parent: parentPath } : undefined);
        if (parentPath === '') {
          dispatch({ type: 'tree-loaded', payload: { dir: res.workspaceDir, tree: res.tree } });
        } else {
          dispatch({ type: 'children-loaded', payload: { path: parentPath, children: res.tree } });
        }
      } catch (e) {
        console.warn('stale re-fetch failed:', e);
      }
    },
    [sessionId],
  );

  // [v0.0.241] file editor 目标（点 12 格式文件设置，关闭置空）
  const [fileEditorTarget, setFileEditorTarget] = useState<WsFileTarget | null>(null);

  const handleOpen = useCallback(
    (node: WsTreeNode) => {
      // [v0.0.241] isBuiltinEditable 守门（替换 v0.0.227 的 .md 硬编码）：12 格式 + md 命中走内置 editor
      if (node.type === 'file' && isBuiltinEditable(node.path)) {
        setFileEditorTarget({ path: node.path, fileName: node.name, subtitle: node.path, format: getFileFormat(node.path) ?? 'md' });
        return;
      }
      openWorkspaceItem(sessionId, {
        path: node.path,
        kind: node.type === 'dir' ? 'folder' : 'file',
      }).catch((e) => console.warn('openWorkspaceItem failed:', e));
    },
    [sessionId],
  );

  // 手动刷新（§3.3）：重置 tree + GET 顶层 + 按 expanded 集合逐层 GET 子目录补回 childrenCache
  // spec §3.3：保留 expanded state（resetForRefresh 不清 expanded），逐层 re-fetch children。
  const handleRefresh = useCallback(() => {
    // 刷新前快照已展开路径（reset 会清 childrenCache 但保留 expanded，按深度排序逐层补回）
    const expandedPaths = expandedPathsByDepth(state.expanded);
    dispatch({ type: 'reset' });
    (async () => {
      try {
        // 1. 重拉顶层 tree
        const res = await getWorkspaceTree(sessionId);
        dispatch({ type: 'tree-loaded', payload: { dir: res.workspaceDir, tree: res.tree } });
        // 2. 逐层补回 expanded paths 的 childrenCache（父先于子，按深度升序）
        for (const parent of expandedPaths) {
          try {
            const sub = await getWorkspaceTree(sessionId, { parent });
            dispatch({ type: 'children-loaded', payload: { path: parent, children: sub.tree } });
          } catch (e) {
            console.warn('refresh sub-tree failed:', parent, e);
          }
        }
      } catch (e) {
        console.warn('refresh failed:', e);
      }
    })();
  }, [sessionId, state.expanded]);

  // 切换工作区目录（§4.5）。§2.5 契约：切目录后端 recycleSession 清光旧监听、不自动重启——
  // 前端须重新 POST watch(path:'') 新根（同新 tab 打开路径）。本地立即补发（兜底，不等 SSE 回环）；
  // dir_changed 分支也会补发一次（覆盖「别的 tab 切了目录」场景），两处均幂等、互不冲突。
  const handleSwitchDir = useCallback(async () => {
    try {
      const picked = await pickWorkspaceDirectory(sessionId, { currentDir: state.workspaceDir });
      if (!picked.path) return; // 用户取消
      await updateSession(sessionId, { workspaceDir: picked.path });
      // SSE dir_changed 接管 tree 重置；兜底立即拉新顶层 + 重新 watch 新根
      dispatch({ type: 'reset' });
      watchPath('');
      const res = await getWorkspaceTree(sessionId);
      dispatch({ type: 'tree-loaded', payload: { dir: res.workspaceDir, tree: res.tree } });
    } catch (e) {
      console.warn('switchDir failed:', e);
    }
  }, [sessionId, state.workspaceDir, watchPath]);

  // 监听 chat-slice fan-out 的 workspace SSE 事件（实现见 use-workspace-event-effect.ts）
  useWorkspaceEventEffect({ sessionId, dispatch, watchPath });

  // ===== 渲染分支：收起态窄栏 / 展开态面板 =====
  if (collapsed) {
    return (
      <aside

        style={{ width: WS_RAIL_WIDTH }}
        className="ws-rail shrink-0 bg-surface border-l border-border flex flex-col items-center pt-2"
      >
        <button
          type="button"

          onClick={() => setCollapsed(false)}
          title={t('workspace.expand.title')}
          aria-label={t('workspace.expand.ariaLabel')}
          className="ws-rail-btn w-7 h-7 rounded-[7px] flex items-center justify-center text-muted bg-transparent border-none cursor-pointer hover:bg-accent-surface hover:text-accent transition-all"
        >
          <ChevronLeftIcon size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside

      style={{ width: renderWidth ?? width }}
      className="ws-panel shrink-0 bg-surface border-l border-border flex flex-col relative min-w-0"
    >
      <ComponentWsResizeHandle
        currentWidth={renderWidth ?? width}
        maxWidth={dragMaxWidth}
        onResize={setWidth}
        onDragStart={() => onDragModeChange?.(true)}
        onResizeEnd={handleResizeEnd}
      />
      <ComponentWsTabBar
        onSwitchDir={() => void handleSwitchDir()}
        onRefresh={handleRefresh}
        onCollapse={() => setCollapsed(true)}
        refreshing={state.loading}
      />
      <ComponentWsPathBar
        workspaceDir={state.workspaceDir}
        sessionId={sessionId}
        onOpenRoot={() =>
          openWorkspaceItem(sessionId, { path: '.', kind: 'folder' }).catch((e) =>
            console.warn('openWorkspaceItem root failed:', e),
          )
        }
      />
      <ComponentWsFileTree
        state={state}
        onExpand={(p) => void handleExpand(p)}
        onCollapse={handleCollapse}
        onOpen={handleOpen}
        onStaleRefetch={(p) => void handleStaleRefetch(p)}
      />
      {/* [v0.0.241] file editor 挂载层（点 12 格式文件时 target 非空，渲染内置编辑器弹层） */}
      <ComponentWsFileEditor sessionId={sessionId} target={fileEditorTarget} onClose={() => setFileEditorTarget(null)} />
    </aside>
  );
}

export default SectionWorkspacePanel;
