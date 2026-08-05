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
}

/**
 * 创建 fake scrollRef helper（stub scrollHeight/scrollTop/clientHeight）。
 * Proxy 拦截 current.* 属性访问，保持 React RefObject 签名 + 暴露 .writes 给测试。
 */
export function makeScrollRef(opts: ScrollRefOpts = {}): ScrollRefHelper {
  const {
    initialScrollTop = 200,
    scrollHeight = 1000,
    clientHeight = 600,
    captureWrites = false,
  } = opts;
  const writes: number[] = [];
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
  return { ref: proxy, writes };
}
