/**
 * component-mention-popover —— @ 触发的多 tab 搜索浮层
 * 参考: specs/ui/components/chat-page/mention-popover.md
 *       specs/api/mention/GET-search.md（请求参数 + 响应结构）
 *
 * 职责：顶部 tab 栏 + search input + 滚动结果列表。
 * 由 ChatComposer 在 `@` 触发时渲染，绝对定位浮于编辑器上方。
 *
 * 边界：不做搜索执行（→ server GET /mention/search）；不做 pill 插入（→ ChatComposer onSelect）。
 */
import { useState, useEffect, useRef, useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { resolveApiBase } from '../../lib/api-base';
import { FileIcon, FolderIcon } from './icons';

/**
 * MentionItem（镜像 server schema，前端透传不解释）。
 * 参考: specs/tech/mention/provider-interface.md §3
 *   - address：按 type 不同字段不同（file/skill=path；workitem=kind+id；member=id）
 *   - display：pill 渲染唯一依据（icon/label/badge）
 *   - listView：popover 列表渲染（title/subtitle/icon），运行时短暂消费
 *   - isDir：file provider 目录命中 true；缺省=文件（member/skill/workitem 不设）
 */
export interface MentionItem {
  type: string;
  /** 是否为目录条目（file provider 目录命中 true；缺省=文件，向后兼容） */
  isDir?: boolean;
  // ─── Address ───
  /** file/skill 路径（workitem/member 不使用此字段） */
  path?: string;
  /** workitem kind ∈ {goal, kr, requirement, task} */
  kind?: string;
  /** workitem ID / member ID（ULID） */
  id?: string;
  // ─── Display（pill 渲染依据） ───
  display: {
    icon: string;
    label: string;
    badge?: string;
  };
  // ─── ListView（popover 列表渲染） ───
  listView: { title: string; subtitle?: string; icon?: string };
}

/** provider 元数据（tab 列表） */
export interface MentionProviderMeta {
  name: string;
  label: string;
}

/** MentionPopover Props */
export interface MentionPopoverProps {
  /** 已注册的 provider 列表（tab 来源） */
  providers: MentionProviderMeta[];
  /** 当前 @ 后输入的查询文本（实时同步） */
  query: string;
  /** 选中结果回调（ChatComposer 据此插入 pill + 关闭面板） */
  onSelect: (item: MentionItem) => void;
  /** 关闭面板回调（Esc / blur / 外部点击） */
  onClose: () => void;
  /** sessionId（调 search API 用） */
  sessionId: string;
}

/** 搜索结果 + 分页游标 */
interface SearchState {
  items: MentionItem[];
  nextCursor?: string;
  loading: boolean;
  /** 服务端是否截断（命中数超 100 早停）；翻页 append 时保留透传 */
  truncated?: boolean;
}

/**
 * @ 触发的多 tab 搜索浮层。
 * 固定尺寸 + overflow-y scroll；debounce 200ms；键盘导航 ↑↓/Enter/Esc。
 */
export function MentionPopover({
  providers,
  query,
  onSelect,
  onClose,
  sessionId,
}: MentionPopoverProps) {
  const [activeTab, setActiveTab] = useState(providers[0]?.name ?? '');
  const [searchQuery, setSearchQuery] = useState(query);
  const [state, setState] = useState<SearchState>({ items: [], loading: true });
  const [focusIndex, setFocusIndex] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');

  // 初始 + query/tab 变更时 debounce 搜索
  const doSearch = useCallback(
    async (q: string, tab: string, cursor?: string, append = false) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setState((s) => ({ ...s, loading: true }));
      try {
        const params = new URLSearchParams({
          provider: tab,
          query: q,
          sessionId,
          limit: '20',
        });
        if (cursor) params.set('cursor', cursor);
        const res = await fetch(`${resolveApiBase()}/mention/search?${params}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`search ${res.status}`);
        const data = await res.json();
        setState((s) => ({
          items: append ? [...s.items, ...(data.items ?? [])] : (data.items ?? []),
          nextCursor: data.nextCursor,
          loading: false,
          // truncated 透传：翻页 append 保留（超限提示持续显示，不阻塞「加载更多」）
          truncated: data.truncated === true || (append ? s.truncated : false),
        }));
        if (!append) setFocusIndex(0);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setState((s) => ({ ...s, loading: false }));
        }
      }
    },
    [sessionId],
  );

  // 弹出时 focus search input
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // query / tab 变更 → debounce 搜索（200ms）
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch(searchQuery, activeTab);
    }, 200);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery, activeTab, doSearch]);

  // 同步外部 query prop → 内部 searchQuery（初始 + 实时）
  useEffect(() => {
    setSearchQuery(query);
  }, [query]);

  // 外部点击收起
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // 延迟绑定避免当前 click 事件触发
    const tid = setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => {
      clearTimeout(tid);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  // 键盘导航
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const { items } = state;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIndex((i) => (i + 1) % Math.max(items.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIndex((i) => (i - 1 + items.length) % Math.max(items.length, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = items[focusIndex];
      if (item) onSelect(item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Tab') {
      // Tab 切换 provider
      e.preventDefault();
      const idx = providers.findIndex((p) => p.name === activeTab);
      const next = providers[(idx + (e.shiftKey ? -1 : 1) + providers.length) % providers.length];
      if (next) setActiveTab(next.name);
    }
  };

  // 滚动到底部 → 加载下一页
  const onScroll = () => {
    const el = listRef.current;
    if (!el || state.loading || !state.nextCursor) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 20) {
      doSearch(searchQuery, activeTab, state.nextCursor, true);
    }
  };

  // 确保 focusIndex 项可见
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const child = el.children[focusIndex] as HTMLElement | undefined;
    child?.scrollIntoView({ block: 'nearest' });
  }, [focusIndex]);

  return (
    <div
      ref={rootRef}

      // z=`--z-popover`（L2，_layering.md §2）
      className="absolute bottom-full left-0 right-0 mb-1 z-[var(--z-popover)] rounded-lg border border-border bg-surface shadow-lg"
      style={{ maxWidth: 360, height: 280 }}
      onKeyDown={onKeyDown}
    >
      {/* tab 栏 + search input */}
      <div className="flex items-center gap-1 border-b border-border px-2 h-9 shrink-0">
        {providers.map((p) => (
          <button
            key={p.name}
            type="button"
            data-action-key={`chat.mention.open-${p.name.toLowerCase().replace(/_/g, '-')}`}
            onClick={() => setActiveTab(p.name)}
            className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
              activeTab === p.name
                ? 'text-fg border-b-2 border-accent'
                : 'text-muted hover:text-fg'
            }`}
          >
            {p.label}
          </button>
        ))}
        <input
          ref={searchInputRef}
          data-action-key="chat.mention.search"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t('mention.searchPlaceholder')}
          className="ml-auto h-7 w-24 bg-transparent border-none text-xs text-fg outline-none placeholder:text-muted"
        />
      </div>

      {/* 结果列表 */}
      <div
        ref={listRef}
        onScroll={onScroll}
        className="overflow-y-auto"
        style={{ height: 'calc(100% - 36px)' }}
      >
        {state.loading && state.items.length === 0 ? (
          <div
            className="flex items-center justify-center h-full text-xs text-muted"
          >
            {tCommon('status.loading')}
          </div>
        ) : state.items.length === 0 ? (
          <div
            className="flex items-center justify-center h-full text-xs text-muted"
          >
            {t('mention.noMatch')}
          </div>
        ) : (
          <>
            {state.items.map((item, idx) => {
              // path 可能 undefined（workitem/member），用复合 id 作 key/data-attr
              const itemId = item.path ?? (item.kind && item.id ? `${item.kind}/${item.id}` : item.id) ?? item.listView.title;
              // file provider：目录 FolderIcon gold / 文件 FileIcon muted（对齐工作区搜索 ws-ico 样式）；
              // 非 file provider（skill/member/workitem）保持现状——不渲染 icon，仅文本
              const isDir = item.isDir === true;
              return (
              <button
                key={itemId}
                type="button"
                data-action-key="chat.mention.select"
                data-item-id={itemId}
                data-item-type={item.type}
                onClick={() => onSelect(item)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left transition-colors ${
                  idx === focusIndex ? 'bg-[var(--color-accent-surface)]' : 'hover:bg-[var(--surface-2)]'
                }`}
              >
                {item.type === 'file' && (
                  <span
                    className={`inline-flex shrink-0 relative ${isDir ? 'text-gold' : 'text-muted'}`}
                    data-testid={`mention-item-icon-${isDir ? 'dir' : 'file'}`}
                  >
                    {isDir ? <FolderIcon size={13} /> : <FileIcon size={13} />}
                  </span>
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-fg truncate">{item.listView.title}</div>
                  {/* 下排路径始终展示：file provider 保证根路径 '/' 或 dirname 非空，无条件渲染；
                      非 file provider 有 subtitle 才渲染（保持现状） */}
                  {(item.type === 'file' || item.listView.subtitle) && (
                    <div className="text-[10px] text-muted truncate">{item.listView.subtitle}</div>
                  )}
                </div>
              </button>
              );
            })}
            {/* 服务端 100 早停截断 → 超限提示（i18n；不阻塞「加载更多」滚动翻页） */}
            {state.truncated && state.items.length > 0 && (
              <div
                data-action-key="chat.mention.search-too-many"
                className="px-3 py-2 text-[10px] text-muted text-center"
              >
                {t('mention.searchTooMany')}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default MentionPopover;
