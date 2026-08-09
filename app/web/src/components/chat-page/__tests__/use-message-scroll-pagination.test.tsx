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
 *   ⑧ [v0.0.262] 内容变化（同 rows.length 下签名变）且 nearBottom=true → 滚底（跟丢修复核心）；
 *      nearBottom=false → 不滚（门控保持）
 *   ⑨ [v0.0.262] nearBottom 暴露为 state：onScroll 后按距底≤120 更新
 *   ⑩ [v0.0.262] scrollToBottom：el.scrollTo({top: scrollHeight}) + 同步 nearBottom=true
 *
 * mock：scrollRef 共享 helper（scroll-ref-helper.ts）。captureWrites=true 时 setter 记录赋值 +
 *   更新 backing（断言 effect 是否滚到底）。
 * [v0.0.262] installSyncRaf：autoScroll 滚底在 rAF 回调内执行（rAF 合并节流），同步 stub 防断言不稳。
 *
 * baseline 分页 case 见 use-message-scroll-pagination.pagination.test.tsx。
 */
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useMessageScrollPagination, NEAR_BOTTOM_THRESHOLD } from '../use-message-scroll-pagination';
import { makeScrollRef, installSyncRaf, installSyncMicrotask } from './scroll-ref-helper';

// [v0.0.262] rAF stub：同步执行回调（滚底在 requestAnimationFrame 内，真 rAF 异步断言不稳）
installSyncRaf();
// [v0.0.287] queueMicrotask stub：编程 scrollTop 后 queueMicrotask 清标记，同步执行防标记位残留
installSyncMicrotask();

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
    // [v0.0.287] 用户手动滚动需先标记用户交互，onScroll 才在窗口内更新 nearBottom
    act(() => result.current.markUserInteract());
    // 模拟用户向上翻：距底部 300px > threshold 120
    ref.current!.scrollTop = 100;
    act(() => result.current.onScroll()); // 触发 near-bottom 追踪更新
    expect(writes.filter((v) => v === 1000).length).toBe(0); // 此处尚无 effect 滚底
    // 新消息到达（autoScrollDeps 变）→ 因 nearBottom=false，effect 不滚
    rerender([6] as unknown[]);
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
    // [v0.0.287] 用户手动滚动需先标记用户交互
    act(() => result.current.markUserInteract());
    // 用户向上翻
    ref.current!.scrollTop = 100;
    act(() => result.current.onScroll()); // hasMore=false 也要更新 nearBottomRef
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
    act(() => result.current.onScroll());
    // 新消息到达 → 滚到底
    rerender([6] as unknown[]);
    expect(writes).toContain(1000);
  });

  it('[v0.0.262] 内容变化（同 rows.length 下签名变）且 nearBottom=true → 滚底（跟丢修复核心）', () => {
    const { ref, writes } = makeScrollRef({ captureWrites: true });
    const { rerender } = renderHook(
      (deps: unknown[]) =>
        useMessageScrollPagination({
          scrollRef: ref,
          hasMore: false,
          isLoadingMore: false,
          onLoadMore: undefined,
          messagesLength: 5,
          autoScrollDeps: deps,
        }),
      { initialProps: [5, 100] as unknown[] },
    );
    writes.length = 0; // 清掉挂载时的初始滚
    // 用户在底部附近（currentTop=1000=scrollHeight，clientHeight=600 → 距底 0 ≤ 120 → nearBottom=true）
    // 内容增长：rows.length 仍为 5，但 textLenSum 100 → 200（流式 text_block_delta 更新同一条消息内容）
    rerender([5, 200] as unknown[]);
    // 内容签名变了（同 rows.length）→ autoScroll effect 触发 → 滚到底
    expect(writes).toContain(1000);
  });

  it('[v0.0.262] 内容变化（签名变）但 nearBottom=false → 不滚（门控保持）', () => {
    const { ref, writes } = makeScrollRef({ captureWrites: true, initialScrollTop: 1000 });
    const { result, rerender } = renderHook(
      (deps: unknown[]) =>
        useMessageScrollPagination({
          scrollRef: ref,
          hasMore: false,
          isLoadingMore: false,
          onLoadMore: undefined,
          messagesLength: 5,
          autoScrollDeps: deps,
        }),
      { initialProps: [5, 100] as unknown[] },
    );
    writes.length = 0;
    // [v0.0.287] 用户手动滚动需先标记用户交互
    act(() => result.current.markUserInteract());
    // 用户向上翻：距底 = 1000 - 100 - 600 = 300 > 120 → nearBottom=false
    ref.current!.scrollTop = 100;
    act(() => result.current.onScroll());
    expect(result.current.nearBottom).toBe(false);
    // 内容变化（签名变）但用户不在底部 → 不滚
    rerender([5, 200] as unknown[]);
    expect(writes.filter((v) => v === 1000).length).toBe(0);
  });

  it('[v0.0.262] nearBottom 暴露：初始 true，onScroll 后按距底 ≤120 更新', () => {
    const { ref } = makeScrollRef({ captureWrites: true });
    const { result, rerender } = renderHook(
      (deps: unknown[]) =>
        useMessageScrollPagination({
          scrollRef: ref,
          hasMore: false,
          isLoadingMore: false,
          onLoadMore: undefined,
          messagesLength: 5,
          autoScrollDeps: deps,
        }),
      { initialProps: [5] as unknown[] },
    );
    // 初始 true（新会话首条消息到达即滚底语义）
    expect(result.current.nearBottom).toBe(true);
    // [v0.0.287] 用户手动滚动需先标记用户交互
    act(() => result.current.markUserInteract());
    // 距底 = 1000 - 200 - 600 = 200 > 120 → false
    ref.current!.scrollTop = 200;
    act(() => result.current.onScroll());
    expect(result.current.nearBottom).toBe(false);
    // 距底 = 1000 - 280 - 600 = 120 ≤ 120 → true（边界含等）
    // 窗口仍在（markUserInteract 设了 500ms deadline），直接再滚
    ref.current!.scrollTop = 280;
    act(() => result.current.onScroll());
    expect(result.current.nearBottom).toBe(true);
    // rerender 后返回签名仍含 onScroll/nearBottom/scrollToBottom（向后兼容字段）
    rerender([6] as unknown[]);
    expect(typeof result.current.onScroll).toBe('function');
    expect(typeof result.current.scrollToBottom).toBe('function');
  });

  it('[v0.0.262] scrollToBottom：el.scrollTo({top: scrollHeight}) + nearBottom 变 true', () => {
    const { ref, scrollToCalls } = makeScrollRef({ captureWrites: true, initialScrollTop: 100 });
    const { result } = renderHook(
      (deps: unknown[]) =>
        useMessageScrollPagination({
          scrollRef: ref,
          hasMore: false,
          isLoadingMore: false,
          onLoadMore: undefined,
          messagesLength: 5,
          autoScrollDeps: deps,
        }),
      { initialProps: [5] as unknown[] },
    );
    // [v0.0.287] 用户手动滚动需先标记用户交互
    act(() => result.current.markUserInteract());
    // 用户翻历史：距底 = 1000 - 100 - 600 = 300 > 120 → nearBottom=false
    ref.current!.scrollTop = 100;
    act(() => result.current.onScroll());
    expect(result.current.nearBottom).toBe(false);
    // 调用 scrollToBottom('smooth')：scrollTo 置底 + nearBottom 同步 true
    act(() => result.current.scrollToBottom('smooth'));
    expect(scrollToCalls).toEqual([{ top: 1000, behavior: 'smooth' }]);
    expect(result.current.nearBottom).toBe(true);
    // 默认 behavior='auto'
    act(() => result.current.scrollToBottom());
    expect(scrollToCalls[scrollToCalls.length - 1]).toEqual({ top: 1000, behavior: 'auto' });
    // scrollTo stub 更新 backing scrollTop（captureWrites）→ 后续 onScroll 算距底 = -600 ≤ 120 → true
    act(() => result.current.onScroll());
    expect(result.current.nearBottom).toBe(true);
  });
});

