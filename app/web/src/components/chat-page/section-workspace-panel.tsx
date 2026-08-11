/**
 * section-workspace-panel —— WorkspacePanel 容器（§1 + §4 + §8）
 * 参考: specs/ui/components/chat-page/component-workspace-panel.md §1/§3/§4/§8
 *       specs/tech/app/frontend/[P0]component_architecture.md §3.10（useLifecycle 契约）
 *
 * 职责：collapsed/expanded 双态 + width state（per session localStorage）+ GET tree（lazy）+
 *   SSE file_changed/dir_changed 处理（经 chat-slice fan-out）+ 文件分流：.url 远程链接浏览器 / 本地文件进内置 editor（v0.0.263）。
 * reducer 在 workspace-reducer.ts；localStorage 在 workspace-storage.ts；
 * 顶层 tree GET 走 useLifecycle 四方法（onInit fetch + signal.aborted + deps=[sessionId]）。
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WsTreeNode, WorkspaceTreeResponse } from './workspace-types';
import { initWorkspaceState, wsReducer } from './workspace-reducer';
import { WS_RAIL_WIDTH, readWsCollapsed, readWsWidth, writeWsCollapsed, writeWsWidth } from './workspace-storage';
import { ComponentWsTabBar } from './component-ws-tab-bar';
import { ComponentWsPathBar } from './component-ws-path-bar';
import { ComponentWsFileTree } from './component-ws-file-tree';
import { ComponentWsSearchBox, type SearchResult } from './component-ws-search-box';
import { buildFilterTree, type FilterTreeResult } from './ws-filter-tree';
import { ComponentWsResizeHandle } from './component-ws-resize-handle';
import { ComponentWsFileEditorFallback, type WsFileTarget } from './component-ws-file-editor-fallback';
import { ComponentWsImageViewer, type WsImageTarget } from './component-ws-image-viewer';
import { usePreviewArea } from './preview-area-context';
import { openLocalPath } from '../../lib/open-local-path';
import { ChevronLeftIcon } from './icons';
import { getWorkspaceTree, openWorkspaceItem, pickWorkspaceDirectory, updateSession } from '../../lib/chat-api';
import { expandedPathsByDepth } from '../../store/workspace-slice-reducer';
import { computeWatchSet } from './workspace-watch-set';
import { useLifecycle } from '../../lib/use-lifecycle';
import { useWorkspaceWatch } from './use-workspace-watch';
import { useWorkspaceEventEffect } from './use-workspace-event-effect';
import { useWorkspaceStructuralRefetch } from './use-workspace-structural-refetch';

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
  const { applyWatchSet } = useWorkspaceWatch(sessionId);
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
  // [v0.0.182] resize end = persist localStorage + 通知父退出场景 A
  const handleResizeEnd = useCallback(() => {
    persistWidth();
    onDragModeChange?.(false);
  }, [persistWidth, onDragModeChange]);

  useEffect(() => { onLayoutChange?.({ settingWidth: width, collapsed }); }, [width, collapsed, onLayoutChange]);

  // 切 session：同步 dispatch fresh（重置 reducer state + 标 loading）
  useEffect(() => { dispatch({ type: 'fresh' }); }, [sessionId]);

  // 拉顶层 tree 走 useLifecycle（onInit fetch + signal.aborted 校验）
  const { ctx: rootTree, error: treeError } = useLifecycle<WorkspaceTreeResponse>({
    onInit: async ({ signal }) => {
      const res = await getWorkspaceTree(sessionId);
      // 不变量②：fetch 后必须 signal.aborted 校验（杜绝 setState on unmounted）
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return res;
    },
    deps: [sessionId],
  });

  useEffect(() => {
    if (rootTree) dispatch({ type: 'tree-loaded', payload: { dir: rootTree.workspaceDir, tree: rootTree.tree } });
  }, [rootTree]);

  useEffect(() => { if (treeError) console.warn('getWorkspaceTree failed:', treeError); }, [treeError]);

  // 展开文件夹（lazy：未加载/stale → GET 子目录；v0.0.271 watch 由重算 effect 触发）
  const handleExpand = useCallback(
    async (path: string) => {
      dispatch({ type: 'toggle-expand', payload: { path, force: true } });
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
    [sessionId, state.childrenCache, state.stalePaths],
  );

  const handleCollapse = useCallback((path: string) => {
    dispatch({ type: 'toggle-expand', payload: { path, force: false } });
  }, []);

  // stale re-fetch（ws-file-tree 监听 stalePaths + 已展开 → 调本函数；结构刷新复用：'' → tree-loaded / 非空 → children-loaded）
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

  const [fileEditorTarget, setFileEditorTarget] = useState<WsFileTarget | null>(null);
  const [wsImageTarget, setWsImageTarget] = useState<WsImageTarget | null>(null);

  // [v0.0.324 D4] 搜索态：FileTree 常驻（数据源切换），搜索时切换为裁剪树
  const [searching, setSearching] = useState(false);
  const [filterResult, setFilterResult] = useState<FilterTreeResult | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);

  // 搜索结果回调 → 构建裁剪树
  const handleSearchResult = useCallback(
    (result: SearchResult | null) => {
      if (!result) {
        setFilterResult(null);
        setSearchTruncated(false);
        return;
      }
      const filtered = buildFilterTree(result.hits, {
        limit: 100,
        existingChildrenCache: state.childrenCache,
      });
      setFilterResult(filtered);
      setSearchTruncated(result.truncated);
    },
    [state.childrenCache],
  );

  // [v0.0.327] 搜索结果到达 → filterResult.expandedPaths 作为初始展开建议合并入 state.expanded
  //   （MERGE 不覆盖：用户已有的手动展开/收起保留；后续 toggle-expand 也走 state.expanded 自然生效）
  useEffect(() => {
    if (filterResult) {
      dispatch({ type: 'merge-expanded', payload: { paths: filterResult.expandedPaths } });
    }
  }, [filterResult]);

  // [Task 3 偏离] usePreviewArea 有 Provider → onEditor 改调 preview.openTab（预览区打开）；
  // 无 Provider（academy section-version-chat）→ 降级 setFileEditorTarget（fallback 弹层，D7 MUST）
  const preview = usePreviewArea();

  // [v0.0.280] 改调共享分发 lib（≡ 聊天链）：folder/.url/image/12 格式/系统打开五路语义原样保留
  const handleOpen = useCallback(
    (node: WsTreeNode) => {
      openLocalPath(node.path, {
        sessionId,
        source: 'workspace',
        // WsTreeNode.type 用 'dir'；openLocalPath/openWorkspaceItem 语义用 'folder'（原 handleOpen node.type!=='file' 判定等价）
        kind: node.type === 'dir' ? 'folder' : 'file',
        onEditor: preview
          ? (t) => preview.openTab(t) // 有 Provider → 预览区 tab（Task 3 D7）
          : (t) => setFileEditorTarget({ path: t.path, fileName: t.fileName, subtitle: t.subtitle, format: t.format ?? 'txt' }),
        onImageViewer: (t) => setWsImageTarget({ path: t.path, fileName: t.fileName, subtitle: t.subtitle }),
      });
    },
    [sessionId, preview],
  );

  // 手动刷新（§3.3）：重置 tree + GET 顶层 + 按 expanded 逐层补回 childrenCache（保留 expanded）
  const handleRefresh = useCallback(() => {
    // 刷新前快照已展开路径（reset 清 childrenCache 保留 expanded，按深度排序逐层补回）
    const expandedPaths = expandedPathsByDepth(state.expanded);
    dispatch({ type: 'reset' });
    (async () => {
      try {
        const res = await getWorkspaceTree(sessionId);
        dispatch({ type: 'tree-loaded', payload: { dir: res.workspaceDir, tree: res.tree } });
        // 逐层补回 expanded paths 的 childrenCache（父先于子，按深度升序）
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

  // 切换工作区目录（§4.5）：本地立即按 dir_changed 语义重置（清 expanded/tree/childrenCache，workspaceDir 更新为新值——覆盖「切目录旧 expanded 相对基准变」风险）；watch 新根由 watch-set 重算 effect 自动发
  const handleSwitchDir = useCallback(async () => {
    try {
      const picked = await pickWorkspaceDirectory(sessionId, { currentDir: state.workspaceDir });
      if (!picked.path) return; // 用户取消
      await updateSession(sessionId, { workspaceDir: picked.path });
      dispatch({
        type: 'dir-changed',
        payload: { type: 'session_workspace_dir_changed', sessionId, createdAt: new Date().toISOString(), data: { workspaceDir: picked.path, prevDir: state.workspaceDir } },
      });
      const res = await getWorkspaceTree(sessionId);
      dispatch({ type: 'tree-loaded', payload: { dir: res.workspaceDir, tree: res.tree } });
    } catch (e) {
      console.warn('switchDir failed:', e);
    }
  }, [sessionId, state.workspaceDir]);

  // 监听 chat-slice fan-out 的 workspace SSE 事件（实现见 use-workspace-event-effect.ts）
  useWorkspaceEventEffect({ sessionId, dispatch });

  useWorkspaceStructuralRefetch({ state, dispatch, onRefetch: handleStaleRefetch });

  // [v0.0.271] watch-set 重算：tree/expanded/childrenCache 变化 → 全量重算 → applyWatchSet（后端 diff；两次幂等）
  // [v0.0.275] 依赖加 stalePaths（fs 事件驱动重算）+ diff pre-check（集合没变不发 POST）
  const lastWatchSetRef = useRef<string | null>(null);
  useEffect(() => {
    const next = computeWatchSet({ tree: state.tree, expanded: state.expanded, childrenCache: state.childrenCache });
    const key = JSON.stringify(next);
    if (key === lastWatchSetRef.current) return; // 集合未变 → 不发 POST（防每事件都发请求）
    lastWatchSetRef.current = key;
    applyWatchSet(next);
  }, [state.tree, state.expanded, state.childrenCache, state.stalePaths, applyWatchSet]);

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
      {/* [v0.0.324 D4] 搜索框：TabBar 与 PathBar 之间；onResult 上报 → 构建裁剪树 */}
      <ComponentWsSearchBox
        sessionId={sessionId}
        tree={state.tree}
        childrenCache={state.childrenCache}
        onResult={handleSearchResult}
        onSearchingChange={setSearching}
      />
      {/* PathBar：搜索态隐藏（不变） */}
      {!searching && (
        <ComponentWsPathBar
          workspaceDir={state.workspaceDir}
          sessionId={sessionId}
          onOpenRoot={() => openWorkspaceItem(sessionId, { path: '.', kind: 'folder' }).catch((e) => console.warn('openWorkspaceItem root failed:', e))}
        />
      )}
      {/* [v0.0.324 D4] FileTree 常驻（去掉 !searching 条件）：搜索态切换数据源为裁剪树 */}
      <ComponentWsFileTree
        state={searching && filterResult
          ? {
              ...state,
              tree: filterResult.tree,
              childrenCache: { ...state.childrenCache, ...filterResult.childrenCache },
              // [v0.0.327] expanded 不覆盖——state.expanded 权威（merge-expanded effect 初始合并 + toggle-expand 用户操作）
            }
          : state}
        onExpand={(p) => void handleExpand(p)}
        onCollapse={handleCollapse}
        onOpen={handleOpen}
        onStaleRefetch={(p) => void handleStaleRefetch(p)}
        tooMany={searching && searchTruncated}
      />
      {/* 挂载层：12 格式 → preview.openTab（有 Provider）/ fallback 弹层（无 Provider 降级）；
          6 格式图片 → image viewer（v0.0.269 保留弹层，不进预览区） */}
      {!preview && <ComponentWsFileEditorFallback sessionId={sessionId} target={fileEditorTarget} onClose={() => setFileEditorTarget(null)} />}
      <ComponentWsImageViewer sessionId={sessionId} target={wsImageTarget} onClose={() => setWsImageTarget(null)} />
    </aside>
  );
}

export default SectionWorkspacePanel;
