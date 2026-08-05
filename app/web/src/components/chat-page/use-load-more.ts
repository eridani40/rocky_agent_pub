/**
 * useLoadMore —— 上滑到顶续载分页 hook（compose-page 层，不进 useLifecycle 契约）
 * 参考: reqs/v0.0.94.component_refactor/design-decisions.md §7（分页不进契约：组件自管）
 *       specs/ui/components/chat-page/_overview.md §4.5（chat-load-more testid + threshold=120px）
 *
 * 抽出 chat 消费方共用（现由 section-chat-session 统一装配）的 loadMore 逻辑（防重入 + token 守卫 + prepend by-id merge）：
 *   - isLoadingMoreRef：同步守卫（不等 setState flush），进行中二次调用直接 return
 *   - loadMoreTokenRef：token 守卫，++token; await fetch; if (token !== ref.current) return 防
 *     快切 session 后旧响应仍 prepend 进新 session 的 messages
 *   - prepend 路径走 useMessages.setMessages(items, {prepend:true}) → mergeMessagesById by-id 去重
 *
 * 不进 useLifecycle 四方法契约（§7：分页是命令式 onDemand 拉取，非订阅/定时器/初始数据，
 *   无资源需生命周期回收）。组件自管 isLoadingMore state + 防重入/token ref，本 hook 收敛复用。
 */
import { useCallback, useRef, useState } from 'react';
import { getMessages } from '../../lib/chat-api';
import type { UseMessagesResult } from './use-messages';

export interface UseLoadMoreResult {
  /** 进行中标志（驱动 message-stream 跳过滚底 effect + 触发 prepend 保持位置 effect） */
  isLoadingMore: boolean;
  /** 上滑到顶续载（threshold=120px 在 ComponentMessageStream onScroll 内判定，caller 只管调） */
  loadMore: () => Promise<void>;
}

/**
 * 上滑续载分页 hook。sessionId 变化或 messagesHook 变化时 useCallback 自动重算闭包。
 * @param sessionId   当前查看的 session id（playground=activeSubId ?? activeSessionId；studio 单聊=sessionId）
 * @param messagesHook useMessages 返回值（取 messages/hasMore/setMessages）
 */
export function useLoadMore(sessionId: string, messagesHook: UseMessagesResult): UseLoadMoreResult {
  const { messages, hasMore, setMessages } = messagesHook;
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  // 防重入同步守卫（滚动事件连续触发时防抖）
  const isLoadingMoreRef = useRef(false);
  // token 守卫：快切 session 后旧响应直接丢弃（不 prepend 进新 session messages）
  const loadMoreTokenRef = useRef(0);

  const loadMore = useCallback(async () => {
    if (!sessionId || !hasMore || messages.length === 0) return;
    // 防重入：进行中二次调用直接 return
    if (isLoadingMoreRef.current) return;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    const myToken = ++loadMoreTokenRef.current;
    const oldestId = messages[0]!.id;
    try {
      const { items, hasMore: more } = await getMessages(sessionId, { limit: 50, beforeId: oldestId });
      // token 守卫：快切 session 后旧响应直接丢弃
      if (myToken !== loadMoreTokenRef.current) return;
      // prepend 走 mergeMessagesById by-id 去重（不破 SSE 累积的 tool_call 增量）
      setMessages(items, { hasMore: more, prepend: true });
    } catch {
      // ignore（拉取失败不影响 SSE 主路径）
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [sessionId, hasMore, messages, setMessages]);

  return { isLoadingMore, loadMore };
}
