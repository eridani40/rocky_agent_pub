/**
 * Layer 2 SSRF 防护（在任何抓取之前 —— 含 jina）
 * 参考: specs/tech/agent/tools/[P1]web_fetch_tool.md §4 §6.2
 *       specs/research/v0.0.23-web-fetch.md §A.6（代理不豁免 SSRF）
 *
 * 三件套：
 *   1. IP 黑名单：URL host → DNS 解析 → 命中私网/保留段 → 拒绝
 *      （10/172.16/192.168/127/::1/169.254/0.0.0.0/100.64 CGN 等）。
 *   2. DNS pinning：校验解析 IP = 实际连接 IP（防 DNS rebinding）。
 *      —— 本模块暴露 resolveAndCheck，调用方（fetch-content）解析后用同 IP 连。
 *   3. 重定向逐跳校验：每跳 3xx 重做 SSRF；跨 origin 重定向剥 Authorization/Cookie
 *      （防凭证泄漏到重定向目标）。
 *
 * 协议白名单：仅 http/https；禁 file:// / ftp:// 等。
 *
 * 为何 jina 之前：jina reader 收到 r.jina.ai/<内部url> 时内部 URL 已泄漏。
 * SSRF-first 把内部地址本地挡掉，jina 只会收到公网 URL。
 *
 * 单测策略：DNS 解析与 fetch 均可注入（resolveDns / fetchImpl），不真实联网。
 */
import { promises as dnsPromises } from 'node:dns';
import { URL } from 'node:url';
import net from 'node:net';

/** SSRF 校验失败抛出的错误 */
export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfError';
  }
}

/** 允许的协议（仅 http/https） */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 判定单个 IP 是否属于私网/保留段（禁止访问）。
 * 覆盖：IPv4 私网三段 + loopback + link-local + 0.0.0.0 + CGN 100.64/10
 *       IPv6 ::1 / :: / fc00::/7 / fe80::/10。
 *
 * @param ip 已解析的 IPv4 或 IPv6 字符串
 * @returns true 表示命中黑名单（应拒绝）
 */
export function isPrivateIp(ip: string): boolean {
  const v4 = ip.includes('.') && !ip.includes(':');
  if (v4) {
    // net.BlockList 仅支持 IPv4 CIDR
    const blockList = new net.BlockList();
    blockList.addAddress('127.0.0.1', 'ipv4'); // loopback
    blockList.addAddress('0.0.0.0', 'ipv4'); // 0.0.0.0
    blockList.addAddress('169.254.0.0', 'ipv4'); // link-local（先 add 单地址再 addSubnet）
    blockList.addSubnet('10.0.0.0', 8, 'ipv4'); // 私网 A
    blockList.addSubnet('172.16.0.0', 12, 'ipv4'); // 私网 B
    blockList.addSubnet('192.168.0.0', 16, 'ipv4'); // 私网 C
    blockList.addSubnet('127.0.0.0', 8, 'ipv4'); // loopback
    blockList.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local
    blockList.addSubnet('100.64.0.0', 10, 'ipv4'); // CGN / fake-ip 代理栈
    blockList.addSubnet('224.0.0.0', 4, 'ipv4'); // 组播 224/4
    blockList.addSubnet('0.0.0.0', 8, 'ipv4'); // 本网
    return blockList.check(ip, 'ipv4');
  }
  // IPv6：手工判 ::1 / :: / 私网 fc00::/7 / 链路本地 fe80::/10
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower === '::') return true; // 未指定
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb'))
    return true; // link-local fe80::/10
  // IPv4-mapped (::ffff:a.b.c.d)：剥出 IPv4 再判
  const mapped = lower.match(/::ffff:([0-9.]+)$/);
  if (mapped && mapped[1]) return isPrivateIp(mapped[1]);
  return false;
}

/** DNS 解析函数类型（可注入 mock） */
export type ResolveDnsFn = (host: string) => Promise<string[]>;

/** 默认 DNS 解析（dns.promises.lookup，返回地址数组；同时取 v4/v6） */
export const defaultResolveDns: ResolveDnsFn = async (host: string): Promise<string[]> => {
  try {
    const result = await dnsPromises.lookup(host, { all: true });
    return result.map((r) => r.address);
  } catch {
    return [];
  }
};

/**
 * 解析 URL host 并对每个 IP 做 SSRF 黑名单判定。
 * 返回解析得到的全部 IP（供 DNS pinning / 连接复用）。
 *
 * @param url 目标 URL
 * @param resolveDns DNS 解析函数（默认 node dns.promises.lookup）
 * @returns 解析到的 IP 数组（公网，已通过黑名单校验）
 * @throws SsrfError：协议非法 / host 解析失败 / 命中私网
 */
