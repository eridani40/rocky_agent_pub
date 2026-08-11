/**
 * use-preview-tabs —— 预览区 tab 状态机（v0.0.320 D4；ET-fix：dirty 守卫覆盖 open + 放弃清 draft）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D4
 *
 * 职责：tabs+activeTabId（id=`${source}:${path}` 唯一）；openTab/activateTab/closeTab 编辑态守卫；
 * saveTab expectedVersion（409 冲突 modal）；读失败 error pill 可重试。
 * [老板编辑态守卫] mode='edit' 就拦截所有切换（不只 dirty=true）；
 *   保存成功更新 version+回 view+dirty=false+draft 同步；
 *   放弃修改 → 回 view + draft 重置为 content（防旧草稿残留，ET-fix BLOCKING2）；
 *   切换后目标 tab 必定只读态（mode='view'，不保留编辑态）；
 * absolute version='' 跳过冲突。
 *
 * [老板第三批补充] collapsed 状态下移到 hook 层：openTab/activateTab 成功后自动展开（setCollapsed(false)）。
 *   collapsed per session localStorage 持久化（读写由 section-preview-area 的 readPvCollapsed/writePvCollapsed 提供）。
 */
import { useCallback, useRef, useState } from 'react';
import type { OpenLocalTarget } from '../../lib/open-local-path';
import { saveWorkspaceFile } from '../../lib/chat-api';
import type {
  ConflictAction,
  ConflictPending,
  DirtyAction,
  DirtyPending,
  PreviewTab,
} from './preview-tabs-types';
import { makeTab, neighborId, readFileContent, readRockyShell } from './preview-tabs-io';
import { usePreviewCollapsed } from './use-preview-collapsed';

interface UsePreviewTabsOpts {
  sessionId: string;
}

/**
 * 预览 tab 状态机。返回 tabs/activeTabId + 操作回调。
 * 内部管理 dirty/conflict modal pending 状态（dirtyPending / conflictPending 供容器渲染 modal）。
 */
