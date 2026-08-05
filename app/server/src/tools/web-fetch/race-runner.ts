/**
 * race runner：ContentFetcher race 编排（fetchContent）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §3.4 §3.5
 *
 * 编排（spec §3.4）：
 *   1. 起始 SSRF（resolveAndCheck，jina 之前）
 *   2. 创建共享 raceController；raceSignal = mergeSignal([外部 signal, 总超时, raceController.signal])
 *   3. 构造注入：new JinaContentFetcher({ signal: raceSignal, ... }) / new LocalContentFetcher(...)
 *      —— signal 构造时就塞进去（非 fetch 后传）
 *   4. Promise.any（首合格：ok && content.length ≥ MIN_CONTENT）→ raceController.abort() → 返回 winner
 *   5. 主流程立即返回，不等输方清理；输方 cleanup().catch(()=>{}) detached 执行
 *   6. 两路皆不合格 → null（调用方决定 isError）
 *
 * 关键正确性（spec §3.5 + §6）：
 *   - AbortController 构造注入（非 fetch 后传）
 *   - 首合格 abort 其他：raceController.abort() 传播到输方所有在飞子操作
 *   - detached 清理不阻塞主流程：Promise.any 拿 winner 即返回
 *   - 清理必须真执行（不跳过），但 best-effort + .catch(()=>{}) 吞异常防 unhandled rejection
 *   - Bun 兼容：超时用 AbortSignal.timeout（BUG-005），不用 undici dispatcher 超时项
 */
import type { ContentFetcher, FetchResult } from './content-fetcher';
import { JinaContentFetcher, type JinaDevConfig } from './jina-fetcher';
import { LocalContentFetcher, MIN_CONTENT, type HeadlessRenderer } from './local-fetcher';
import { resolveAndCheck, type ResolveDnsFn, defaultResolveDns } from './ssrf';
import { proxyFetch } from './proxy';
import { mergeSignal } from './merge-signal';

/** 总超时（race 整体；spec §7 ~30s） */
const OVERALL_TIMEOUT_MS = 30_000;

/** race runner 返回结果（含 metadata） */
export interface FetchContentResult {
  title: string;
  content: string;
  /** 内容来源：jina / local / headless */
  source: 'jina' | 'local' | 'headless';
}

/** 单路 fetcher 失败归因（两路皆空时透出给上层写 error.log 定位，纯观测用途） */
export interface FetchFailure {
  /** fetcher 标识：jina / local */
  fetcher: string;
  /** 失败原因（err/status/内容不足描述） */
  reason: string;
}

/** 调用方选项（web_fetch tool 传入） */
export interface FetchContentOptions {
  /** 取消信号（外部 ctx.signal） */
  signal?: AbortSignal;
  /** DNS 解析（注入 mock） */
  resolveDns?: ResolveDnsFn;
  /** 走代理的 fetch 注入点（默认 proxyFetch；UT mock） */
  fetchImpl?: typeof proxyFetch;
  /** app_config web group（jina 相关） */
  appConfig?: JinaDevConfig;
  /** headless 渲染器（Local 静态不足时起；缺省→跳过 headless） */
  headlessRenderer?: HeadlessRenderer;
  /** 强制 headless（render=true）：Local 跳过静态分支直起 headless */
  forceHeadless?: boolean;
  /** 两路皆空时的失败归因回调（return null 前同步调用；观测用途，不抛） */
  onFailure?: (failures: FetchFailure[]) => void;
}

/**
 * fetchContent 主入口：race 编排。
 * 调用方（web_fetch tool）应已在更上层做 assertSsrfSafe；本函数内部起始 URL 也再校验一次。
 *
 * @returns FetchContentResult；全部路线失败 → null（调用方决定 isError）
 */
export async function fetchContent(
  url: string,
  options: FetchContentOptions = {},
): Promise<FetchContentResult | null> {
  const resolveDns = options.resolveDns ?? defaultResolveDns;
  const fetchImpl = options.fetchImpl ?? proxyFetch;
  const outerSignal = options.signal;

  // 起始 URL SSRF 校验（jina 之前；spec §1：SSRF 永远最先）
  await resolveAndCheck(url, resolveDns);

  // 创建共享 race abort controller + 合并 signal（外部 + 总超时 + race abort）
  const raceController = new AbortController();
  const timeoutSig = AbortSignal.timeout(OVERALL_TIMEOUT_MS);
  const raceSignal = mergeSignal([outerSignal, timeoutSig, raceController.signal]);

  // ★ 构造注入：创建 fetcher 时就把 signal 塞进构造参数（spec §6.2）
  const fetchers: ContentFetcher[] = [];
  const jinaEnabled = options.appConfig?.jinaEnabled ?? true;
  if (jinaEnabled) {
    fetchers.push(
      new JinaContentFetcher({
        signal: raceSignal,
        // JinaContentFetcher 形参仍叫 devConfig（JinaDevConfig 子结构）；
        // options.appConfig 与之是同一份 jina 配置数据（owner service 不同）。
        devConfig: options.appConfig,
        fetchImpl,
      }),
    );
  }
  fetchers.push(
    new LocalContentFetcher({
      signal: raceSignal,
      resolveDns,
      fetchImpl,
      headlessRenderer: options.headlessRenderer,
      forceHeadless: options.forceHeadless,
    }),
  );

  // 包成「合格才 resolve，否则 reject」让 Promise.any race
  // 合格 = ok && trim(content) ≥ MIN_CONTENT（spec §3.4）
  // reject 时携带 fetcher 归因（err 字段），AggregateError 收集后透出给 onFailure
  const racing = fetchers.map((f) =>
    f.fetch({ url }).then((r: FetchResult): FetchContentResult => {
      if (!r.ok || r.content.trim().length < MIN_CONTENT) {
        const reason = !r.ok
          ? (r.err ?? '抓取失败')
          : `内容不足（trim ${r.content.trim().length} < ${MIN_CONTENT}）`;
        const err = new Error(`${f.id}: ${reason}`) as Error & { fetcher?: string };
        err.fetcher = f.id;
        throw err;
      }
      // 胜出 → 取消其他 fetcher 的在飞子操作（spec §3.4）
      raceController.abort();
      return { title: r.title, content: r.content, source: r.source };
    }),
  );

  let winner: FetchContentResult | null = null;
  try {
    winner = await Promise.any(racing);
  } catch (e) {
    // 全 reject（两路皆不合格 / 都失败）→ winner 保持 null；
    // 收集各 fetcher 失败归因透出（观测用途，供上层写 error.log 定位哪路为何挂）
    winner = null;
    if (e instanceof AggregateError && options.onFailure) {
      const failures: FetchFailure[] = e.errors.map((x) => {
        const fe = x as (Error & { fetcher?: string }) | undefined;
        return {
          fetcher: fe?.fetcher ?? 'unknown',
          reason: fe?.message ?? String(x),
        };
      });
      try {
        options.onFailure(failures);
      } catch {
        /* 归因回调失败不影响主流程 */
      }
    }
  }

  // ★ detached 清理：每个 fetcher 都清（胜方+输方），best-effort 不抛，主流程不等（spec §6.3）
  // cleanup 必须真执行（关 dispatcher / 关浏览器），但 .catch(()=>{}) 吞异常防 unhandled rejection
  for (const f of fetchers) {
    f.cleanup().catch(() => {
      /* ignore cleanup error — best-effort */
    });
  }

  return winner;
}
