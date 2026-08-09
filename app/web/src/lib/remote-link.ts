/**
 * remote-link —— workspace 远程链接（.url 快捷方式）打开 lib（v0.0.263 / v0.0.280 断循环依赖）
 * 参考: specs/prd/version_logs/v0.0.263.workspace_symlink_browse/prd.md §2.3/§3.6/UC-5b
 *       specs/tech/version_logs/v0.0.263/change_plan.md 行 8/9
 *       specs/tech/version_logs/v0.0.280/change_plan.md 行 25（.url 嗅探复用）
 *
 * 职责：
 *   1. parseUrlFileContent(content) — 从 .url 文件内容提取首个 http/https URL（纯函数，可 UT）
 *   2. openRemoteLink(sessionId, path) — readWorkspaceFile 读 .url 内容 → 提取 URL →
 *      openWebUrl 浏览器打开（Electron shell.openExternal / window.open fallback）；
 *      嗅探失败（无 URL）→ 返 { opened: false } 供 handleOpen 降级 editor。
 *   3. openWebUrl(url) — 内联 web 打开（与 link-target web 分支逐字等价）。
 *
 * 安全：只提取 http/https；危险协议（javascript:/data: 等）不提取。
 *
 * [v0.0.280] 本文件 **不 import link-target**（openRemoteLink 原调 openLinkTarget(url) web 分支，
 *   改为内联 openWebUrl）——断开 open-local-path → remote-link → link-target → open-local-path 循环依赖
 *   （vitest mock 下环导致 open-local-path 命名绑定 undefined；openLinkTarget web 分支语义即 openWebUrl）。
 */
import { readWorkspaceFile } from './chat-api';

/** http/https URL 提取正则（首个命中；URL 内不含空白） */
const URL_RE = /(https?:\/\/[^\s]+)/i;

/**
 * 从 .url 文件内容提取首个 http/https URL。
 * @param content .url 文件文本内容（通常形如 `[InternetShortcut]\nURL=https://...`）
 * @returns URL 字符串；无 http/https 命中 → null（调用方降级 editor）
 */
export function parseUrlFileContent(content: string): string | null {
  const m = URL_RE.exec(content);
  return m ? m[1]! : null;
}

/**
 * 内联 web 打开（与 link-target web 分支逐字等价：Electron → shell.openExternal；非 Electron → window.open）。
 * openRemoteLink / openLocalPath absolute .url 嗅探命中后调用。parseUrlFileContent 只提取 http/https，
 * 调用方（link-target）已做危险协议拦截 → 本函数无需再拦。
 */
export function openWebUrl(url: string): void {
  if (typeof window !== 'undefined' && window.rockyShell) {
    void window.rockyShell.openExternal(url);
  } else if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener');
  }
}

/**
 * 打开远程链接（.url 快捷方式 → 系统浏览器）。
 * 流程：readWorkspaceFile 读内容 → parseUrlFileContent 提取 URL → 命中 → openWebUrl（opened:true）；
 *   无命中 → 不静默，返 { opened: false } 供 caller 降级 editor。
 * @param sessionId 会话 id
 * @param path .url 文件相对 workspaceDir 的路径
 */
export async function openRemoteLink(
  sessionId: string,
  path: string,
): Promise<{ opened: boolean }> {
  const { content } = await readWorkspaceFile(sessionId, { path });
  const url = parseUrlFileContent(content);
  if (!url) return { opened: false };
  openWebUrl(url);
  return { opened: true };
}

export default openRemoteLink;