export function usePreviewTabs({ sessionId }: UsePreviewTabsOpts) {
  const [tabs, setTabs] = useState<PreviewTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [dirtyPending, setDirtyPending] = useState<DirtyPending | null>(null);
  const [conflictPending, setConflictPending] = useState<ConflictPending | null>(null);
  // [老板第三批补充] collapsed 下移到 hook 层（抽离到 use-preview-collapsed.ts）
  // [v0.0.329 门模型] 解构 door/setDoor（collapsed 派生 = door!=='center'；setCollapsed 桥接 setDoor）
  const { collapsed, setCollapsed, door, setDoor } = usePreviewCollapsed(sessionId);
  // 递增 reqId 屏蔽过期响应（openTab 快速切换时旧请求覆盖新值）
  const reqIdRef = useRef(0);

  /** 激活 tab（不经守卫——守卫在容器层 pending 确认后调用本函数） */
  const activateTabDirect = useCallback((id: string) => {
    // [老板编辑态守卫] 切换后目标 tab 必定只读态（不保留编辑态）
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, mode: 'view' as const } : t)));
    setActiveTabId(id);
    // [老板第三批补充] 收起态切换文件 → 自动展开
    setCollapsed(false);
  }, [setCollapsed]);

  /** 异步加载 tab 内容并更新状态（reqId 防竞态；读失败 → error pill 可重试） */
  const loadTab = useCallback(
    (tabId: string, path: string, source: 'workspace' | 'absolute') => {
      const myId = ++reqIdRef.current;
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, loadState: 'loading', errorMsg: undefined } : t)));
      readFileContent(sessionId, source, path)
        .then(({ content, version }) => {
          if (myId !== reqIdRef.current) return;
          setTabs((prev) =>
            prev.map((t) =>
              t.id === tabId ? { ...t, content, draft: content, version, loadState: 'loaded', errorMsg: undefined, dirty: false } : t,
            ),
          );
        })
        .catch((e: unknown) => {
          if (myId !== reqIdRef.current) return;
          setTabs((prev) =>
            prev.map((t) => (t.id === tabId ? { ...t, loadState: 'error', errorMsg: e instanceof Error ? e.message : '打开失败' } : t)),
          );
        });
    },
    [sessionId],
  );

  /** 打开文件核心（无守卫）：同 path 已存在 → activate（重置 view）；不存在 → 新建 + activate + 异步 load */
  const openTabDirect = useCallback(
    (target: OpenLocalTarget) => {
      const id = `${target.source}:${target.path}`;
      if (tabs.some((t) => t.id === id)) {
        activateTabDirect(id);
        return;
      }
      const tab = makeTab(target);
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(id);
      loadTab(id, target.path, target.source);
      // [老板第三批补充] 收起态打开新文件 → 自动展开
      setCollapsed(false);
    },
    [tabs, activateTabDirect, loadTab, setCollapsed],
  );

  /** 打开文件（[老板编辑态守卫] mode='edit' 就拦截：编辑态开新文件 → pending open；否则直接打开） */
  const openTab = useCallback(
    (target: OpenLocalTarget) => {
      const id = `${target.source}:${target.path}`;
      const current = tabs.find((t) => t.id === activeTabId);
      if (current?.mode === 'edit' && current.id !== id) {
        setDirtyPending({ tabId: current.id, action: 'open', targetTabId: id, pendingOpen: target });
        return;
      }
      openTabDirect(target);
    },
    [tabs, activeTabId, openTabDirect],
  );

  /** 激活 tab（[老板编辑态守卫] mode='edit' 就拦截：编辑态切 tab → pending 确认；否则直接激活） */
  const activateTab = useCallback(
    (id: string) => {
      const current = tabs.find((t) => t.id === activeTabId);
      if (current?.mode === 'edit' && current.id !== id) {
        setDirtyPending({ tabId: current.id, action: 'activate', targetTabId: id });
        return;
      }
      activateTabDirect(id);
    },
    [tabs, activeTabId, activateTabDirect],
  );

  /** 关闭 tab（dirty 守卫 + 焦点左移；无守卫时直接关闭——守卫确认后调用） */
  const closeTabDirect = useCallback(
    (id: string) => {
      const next = neighborId(tabs, id);
      setTabs((prev) => prev.filter((t) => t.id !== id));
      if (activeTabId === id) setActiveTabId(next);
    },
    [tabs, activeTabId],
  );

  /** 关闭 tab（[老板编辑态守卫] mode='edit' 就拦截） */
  const closeTab = useCallback(
    (id: string) => {
      const current = tabs.find((t) => t.id === id);
      if (current?.mode === 'edit') {
        setDirtyPending({ tabId: id, action: 'close', targetTabId: null });
        return;
      }
      closeTabDirect(id);
    },
    [tabs, closeTabDirect],
  );

  /**
   * 保存 tab 内容核心。返回 true=保存成功；false=409 冲突（conflictPending 已挂起，调用方勿切/关）。
   * [ET-fix BLOCKING2] 保存成功 → draft 同步为已保存内容（与 content 一致，防旧草稿残留）。
   */
  const saveTabContent = useCallback(
    async (tabId: string, skipConflict: boolean): Promise<boolean> => {
      const tab = tabs.find((t) => t.id === tabId);
      if (!tab) return true;
      if (tab.source === 'absolute') {
        const api = readRockyShell();
        if (!api) throw new Error('保存失败');
        const res = await api.writeFileText(tab.path, tab.draft);
        if (!res.ok) throw new Error(res.reason === 'not-found' ? '文件已不存在' : '保存失败');
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, content: t.draft, draft: t.draft, dirty: false, mode: 'view' } : t)),
        );
        return true;
      }
      // workspace 源：带 expectedVersion（409 → 冲突 modal；force 跳过）
      const body: { path: string; content: string; expectedVersion?: string; force?: boolean } = {
        path: tab.path,
        content: tab.draft,
      };
      if (tab.version) body.expectedVersion = tab.version;
      if (skipConflict) body.force = true;
      try {
        const res = await saveWorkspaceFile(sessionId, body);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId ? { ...t, content: t.draft, draft: t.draft, dirty: false, mode: 'view', version: res.version ?? '' } : t,
          ),
        );
        return true;
      } catch (e) {
        const err = e as Error & { status?: number; body?: { currentVersion?: string } };
        if (err.status === 409) {
          setConflictPending({ tabId, currentVersion: err.body?.currentVersion ?? '' });
          return false;
        }
        throw e;
      }
    },
    [sessionId, tabs],
  );

  /**
   * dirty 守卫确认：save-switch → 保存成功才执行原操作；discard → 放弃（清 draft）执行原操作；cancel → 取消。
   * 执行原操作用 Direct 版（守卫已通过，避免旧闭包二次 pending）。
   */
  const resolveDirty = useCallback(
    async (action: DirtyAction) => {
      if (!dirtyPending) return;
      const { tabId, action: kind, targetTabId, pendingOpen } = dirtyPending;
      if (action === 'cancel') {
        setDirtyPending(null);
        return;
      }
      if (action === 'discard') {
        // [ET-fix BLOCKING2] 放弃修改 → 回 view + draft 重置为 content（文件最新内容，防旧草稿残留）
        setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, dirty: false, mode: 'view', draft: t.content } : t)));
        setDirtyPending(null);
        if (kind === 'close') closeTabDirect(tabId);
        else if (kind === 'open' && pendingOpen) openTabDirect(pendingOpen);
        else if (targetTabId) activateTabDirect(targetTabId);
        return;
      }
      // save-switch：保存成功才执行原操作；409 冲突 modal 挂起不切换
      const saved = await saveTabContent(tabId, false);
      if (!saved) return;
      setDirtyPending(null);
      if (kind === 'close') closeTabDirect(tabId);
      else if (kind === 'open' && pendingOpen) openTabDirect(pendingOpen);
      else if (targetTabId) activateTabDirect(targetTabId);
    },
    [dirtyPending, closeTabDirect, openTabDirect, activateTabDirect, saveTabContent],
  );

  /** 保存 tab（viewer/editor 保存按钮入口） */
  const saveTab = useCallback(
    async (tabId: string) => {
      await saveTabContent(tabId, false);
    },
    [saveTabContent],
  );

  /** 冲突 modal 确认：reload → 以服务端 currentVersion 重读（discard draft）；overwrite → force 覆盖重发 */
  const resolveConflict = useCallback(
    async (action: ConflictAction) => {
      if (!conflictPending) return;
      const { tabId, currentVersion } = conflictPending;
      setConflictPending(null);
      if (action === 'reload') {
        const tab = tabs.find((t) => t.id === tabId);
        if (tab) loadTab(tabId, tab.path, tab.source);
        return;
      }
      // overwrite = force 重发（跳过冲突检测）
      try {
        await saveTabContent(tabId, true);
      } catch {
        // 覆盖失败：留在 edit 显示错误（editor 内部处理）
      }
    },
    [conflictPending, tabs, loadTab, saveTabContent],
  );

  /** 编辑态操作 */
  const setDraft = useCallback((id: string, draft: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, draft, dirty: true } : t)));
  }, []);

  const setMode = useCallback((id: string, mode: 'view' | 'edit') => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, mode } : t)));
  }, []);

  const setDirty = useCallback((id: string, dirty: boolean) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, dirty } : t)));
  }, []);

  /** 重试读（error pill 按钮） */
  const retryLoad = useCallback(
    (id: string) => {
      const tab = tabs.find((t) => t.id === id);
      if (tab) loadTab(id, tab.path, tab.source);
    },
    [tabs, loadTab],
  );

  return {
    tabs,
    activeTabId,
    dirtyPending,
    conflictPending,
    collapsed,
    setCollapsed,
    door,
    setDoor,
    openTab,
    closeTab,
    activateTab,
    saveTab,
    resolveDirty,
    resolveConflict,
    setDraft,
    setMode,
    setDirty,
    retryLoad,
  };
}

export default usePreviewTabs;
