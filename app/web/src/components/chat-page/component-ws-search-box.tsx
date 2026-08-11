/**
 * component-ws-search-box —— WorkspacePanel 工作区搜索框（v0.0.324 D3 瘦身）
 * 参考: specs/tech/version_logs/v0.0.324/change_plan.md D3
 *       specs/prd/version_logs/v0.0.324-file-tree-search-filter-tree.md
 *
 * 职责（v0.0.324 瘦身后）：文件树上方搜索框（TabBar 与 PathBar 之间）。
 *   - 输入防抖 500ms（[v0.0.328] 从 300ms 调至 500ms，减少连续输入的无效请求）
 *   - 回车立即搜（[v0.0.328] 新增：按 Enter 跳过防抖立即触发，不等防抖）
 *   - 前端过滤：已加载树（tree + childrenCache 递归）匹配（basename 或 path 子串）
 *   - 后端补全：searchWorkspaceFiles(sessionId, {q}) → files[] + dirs[]
 *   - 合并去重 → onResult 回调上报父级（不再内部渲染结果列表）
 *   - 清空（× 或删空）→ onResult(null) + onSearchingChange(false)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WsTreeNode } from './workspace-types';
import { searchWorkspaceFiles } from '../../lib/chat-api';
import { basename } from './ws-filter-tree';
import { CloseIcon } from './icons';

/** 搜索结果上报父级的 payload */
export interface SearchResult {
  hits: { path: string; type: 'file' | 'dir' }[];
  truncated: boolean;
}

/** 搜索框 props（父级 section-workspace-panel 接线） */
interface WsSearchBoxProps {
  sessionId: string;
  /** 顶层树 + childrenCache（前端过滤已加载部分） */
  tree: WsTreeNode[];
  childrenCache: Record<string, WsTreeNode[]>;
  /** 搜索结果上报父级（null = 清空搜索态） */
  onResult: (result: SearchResult | null) => void;
  /** 搜索态变化（父级切换 FileTree 数据源） */
  onSearchingChange: (searching: boolean) => void;
}

/** 搜索上限（与后端 SEARCH_LIMIT 对齐） */
const SEARCH_LIMIT = 100;

/** 递归收集已加载节点（tree + childrenCache 展开部分） */
function collectLoaded(tree: WsTreeNode[], childrenCache: Record<string, WsTreeNode[]>): WsTreeNode[] {
  const out: WsTreeNode[] = [];
  const walk = (items: WsTreeNode[]) => {
    for (const n of items) {
      out.push(n);
      const kids = childrenCache[n.path];
      if (n.type === 'dir' && kids && kids.length > 0) walk(kids);
    }
  };
  walk(tree);
  return out;
}

/**
 * 工作区搜索框（瘦身后只保留输入 + 防抖 + loading）。
 * 结果列表渲染交回 ComponentWsFileTree（父级构建裁剪树）。
 */
export function ComponentWsSearchBox({
  sessionId,
  tree,
  childrenCache,
  onResult,
  onSearchingChange,
}: WsSearchBoxProps) {
  const { t } = useTranslation('chat');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const reqIdRef = useRef(0);
  /** 防抖定时器 ref（Enter 立即搜时清掉，防双发） */
  const debounceRef = useRef<number | null>(null);

  /**
   * 执行一次搜索（前端过滤 + 后端补全合并去重 → onResult 上报）。
   * 由防抖定时器（500ms）或 Enter 立即搜触发；reqIdRef 防过期响应覆盖。
   */
  const runSearch = useCallback(
    (rawQ: string) => {
      const q = rawQ.trim();
      if (!q) return;
      onSearchingChange(true);
      const myId = ++reqIdRef.current;
      setLoading(true);
      // q 含 / → path 子串匹配；不含 / → basename 匹配（与后端语义一致）
      const lower = q.toLowerCase();
      const pathMode = q.includes('/');
      const loaded = collectLoaded(tree, childrenCache);
      const local: { path: string; type: 'file' | 'dir' }[] = [];
      for (const n of loaded) {
        const target = pathMode ? n.path.toLowerCase() : n.name.toLowerCase();
        if (target.includes(lower)) {
          local.push({ path: n.path, type: n.type });
        }
      }
      searchWorkspaceFiles(sessionId, { q })
        .then((res) => {
          if (myId !== reqIdRef.current) return;
          // 后端结果 → {path,type}[]
          const remoteHits: { path: string; type: 'file' | 'dir' }[] = [];
          for (const d of res.dirs) remoteHits.push({ path: d, type: 'dir' });
          for (const f of res.files) remoteHits.push({ path: f, type: 'file' });
          // 合并去重（后端优先，前端补充）
          const seen = new Set<string>();
          const merged: { path: string; type: 'file' | 'dir' }[] = [];
          const push = (h: { path: string; type: 'file' | 'dir' }) => {
            if (!seen.has(h.path)) {
              seen.add(h.path);
              merged.push(h);
            }
          };
          for (const h of remoteHits) push(h);
          for (const h of local) push(h);
          // 截断
          const truncated = merged.length > SEARCH_LIMIT || res.truncated === true;
          const hits = merged.slice(0, SEARCH_LIMIT);
          onResult({ hits, truncated });
          setLoading(false);
        })
        .catch(() => {
          if (myId !== reqIdRef.current) return;
          const truncated = local.length > SEARCH_LIMIT;
          onResult({ hits: local.slice(0, SEARCH_LIMIT), truncated });
          setLoading(false);
        });
    },
    [tree, childrenCache, sessionId, onResult, onSearchingChange],
  );

  // [v0.0.328] 输入防抖：非空 query → 500ms 后触发 runSearch；空 → 清空搜索态
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setLoading(false);
      onResult(null);
      onSearchingChange(false);
      return;
    }
    // 连续输入重置防抖（停下 500ms 才真发请求）
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      runSearch(query);
    }, 500);
    return () => {
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [query, runSearch, onResult, onSearchingChange]);

  /** [v0.0.328] 回车立即搜：清防抖定时器 + 立即触发（不等 500ms） */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return;
      if (debounceRef.current !== null) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      runSearch(query);
    },
    [query, runSearch],
  );

  const searching = query.trim() !== '';

  return (
    <div className="ws-search shrink-0 px-2 pt-2 pb-1">
      <div className="flex items-center gap-1.5 rounded-md bg-bg-warm border border-border px-2 h-[26px]">
        <input
          data-testid="ws-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t('workspace.preview.searchPlaceholder')}
          className="flex-1 min-w-0 bg-transparent border-none outline-none text-[12.5px] text-fg placeholder:text-muted"
        />
        {loading && (
          <span
            aria-label={t('workspace.preview.loading')}
            className="inline-block w-[10px] h-[10px] border-[1.5px] border-border-strong border-t-accent rounded-full animate-spin shrink-0"
          />
        )}
        {searching && (
          <button
            type="button"
            data-testid="ws-search-clear"
            onClick={() => setQuery('')}
            title={t('workspace.preview.searchClear')}
            aria-label={t('workspace.preview.searchClear')}
            className="w-[16px] h-[16px] rounded flex items-center justify-center text-muted bg-transparent border-none cursor-pointer hover:text-accent shrink-0"
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

export default ComponentWsSearchBox;
