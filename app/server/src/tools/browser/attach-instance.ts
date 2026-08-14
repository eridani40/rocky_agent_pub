/**
 * attach-instance —— attach 生命周期纯 helper（connect / disconnect / 失活判定）
 * 参考: specs/tech/agent/tools/[P1]browser_instance_manager.md §3.3（attach 纳入）
 *       specs/tech/agent/tools/[P1]browser_tool.md §4（ChromeMcpDriver connect/close 语义）
 *       change_plan v0.0.266 Delta（T3：纯 helper 保留，launch/dispatch/失活逻辑并入 AttachModeImpl）
 *
 * 定位：无状态纯函数/纯文本判定，供 AttachModeImpl 复用。
 * v0.0.266 T3 删：launchAttach / handleAttachLost / AttachManagerHooks / buildAttachInstance /
 * AttachLaunchGate / launchAttachInstance（逻辑并入 attach-mode-impl.ts）。
 *
 * attach 语义（相对 worker-based）：
 *   - connect：ChromeMcpDriver.connect → BrowserSession（主进程持有；attach 不 spawn worker）。
 *     autoConnect-only：driver 固定走 --autoConnect（spec §4，chrome 144+ inspect
 *     远调模式唯一可用；不塞 127.0.0.1:9222，该模式 /json/version 404 必挂）
 *   - disconnect：driver.disconnect（graceful client.close + transport.close kill MCP 进程），
 *     不杀用户 chrome；幂等（连接已断 no-op）；失败记 warn 不抛
 *   - 失活判定：操作中 CDP 断/chrome 被关 → dispatchAction 返回文本匹配 isAttachConnectionLost
 *     → AttachModeImpl 置 dead + 引导重新 launch
 */
import type { ChromeMcpDriver } from './chrome-mcp-driver';
import type { BrowserSession } from './types';
import { isAttachConnectError } from './chrome-mcp-driver';
import { defaultChromeUserDataDirCandidates } from './attach-debug-state';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

/** attach 连接失败错误（由 connect 透传，kind=attach_failed） */
export interface AttachConnectError {
  kind: 'attach_failed';
  message: string;
}

/** connectAttachSession/disconnectAttachSession 可注入依赖（UT mock existsSync/homedir/platform；生产缺省真实实现） */
export interface ConnectAttachDeps {
  /** 文件存在探测（UT 注入 mock 强制全 false 测 undefined 分支） */
  existsSync?: (path: string) => boolean;
  /** 用户 home 目录（UT 注入固定值隔离本机环境） */
  homedir?: () => string;
  /** 平台（UT 注入 linux/win32 测多候选分支；缺省 process.platform） */
  platform?: string;
}

/**
 * 解析 attach 默认 Chrome user data dir（v0.0.334 fix：attach 连不上回归；v0.0.336 提模块级复用）。
 * 遍历 defaultChromeUserDataDirCandidates(homedir())，返回**首个 existsSync 存在**的 dir；
 * 全不存在 → undefined（不传 --userDataDir，走 chrome-devtools-mcp else 分支，由 driver 错误引导兜底）。
 * 单一数据源：connect/disconnect 共用本函数保证 cacheKey 对称（v0.0.336 P1 修 launch 复用死连接）。
 * @param deps UT 可注入 existsSync/homedir/platform mock（生产缺省真实实现）
 */
export function resolveDefaultChromeUserDataDir(deps: ConnectAttachDeps = {}): string | undefined {
  const existsFn = deps.existsSync ?? existsSync;
  const homeFn = deps.homedir ?? homedir;
  for (const dir of defaultChromeUserDataDirCandidates(homeFn(), deps.platform ?? process.platform)) {
    if (existsFn(dir)) return dir;
  }
  return undefined;
}

