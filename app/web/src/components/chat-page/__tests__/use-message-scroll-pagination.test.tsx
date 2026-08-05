// @vitest-environment jsdom
/**
 * useMessageScrollPagination hook 单测 —— sticky-bottom 主题（v0.0.129）
 * 参考: specs/ui/components/chat-page/_overview.md §4.5（sticky-bottom 门控：仅当用户在
 *   底部附近时才自动滚到底；用户向上翻看不强制拉回）
 *
 * 覆盖 invariants：
 *   ⑤ [v0.0.129] sticky-bottom：nearBottomRef=true 时新消息到达 → 滚到底；=false（向上翻）→ 不滚
 *   ⑥ [v0.0.129] loadMore 完成一帧仍跳过滚底（wasLoadingMoreRef 防滚回底）
 *   ⑦ [v0.0.129] hasMore=false 时 sticky-bottom 门控仍生效（onScroll 始终追踪 near-bottom）
 *
 * mock：scrollRef 共享 helper（scroll-ref-helper.ts）。captureWrites=true 时 setter 记录赋值 +
 *   更新 backing（断言 effect 是否滚到底）。
 *
 * baseline 分页 case 见 use-message-scroll-pagination.pagination.test.tsx。
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMessageScrollPagination, NEAR_BOTTOM_THRESHOLD } from '../use-message-scroll-pagination';
import { makeScrollRef } from './scroll-ref-helper';

describe('useMessageScrollPagination sticky-bottom（v0.0.129）', () => {
  it('NEAR_BOTTOM_THRESHOLD = 120（sticky-bottom threshold，对称 loadMore）', () => {
    expect(NEAR_BOTTOM_THRESHOLD).toBe(120);
  });

  it('初始挂载 nearBottomRef=true → autoScroll effect 滚到底（首次进入会话）', () => {
    const { ref, writes } = makeScrollRef({ captureWrites: true });
    renderHook(() =>
      useMessageScrollPagination({
        scrollRef: ref,
        hasMore: false,
        isLoadingMore: false,
        onLoadMore: undefined,
        messagesLength: 5,
        autoScrollDeps: [5],
      }),
    );
    // 挂载即滚到底：scrollTop 被赋值为 scrollHeight（=1000）
    expect(writes).toContain(1000);
  });

  it('near bottom → 新消息到达（autoScrollDeps 变）→ 滚到底', () => {
    const { ref, writes } = makeScrollRef({ captureWrites: true });
    const { rerender } = renderHook(
      (deps: unknown[]) =>
        useMessageScrollPagination({
          scrollRef: ref,
          hasMore: false,
          isLoadingMore: false,
          onLoadMore: undefined,
          messagesLength: deps.length,
          autoScrollDeps: deps,
        }),
      { initialProps: [5] as unknown[] },
    );
    writes.length = 0; // 清掉挂载时的初始滚
    // 用户在底部附近（currentTop 仍 = 1000，scrollHeight=1000，clientHeight=600）→ nearBottom=true
    rerender([6] as unknown[]);
    // 新消息到达 → 滚到底：有一次新的 scrollTop=1000 赋值
    expect(writes.filter((v) => v === 1000).length).toBe(1);
  });

  it('不在底部（用户向上翻）→ 新消息到达 → 不滚动（核心断言）', () => {
    const { ref, writes } = makeScrollRef({ captureWrites: true, initialScrollTop: 1000 });
    const { result, rerender } = renderHook(
      (deps: unknown[]) =>
        useMessageScrollPagination({
          scrollRef: ref,
          hasMore: false,
          isLoadingMore: false,
          onLoadMore: undefined,
          messagesLength: deps.length,
          autoScrollDeps: deps,
        }),
      { initialProps: [5] as unknown[] },
    );
    writes.length = 0; // 清掉挂载时的初始滚
    // 模拟用户向上翻：距底部 300px > threshold 120
    // scrollHeight(1000) - scrollTop(100) - clientHeight(600) = 300 > 120 → nearBottom=false
    ref.current!.scrollTop = 100; // writes = [100]（用户滚动赋值，非 effect 滚底）
    result.current.onScroll(); // 触发 near-bottom 追踪更新（onScroll 只读不写）
    expect(writes.filter((v) => v === 1000).length).toBe(0); // 此处尚无 effect 滚底
    // 新消息到达（autoScrollDeps 变）→ 因 nearBottom=false，effect 不滚
    rerender([6] as unknown[]);
    // 关键断言：用户向上翻时新消息不强制拉回（autoScroll effect 未写 scrollTop=scrollHeight）
    expect(writes.filter((v) => v === 1000).length).toBe(0);
  });

  it('loadMore 期间（isLoadingMore=true）→ 跳过滚底（invariant 保持）', () => {
    const { ref, writes } = makeScrollRef({ captureWrites: true });
    renderHook(() =>
      useMessageScrollPagination({
        scrollRef: ref,
        hasMore: true,
        isLoadingMore: true, // loadMore 进行中
        onLoadMore: undefined,
        messagesLength: 50,
        autoScrollDeps: [50],
      }),
    );
    // isLoadingMore=true → autoScroll effect 直接 return，不写 scrollTop
    expect(writes).not.toContain(1000);
  });

  it('loadMore 完成一帧仍跳过滚底（wasLoadingMoreRef 防滚回底）', () => {
    const { ref, writes } = makeScrollRef({ captureWrites: true });
    // 1) mount 时 isLoadingMore=true → wasLoadingMoreRef 置 true
    const { rerender } = renderHook(
      (props: { loading: boolean; deps: unknown[] }) =>
        useMessageScrollPagination({
          scrollRef: ref,
          hasMore: true,
          isLoadingMore: props.loading,
          onLoadMore: undefined,
          messagesLength: 50,
          autoScrollDeps: props.deps,
        }),
      { initialProps: { loading: true, deps: [50] } },
    );
    writes.length = 0;
    // 2) loadMore 结束（loading=false）+ 新消息到达（deps 变）同时发生：
    //    此时 wasLoadingMoreRef=true → effect 进入 if 分支，置 wasLoadingMoreRef=false 后 return，不滚
    rerender({ loading: false, deps: [51] });
    expect(writes.length).toBe(0); // 完成一帧仍跳过
    // 3) 再下一次 deps 变（wasLoadingMoreRef 已清）→ 恢复正常滚到底
    rerender({ loading: false, deps: [52] });
    expect(writes).toContain(1000);
  });

  it('hasMore=false 时 onScroll 仍追踪 near-bottom（用户向上翻 → 不滚）', () => {
    const { ref, writes } = makeScrollRef({ captureWrites: true, initialScrollTop: 1000 });
    const { result, rerender } = renderHook(
      (deps: unknown[]) =>
        useMessageScrollPagination({
          scrollRef: ref,
          hasMore: false, // 无分页，但 sticky-bottom 仍要工作
          isLoadingMore: false,
          onLoadMore: undefined,
          messagesLength: deps.length,
          autoScrollDeps: deps,
        }),
      { initialProps: [5] as unknown[] },
    );
    writes.length = 0;
    // 用户向上翻
    ref.current!.scrollTop = 100; // writes = [100]（用户赋值）
    result.current.onScroll(); // hasMore=false 也要更新 nearBottomRef
    rerender([6] as unknown[]);
    // hasMore=false 时 sticky-bottom 门控仍生效：autoScroll effect 未写 scrollTop=scrollHeight
    expect(writes.filter((v) => v === 1000).length).toBe(0);
  });

  it('onScroll 在底部附近（距底 ≤ threshold）→ nearBottomRef=true → 下次新消息滚', () => {
    const { ref, writes } = makeScrollRef({
      captureWrites: true,
      scrollHeight: 1000,
      clientHeight: 880, // 距底 = 1000 - scrollTop - 880 ≤ 120 → scrollTop ≥ 0 都满足
      initialScrollTop: 100,
    });
    const { result, rerender } = renderHook(
      (deps: unknown[]) =>
        useMessageScrollPagination({
          scrollRef: ref,
          hasMore: false,
          isLoadingMore: false,
          onLoadMore: undefined,
          messagesLength: deps.length,
          autoScrollDeps: deps,
        }),
      { initialProps: [5] as unknown[] },
    );
    writes.length = 0;
    // 触发 onScroll：距底 = 1000 - 100 - 880 = 20 ≤ 120 → nearBottom=true
    result.current.onScroll();
    // 新消息到达 → 滚到底
    rerender([6] as unknown[]);
    expect(writes).toContain(1000);
  });
});
