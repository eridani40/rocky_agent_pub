/**
 * use-message-scroll-pagination —— 消息流分页 + 滚动位置保持 + sticky-bottom hook
 * 参考: specs/ui/components/chat-page/_overview.md §4.5（分页前插 + 跳过滚底 + prepend 保持位置 +
 *   sticky-bottom 门控：仅当用户已在底部附近时才自动滚到底）
 *       specs/tech/version_logs/v0.0.85.ui_opt/change_plan.md F1（invariants ②③④）
 *
 * 职责：ComponentMessageStream 的滚动相关副作用——onScroll 触发 loadMore / 自动滚底 /
 *   prepend 保持位置 / sticky-bottom 门控。
 *
 * Invariants（MUST NOT 破坏）：
 *   ① 自动滚底只在「新消息/run 状态变化」触发；loadMore 前插绝不触发滚底（isLoadingMore=true 跳过）。
 *   ② loadMore 完成后下一帧也跳过一次自动滚底（防 setMessages 后又滚回底）。
 *   ③ prepend 后视觉保持原顶部条目位置：prevHeight = scrollHeight - scrollTop 技巧
 *     （useLayoutEffect 在 DOM paint 前捕获 + 恢复，无视觉跳屏）。
 *   ④ [v0.0.129] sticky-bottom：仅当用户已在底部附近（nearBottomRef.current=true）时才自动滚到底；
 *     用户向上翻看历史时不强制拉回。nearBottomRef 在 onScroll 里实时更新，初始 true。
 *   ⑤ [v0.0.129] onScroll 始终挂载（不管 hasMore）：内部同时做 near-bottom 追踪（始终）+
 *     loadMore 触发（仅 hasMore && scrollTop<threshold）。component-message-stream 无需条件挂载。
 */
import { useEffect, useLayoutEffect, useRef } from 'react';

/** onScroll threshold——scrollTop < 120px 触发 loadMore（边界缓冲，禁裸 scrollTop===0） */
export const LOAD_MORE_THRESHOLD = 120;
/**
 * [v0.0.129] sticky-bottom threshold——用户距底部 ≤ 此 px 视为「在底部附近」，
 * 新消息到达时才自动滚到底。取值参考：容器有 pb-[60px] + gap-7（28px），
 * LOAD_MORE_THRESHOLD=120；选 120 与 loadMore 对称，给上下边界同等缓冲。
 */
export const NEAR_BOTTOM_THRESHOLD = 120;

interface PaginationOpts {
  /** 滚动容器 ref（caller 传入） */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 还有更旧消息（控制 loadMore 是否触发；不影响 onScroll 是否挂载——v0.0.129 起 onScroll 始终挂） */
  hasMore: boolean;
  /** loadMore 进行中（跳过自动滚底 + 触发 prepend 保持位置） */
  isLoadingMore: boolean;
  /** 上滑到顶续载回调 */
  onLoadMore: (() => void) | undefined;
  /** caller 传 messages.length——prepend 时变化触发 restore effect */
  messagesLength: number;
  /** caller 传 [rows.length, lastRunFinish, runActive]——自动滚底 effect 依赖 */
  autoScrollDeps: unknown[];
}

/**
 * 消息流滚动 + 分页副作用聚合。返回 onScroll handler（caller 挂到滚动容器）。
 *
 * [v0.0.129] onScroll 始终定义为函数（不管 hasMore）：内部同时处理 near-bottom 追踪 +
 * loadMore 触发（仅 hasMore 时）。caller 无需条件挂载。
 */
export function useMessageScrollPagination(opts: PaginationOpts): {
  onScroll: () => void;
} {
  const { scrollRef, hasMore, isLoadingMore, onLoadMore, messagesLength, autoScrollDeps } = opts;
  // prepend 位置保持：loadMore 进入时捕获 prevHeight，messages 变化后恢复 scrollTop
  const prevHeightForPrependRef = useRef<number | null>(null);
  // 跳过 loadMore 完成后下一帧的自动滚底（防 setMessages 后又滚回底）
  const wasLoadingMoreRef = useRef(false);
  // [v0.0.129] sticky-bottom 门控：用户是否在底部附近。onScroll 里实时更新；初始 true
  // （新会话首次挂载时视作用户在底部，第一条消息到达即滚到底）。
  const nearBottomRef = useRef(true);

  // capture：isLoadingMore false→true 那帧 paint 前记 prevHeight = scrollHeight - scrollTop
  useLayoutEffect(() => {
    if (isLoadingMore && prevHeightForPrependRef.current === null && scrollRef.current) {
      prevHeightForPrependRef.current =
        scrollRef.current.scrollHeight - scrollRef.current.scrollTop;
    }
  }, [isLoadingMore, scrollRef]);

  // restore：messagesLength 变化且 prevHeight !== null 时设 scrollTop（视觉保持原顶部条目位置）
  useLayoutEffect(() => {
    if (prevHeightForPrependRef.current !== null && scrollRef.current) {
      scrollRef.current.scrollTop =
        scrollRef.current.scrollHeight - prevHeightForPrependRef.current;
    }
  }, [messagesLength, scrollRef]);

  // 自动滚底：messages/lastRunFinish/runActive 变化时 scrollTop = scrollHeight。
  // 跳过：loadMore 期间（isLoadingMore）+ 完成后下一帧（wasLoadingMoreRef 防滚回底）。
  // [v0.0.129] sticky-bottom 门控：仅当 nearBottomRef.current=true（用户在底部附近）才滚。
  //   读的是「上一刻用户位置」——新内容长高前 scroll 事件已把当前位置记入 ref，
  //   即使用户本来在底部、新内容长高后 (scrollHeight - scrollTop - clientHeight) 暂时 > 阈值，
  //   ref 仍为 true，effect 仍滚到底。
  useEffect(() => {
    if (isLoadingMore || wasLoadingMoreRef.current) {
      wasLoadingMoreRef.current = isLoadingMore;
      return;
    }
    if (nearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      // 编程设 scrollTop 不触发 scroll 事件——显式置 true 保持 sticky（滚到底后自然在底部附近）。
      nearBottomRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...autoScrollDeps, isLoadingMore, scrollRef]);

  // loadMore 结束时清捕获高度（下一次 loadMore 重新捕获）
  useEffect(() => {
    if (!isLoadingMore) prevHeightForPrependRef.current = null;
  }, [isLoadingMore]);

  // [v0.0.129] onScroll 始终挂载：同时处理 near-bottom 追踪（始终）+ loadMore 触发（仅 hasMore）。
  //   caller 把它直接挂到 onScroll 即可，无需条件判断。
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // near-bottom 追踪（始终更新——hasMore=false 时也要工作，sticky-bottom 不依赖分页）
    nearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_THRESHOLD;
    // loadMore 触发（仅 hasMore 时；保留原有重入守卫）
    if (hasMore && !isLoadingMore && onLoadMore && el.scrollTop < LOAD_MORE_THRESHOLD) {
      onLoadMore();
    }
  };

  return { onScroll };
}