/**
 * connect attach session：ChromeMcpDriver.connect({userDataDir}) → BrowserSession（autoConnect-only）。
 * v0.0.334 fix：attach 必须注入默认 userDataDir —— chrome-devtools-mcp autoConnect 读
 * DevToolsActivePort 的前提是 options.userDataDir 非空；为空则 puppeteer 按 channel 启动新实例，
 * 根本不读用户日常 Chrome 的 DevToolsActivePort（报 Could not find DevToolsActivePort）。
 * 注入后 session 缓存 key 自动含 userDataDir（cacheKey=[profileName,userDataDir] 二元组），
 * attach 多次 connect 命中同一缓存，语义一致。
 * 失败归类：driver.connect 内部已把连接失败转 BrowserError('attach_failed') 透传；
 * 原样透传错误（含失败清理，见 driver.connect）。
 * v0.0.337 H4：第三参 signal（launch 超时 abort 感知）透传 driver.connect；
 * 失败时透传 driver 最近一次 spawn pid（getLastSpawnPid，含失败）→ 返回 spawnPid 供 impl 失败入台账兜底。
 * @param deps UT 可注入 existsSync/homedir mock（生产缺省真实实现）
 * @param signal 取消信号（v0.0.337 H3/H4：abort → driver.connect 抛 attach_failed 触发 driver 内部清理）
 * @returns {ok:true, session, mcpPid?} | {ok:false, error:{kind:'attach_failed', message}, spawnPid?}
 *          mcpPid = MCP 子进程 pid（v0.0.334 B8：attach 台账锚点；缺省 undefined 不阻塞 launch）
 *          spawnPid = 最近一次 spawn 的 pid（v0.0.337 H4：失败也可读；供 H9 失败入台账兜底；无则 undefined）
 */
export async function connectAttachSession(
  driver: ChromeMcpDriver,
  deps: ConnectAttachDeps = {},
  signal?: AbortSignal,
): Promise<
  | { ok: true; session: BrowserSession; mcpPid?: number }
  | { ok: false; error: AttachConnectError; spawnPid?: number }
> {
  try {
    const userDataDir = resolveDefaultChromeUserDataDir(deps);
    const session = await driver.connect({ userDataDir }, signal);
    // B8：driver 透传最近一次 connect 的 MCP 子进程 pid（getLastMcpPid 新增导出）
    const mcpPid = typeof (driver as ChromeMcpDriver & { getLastMcpPid?: () => number | undefined }).getLastMcpPid === 'function'
      ? (driver as ChromeMcpDriver & { getLastMcpPid: () => number | undefined }).getLastMcpPid()
      : undefined;
    return { ok: true, session, ...(mcpPid !== undefined ? { mcpPid } : {}) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // H4：失败透传 spawn pid（driver 最近一次 spawn，含失败；拿不到 undefined 不阻塞）
    const spawnPid = typeof (driver as ChromeMcpDriver & { getLastSpawnPid?: () => number | undefined }).getLastSpawnPid === 'function'
      ? (driver as ChromeMcpDriver & { getLastSpawnPid: () => number | undefined }).getLastSpawnPid()
      : undefined;
    return {
      ok: false,
      error: { kind: 'attach_failed', message: msg },
      ...(spawnPid !== undefined ? { spawnPid } : {}),
    };
  }
}

/**
 * disconnect attach session：ChromeMcpDriver.disconnect({userDataDir})（autoConnect-only）。
 * v0.0.336 fix（P1 launch 复用死连接）：disconnect 必须用与 connect **同一 userDataDir 解析**
 * （复用 resolveDefaultChromeUserDataDir），保证 cacheKey 对称——connect 传 {userDataDir}、
 * disconnect 也传 {userDataDir}，driver cache.get(key) 命中正常清 cache，下次 connect cache miss
 * 走新建，不复用死连接。
 * attach 语义：只断 MCP 连接（graceful client.close + transport.close kill MCP 代理进程），
 * 不杀用户 chrome；幂等（cache miss no-op）；失败 catch 记 warn 不抛（不阻塞调用方清理流程）。
 * @param deps UT 可注入 existsSync/homedir/platform mock（生产缺省真实实现，与 connect 同解析）
 */
export async function disconnectAttachSession(
  driver: ChromeMcpDriver | undefined,
  deps: ConnectAttachDeps = {},
): Promise<void> {
  if (!driver) return;
  try {
    const userDataDir = resolveDefaultChromeUserDataDir(deps);
    await driver.disconnect({ userDataDir });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[attach-instance] disconnectAttachSession 失败: ${msg}`);
  }
}

/** transport 级失活模式（chrome-devtools-mcp 连接断/进程退时工具返回文本） */
const ATTACH_LOST_RE =
  /connection closed|channel closed|transport closed|server disconnected|socket hang up|stdout closed/i;

/**
 * attach 失活文本判定：操作中 CDP 断/chrome 被关 → dispatchAction 返回错误文本匹配本函数。
 * 复用 chrome-mcp-driver 已导出 isAttachConnectError（Could not connect/DevToolsActivePort/
 * ECONNREFUSED/Failed to connect）+ transport 级扩展（connection closed 等）。
 * 纯文本匹配无副作用；供 AttachModeImpl.execute 检查 dispatchAction 返回 → 置 dead。
 */
export function isAttachConnectionLost(text: string): boolean {
  return isAttachConnectError(text) || ATTACH_LOST_RE.test(text);
}
