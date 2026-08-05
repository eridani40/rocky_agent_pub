/**
 * JinaContentFetcher：走 r.jina.ai/<url>，jina 服务端渲染 JS
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §3.2
 *
 * 设计要点：
 *   - jina 自带 JS 渲染（r.jina.ai 服务端渲染 + 提取），返回 markdown。
 *   - 有 jinaApiKey → Bearer；无 → 匿名（spec §3.2 注：匿名也能用）。
 *   - 超时用 AbortSignal.timeout 合并进 signal（BUG-005：不用 undici dispatcher 超时）。
 *   - signal 构造注入（spec §6.2）：构造时存 signal 字段，fetch 内子操作一开始就接好 abort。
 *   - SSRF 已在 tool 层（assertSsrfSafe）+ race runner 起始 resolveAndCheck 做过，
 *     fetcher 内部不再 SSRF（spec §1：SSRF 永远最先，公网 URL 才放行到 fetcher）。
 *
 * cleanup：proxyFetch per-call dispatcher 在 proxyFetch 内部 finally close（BUG-003 守卫），
 *   本 fetcher cleanup 为 idempotent no-op（spec §3.2）。
 */
import type { ContentFetcher, FetchContext, FetchResult } from './content-fetcher';
import { proxyFetch, type ProxyFetchInit } from './proxy';
import { mergeSignal } from './merge-signal';
import { maskKey } from './mask-key';

/** jina reader 基础 URL */
const JINA_BASE = 'https://r.jina.ai/';
/**
 * jina 默认超时（app_config 缺省回退值）。
 * ≤ race 总超时 OVERALL_TIMEOUT_MS(30s, race-runner.ts)，给大页渲染留 2s 余量；
 * 原 20s 对大页不够（v0.0.225 放宽）。
 */
export const DEFAULT_JINA_TIMEOUT_MS = 28_000;

/**
 * app_config web group（jina 相关）形状。
 * 类型名保留 JinaDevConfig（历史命名），实际对应 app_config.web group。
 */
export interface JinaDevConfig {
  jinaEnabled?: boolean;
  jinaApiKey?: string;
  jinaTimeoutMs?: number;
}

/** JinaContentFetcher 构造参数（spec §3.2：signal 构造注入） */
export interface JinaFetcherCtor {
  /** 已合并的 abort signal（含外部 ctx.signal + 总超时 + race abort）—— 构造注入 */
  signal: AbortSignal | undefined;
  /** app_config web group（jinaEnabled/jinaApiKey/jinaTimeoutMs；字段名 devConfig 为历史命名，实现读 app_config） */
  devConfig?: JinaDevConfig;
  /** 走代理的 fetch 注入点（默认 proxyFetch；UT mock） */
  fetchImpl?: typeof proxyFetch;
}

/**
 * JinaContentFetcher 实现。
 * signal 在构造时注入并保存为字段；fetch 内的 proxyFetch 一开始就接好此 signal。
 */
export class JinaContentFetcher implements ContentFetcher {
  readonly id = 'jina' as const;
  private readonly signal: AbortSignal | undefined;
  private readonly devConfig: JinaDevConfig | undefined;
  private readonly fetchImpl: typeof proxyFetch;

  constructor(ctor: JinaFetcherCtor) {
    this.signal = ctor.signal;
    this.devConfig = ctor.devConfig;
    this.fetchImpl = ctor.fetchImpl ?? proxyFetch;
  }

  /**
   * 抓取：GET r.jina.ai/<url>，返回 markdown。
   * 失败/不充足返回 ok:false（不抛），让 runner 用 Promise.any 跑完 race。
   */
  async fetch(ctx: FetchContext): Promise<FetchResult> {
    const jinaEnabled = this.devConfig?.jinaEnabled ?? true;
    if (!jinaEnabled) {
      // jina 禁用 → 直接返回 ok:false（runner 会跳过本 fetcher，正常不应被构造）
      return { title: '', content: '', source: 'jina', ok: false, err: 'jinaEnabled=false' };
    }
    const timeoutMs = this.devConfig?.jinaTimeoutMs ?? DEFAULT_JINA_TIMEOUT_MS;
    const headers: Record<string, string> = { Accept: 'text/markdown' };
    // 有 key 就传，无则不传（匿名也能用，spec §3.2）
    const key = this.devConfig?.jinaApiKey;
    if (key && key.trim().length > 0) {
      headers.Authorization = `Bearer ${key}`;
      console.log(`[jina-fetcher] key=${maskKey(key)}`);
    } else {
      console.log('[jina-fetcher] key=anonymous');
    }
    // 超时用 AbortSignal.timeout 合并进 signal（BUG-005：不用 undici dispatcher 超时）
    const timeoutSig = AbortSignal.timeout(timeoutMs);
    const merged = mergeSignal([this.signal, timeoutSig]);
    const init: ProxyFetchInit = {
      method: 'GET',
      headers,
      signal: merged,
      noFollowRedirect: false,
    };
    try {
      const resp = await this.fetchImpl(`${JINA_BASE}${ctx.url}`, init);
      if (!resp.ok) {
        return { title: '', content: '', source: 'jina', ok: false, err: `jina http ${resp.status}` };
      }
      const text = await resp.text();
      const trimmed = text.trim();
      // 合格判定在 runner；fetcher 只报拿到了什么。空内容 → ok:false
      return {
        title: '',
        content: trimmed,
        source: 'jina',
        ok: trimmed.length > 0,
        err: trimmed.length > 0 ? undefined : 'jina 返回空内容',
      };
    } catch (e) {
      // 失败（含 abort）→ ok:false，不抛（让 runner 跑完 race）
      // proxyFetch 内部 finally 已关 dispatcher（BUG-003 守卫）
      return {
        title: '',
        content: '',
        source: 'jina',
        ok: false,
        err: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * cleanup：proxyFetch per-call dispatcher 已在 fetch finally 内 close（BUG-003 守卫）；
   * 本方法 idempotent no-op（spec §3.2）。
   */
  async cleanup(): Promise<void> {
    /* idempotent — 资源已在 fetch 路径释放 */
  }
}
