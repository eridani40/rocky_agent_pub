/**
 * CDP 端口分配（mode ② 持久 profile）
 * 参考: specs/research/v0.0.23-browser-use.md §3.2（openclaw profiles.ts allocateCdpPort）
 *       specs/tech/agent/tools/[P1]browser_tool.md §3
 *
 * 端口段 18800-18899（100 profile 上限）。
 * allocateCdpPort 取段内首个未占用端口（避开预留）。
 * 端口持久化进 profile config 由 connectors 任务接入；本文件仅提供分配函数 + 探测。
 */
import { BrowserError } from './types';

/** CDP 端口段起始 */
export const CDP_PORT_RANGE_START = 18800;
/** CDP 端口段结束（含） */
export const CDP_PORT_RANGE_END = 18899;

/** 预留端口（gateway/bridge/control/canvas 等系统服务，不可分配） */
export const RESERVED_PORTS = new Set<number>([18789, 18790, 18791, 18793]);

/** 端口是否被占用（net.Socket 探测 127.0.0.1:port）；连接上=占用 */
export type PortBusyFn = (port: number) => Promise<boolean>;

/**
 * 分配段内首个未占用端口（避开已用 + 预留 + 真实探测占用）。
 * @param usedPorts 已分配给其它 profile 的端口集合（从 config 读）
 * @param isBusy 端口占用探测函数（生产用 net 探测，测试可注入 mock）
 * @returns 选中的端口号
 * @throws BrowserError(port_exhausted) 段内全部不可用
 */
export async function allocateCdpPort(
  usedPorts: Set<number>,
  isBusy: PortBusyFn,
): Promise<number> {
  for (let port = CDP_PORT_RANGE_START; port <= CDP_PORT_RANGE_END; port++) {
    if (RESERVED_PORTS.has(port)) continue;
    if (usedPorts.has(port)) continue;
    let busy = false;
    try {
      busy = await isBusy(port);
    } catch {
      // 探测异常保守视为占用，跳过
      busy = true;
    }
    if (!busy) return port;
  }
  throw new BrowserError(
    'port_exhausted',
    `CDP 端口段 ${CDP_PORT_RANGE_START}-${CDP_PORT_RANGE_END} 全部占用（profile 上限 100）`,
  );
}

/**
 * 用 net 探测端口占用（连接成功=占用）。
 * 生产实现：连 127.0.0.1:port，成功=有进程在听。
 */
export const netPortBusy: PortBusyFn = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    // 延迟 require 避免 typecheck/单测拉起 net 时副作用
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const net = require('node:net') as typeof import('node:net');
    const sock = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (busy: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(busy);
    };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    // 200ms 超时保守判定空闲
    setTimeout(() => done(false), 200);
  });
};

/** 验证端口号在段内（profile config 落库前校验） */
export function isValidCdpPort(port: number): boolean {
  return (
    Number.isInteger(port) &&
    port >= CDP_PORT_RANGE_START &&
    port <= CDP_PORT_RANGE_END &&
    !RESERVED_PORTS.has(port)
  );
}
