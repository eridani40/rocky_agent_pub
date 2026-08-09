/**
 * workspace-api —— session 工作区文件树 / 打开 / 选目录 / watch HTTP 客户端（从 chat-api.ts 拆出）
 * 参考: specs/api/version_logs/v0.0.17/change_log.md（workspace 端点组）
 *       specs/api/overall/04-agent-session.md §2.6（workspace 契约）
 *       specs/api/version_logs/v0.0.139/change_log.md（lazy watch acquire/release）
 *
 * 依赖 session-api.ts export 的 req helper。
 * v0.0.156 拆分重构：从原单文件 chat-api.ts move，**URL/method/body 100% 等价**（INV-B-3/G1）。
 */
import type { WorkspaceTreeResponse } from '../../components/chat-page/workspace-types';
import { req } from './session-api';

/**
 * [v0.0.17] GET /session/:id/workspace/tree —— 工作区文件树（lazy，§2.6.1）。
 * - 无 parent → 返顶层（workspaceDir 根级）；指定 parent → 返 parent 下的直接子项（depth=1）
 * - 响应含 workspaceDir（前端据此刷新 path-bar）+ tree[]（WsTreeNode，hasChildren 字段控制 twisty）
 */
export async function getWorkspaceTree(
  sessionId: string,
  opts?: { parent?: string; depth?: number },
  base?: string,
): Promise<WorkspaceTreeResponse> {
  const params = new URLSearchParams();
  if (opts?.parent !== undefined && opts.parent !== '') params.set('parent', opts.parent);
  if (opts?.depth !== undefined) params.set('depth', String(opts.depth));
  const q = params.toString();
  return req<WorkspaceTreeResponse>(
    `/session/${encodeURIComponent(sessionId)}/workspace/tree${q ? `?${q}` : ''}`,
    undefined,
    base,
  );
}

/**
 * [v0.0.17] POST /session/:id/workspace/open —— 打开文件/文件夹（系统默认应用，§2.6.2）。
 * path = 相对 workspaceDir 的路径；kind = file / folder；后端 spawn 平台对应命令。
 */