// ===== v0.0.287 四状态决策 + 竞态时序 =====
import { makeScrollTestHelper, type ScrollTestHelper } from './scroll-ref-helper';

// installSyncMicrotask 已在文件顶部安装（与 installSyncRaf 并列）

describe('useMessageScrollPagination 四状态决策 + 竞态根治（v0.0.287）', () => {
  // 公共 helper：渲染 hook 并返回 result + testHelper
  function renderScrollHook(opts?: {
    initialScrollTop?: number;
    scrollHeight?: number;
    hasMore?: boolean;
    onLoadMore?: () => void;
    messagesLength?: number;
  }) {
    const helper = makeScrollTestHelper({
      initialScrollTop: opts?.initialScrollTop ?? 400,
      scrollHeight: opts?.scrollHeight ?? 1000,
    });
    const { result, rerender } = renderHook(
      (deps: unknown[]) =>
        useMessageScrollPagination({
          scrollRef: helper.ref,
          hasMore: opts?.hasMore ?? false,
          isLoadingMore: false,
          onLoadMore: opts?.onLoadMore,
          messagesLength: opts?.messagesLength ?? 5,
          autoScrollDeps: deps,
        }),
      { initialProps: [5] as unknown[] },
    );
    return { result, helper, rerender };
  }

  it('USER_INTERACT_WINDOW_MS = 300（用户操作时效窗口，用户滚动后 300ms 内 skip autoScroll）', async () => {
    const mod = await import('../use-message-scroll-pagination');
    expect(mod.USER_INTERACT_WINDOW_MS).toBe(300);
  });

  it('状态①+④：程序 scroll（triggerScroll）→ nearBottom 保持 true（不因 scroll 事件误判）', () => {
    // 初始 nearBottomRef=true（挂载即滚底）→ 模拟编程 scroll 撑高内容 200px
    const { result, helper } = renderScrollHook({ initialScrollTop: 400 });
    // 挂载后 nearBottom 应为 true（autoScroll 已滚到底）
    expect(result.current.nearBottom).toBe(true);
    // 模拟 rAF 设 scrollTop=scrollHeight 后内容撑高 +200（距底 > 120）
    // triggerScroll 不设用户窗口 → programmaticScrollRef 在 rAF 内已设 true → onScroll 跳过 nearBottom 更新
    helper.setScrollHeight(1200); // 内容撑高
    // programmaticScrollRef 已被 rAF 设 true（installSyncRaf + installSyncMicrotask 同步执行）
    act(() => helper.triggerScroll(result.current.onScroll, 1000, 1200));
    // 核心：nearBottom 仍为 true（程序 scroll 被跳过，不误判）
    expect(result.current.nearBottom).toBe(true);
  });

  it('状态④有用户操作：用户 wheel 上翻（simulateUserScroll）+ 窗口内 → nearBottom=false（门控不追）', () => {
    const { result, helper } = renderScrollHook({ initialScrollTop: 400 });
    expect(result.current.nearBottom).toBe(true);
    // 标记用户交互 → 开时效窗口
    act(() => result.current.markUserInteract());
    // 用户上翻到 scrollTop=100（距底=1000-100-600=300 > 120 → nearBottom=false）
    act(() => helper.simulateUserScroll(result.current.onScroll, 100));
    // 窗口内正常更新 → nearBottom=false
    expect(result.current.nearBottom).toBe(false);
  });

  it('状态④无用户操作：内容撑高触发 scroll 但不在用户窗口 → nearBottom 保持 true（追赶）', () => {
    const { result, helper } = renderScrollHook({ initialScrollTop: 400 });
    expect(result.current.nearBottom).toBe(true);
    // 不调 markUserInteract → userInteractDeadlineRef=0（过期态）
    // 模拟内容撑高 200px 触发 scroll 事件（非用户操作）
    helper.setScrollHeight(1200);
    act(() => helper.simulateUserScroll(result.current.onScroll, 0));
    // 窗口外 → 不更新 nearBottom → 保持 true（追赶）
    expect(result.current.nearBottom).toBe(true);
  });

  it('核心竞态模拟：rAF 设 scrollTop=scrollHeight + 内容撑高 200px + triggerScroll → nearBottom 保持 true', () => {
    // 这是 BUG 核心修复断言：旧代码 onScroll 不区分程序/用户 scroll → 内容撑高瞬间误判 false → 不追
    const { result, helper } = renderScrollHook({ initialScrollTop: 400 });
    expect(result.current.nearBottom).toBe(true);
    // 1. rAF 设 scrollTop=scrollHeight（autoScroll 滚底）→ programmaticScrollRef=true
    //    installSyncRaf 已在文件顶部安装 → effect 挂载即执行 rAF 回调 → scrollTop 已设为 scrollHeight
    // 2. 模拟下一批 delta 撑高 scrollHeight +200
    helper.setScrollHeight(1200);
    // 3. triggerScroll 模拟 scroll 事件（标记位仍 true → onScroll 跳过 nearBottom 更新）
    act(() => helper.triggerScroll(result.current.onScroll, 1000));
    // 核心断言：nearBottom 保持 true（修复前会变 false → 门控失效 → 间歇性跟丢）
    expect(result.current.nearBottom).toBe(true);
  });

  it('scrollToBottom → nearBottom=true + userInteractDeadlineRef 重置（D4 恢复吸底）', () => {
    const { result, helper } = renderScrollHook({ initialScrollTop: 400 });
    expect(result.current.nearBottom).toBe(true);
    // 用户上翻 → markUserInteract + simulateUserScroll → nearBottom=false
    act(() => result.current.markUserInteract());
    act(() => helper.simulateUserScroll(result.current.onScroll, 100));
    expect(result.current.nearBottom).toBe(false);
    // scrollToBottom 恢复吸底：nearBottom=true + deadline 重置
    act(() => result.current.scrollToBottom('smooth'));
    expect(result.current.nearBottom).toBe(true);
    // D4 验证：scrollToBottom 后不在用户窗口 → 内容撑高 scroll 不篡改 nearBottom
    helper.setScrollHeight(1500);
    act(() => helper.simulateUserScroll(result.current.onScroll, 1000));
    expect(result.current.nearBottom).toBe(true);
  });

  it('markUserInteract 返回稳定引用（useCallback）', () => {
    const { result, rerender } = renderScrollHook();
    const fn1 = result.current.markUserInteract;
    rerender([6] as unknown[]);
    const fn2 = result.current.markUserInteract;
    expect(fn1).toBe(fn2);
  });

  it('返回签名含 markUserInteract（向后兼容——现有解构不取仍正常）', () => {
    const { result } = renderScrollHook();
    expect(typeof result.current.markUserInteract).toBe('function');
    expect(typeof result.current.onScroll).toBe('function');
    expect(typeof result.current.scrollToBottom).toBe('function');
    expect(typeof result.current.nearBottom).toBe('boolean');
  });

  it('回归①：用户上翻不拉回（invariant ④ 保持）', () => {
    const { result, helper, rerender } = renderScrollHook({ initialScrollTop: 400 });
    // 用户上翻 → markUserInteract + 滚离底部 → nearBottom=false → 新消息到达不滚
    act(() => result.current.markUserInteract());
    act(() => helper.simulateUserScroll(result.current.onScroll, 100));
    expect(result.current.nearBottom).toBe(false);
    // 初始挂载 rAF 已写一次 scrollHeight，记录当前 writes 快照
    const initialWrites = [...helper.writes];
    // rerender 触发 autoScroll effect（内容签名变）但 nearBottomRef=false → effect 门控不通过 → 不滚
    rerender([7] as unknown[]);
    // nearBottomRef 被 simulateUserScroll 设为 false → effect 门控不通过 → 无新写入
    expect(helper.writes.length).toBe(initialWrites.length);
  });

  it('回归②：loadMore 检查始终执行（invariant ⑤——标记位不影响 loadMore）', () => {
    let loadMoreCalls = 0;
    const onLoadMore = () => { loadMoreCalls++; };
    // hasMore=true + scrollTop 在 loadMore 阈值内
    const helper = makeScrollTestHelper({
      initialScrollTop: 50, // < LOAD_MORE_THRESHOLD=120
      scrollHeight: 1000,
    });
    const { result } = renderHook(
      (deps: unknown[]) =>
        useMessageScrollPagination({
          scrollRef: helper.ref,
          hasMore: true,
          isLoadingMore: false,
          onLoadMore,
          messagesLength: 5,
          autoScrollDeps: deps,
        }),
      { initialProps: [5] as unknown[] },
    );
    // 程序 scroll 场景下 loadMore 也应触发（标记位不影响 loadMore）
    // 注意：挂载时 autoScroll effect 会滚底（scrollTop→scrollHeight），所以需手动设回 50
    helper.ref.current!.scrollTop = 50;
    act(() => helper.triggerScroll(result.current.onScroll, 50));
    expect(loadMoreCalls).toBeGreaterThanOrEqual(1);
  });
});
