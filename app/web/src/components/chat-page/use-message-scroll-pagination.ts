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
 *   ① 自动滚底只在「消息内容变化/run 状态变化」触发（v0.0.262 起触发语义 = 内容变化：
 *     deps 由 caller 传内容签名 `${rows.length}:${textLenSum}`，流式 delta 更新同一条消息内容
 *     时 rows.length 不变也能触发）；loadMore 前插绝不触发滚底（isLoadingMore=true 跳过）。
 *   ② loadMore 完成后下一帧也跳过一次自动滚底（防 setMessages 后又滚回底）。
 *   ③ prepend 后视觉保持原顶部条目位置：prevHeight = scrollHeight - scrollTop 技巧
 *     （useLayoutEffect 在 DOM paint 前捕获 + 恢复，无视觉跳屏）。
 *   ④ [v0.0.129] sticky-bottom：仅当用户已在底部附近（nearBottomRef.current=true）时才自动滚到底；
 *     用户向上翻看历史时不强制拉回。nearBottomRef 在 onScroll 里实时更新，初始 true。
 *   ⑤ [v0.0.129] onScroll 始终挂载（不管 hasMore）：内部同时做 near-bottom 追踪（始终）+
 *     loadMore 触发（仅 hasMore && scrollTop<threshold）。component-message-stream 无需条件挂载。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** onScroll threshold——scrollTop < 120px 触发 loadMore（边界缓冲，禁裸 scrollTop===0） */
export const LOAD_MORE_THRESHOLD = 120;
/**
 * [v0.0.129] sticky-bottom threshold——用户距底部 ≤ 此 px 视为「在底部附近」，
 * 新消息到达时才自动滚到底。取值参考：容器有 pb-[60px] + gap-7（28px），
 * LOAD_MORE_THRESHOLD=120；选 120 与 loadMore 对称，给上下边界同等缓冲。
 */
export const NEAR_BOTTOM_THRESHOLD = 120;
/**
 * [v0.0.287] 用户操作时效窗口毫秒数。用户交互（wheel/touchmove/keydown）后
 * 此窗口内 onScroll 正常更新 nearBottom；窗口外跳过（内容撑高不算用户操作）。
 */
