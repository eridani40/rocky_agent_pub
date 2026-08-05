/**
 * LocalContentFetcher：本地静态 fetch + readability，含 headless 子分支
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §3.3
 *
 * 设计要点（spec §3.3 + §6.1 重构核心）：
 *   - headless 是 Local 内部子分支，不是顶层第 3 个竞争者。
 *     Local 自己决定「静态不足 → 起 chrome」。
 *   - 子分支 1 静态：proxyFetch(url) + readability（快、不渲染 JS）。
 *   - 子分支 2 headless（静态 trim ≤ MIN_CONTENT 时）：headlessRenderer 渲染 → readability。
 *   - 两条子分支都接 signal；headless 起 chrome 后在 finally 关 page+context+kill 进程。
 *   - signal 构造注入（spec §6.2）。
 *
 * headlessRenderer 契约：(url, signal) => Promise<string>，内部 navigate → 等 DOM 稳定 →
 *   返回渲染后 HTML；内部 finally 关 page + 关 context + kill 浏览器进程（防孤儿 chromium），
 *   并接受 signal abort（race 输掉时被 abort）。
 *
 * DNS pinning（spec §4）：静态分支每跳 resolveAndCheck 取首个 IP → resolvedIp 钉死 TCP 连接。
 */
import type { ContentFetcher, FetchContext, FetchResult } from './content-fetcher';
import { proxyFetch, type ProxyFetchInit } from './proxy';
import { extractMainContent, type ExtractResult } from './readability-extract';
import { resolveAndCheck, stripAuthOnCrossOrigin, type ResolveDnsFn } from './ssrf';
import { mergeSignal } from './merge-signal';

/** race 阈值：trim 后正文 ≥ 此值视为「内容充足」（与 race-runner 共享同一阈值语义） */
export const MIN_CONTENT = 200;
/** 最大重定向跳数（逐跳 SSRF） */
const MAX_REDIRECTS = 10;

/** 构造 local 路失败 FetchResult（ok:false + err 归因，透出给 race runner 写 error.log） */
function localFail(err: string): FetchResult {
  return { title: '', content: '', source: 'local', ok: false, err };
}

/** headless 渲染器契约（注入；生产=tool.ts buildHeadlessRenderer 包装 driver.executeOnce，UT=mock） */
export type HeadlessRenderer = (url: string, signal?: AbortSignal) => Promise<string>;

/** headless 子分支结果：result 为提取内容；err 为渲染器抛错时的真实 message（透出给 error.log 定位） */
interface HeadlessOutcome {
  result: ExtractResult | null;
  err?: string;
}

/** LocalContentFetcher 构造参数（spec §3.3：signal 构造注入） */
export interface LocalFetcherCtor {
  /** 已合并的 abort signal（含外部 ctx.signal + 总超时 + race abort）—— 构造注入 */
  signal: AbortSignal | undefined;
  /** DNS 解析（注入 mock；用于每跳 SSRF + DNS pinning） */
  resolveDns: ResolveDnsFn;
  /** 走代理的 fetch 注入点（默认 proxyFetch；UT mock） */
  fetchImpl?: typeof proxyFetch;
  /** headless 渲染器（缺省→静态不足时跳过 headless） */
  headlessRenderer?: HeadlessRenderer;
  /** 强制 headless（render=true）：跳过静态分支直起 headless，用于已知 JS 页或静态内容不全时 */
  forceHeadless?: boolean;
}

/**
 * LocalContentFetcher 实现。
 * signal 在构造时注入并保存为字段；fetch 内静态/headless 子操作一开始就接好此 signal。
 */
export class LocalContentFetcher implements ContentFetcher {
  readonly id = 'local' as const;
  private readonly signal: AbortSignal | undefined;
  private readonly resolveDns: ResolveDnsFn;
  private readonly fetchImpl: typeof proxyFetch;
  private readonly headlessRenderer: HeadlessRenderer | undefined;
  private readonly forceHeadless: boolean;

  constructor(ctor: LocalFetcherCtor) {
    this.signal = ctor.signal;
    this.resolveDns = ctor.resolveDns;
    this.fetchImpl = ctor.fetchImpl ?? proxyFetch;
    this.headlessRenderer = ctor.headlessRenderer;
    this.forceHeadless = ctor.forceHeadless === true;
  }

