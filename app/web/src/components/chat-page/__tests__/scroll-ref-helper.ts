/**
 * scroll-ref-helper —— useMessageScrollPagination 测试共享 mock factory
 *
 * 把 scrollRef mock 抽到独立文件，sticky-bottom / pagination baseline 两个 test 文件共享，
 * 单点维护。非 test 文件（无 .test.ts 后缀），vitest 不会扫描。
 */

/** 创建 fake scrollRef 的选项 */
export interface ScrollRefOpts {
  /** 初始 scrollTop（默认 200） */
  initialScrollTop?: number;
  /** scrollHeight（默认 1000） */
  scrollHeight?: number;
  /** clientHeight（默认 600） */
  clientHeight?: number;
  /** true = setter 记录赋值 + 更新 backing；false（默认）= setter no-op（兼容 baseline 测试） */
  captureWrites?: boolean;
}

/** makeScrollRef 返回的 helper：ref 接到 hook，writes 用于断言 effect 是否滚到底 */
export interface ScrollRefHelper {
  ref: React.MutableRefObject<HTMLDivElement | null>;
  /** scrollTop 赋值记录（captureWrites=true 时填） */
  writes: number[];
  /** [v0.0.262] scrollTo 调用记录（stub 总是记录；captureWrites=true 时同时更新 backing scrollTop） */
  scrollToCalls: ScrollToCall[];
}

/** [v0.0.262] scrollTo stub 记录的单次调用 */
export interface ScrollToCall {
  /** scrollTo 目标 top（scrollHeight） */
  top: number;
  /** 滚动行为（'auto' | 'smooth'）；默认 'auto' */
  behavior: ScrollBehavior;
}

/**
 * 创建 fake scrollRef helper（stub scrollHeight/scrollTop/clientHeight）。
 * Proxy 拦截 current.* 属性访问，保持 React RefObject 签名 + 暴露 .writes 给测试。
 * [v0.0.262] fake 增加 scrollTo stub（scrollToBottom 调用用）——防 fake 无 scrollTo 抛 TypeError
 *   （真实浏览器 Element.scrollTo 全支持）；调用记录到 .scrollToCalls。
 */
export function makeScrollRef(opts: ScrollRefOpts = {}): ScrollRefHelper {
  const {
    initialScrollTop = 200,
    scrollHeight = 1000,
    clientHeight = 600,
    captureWrites = false,
  } = opts;
  const writes: number[] = [];
  const scrollToCalls: ScrollToCall[] = [];
  let currentTop = initialScrollTop;
  const fake: Partial<HTMLDivElement> = { scrollHeight, clientHeight };
  Object.defineProperty(fake, 'scrollTop', {
    get: () => currentTop,
    set: (v: number) => {
      writes.push(v);
      if (captureWrites) currentTop = v;
    },
    configurable: true,
  });
  fake.scrollTo = ((options?: ScrollToOptions) => {
    const top = options?.top ?? 0;
    const behavior = options?.behavior ?? 'auto';
    scrollToCalls.push({ top, behavior });
    // scrollTo 语义 = 设置 scrollTop；captureWrites 时更新 backing（后续 near-bottom 计算读它）
    if (captureWrites) currentTop = top;
  }) as HTMLDivElement['scrollTo'];
  const target = { current: fake as HTMLDivElement };
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (prop === 'current') return t.current;
      return (t.current as unknown as Record<string, unknown>)[prop as string];
    },
    set(t, prop, value) {
      if (prop === 'current') {
        t.current = value as HTMLDivElement;
        return true;
      }
      (t.current as unknown as Record<string, unknown>)[prop as string] = value;
      return true;
    },
  }) as unknown as React.MutableRefObject<HTMLDivElement | null>;
  return { ref: proxy, writes, scrollToCalls };
}

/**
 * [v0.0.262] 安装同步 rAF stub：autoScroll 滚底在 requestAnimationFrame 回调内执行，
 * 真 rAF 异步会让断言不稳（需手动 flush）。同步执行 = 单测中等价于立即滚底
 * （rAF 合并节流在真实浏览器生效，单测只验证「该滚时滚、不该滚时不滚」）。
 * 返回卸载函数；vitest 每文件独立环境，文件级调用一次即可。
 */
export function installSyncRaf(): () => void {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCaf = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  };
  globalThis.cancelAnimationFrame = () => {};
  return () => {
    globalThis.requestAnimationFrame = originalRaf;
    globalThis.cancelAnimationFrame = originalCaf;
  };
}

/**
 * [v0.0.287] 安装同步 queueMicrotask stub：编程 scrollTop 后 queueMicrotask 清标记，
 * 同步执行 = 单测中等价于立即清标记（与 installSyncRaf 配合使用）。
 * 返回卸载函数。
 */
export function installSyncMicrotask(): () => void {
  const original = globalThis.queueMicrotask;
  globalThis.queueMicrotask = (cb: VoidFunction) => { cb(); };
  return () => { globalThis.queueMicrotask = original; };
}

/**
 * [v0.0.287] 扩展 helper：在 ScrollRefHelper 基础上提供 scroll 事件模拟方法。
 * triggerScroll 模拟编程设 scrollTop 后异步触发 scroll 事件全流程（标记位→onScroll→microtask 清）。
 * simulateUserScroll 模拟用户 wheel 改变 scrollTop 再触发 scroll 事件（不设标记位）。
 */
export interface ScrollTestHelper extends ScrollRefHelper {
  /**
   * 模拟编程 scroll（autoScroll/scrollToBottom/prepend）：
   * 设 scrollTop（可选 override）→ 调 onScroll（标记位应已由 hook 设 true→onScroll 跳过 nearBottom 更新）。
   * @param onScroll hook 的 onScroll handler
   * @param newScrollTop 可选 scrollTop override（默认不改变 backing）
   * @param newScrollHeight 可选 scrollHeight override（模拟内容撑高）
   */
  triggerScroll(onScroll: () => void, newScrollTop?: number, newScrollHeight?: number): void;
  /**
   * 模拟用户 scroll（wheel/touchmove/keydown）：
   * 直接设 scrollTop=targetTop → 调 onScroll（无标记位→onScroll 在用户窗口内正常更新 nearBottom）。
   * @param onScroll hook 的 onScroll handler
   * @param targetTop 用户滚动后的 scrollTop 值
   */
  simulateUserScroll(onScroll: () => void, targetTop: number): void;
  /** 动态修改 scrollHeight（模拟流式内容撑高） */
  setScrollHeight(h: number): void;
}

/**
 * [v0.0.287] 创建带 scroll 事件模拟能力的 test helper（扩展 makeScrollRef）。
 * captureWrites=true 必须（triggerScroll/simulateUserScroll 需更新 backing scrollTop）。
 */
export function makeScrollTestHelper(opts: ScrollRefOpts = {}): ScrollTestHelper {
  const base = makeScrollRef({ captureWrites: true, ...opts });
  const fake = base.ref.current as unknown as {
    scrollHeight: number;
    clientHeight: number;
    scrollTop: number;
  };

  return {
    ...base,
    triggerScroll(onScroll, newScrollTop?, newScrollHeight?) {
      if (newScrollHeight !== undefined) fake.scrollHeight = newScrollHeight;
      if (newScrollTop !== undefined) fake.scrollTop = newScrollTop;
      onScroll();
    },
    simulateUserScroll(onScroll, targetTop) {
      fake.scrollTop = targetTop;
      onScroll();
    },
    setScrollHeight(h: number) {
      fake.scrollHeight = h;
    },
  };
}
