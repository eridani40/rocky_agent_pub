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
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionHandlerDeps } from './session';
import { json, IGNORED_NAMES } from './session-workspace';
import { whitelistResolve } from './session-workspace-path';

/** 搜索上限（files+dirs 合计；v0.0.324 从 200 降至 100） */
const SEARCH_LIMIT = 100;

/**
 * 递归搜索目录（当前目录绝对路径 + 相对 workspaceDir 的 POSIX 路径前缀）。
 * pathMode=true（q 含 `/`）→ 匹配完整相对路径 relChild（子串、大小写不敏感）；
 * pathMode=false（q 不含 `/`）→ 匹配 basename name（现状不变）。
 */
function walkSearch(
  absDir: string,
  relDir: string,
  qLower: string,
  pathMode: boolean,
  files: string[],
  dirs: string[],
): boolean {
  // 返回 true = 已达上限需停止；false = 可继续
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return false; // 目录不可读（权限/竞态删）→ 跳过该分支
  }
  for (const name of entries) {
    if (IGNORED_NAMES.has(name)) continue; // node_modules/.git 不遍历不返回（与 tree/watch 一致）
    const absChild = join(absDir, name);
    const relChild = relDir ? `${relDir}/${name}` : name;

    let isSymlink = false;
    try {
      isSymlink = lstatSync(absChild).isSymbolicLink();
    } catch {
      continue; // lstat 失败（权限/竞态删）跳过
    }
    let isDir = false;
    try {
      isDir = statSync(absChild).isDirectory();
    } catch {
      continue; // stat 失败（broken symlink 目标不存在/权限）跳过
    }

    // 匹配目标：pathMode 匹配完整相对路径，否则匹配 basename
    const matchTarget = pathMode ? relChild.toLowerCase() : name.toLowerCase();

    // 目录命中 → dirs 推入 + **不递归其下层**（API change_log §1.3：前端拿到 dir 后展示该目录
    //   展开内容，后端只返 dir 路径本身；PRD §2.5「其下层内容前端一并展示」）
    if (isDir) {
      if (matchTarget.includes(qLower)) {
        dirs.push(relChild);
        if (files.length + dirs.length >= SEARCH_LIMIT) return true;
        continue;
      }
      // 目录未命中 → 递归其下层（普通目录）；symlink→dir 一律不递归——目标可能出 workspace 或
      //   指向祖先（循环），保守跳过（防越权/循环，acceptanceCriteria 8；比 API 文档约束更严）
      if (!isSymlink) {
        if (walkSearch(absChild, relChild, qLower, pathMode, files, dirs)) return true;
      }
      continue;
    }

    // 文件命中 → files 推入（symlink→file 可列入，API change_log §1.3）
    if (matchTarget.includes(qLower)) {
      files.push(relChild);
      if (files.length + dirs.length >= SEARCH_LIMIT) return true;
    }
  }
  return false;
}

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
  const qLower = q.toLowerCase();
  // q 含 `/` → 匹配完整相对路径（pathMode）；不含 `/` → 匹配 basename（现状不变）
  const pathMode = q.includes('/');

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

  const files: string[] = [];
  const dirs: string[] = [];
  const truncated = walkSearch(realRoot, '', qLower, pathMode, files, dirs);

  const body: { files: string[]; dirs: string[]; truncated?: boolean } = { files, dirs };
  if (truncated) body.truncated = true;
  return json(200, body);
}
