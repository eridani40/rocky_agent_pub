/**
 * session-workspace handlers —— workspace 文件树 + 打开文件 + 选目录 dialog
 * 参考: specs/api/overall/04-agent-session.md §2.6 / specs/tech/agent/session/[P0]session_workspace.md §6
 *
 * 三个端点：GET tree（lazy） / POST open（spawn 系统应用） / POST pick-directory（原生 dialog）
 * 安全：路径白名单 resolve + 链式授权解析（防 ../ + 绝对路径注入；workspace 内 symlink = 用户
 *   放置 = 授权，见 session-workspace-path.ts，spec §6 MANDATORY）
 * [v0.0.263] whitelistResolve 迁出到 session-workspace-path.ts（本文件 ≤300 行硬限腾挪），
 *   tree 节点新增 isSymlink/linkTarget 可选字段（symlink 浏览）。
 * 不在本文件：PUT /session/:id（切目录 → session-update.ts）；watch/unwatch（v0.0.139，见
 *   session-workspace-watch.ts，拆文件避免本文件超 300 行）；switchDir 联动（manager）
 */
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { SessionHandlerDeps } from './session';
import { openWithSystemApp, type OpenKind } from '../platform/workspace-open';
import { pickDirectory } from '../platform/workspace-dialog';
import { whitelistResolve } from './session-workspace-path';

/** GET /session/:id/workspace/tree 响应（spec §2.6.1 WorkspaceTreeResponse） */
interface WorkspaceTreeResponse {
  workspaceDir: string;
  parent: string | null;
  tree: WsTreeNode[];
}

/** 文件树节点（spec §2.6.1 WsTreeNode） */
interface WsTreeNode {
  name: string;
  path: string; // 相对 workspaceDir
  type: 'file' | 'dir';
  hasChildren: boolean;
  /** [v0.0.263] true = 该节点是 symlink（真实类型仍由 type 表达，statSync 跟随判定） */
  isSymlink?: boolean;
  /** [v0.0.263] symlink 目标 realpath 绝对路径；仅 isSymlink=true 时有意义 */
  linkTarget?: string;
}

/** 与 chokidar WATCH_OPTIONS 一致的 ignore 名单（spec §2.6.1 + manager §4） */
const IGNORED_NAMES = new Set(['node_modules', '.git']);

/** 构造 JSON Response（可选 Allow 头）。export 供 session-workspace-watch.ts 复用。 */
export function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * GET /session/:id/workspace/tree —— 文件树 lazy 加载（spec §2.6.1）。
 * ?parent 缺省=顶层；?depth 固定 1（非 [1,10]→400）。dir 节点返 hasChildren（不递归）。
 * ignore node_modules/.git；白名单越界→400。错：404 session / 400 越界+depth / 500 不可读。
 */
export async function handleWorkspaceTree(
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

  const url = new URL(req.url);
  const parentParam = url.searchParams.get('parent') ?? undefined;
  const depthStr = url.searchParams.get('depth');
  // depth 校验（spec §2.6.1：[1,10]；缺省 1）
  let depth = 1;
  if (depthStr !== null) {
    const n = Number(depthStr);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      return json(400, { error: 'depth must be integer in [1,10]' });
    }
    depth = n;
  }
  void depth; // 固定一层（lazy），保留参数语义供未来 depth=N 扩展

  const workspaceDir = got.workspaceDir;
  if (!workspaceDir) {
    return json(500, { error: 'session has no workspaceDir' });
  }

  // realpath workspaceDir 一次（防 workspaceDir 自身含 symlink 段；后续 realpath 子项对齐）
  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceDir);
  } catch {
    return json(500, { error: 'workspaceDir not readable' });
  }

  // 路径白名单（spec §2.6.1 安全校验 MANDATORY；含 symlink 穿越防护）
  const wl = whitelistResolve(realRoot, parentParam);
  if (!wl.ok) {
    if (wl.reason === 'not_found') return json(500, { error: 'workspaceDir not readable' });
    return json(400, { error: 'parent out of workspace (path traversal denied)' });
  }
  const absParent = wl.realAbs;

  let entries: string[];
  try {
    entries = readdirSync(absParent);
  } catch {
    // workspaceDir 不存在或不可读（极端：用户外部删了目录）
    return json(500, { error: 'workspaceDir not readable' });
  }

  const nodes: WsTreeNode[] = [];
  for (const name of entries) {
    if (IGNORED_NAMES.has(name)) continue; // 与 chokidar WATCH_OPTIONS 一致
    const absChild = resolve(absParent, name);
    // [v0.0.263] symlink 识别：lstatSync 不跟随（statSync 跟随判真实类型，对称进行）
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
    // linkTarget：仅 symlink 节点 realpath 一次；broken symlink realpath 失败 → 跳过该节点（现状隐藏语义）
    let linkTarget: string | undefined;
    if (isSymlink) {
      try {
        linkTarget = realpathSync(absChild);
      } catch {
        continue;
      }
    }
    // 相对 workspaceDir 的 path（前端唯一 key + POST open 入参）；
    // [v0.0.263] 基于 parentParam 拼接（保留 symlink 段——absChild 可能已解析到授权目标外部，
    //   relPath 无法反推相对路径）；普通路径与旧 relPath(realRoot, absChild) 等价
    const relChild = parentParam ? `${parentParam}/${name}` : name;
    nodes.push({
      name,
      path: relChild,
      type: isDir ? 'dir' : 'file',
      hasChildren: isDir ? dirHasChildren(absChild) : false,
      ...(isSymlink ? { isSymlink: true, linkTarget } : {}),
    });
  }

  // parent 字段：顶层=null；子目录=相对 workspaceDir 的路径（spec §2.6.1）
  const parentField = parentParam ?? null;

  const body: WorkspaceTreeResponse = {
    workspaceDir,
    parent: parentField,
    tree: nodes,
  };
  return json(200, body);
}

