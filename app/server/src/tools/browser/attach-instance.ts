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
 *   - connect：ChromeMcpDriver.connect → BrowserSession（主进程持有；attach 不 spawn worker）
 *   - disconnect：driver.disconnect（graceful client.close + transport.close kill MCP 进程），
 *     不杀用户 chrome；幂等（连接已断 no-op）；失败记 warn 不抛
 *   - 失活判定：操作中 CDP 断/chrome 被关 → dispatchAction 返回文本匹配 isAttachConnectionLost
 *     → AttachModeImpl 置 dead + 引导重新 launch
 */
import type { ChromeMcpDriver } from './chrome-mcp-driver';
import type { BrowserSession } from './types';
import { isAttachConnectError } from './chrome-mcp-driver';
import { DEFAULT_ATTACH_CDP_URL } from './chrome-mcp-driver';

/** attach 连接失败错误（由 connect 透传，kind=attach_failed） */
export interface AttachConnectError {
  kind: 'attach_failed';
  message: string;
}

/**
 * connect attach session：ChromeMcpDriver.connect({cdpUrl}) → BrowserSession。
 * 失败归类：driver.connect 内部已把连接失败转 BrowserError('attach_failed') 透传；
 * 此处仅保证 cdpUrl 缺省时兜底默认端点，并原样透传错误（含失败清理，见 driver.connect）。
 * @returns {ok:true, session} | {ok:false, error:{kind:'attach_failed', message}}
 */
export async function connectAttachSession(
  driver: ChromeMcpDriver,
  cdpUrl?: string,
): Promise<{ ok: true; session: BrowserSession } | { ok: false; error: AttachConnectError }> {
  try {
    const session = await driver.connect({ cdpUrl: cdpUrl ?? DEFAULT_ATTACH_CDP_URL });
    return { ok: true, session };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { kind: 'attach_failed', message: msg } };
  }
}

/**
 * disconnect attach session：ChromeMcpDriver.disconnect({cdpUrl})。
 * attach 语义：只断 MCP 连接（graceful client.close + transport.close kill MCP 代理进程），
 * 不杀用户 chrome；幂等（cache miss no-op）；失败 catch 记 warn 不抛（不阻塞调用方清理流程）。
 */
export async function disconnectAttachSession(
  driver: ChromeMcpDriver | undefined,
  cdpUrl?: string,
): Promise<void> {
  if (!driver) return;
  try {
    await driver.disconnect({ cdpUrl: cdpUrl ?? DEFAULT_ATTACH_CDP_URL });
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
