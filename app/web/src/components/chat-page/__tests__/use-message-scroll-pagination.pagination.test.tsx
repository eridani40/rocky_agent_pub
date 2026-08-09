// @vitest-environment jsdom
/**
 * useMessageScrollPagination hook 单测 —— 分页 baseline 主题
 * 参考: specs/ui/components/chat-page/_overview.md §4.5（分页前插 + 跳过滚底 + prepend 保持位置）
 *       specs/tech/version_logs/v0.0.85.ui_opt/change_plan.md F1（invariants ②③④）
 *
 * 覆盖 invariants：
 *   ① onScroll threshold=120px：scrollTop<120 && hasMore && !isLoadingMore → 调 onLoadMore
 *   ② [v0.0.129] onScroll 始终挂载（不管 hasMore）：返回函数 + hasMore=false 时不触发 loadMore
 *   ③ isLoadingMore=true → onScroll 不触发 onLoadMore（防重入）
 *   ④ onLoadMore=undefined → onScroll 调用安全无副作用
 *
 * mock：scrollRef 共享 helper（scroll-ref-helper.ts）。
 * sticky-bottom case 见 use-message-scroll-pagination.test.tsx。
 */
import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMessageScrollPagination, LOAD_MORE_THRESHOLD } from '../use-message-scroll-pagination';
import { makeScrollRef } from './scroll-ref-helper';

describe('useMessageScrollPagination pagination baseline', () => {
  it('LOAD_MORE_THRESHOLD = 120（change_plan F1 contract）', () => {
    expect(LOAD_MORE_THRESHOLD).toBe(120);
  });

  it('hasMore=true 时返回 onScroll 函数', () => {
    const { ref } = makeScrollRef();
    const onLoadMore = vi.fn();
    const { result } = renderHook(() =>
      useMessageScrollPagination({
        scrollRef: ref,
        hasMore: true,
        isLoadingMore: false,
        onLoadMore,
        messagesLength: 50,
        autoScrollDeps: [50],
      }),
    );
    expect(typeof result.current.onScroll).toBe('function');
  });

  it('[v0.0.129] hasMore=false 时 onScroll 仍为函数（始终挂载，追踪 near-bottom）', () => {
    const { ref } = makeScrollRef();
    const onLoadMore = vi.fn();
    const { result } = renderHook(() =>
      useMessageScrollPagination({
        scrollRef: ref,
        hasMore: false,
        isLoadingMore: false,
        onLoadMore,
        messagesLength: 10,
        autoScrollDeps: [10],
      }),
    );
    // onScroll 始终定义（sticky-bottom 追踪不依赖 hasMore）
    expect(typeof result.current.onScroll).toBe('function');
    // 但 hasMore=false 时调用不应触发 loadMore（v0.0.262：onScroll 内部同时 setNearBottom → act 包裹）
    act(() => result.current.onScroll());
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('scrollTop<threshold && hasMore && !isLoadingMore → 调 onLoadMore（invariant ①）', () => {
    const { ref } = makeScrollRef({ initialScrollTop: 50 }); // scrollTop=50 < 120
    const onLoadMore = vi.fn();
    const { result } = renderHook(() =>
      useMessageScrollPagination({
        scrollRef: ref,
        hasMore: true,
        isLoadingMore: false,
        onLoadMore,
        messagesLength: 50,
        autoScrollDeps: [50],
      }),
    );
    act(() => result.current.onScroll());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('scrollTop=threshold 边界：不触发（>threshold 才安全，给缓冲）', () => {
    const { ref } = makeScrollRef({ initialScrollTop: LOAD_MORE_THRESHOLD });
    const onLoadMore = vi.fn();
    const { result } = renderHook(() =>
      useMessageScrollPagination({
        scrollRef: ref,
        hasMore: true,
        isLoadingMore: false,
        onLoadMore,
        messagesLength: 50,
        autoScrollDeps: [50],
      }),
    );
    act(() => result.current.onScroll());
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('isLoadingMore=true → onScroll 不触发 onLoadMore（防重入 invariant ④）', () => {
    const { ref } = makeScrollRef({ initialScrollTop: 0 });
    const onLoadMore = vi.fn();
    const { result } = renderHook(() =>
      useMessageScrollPagination({
        scrollRef: ref,
        hasMore: true,
        isLoadingMore: true,
        onLoadMore,
        messagesLength: 50,
        autoScrollDeps: [50],
      }),
    );
    act(() => result.current.onScroll());
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('onLoadMore=undefined → onScroll 调用安全无副作用', () => {
    const { ref } = makeScrollRef({ initialScrollTop: 0 });
    const { result } = renderHook(() =>
      useMessageScrollPagination({
        scrollRef: ref,
        hasMore: true,
        isLoadingMore: false,
        onLoadMore: undefined,
        messagesLength: 50,
        autoScrollDeps: [50],
      }),
    );
    expect(() => act(() => result.current.onScroll())).not.toThrow();
  });
});