export async function resolveAndCheck(
  url: string,
  resolveDns: ResolveDnsFn = defaultResolveDns,
): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfError(`URL 解析失败: ${url}`);
  }
  // 协议白名单（禁 file:///ftp://）
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new SsrfError(`协议被禁用: ${parsed.protocol}（仅允许 http/https）`);
  }
  const host = parsed.hostname;
  // IP 字面量（http://127.0.0.1/）直接判；hostname 域名则 DNS 解析
  const isLiteral = net.isIP(host) !== 0;
  const ips = isLiteral ? [host] : await resolveDns(host);
  if (ips.length === 0) {
    throw new SsrfError(`DNS 解析失败: ${host}`);
  }
  for (const ip of ips) {
    if (isPrivateIp(ip)) {
      throw new SsrfError(`目标 IP 命中私网/保留段: ${ip}（host=${host}）`);
    }
  }
  return ips;
}

/**
 * SSRF 顶层断言：解析 + 校验（jina 之前必调）。
 * 单测/调用方常用此函数，不关心 IP 列表。
 * @throws SsrfError 校验失败时抛出
 */
export async function assertSsrfSafe(
  url: string,
  resolveDns: ResolveDnsFn = defaultResolveDns,
): Promise<void> {
  await resolveAndCheck(url, resolveDns);
}

/**
 * 判定 URL 是否为 IP 字面量（用于跨重定向跳 IP 时的特殊判定）。
 */
export function isIpLiteral(host: string): boolean {
  return net.isIP(host) !== 0;
}

/**
 * 判定 IP 字面量是否 loopback（127.0.0.0/8 或 ::1）。
 * 用途：CDP 控制面豁免——本地 chrome attach（http://127.0.0.1:9222）不该被
 * SSRF（页面导航语义）误拦。loopback CDP 是本地控制面，非页面导航。
 * 参考: refs/openclaw/.../cdp-reachability-policy.ts:33（loopback CDP 豁免 SSRF）
 *
 * 边界：不含 0.0.0.0（unspecified，非 loopback）；IPv4-mapped ::ffff:127.x.x.x 识别。
 * @param ip IPv4 或 IPv6 字面量字符串
 * @returns true 表示是 loopback
 */
export function isLoopbackIp(ip: string): boolean {
  const v4 = ip.includes('.') && !ip.includes(':');
  if (v4) {
    // IPv4 loopback：整段 127.0.0.0/8（127. 开头即 loopback，含 127.5.6.7 等）
    return ip.startsWith('127.');
  }
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // IPv6 loopback
  // IPv4-mapped ::ffff:127.x.x.x：剥出 IPv4 再判
  const mapped = lower.match(/::ffff:([0-9.]+)$/);
  if (mapped && mapped[1]) return isLoopbackIp(mapped[1]);
  return false;
}

/**
 * 判定 URL host 是否 loopback（localhost 或 loopback IP 字面量）。
 * 用途：browser attach cdpUrl 门禁——loopback CDP 豁免 SSRF（见 isLoopbackIp）。
 *
 * 判定：hostname=localhost（忽略大小写）→ true；
 *       hostname 是 IP 字面量 → 调 isLoopbackIp；
 *       域名（需 DNS 解析）→ 保守返回 false（CDP 豁免只对字面量 loopback，不承担 DNS rebinding 风险）。
 * URL 解析失败 → false（fail-open 仅对字面量；解析失败由调用方走 SSRF 兜底）。
 * @param url 待判定 URL 字符串
 * @returns true 表示该 URL 的 host 是 loopback
 */
export function isLoopbackHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname;
  if (host.toLowerCase() === 'localhost') return true;
  // WHATWG URL 对 IPv6 字面量保留方括号（hostname='[::1]'），需剥括号才能被 net.isIP 识别
  const ipStr = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(ipStr) !== 0) return isLoopbackIp(ipStr);
  return false; // 域名不在此判（需 DNS，CDP 豁免只对字面量 loopback）
}

/**
 * 跨 origin 重定向时剥除 Authorization / Cookie 头（防凭证泄漏到重定向目标）。
 * @param fromUrl 起始 URL
 * @param toUrl 重定向目标 URL
 * @param headers 原请求头
 * @returns 处理后的请求头（同 origin 保留 / 跨 origin 剥凭证）
 */
export function stripAuthOnCrossOrigin(
  fromUrl: string,
  toUrl: string,
  headers: Record<string, string>,
): Record<string, string> {
  let from: URL;
  let to: URL;
  try {
    from = new URL(fromUrl);
    to = new URL(toUrl);
  } catch {
    // 解析失败保守剥除所有凭证
    const { authorization, Authorization, cookie, Cookie, ...rest } = headers;
    return rest;
  }
  const sameOrigin =
    from.protocol === to.protocol && from.host === to.host;
  if (sameOrigin) return { ...headers };
  // 跨 origin：剥 Authorization / Cookie（大小写两套）
  const {
    authorization,
    Authorization,
    cookie,
    Cookie,
    ...rest
  } = headers;
  void authorization;
  void Authorization;
  void cookie;
  void Cookie;
  return rest;
}