  /**
   * 抓取：静态 → 不足起 headless（forceHeadless=true 时跳过静态直起 headless）。
   * 失败/不充足返回 ok:false（不抛），让 runner 用 Promise.any 跑完 race。
   */
  async fetch(ctx: FetchContext): Promise<FetchResult> {
    try {
      // forceHeadless=true（render 参数）：跳过静态分支直起 headless（用于已知 JS 页或静态内容不全时）
      if (this.forceHeadless) {
        return this.fetchHeadlessOnly(ctx.url);
      }
      // 子分支 1：静态 fetch + readability（快）
      const staticResult = await this.fetchStatic(ctx.url);
      if (staticResult && staticResult.content.trim().length >= MIN_CONTENT) {
        return {
          title: staticResult.title || ctx.url,
          content: staticResult.content.trim(),
          source: 'local',
          ok: true,
        };
      }
      // 静态失败/不足的归因（观测用途，透出给 race runner 写 error.log）
      const staticReason = staticResult
        ? `静态内容不足（trim ${staticResult.content.trim().length} < ${MIN_CONTENT}）`
        : '静态抓取失败（网络/非 2xx/解析异常）';
      // 子分支 2：静态不足 → 内部起 headless 渲染（贵，仅 JS 页触发）
      if (this.headlessRenderer) {
        const headless = await this.fetchHeadless(ctx.url);
        if (headless.result && headless.result.content.trim().length >= MIN_CONTENT) {
          return {
            title: headless.result.title || ctx.url,
            content: headless.result.content.trim(),
            source: 'headless',
            ok: true,
          };
        }
        const headlessReason = headless.result
          ? `headless 内容不足（trim ${headless.result.content.trim().length} < ${MIN_CONTENT}）`
          : headless.err
            ? `headless 渲染失败：${headless.err}`
            : 'headless 渲染失败';
        return localFail(`${staticReason}；${headlessReason}`);
      }
      return localFail(`${staticReason}，无 headless 兜底`);
    } catch (e) {
      // 失败（含 abort）→ ok:false，不抛（让 runner 跑完 race）
      // 静态 fetch 的 dispatcher 在 proxyFetch 内部 close（BUG-003 守卫）；
      // headless 若起了，headlessRenderer 内部 finally 已关 page/context/kill chrome
      return localFail(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * cleanup：主要清理在 headlessRenderer 内部 finally + proxyFetch 内部 finally；
   * 本方法 idempotent（spec §3.3）。
   */
  async cleanup(): Promise<void> {
    /* idempotent — 资源已在 fetch 路径释放 */
  }

  /**
   * 静态子分支：proxyFetch + 重定向逐跳 SSRF + DNS pinning + readability。
   * @returns ExtractResult；失败返 null（调用方决定是否起 headless）
   */
  private async fetchStatic(url: string): Promise<ExtractResult | null> {
    try {
      const { finalUrl, response } = await this.fetchWithRedirectGuard(url, {
        method: 'GET',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        signal: this.signal,
      });
      if (!response.ok) return null;
      const html = await response.text();
      const result = await extractMainContent(html);
      // 附最终 URL（重定向后）到 title（无 title 时补）
      if (!result.title) result.title = finalUrl;
      return result;
    } catch {
      return null;
    }
  }

  /**
   * 强制 headless 路径（render=true）：跳过静态直起 headlessRenderer。
   * 无 headlessRenderer → ok:false（driver 无 executeOnce，优雅降级，jina 兜底）。
   */
  private async fetchHeadlessOnly(url: string): Promise<FetchResult> {
    if (!this.headlessRenderer) {
      return localFail('render=true 但无 headlessRenderer（driver 无 executeOnce）');
    }
    const headless = await this.fetchHeadless(url);
    if (headless.result && headless.result.content.trim().length >= MIN_CONTENT) {
      return {
        title: headless.result.title || url,
        content: headless.result.content.trim(),
        source: 'headless',
        ok: true,
      };
    }
    const headlessReason = headless.result
      ? `headless 内容不足（trim ${headless.result.content.trim().length} < ${MIN_CONTENT}）`
      : headless.err
        ? `headless 渲染失败：${headless.err}`
        : 'headless 渲染失败';
    return localFail(`强制 headless：${headlessReason}`);
  }

  /**
   * headless 子分支：headlessRenderer 渲染 → readability。
   * headlessRenderer 内部 finally 负责关 page/context/kill chrome（防孤儿）。
   * 渲染器抛错时捕获真实 message 到 err（不再笼统吞），调用方透出到 FetchResult.err 供诊断。
   */
  private async fetchHeadless(url: string): Promise<HeadlessOutcome> {
    if (!this.headlessRenderer) return { result: null };
    try {
      const html = await this.headlessRenderer(url, this.signal);
      const result = await extractMainContent(html);
      return { result };
    } catch (e) {
      // 透出渲染器真实 error（chrome_not_found / worker stderr / 等），供 error.log 定位
      return { result: null, err: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * 抓取单 URL（含重定向逐跳 SSRF + DNS pinning + 跨 origin 剥凭证）。
   * 每跳：resolveAndCheck 取公网 IP → resolvedIp 传 fetchImpl 钉死连接 → manual 重定向。
   * 返回最终 URL 与 Response。重定向跳数 ≤ MAX_REDIRECTS。
   */
  private async fetchWithRedirectGuard(
    url: string,
    opts: ProxyFetchInit,
  ): Promise<{ finalUrl: string; response: Response }> {
    let currentUrl = url;
    let headers = { ...(opts.headers ?? {}) };
    for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
      // 每跳 SSRF 校验（含起始与重定向目标），取解析到的首个 IP 做 DNS pinning
      const ips = await resolveAndCheck(currentUrl, this.resolveDns);
      const pinnedIp = ips[0];
      // redirect:'manual' 让我们逐跳处理（web_fetch 必须，跨 origin 剥凭证 + 每跳 SSRF）
      const resp = await this.fetchImpl(currentUrl, {
        ...opts,
        headers,
        redirect: 'manual',
        resolvedIp: pinnedIp,
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location');
        if (!loc) return { finalUrl: currentUrl, response: resp };
        const nextUrl = new URL(loc, currentUrl).toString();
        // 跨 origin 剥 Authorization / Cookie
        headers = stripAuthOnCrossOrigin(currentUrl, nextUrl, headers);
        currentUrl = nextUrl;
        continue;
      }
      return { finalUrl: currentUrl, response: resp };
    }
    throw new Error(`重定向跳数超过 ${MAX_REDIRECTS}`);
  }
}