export async function openWorkspaceItem(
  sessionId: string,
  body: { path: string; kind: 'file' | 'folder' },
  base?: string,
): Promise<{ ok: true }> {
  return req<{ ok: true }>(
    `/session/${encodeURIComponent(sessionId)}/workspace/open`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
}

/**
 * [v0.0.17] POST /session/:id/workspace/pick-directory —— 系统 dialog 选目录（§2.6.3）。
 * 后端 spawn OS 原生 dialog（mac osascript / win FolderBrowserDialog / linux zenity/kdialog）。
 * 返 { path: string }（用户选/建）或 { path: null }（用户取消）。
 */
export async function pickWorkspaceDirectory(
  sessionId: string,
  opts?: { currentDir?: string },
  base?: string,
): Promise<{ path: string | null }> {
  return req<{ path: string | null }>(
    `/session/${encodeURIComponent(sessionId)}/workspace/pick-directory`,
    { method: 'POST', body: JSON.stringify(opts ?? {}) },
    base,
  );
}

/**
 * [v0.0.139] POST /session/:id/workspace/watch —— 懒监听 acquire（§2.6.5）。
 * 为 tab（clientId）登记对 path（相对 workspaceDir 的目录，一层非递归）的监听；
 * path="" 或 "." = workspace 根一层。幂等：同 (clientId,path) 重复调用后端不叠加。
 */
export async function watchWorkspaceDir(
  sessionId: string,
  body: { clientId: string; path: string },
  base?: string,
): Promise<{ ok: true }> {
  return req<{ ok: true }>(
    `/session/${encodeURIComponent(sessionId)}/workspace/watch`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
}

/**
 * [v0.0.139] POST /session/:id/workspace/unwatch —— 懒监听 release（§2.6.5）。
 * path 省略 = 回收该 tab 名下全部监听（release-all，卸载/切 session 用）；
 * 该 tab 未持有 path 时后端静默 no-op。caller best-effort 处理失败（对齐 openWorkspaceItem 风格）。
 */
export async function unwatchWorkspaceDir(
  sessionId: string,
  body: { clientId: string; path?: string },
  base?: string,
): Promise<{ ok: true }> {
  return req<{ ok: true }>(
    `/session/${encodeURIComponent(sessionId)}/workspace/unwatch`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
}

/**
 * [v0.0.271] POST /session/:id/workspace/watch-set —— 声明式 watch 集合替换（§2.6.5）。
 * 为该 tab（clientId）全量声明关注目录集合（paths = 相对 workspaceDir 的目录列表，含 '' 根）；
 * 后端与上次集合 diff：新增的建 watcher、不在新集合的一律 close（防泄漏对账）。
 * 新前端只用 watch-set（不用 watch/unwatch 增量，同 tab 混用会不一致）。
 */
export async function watchWorkspaceSet(
  sessionId: string,
  body: { clientId: string; paths: string[] },
  base?: string,
): Promise<{ ok: true }> {
  return req<{ ok: true }>(
    `/session/${encodeURIComponent(sessionId)}/workspace/watch-set`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
}

/**
 * [v0.0.177] POST /session/:id/workspace/save-image —— 粘贴图片落盘 ws/images（§2.6.6）。
 * client 只传 mediaType + base64，server 单一权威生成 filename（image-<ulid>.<ext>）。
 * 返 { path: 'images/<filename>' }（相对 workspaceDir 的 POSIX 路径）。
 * 失败 throw（带 status，与既有 ws API 一致）。
 */
export async function saveImage(
  sessionId: string,
  body: { mediaType: string; base64: string },
  base?: string,
): Promise<{ path: string }> {
  return req<{ path: string }>(
    `/session/${encodeURIComponent(sessionId)}/workspace/save-image`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
}

/**
 * [v0.0.227] GET /session/:id/workspace/file —— 读工作区内文本文件内容（§2.6.7）。
 * path = 相对 workspaceDir 的路径；后端做路径穿越校验（whitelistResolve）单一权威。
 * 返 { content: string }（UTF-8 文本；用于 md editor 首次加载）。
 * 失败 throw（路径越界 400 / 不存在 404，与既有 ws API 一致）。
 */
export async function readWorkspaceFile(
  sessionId: string,
  body: { path: string },
  base?: string,
): Promise<{ content: string }> {
  const q = new URLSearchParams({ path: body.path }).toString();
  return req<{ content: string }>(
    `/session/${encodeURIComponent(sessionId)}/workspace/file?${q}`,
    undefined,
    base,
  );
}

/**
 * [v0.0.269] GET /session/:id/workspace/file?binary=1 —— 读工作区内文件二进制内容（§2.6.7）。
 * path 语义与 readWorkspaceFile 相同（同 whitelistResolve 安全面）。
 * 返 { content: string }（base64 编码；image viewer 拼 `data:image/{ext};base64,`）。
 * 失败 throw（路径越界 400 / 不存在 404 / 读失败 500，与既有 ws API 一致）。
 */
export async function readWorkspaceFileBinary(
  sessionId: string,
  body: { path: string },
  base?: string,
): Promise<{ content: string }> {
  const q = new URLSearchParams({ path: body.path, binary: '1' }).toString();
  return req<{ content: string }>(
    `/session/${encodeURIComponent(sessionId)}/workspace/file?${q}`,
    undefined,
    base,
  );
}

/**
 * [v0.0.227] POST /session/:id/workspace/file/save —— 存工作区内文本文件（§2.6.7）。
 * last-write-wins：直接覆盖，无 mtime 冲突检测（PRD §6.3）。
 * 返 { ok: true }；失败 throw（路径越界 400 / IO 失败 500）。
 */
export async function saveWorkspaceFile(
  sessionId: string,
  body: { path: string; content: string },
  base?: string,
): Promise<{ ok: true }> {
  return req<{ ok: true }>(
    `/session/${encodeURIComponent(sessionId)}/workspace/file/save`,
    { method: 'POST', body: JSON.stringify(body) },
    base,
  );
}
