/**
 * session-workspace-search handler —— workspace 递归全量搜索（v0.0.320）
 * 参考: specs/api/version_logs/v0.0.320/change_log.md §1.3
 *       specs/tech/version_logs/v0.0.320/change_plan.md D10
 *       specs/api/overall/04-agent-session.md §2.6（workspace 端点安全面）
 *
 * 端点：
 *   - GET /session/:id/workspace/search?q= 递归全量搜索文件名/文件夹名（大小写不敏感 substring）
 *
 * 安全：复用 session-workspace.ts export 的 json() + session-workspace-path.ts 的 whitelistResolve()
 *   （根校验与 tree 一致；symlink 目录不跟随出 workspace——防越权/循环，API change_log §1.3 约束）。
 * IGNORED_NAMES（node_modules/.git）复用 session-workspace.ts 导出（不重复定义）。
 *
 * 拆独立文件对齐 session-workspace-file.ts / session-workspace-save-image.ts 先例
 *   （session-workspace.ts 已 298 行近 300 上限）。
 */
import { realpathSync } from 'node:fs';
import type { SessionHandlerDeps } from './session';
import { json } from './session-workspace';
import { whitelistResolve } from './session-workspace-path';
import { searchWorkspace } from '../search/workspace-search-core';

/**
 * GET /session/:id/workspace/search —— 递归全量搜索 workspace 文件名/文件夹名。
 * 流程：method 校验 → getSession → query q 校验 → workspaceDir → realRoot → whitelistResolve 根校验 →
 *   递归遍历（ignore node_modules/.git；symlink 目录不跟随出 workspace）→ files/dirs（相对路径）。
 * 错误：405 非 GET / 404 session / 400 q 缺失或空串 / 500 workspaceDir 不可读。
 */
export async function handleWorkspaceSearch(
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

  // query q（必填非空；trim 后空串 → 400）
  const url = new URL(req.url);
  const qParam = url.searchParams.get('q');
  const q = (qParam ?? '').trim();
  if (q === '') {
    return json(400, { error: 'q required' });
  }

  const workspaceDir = got.workspaceDir;
  if (!workspaceDir) {
    return json(500, { error: 'session has no workspaceDir' });
  }

  // realpath workspaceDir + 白名单根校验（复用 tree 安全面；API change_log §1.3 约束）
  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceDir);
  } catch {
    return json(500, { error: 'workspaceDir not readable' });
  }
  const wl = whitelistResolve(realRoot, '');
  if (!wl.ok) {
    return json(500, { error: 'workspaceDir not readable' });
  }

  const result = searchWorkspace(realRoot, q, { relRoot: '' });

  const body: { files: string[]; dirs: string[]; truncated?: boolean } = {
    files: result.files,
    dirs: result.dirs,
  };
  if (result.truncated) body.truncated = true;
  return json(200, body);
}