export const USER_INTERACT_WINDOW_MS = 300;

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
  /** [v0.0.262] caller 传 [内容签名, lastRunFinish, runActive]——自动滚底 effect 依赖。
   *   内容签名 = `${rows.length}:${textLenSum}`（含行数维度，替代旧 rows.length 单维度，
   *   流式 delta 更新同一条消息内容时 rows.length 不变也能触发） */
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
  /** [v0.0.262] 是否在底部附近（引导气泡消费）。初始 true；onScroll 值去重更新 */
  nearBottom: boolean;
  /** [v0.0.262] 编程滚底（气泡点击用）。el.scrollTo({ top: scrollHeight, behavior }) + 同步 nearBottom=true */
  scrollToBottom: (behavior?: 'auto' | 'smooth') => void;
  /** [v0.0.287] 标记用户交互（wheel/touchmove/keydown → 开时效窗口，onScroll 据此区分用户/非用户 scroll） */
  markUserInteract: () => void;
} {
  const { scrollRef, hasMore, isLoadingMore, onLoadMore, messagesLength, autoScrollDeps } = opts;
  // prepend 位置保持：loadMore 进入时捕获 prevHeight，messages 变化后恢复 scrollTop
  const prevHeightForPrependRef = useRef<number | null>(null);
  // 跳过 loadMore 完成后下一帧的自动滚底（防 setMessages 后又滚回底）
  const wasLoadingMoreRef = useRef(false);
  // [v0.0.129] sticky-bottom 门控：用户是否在底部附近。onScroll 里实时更新；初始 true
  const nearBottomRef = useRef(true);
  // [v0.0.262] nearBottom 暴露为 React state（引导气泡消费）。初始 true 保持「新会话首条消息即滚底」
  const [nearBottom, setNearBottom] = useState(true);
  // [v0.0.262] autoScroll rAF 合并句柄
  const rafRef = useRef<number | null>(null);
  // [v0.0.287] 程序滚动标记位：编程设 scrollTop 前置 true，onScroll 检测到则跳过 nearBottom 更新（防误判）
  const programmaticScrollRef = useRef(false);
  // [v0.0.287] 用户操作时效截止时间戳（performance.now() 基准）。初始 0=过期态=无窗口
  const userInteractDeadlineRef = useRef(0);

  // capture：isLoadingMore false→true 那帧 paint 前记 prevHeight = scrollHeight - scrollTop
  useLayoutEffect(() => {
    if (isLoadingMore && prevHeightForPrependRef.current === null && scrollRef.current) {
      prevHeightForPrependRef.current =
        scrollRef.current.scrollHeight - scrollRef.current.scrollTop;
    }
  }, [isLoadingMore, scrollRef]);

  // restore：messagesLength 变化且 prevHeight !== null 时设 scrollTop（视觉保持原顶部条目位置）
  // [v0.0.287] 编程设 scrollTop 前置标记位，防 prepend restore 的 scroll 事件误判 nearBottom
  useLayoutEffect(() => {
    if (prevHeightForPrependRef.current !== null && scrollRef.current) {
      programmaticScrollRef.current = true;
      scrollRef.current.scrollTop =
        scrollRef.current.scrollHeight - prevHeightForPrependRef.current;
      queueMicrotask(() => { programmaticScrollRef.current = false; });
    }
  }, [messagesLength, scrollRef]);

  // 自动滚底：消息内容/run 状态变化时滚到底。
  // 跳过：loadMore 期间（isLoadingMore）+ 完成后下一帧（wasLoadingMoreRef 防滚回底）。
  // [v0.0.129] sticky-bottom 门控：仅当 nearBottomRef.current=true（用户在底部附近）才滚。
  //   读的是「上一刻用户位置」——新内容长高前 scroll 事件已把当前位置记入 ref，
  //   即使用户本来在底部、新内容长高后 (scrollHeight - scrollTop - clientHeight) 暂时 > 阈值，
  //   ref 仍为 true，effect 仍滚到底。
  // [v0.0.262] rAF 合并：cancel + requestAnimationFrame（每帧最多一次滚底，流式 delta 逐帧防抖）；
  //   cleanup cancel 未执行的 rAF（组件卸载/依赖再变时不留悬空回调）。
  useEffect(() => {
    if (isLoadingMore || wasLoadingMoreRef.current) {
      wasLoadingMoreRef.current = isLoadingMore;
      return;
    }
    // [v0.0.287] 用户滚动过程中 + 停止后 USER_INTERACT_WINDOW_MS(300ms) 内 → skip autoScroll
    //   防止流式内容更新触发 autoScroll 和用户滚动抢
    if (performance.now() < userInteractDeadlineRef.current) return;
    if (nearBottomRef.current && scrollRef.current) {
      const el = scrollRef.current;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        // [v0.0.287] 编程设 scrollTop 会异步触发 scroll 事件——前置标记位防 onScroll 误判 nearBottom，
        //   queueMicrotask 异步清标记（scroll 事件在当前宏任务后、微任务前派发，microtask 保证 handler 看到标记后清）。
        programmaticScrollRef.current = true;
        el.scrollTop = el.scrollHeight;
        nearBottomRef.current = true;
        queueMicrotask(() => { programmaticScrollRef.current = false; });
        rafRef.current = null;
      });
    }
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...autoScrollDeps, isLoadingMore, scrollRef]);

  // loadMore 结束时清捕获高度（下一次 loadMore 重新捕获）
  useEffect(() => {
    if (!isLoadingMore) prevHeightForPrependRef.current = null;
  }, [isLoadingMore]);

  // [v0.0.287] onScroll 四状态决策：
  //   ① programmaticScrollRef=true → 程序滚动（autoScroll/scrollToBottom/prepend）→ 跳过 nearBottom 更新
  //   ② performance.now() < userInteractDeadlineRef → 用户操作窗口内 → 正常更新 nearBottom（空间判定）
  //   ③ 窗口外 → 内容撑高等非用户操作 → 跳过 nearBottom 更新（防误判 false → sticky 失效）
  //   loadMore 检查始终执行（invariant ⑤）。
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // ① 程序滚动 → 跳过 nearBottom 更新（标记位由 queueMicrotask 异步清）
    if (programmaticScrollRef.current) {
      // 仍做 loadMore 检查（invariant ⑤ 保留——loadMore 不受标记位影响）
      if (hasMore && !isLoadingMore && onLoadMore && el.scrollTop < LOAD_MORE_THRESHOLD) {
        onLoadMore();
      }
      return;
    }
    // ② 用户操作窗口内 → 正常更新 nearBottom（空间判定）
    if (performance.now() < userInteractDeadlineRef.current) {
      const nextNearBottom =
        el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_THRESHOLD;
      nearBottomRef.current = nextNearBottom;
      setNearBottom(nextNearBottom);
    }
    // ③ 窗口外 → 非用户操作（内容撑高等）→ 不更新 nearBottom（nearBottomRef 保持 true = 追赶）
    // loadMore 触发（仅 hasMore 时；保留原有重入守卫）
    if (hasMore && !isLoadingMore && onLoadMore && el.scrollTop < LOAD_MORE_THRESHOLD) {
      onLoadMore();
    }
  };

  // [v0.0.262] 编程滚底（引导气泡点击用）：el.scrollTo({ top: scrollHeight, behavior })。
  //   同步 nearBottomRef/setNearBottom(true)——点击滚底后气泡即时消失。
  // [v0.0.287] 前置标记位防 scroll 事件误判 + 重置 userInteractDeadlineRef=0（D4 恢复吸底：
  //   重置后不在用户窗口内→nearBottom 不被后续 scroll 篡改→吸底持续）。
  const scrollToBottom = useCallback((behavior: 'auto' | 'smooth' = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    programmaticScrollRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior });
    nearBottomRef.current = true;
    setNearBottom(true);
    userInteractDeadlineRef.current = 0;
    queueMicrotask(() => { programmaticScrollRef.current = false; });
  }, [scrollRef]);

  // [v0.0.287] 标记用户交互（message-stream 挂 wheel/touchmove/keydown → 调此方法）。
  //   设时效窗口 deadline——onScroll 在窗口内正常更新 nearBottom（用户上翻→false→门控不追）。
  const markUserInteract = useCallback(() => {
    userInteractDeadlineRef.current = performance.now() + USER_INTERACT_WINDOW_MS;
  }, []);

  return { onScroll, nearBottom, scrollToBottom, markUserInteract };
}
