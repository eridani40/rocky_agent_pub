/**
 * session-workspace-file handler —— workspace 文本文件读/存（v0.0.227）
 * 参考: specs/api/overall/04-agent-session.md §2.6.7
 *       specs/prd/version_logs/v0.0.227.md
 *       specs/tech/version_logs/v0.0.227/change_plan.md（ws-handler 行）
 *
 * 两个端点：
 *   - GET  /session/:id/workspace/file       读 UTF-8 文本（供内置 md editor 查看）
 *   - POST /session/:id/workspace/file/save  覆盖写（last-write-wins，不新建文件）
 *
 * 安全：复用 session-workspace.ts export 的 json() + whitelistResolve()（字符串前缀
 *   + realpath 双层校验，防 ../ + symlink 穿越外部，spec §2.6.7 MANDATORY）。
 * 打包护栏 BUG-004：realRoot 经 realpathSync(session.workspaceDir)（workspaceDir 已由
 *   server 启动时 resolveDataDir 展开为绝对路径）；禁字面 ~ / 禁裸 path.resolve 拼接。
 *
 * 拆独立文件对齐 session-workspace-save-image.ts 先例（session-workspace.ts 已 298 行）。
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { SessionHandlerDeps } from './session';
import { json, whitelistResolve } from './session-workspace';

/**
 * 解析 rel 并做白名单校验（read/save 共用安全前置）：
 *   realpath workspaceDir → whitelistResolve（traversal→400 / not_found→404）。
 * caller 传 getSession 取得的 workspaceDir + 相对路径 rel，得合法 absPath 或错误 Response。
 */
function resolveWsFilePath(
  workspaceDir: string | undefined,
  rel: string,
): { ok: true; absPath: string } | { ok: false; response: Response } {
  if (!workspaceDir) {
    return { ok: false, response: json(500, { error: 'session has no workspaceDir' }) };
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceDir);
  } catch {
    return { ok: false, response: json(500, { error: 'workspaceDir not readable' }) };
  }
  const wl = whitelistResolve(realRoot, rel);
  if (!wl.ok) {
    // traversal→400（明确越界）；not_found→404（realpath 失败=文件不存在）
    if (wl.reason === 'not_found') return { ok: false, response: json(404, { error: 'path not found' }) };
    return { ok: false, response: json(400, { error: 'path out of workspace (traversal denied)' }) };
  }
  return { ok: true, absPath: wl.realAbs };
}

/**
 * GET /session/:id/workspace/file —— 读 workspace 内文本文件（UTF-8）。
 * 流程：method 校验 → getSession → query path 校验 → realRoot → whitelistResolve → readFileSync。
 * 错误：405 非 GET / 404 session+文件不存在 / 400 path 缺失或越界 / 500 workspace+realpath+读失败。
 */
export async function handleWorkspaceFileRead(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'GET') {
    return json(405, { error: 'Method Not Allowed' }, 'GET');
  }
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  // query path（相对 workspaceDir，同 §2.6.1 tree node.path / §2.6.2 OpenBody.path）
  const url = new URL(req.url);
  const pathParam = url.searchParams.get('path');
  if (typeof pathParam !== 'string' || pathParam === '') {
    return json(400, { error: 'path required' });
  }

  // 路径白名单 + realpath（spec §2.6.7 安全 MANDATORY；traversal→400 / not_found→404）
  const resolved = resolveWsFilePath(got.workspaceDir, pathParam);
  if (!resolved.ok) return resolved.response;

  // 读 UTF-8 文本（.md 文本文件；race 极端删→catch 500）
  try {
    const content = readFileSync(resolved.absPath, 'utf8');
    return json(200, { content });
  } catch {
    return json(500, { error: 'read failed' });
  }
}

/**
 * POST /session/:id/workspace/file/save —— 覆盖写 workspace 文本文件（last-write-wins）。
 * 流程：method 校验 → getSession → body {path,content} 校验 → realRoot → whitelistResolve → writeFileSync 覆盖。
 * PRD §6.3 last-write-wins：无 mtime 校验、无冲突提示，直接覆盖既有文件（不新建）。
 * 错误：405 非 POST / 404 session+文件不存在 / 400 body 非法或越界 / 500 workspace+realpath+写失败。
 */
export async function handleWorkspaceFileSave(
  req: Request,
  method: string,
  id: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'POST') {
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }
  const got = await deps.store.getSession(id);
  if (!got) return json(404, { error: 'session not found' });

  // body 解析 { path, content }：非 string / 缺失 → 400（spec §2.6.7）
  let bodyPath: string | undefined;
  let bodyContent: string | undefined;
  try {
    const parsed = (await req.json()) as { path?: unknown; content?: unknown };
    if (typeof parsed.path === 'string') bodyPath = parsed.path;
    if (typeof parsed.content === 'string') bodyContent = parsed.content;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  // path 必填非空字符串；content 必须 string（空串合法 = 用户清空文件）
  if (typeof bodyPath !== 'string' || bodyPath === '') {
    return json(400, { error: 'path must be non-empty string' });
  }
  if (typeof bodyContent !== 'string') {
    return json(400, { error: 'content must be string' });
  }

  // 路径白名单 + realpath（spec §2.6.7 安全 MANDATORY；traversal→400 / not_found→404）
  const resolved = resolveWsFilePath(got.workspaceDir, bodyPath);
  if (!resolved.ok) return resolved.response;

  // writeFileSync 直接覆盖（last-write-wins，PRD §6.3；无 mtime 校验/无冲突提示）
  try {
    writeFileSync(resolved.absPath, bodyContent, 'utf8');
    return json(200, { ok: true });
  } catch {
    return json(500, { error: 'save failed' });
  }
}
