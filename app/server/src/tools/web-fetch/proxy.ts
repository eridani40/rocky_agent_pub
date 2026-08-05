/**
 * Layer 1 代理：undici EnvHttpProxyAgent（系统代理支持）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §3
 *       specs/research/v0.0.23-web-fetch.md §A.2/§A.5/§A.6
 *
 * 设计要点（调研结论）：
 *   - Bun 原生 Bun.fetch 不读 HTTP_PROXY/HTTPS_PROXY，必须用 undici。
 *   - undici EnvHttpProxyAgent 自动解析 HTTP_PROXY/HTTPS_PROXY/NO_PROXY（含 CIDR），
 *     与 openclaw 同路线。
 *   - allowH2:false（HTTP/2 dispatcher 不稳，openclaw 经验）。
 *   - dispatcher 用完必须 close（释放连接池，防句柄泄漏）。
 *   - 代理失败不静默降级直连（避免 SSRF 形同虚设，调研 §A.6）。
 *
 * 本模块导出：
 *   - proxyFetch(url, init)：走 EnvHttpProxyAgent 的 fetch util（web_fetch 与
 *     Zhipu provider 等出站调用共用）。
 *   - createProxyDispatcher()：构造单次 dispatcher（调用方负责 close）。
 *
 * 注：NO_PROXY 含 CIDR 的支持由 undici 内部 matcher 负责（v6+）。
 */
import { EnvHttpProxyAgent, fetch as undiciFetch, Agent, type Dispatcher } from 'undici';
import { mergeSignal } from './merge-signal';

/** 默认连接 / 收发超时（ms）—— 自托管静态抓取与代理共用 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 判断环境是否配置了任何代理 env（HTTP(S)_PROXY 大小写两套）。
 * 用于决定走 EnvHttpProxyAgent 还是直连 Agent。
 * @returns true 表示 env 存在 PROXY 变量
 */
export function hasProxyEnv(): boolean {
  return Boolean(
    process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy,
  );
}

/**
 * 创建一个走系统代理的 dispatcher（undici EnvHttpProxyAgent）。
 * 调用方负责 close（finally 中），避免句柄泄漏。
 * @param timeoutMs 连接 / 收发超时（默认 30s）
 */
export function createProxyDispatcher(timeoutMs: number = DEFAULT_TIMEOUT_MS): Dispatcher {
  // allowH2:false 强制 HTTP/1.1（openclaw 经验：H2 dispatcher 不稳）
  return new EnvHttpProxyAgent({
    allowH2: false,
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
    connect: { timeout: timeoutMs },
  });
}

/**
 * 创建直连 dispatcher（env 无代理 / NO_PROXY 命中时用）。
 * @param timeoutMs 连接 / 收发超时
 */
export function createDirectDispatcher(timeoutMs: number = DEFAULT_TIMEOUT_MS): Dispatcher {
  return new Agent({
    allowH2: false,
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
    connect: { timeout: timeoutMs },
  });
}

/**
 * 创建「DNS 已校验」的直连 dispatcher（DNS pinning 防 rebinding）。
 * 用 connect.lookup 钉死解析 IP——TCP 连接始终打到已通过 SSRF 校验的 IP，
 * 攻击者在 check(公网)与 connect(私网)间做 DNS rebinding 无效。
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §4（DNS pinning 要求）
 *
 * @param resolvedIp 已通过 resolveAndCheck 校验的公网 IP（v4/v6 字面量）
 * @param timeoutMs 连接 / 收发超时
 */