/** 目录是否有子项（不递归，仅 boolean；spec §2.6.1 hasChildren） */
function dirHasChildren(absDir: string): boolean {
  try {
    const items = readdirSync(absDir);
    // 排除 ignored 后是否还有任何项
    for (const name of items) {
      if (!IGNORED_NAMES.has(name)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * POST /session/:id/workspace/open —— spawn 系统应用打开文件/文件夹（spec §2.6.2）。
 * body { path, kind }；kind 非 file/folder→400；白名单越界→400；不存在→404；spawn 失败→500。
 */
export async function handleWorkspaceOpen(
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

  // body 解析
  let bodyPath = '';
  let bodyKind = '';
  try {
    const parsed = (await req.json()) as { path?: string; kind?: string };
    if (typeof parsed.path === 'string') bodyPath = parsed.path;
    if (typeof parsed.kind === 'string') bodyKind = parsed.kind;
  } catch {
    return json(400, { error: 'invalid json body' });
  }

  // kind 校验（spec §2.6.2）
  if (bodyKind !== 'file' && bodyKind !== 'folder') {
    return json(400, { error: 'kind must be "file" or "folder"' });
  }

  const workspaceDir = got.workspaceDir;
  if (!workspaceDir) {
    return json(500, { error: 'session has no workspaceDir' });
  }

  // realpath workspaceDir 一次（防 workspaceDir 自身含 symlink 段；后续 realpath 子项对齐）
  let realRoot: string;
  try {
    realRoot = realpathSync(workspaceDir);
  } catch {
    return json(500, { error: 'workspaceDir not readable' });
  }

  // 路径白名单（spec §2.6.2 安全校验 MANDATORY；含 symlink 穿越防护）
  const wl = whitelistResolve(realRoot, bodyPath);
  if (!wl.ok) {
    if (wl.reason === 'not_found') return json(404, { error: 'path not found' });
    return json(400, { error: 'path out of workspace (traversal denied)' });
  }
  const absPath = wl.realAbs; // 已 realpath → 存在性已隐含保证

  // spawn 系统应用（deps 注入 mock 或 fallback 默认 openWithSystemApp）
  const opener = deps.openWorkspaceItem ?? openWithSystemApp;
  const result = opener(bodyKind as OpenKind, absPath);
  if (!result.ok) {
    return json(500, { error: result.error || 'open failed' });
  }
  return json(200, { ok: true });
}

/**
 * POST /session/:id/workspace/pick-directory —— spawn 原生 dialog 选目录。
 *
 * 行为（spec §2.6.3）：
 *   - body { currentDir? } 可选（dialog 默认位置）
 *   - spawn 系统原生 dialog（委托 platform/workspace-dialog.ts）
 *   - 用户选定 → { path: 绝对路径 }；用户取消 → { path: null }（200，非错误）
 *   - spawn 失败（如 Linux 缺 zenity/kdialog）→ 500
 *
 * 错误：404 session；500 dialog spawn 失败。
 */
export async function handleWorkspacePickDirectory(
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

  // body 可选：{ currentDir?: string }
  let currentDir: string | undefined;
  try {
    if (req.body !== null && req.body !== undefined) {
      const parsed = (await req.json()) as { currentDir?: string };
      if (typeof parsed.currentDir === 'string') currentDir = parsed.currentDir;
    }
  } catch {
    // 空 body / 非法 JSON → 视作无 currentDir
  }

  // 安全校验：currentDir 必须绝对路径（防相对路径引发 dialog 不可预期行为）
  if (currentDir && !isAbsolute(currentDir)) {
    return json(400, { error: 'currentDir must be absolute path' });
  }

  // dialog（deps 注入 mock 或 fallback 默认 pickDirectory）
  const picker = deps.pickWorkspaceDirectory ?? pickDirectory;
  const result = picker(currentDir);
  if (result.error) {
    return json(500, { error: result.error });
  }
  // 用户选定 → { path }；取消 → { path: null }（200，spec §2.6.3 取消语义非错误）
  return json(200, { path: result.path });
}
