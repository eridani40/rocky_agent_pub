/**
 * CDP 就绪探测（chrome launch 后轮询 /json/version 200 → connectOverCDP）
 * 参考: specs/research/v0.0.23-browser-use.md §2.3（isChromeCdpReady）
 *       specs/tech/agent/tools/[P1]browser_tool.md §3
 *
 * 仅验 HTTP 200 不足（僵尸 chrome 的 /json/version 仍返 200 + 旧 ws URL → 误判就绪
 * → connectOverCDP 连死 WS 超时），故增加 webSocketDebuggerUrl 字段非空校验：
 * HTTP 200 且 body 含非空 ws URL 才算就绪。不真连 WS（那个交给 connectOverCDP），只做字段存在性校验。
 */
import { BrowserError } from './types';

/** CDP 就绪轮询默认参数 */
export const CDP_POLL_INTERVAL_MS = 200;
export const CDP_POLL_TIMEOUT_MS = 10_000;

/**
 * fetch 注入点（测试 mock 用）。
 * body/webSocketDebuggerUrl 为可选字段——只返 {ok,status} 的 mock 仍兼容（按 200 即就绪）；
 * 提供 body 或 webSocketDebuggerUrl 则触发更严判定。
 */
export interface CdpFetchResult {
  ok: boolean;
  status: number;
  /** /json/version body 文本（可选；提供则触发 webSocketDebuggerUrl 校验） */
  body?: string;
  /** 解析后的 webSocketDebuggerUrl（可选；优先于 body 解析） */
  webSocketDebuggerUrl?: string;
}
export type FetchFn = (url: string) => Promise<CdpFetchResult>;

/**
 * 轮询 http://127.0.0.1:<port>/json/version 直到就绪。
 * 就绪判定：
 *   - HTTP 200 且无 body/ws 字段 → 即就绪（向后兼容）
 *   - HTTP 200 且提供 body/ws 字段 → 要求 webSocketDebuggerUrl 非空才算就绪
 *     （僵尸 chrome HTTP 200 但 ws 字段为空/缺 → 继续轮询，不误判）
 * @param port CDP 端口
 * @param deps fetch / interval / timeout / sleep（测试可注入）
 * @throws BrowserError(cdp_timeout) 超时仍未就绪
 */
export async function waitForCdpReady(
  port: number,
  deps: {
    fetch?: FetchFn;
    intervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<void> {
  const fetch = deps.fetch ?? defaultFetch;
  const interval = deps.intervalMs ?? CDP_POLL_INTERVAL_MS;
  const timeout = deps.timeoutMs ?? CDP_POLL_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;

  const url = `http://127.0.0.1:${port}/json/version`;
  const start = now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200) {
        // BUG-001 增强：若提供了 body/ws 字段，需校验 webSocketDebuggerUrl 非空
        if (isReadyWithWsField(res)) return;
        // 未提供字段（旧 mock / 旧生产路径）→ 按 200 即就绪（向后兼容）
        if (res.body === undefined && res.webSocketDebuggerUrl === undefined) return;
        // 提供了字段但 ws URL 空 → 不算就绪，继续轮询（僵尸 chrome 场景）
      }
    } catch {
      // 连不上，继续轮询
    }
    if (now() - start >= timeout) {
      throw new BrowserError(
        'cdp_timeout',
        `chrome CDP 端口 ${port} 在 ${timeout}ms 内未就绪`,
      );
    }
    await sleep(interval);
  }
}

/**
 * 校验 fetch 结果的 webSocketDebuggerUrl 非空。
 * 优先用显式 webSocketDebuggerUrl 字段；否则从 body JSON 解析。
 * 任一拿到非空 ws URL → true（就绪）；提供字段但都空 → false（僵尸，继续轮询）。
 * 仅 HTTP 200 时调用（调用方已保证）。
 */
function isReadyWithWsField(res: CdpFetchResult): boolean {
  // 显式字段优先
  if (res.webSocketDebuggerUrl !== undefined) {
    return res.webSocketDebuggerUrl.length > 0;
  }
  // body 提供则解析 JSON 取 webSocketDebuggerUrl
  if (res.body !== undefined) {
    try {
      const parsed = JSON.parse(res.body) as { webSocketDebuggerUrl?: unknown };
      const ws = parsed.webSocketDebuggerUrl;
      return typeof ws === 'string' && ws.length > 0;
    } catch {
      // body 非 JSON / 解析失败 → 视为未就绪（不误判）
      return false;
    }
  }
  // 两个字段都没提供 → 不归本函数判（调用方按旧口径处理）
  return false;
}

/** 默认 fetch（node 18+ 全局 fetch；返 body 供 ws 字段校验） */
const defaultFetch: FetchFn = async (url: string) => {
  const res = await fetch(url);
  const body = res.ok ? await res.text() : undefined;
  return { ok: res.ok, status: res.status, body };
};

/** CDP endpoint URL（供 connectOverCDP） */
export function cdpEndpointUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}