export function createPinnedDispatcher(
  resolvedIp: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Dispatcher {
  return new Agent({
    allowH2: false,
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
    connect: {
      timeout: timeoutMs,
      // lookup hook：忽略传入 hostname，固定返回已校验 IP（DNS pinning）。
      // 兼容 undici/node net 两种调用形态：
      //   - (_, opts, cb) 且 opts.all=true（autoSelectFamily Happy Eyeballs）
      //     → cb(null, [{ address, family }])（数组形态；缺此形态 node net 抛
      //       "Invalid IP address: undefined"，prod Node runtime 实证）
      //   - (_, cb) / (_, opts, cb) 普通形态 → cb(null, address, family)
      lookup: (_hostname, opts, cb) => {
        // 兼容 undici 两种实参个数：(_, cb) 与 (_, opts, cb)
        const callback = (typeof opts === 'function' ? opts : cb) as (
          err: NodeJS.ErrnoException | null,
          addressOrList: string | Array<{ address: string; family: number }>,
          family?: number,
        ) => void;
        const family = resolvedIp.includes(':') ? 6 : 4;
        const wantAll =
          typeof opts === 'object' &&
          opts !== null &&
          (opts as { all?: boolean }).all === true;
        if (wantAll) {
          callback(null, [{ address: resolvedIp, family }]);
        } else {
          callback(null, resolvedIp, family);
        }
      },
    },
  });
}

/** proxyFetch 扩展 init（透传 dispatcher 与自定义超时） */
export interface ProxyFetchInit {
  /** 自定义请求方法 */
  method?: string;
  /** 请求头 */
  headers?: Record<string, string>;
  /** 请求体 */
  body?: string | Uint8Array;
  /** 取消信号 */
  signal?: AbortSignal;
  /** 重定向模式：默认 'manual'（web_fetch 逐跳 SSRF 校验；普通调用方可用 'follow'） */
  redirect?: 'manual' | 'follow' | 'error';
  /** 超时 ms（默认 30s）—— 同时用于 headers/body/connect */
  timeoutMs?: number;
  /** 是否禁止自动跟随重定向（默认 true：web_fetch 自己逐跳处理） */
  noFollowRedirect?: boolean;
  /**
   * DNS pinning：传入已通过 resolveAndCheck 校验的 IP，
   * 则 TCP 连接固定打到该 IP（防 DNS rebinding，web_fetch_tool §4）。
   * 未传 → 普通直连（DNS 重新解析）。
   */
  resolvedIp?: string;
}

/**
 * 走系统代理的 fetch util。
 * - env 有 PROXY → EnvHttpProxyAgent；无 → 直连 Agent。
 * - redirect 默认 'manual'（调用方做逐跳 SSRF 校验）。
 * - 不静默降级直连（env 配了代理但失败 → 直接抛错，保留 SSRF 有效性）。
 *
 * @param url 目标 URL
 * @param init 请求参数（headers/body/signal/timeoutMs/redirect）
 * @returns undici Response
 */
export async function proxyFetch(
  url: string,
  init: ProxyFetchInit = {},
): Promise<Response> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 选 dispatcher：
  //   - resolvedIp 给了 → pinned dispatcher（DNS pinning，最高优先级；与代理互斥，
  //     因代理 env 由调用方负责 SSRF/校验，pinned 仅直连场景）
  //   - env 有 PROXY → EnvHttpProxyAgent
  //   - 否则 → 直连 Agent
  let dispatcher: Dispatcher;
  if (init.resolvedIp) {
    dispatcher = createPinnedDispatcher(init.resolvedIp, timeoutMs);
  } else if (hasProxyEnv()) {
    dispatcher = createProxyDispatcher(timeoutMs);
  } else {
    dispatcher = createDirectDispatcher(timeoutMs);
  }
  try {
    // 超时强制：Bun 内置 undici 8.5.0 下 dispatcher 的 headersTimeout/bodyTimeout/
    // connect.timeout 不生效（实证：传 5s 实际 hung 75s 才报 "Unable to connect"），
    // 导致 jina/cloudflare 等不可达目标 hung 到 75s 才失败——web_fetch chat-flow
    // wf_public flaky 直接根因。改用 AbortSignal.timeout 强制中断 fetch（Bun 原生
    // AbortSignal 受支持，5000ms 精确触发 TimeoutError）。与调用方 init.signal 合并：
    // 任一触发即中止。
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = mergeSignal([init.signal, timeoutSignal]);
    const resp = await undiciFetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal,
      // web_fetch 逐跳 SSRF 校验需要 manual；其他调用方可显式 follow。
      // 显式 init.redirect 优先；否则 noFollowRedirect=false → follow，否则 manual。
      redirect: init.redirect ?? (init.noFollowRedirect ? 'manual' : 'follow'),
      dispatcher,
    } as Parameters<typeof undiciFetch>[1]);
    return resp as unknown as Response;
  } finally {
    // 释放连接池（openclaw closeDispatcher 模式）。
    // Bun 内置 undici 8.5.0 的 Dispatcher 没有 close() 方法
    // （typeof dispatcher.close === 'undefined'），直接 await dispatcher.close() 抛
    // "dispatcher.close is not a function"，被上层 catch 当成 provider 调用失败。
    // 防御性 typeof 守卫：有 close 才调；无则跳过（Bun 下 Agent 由 GC 回收，无句柄泄漏）。
    const d = dispatcher as Dispatcher & { close?: () => Promise<void> };
    if (typeof d.close === 'function') {
      await d.close().catch(() => {
        /* ignore close error */
      });
    }
  }
}
