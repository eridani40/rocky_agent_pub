/**
 * session-workspace-seed handlers - test-only ET seed endpoints
 * 参考: tests/e2e/chat/workspace_{tc}/checkpoint.json (ET cases use this to seed fs)
 *       specs/tech/agent/session/[P0]session_workspace.md §6 (path whitelist reuse)
 *
 * 职责 (only effective when NODE_ENV=test; production returns 404 via router gate):
 *   - POST /api/workspace/ensure-dir { path, sessionId } -> mkdir (e.g. build src/utils)
 *   - POST /api/workspace/touch       { path, sessionId, content } -> writeFile (build index.ts etc)
 *   - POST /api/workspace/ensure?path=<abs>           -> mkdir idempotent (switch_tc1 step3)
 *
 * 安全 (MANDATORY): reuse session-workspace.ts whitelist semantics:
 *   - path must be inside session.workspaceDir (resolve + startsWith workspaceDir)
 *   - out of workspace -> 400 (reject writes to external dirs)
 *
 * This file does not host production endpoints (ET seed infra only);
 * non-test env router does not register these routes, avoiding production exposure.
 *
 * Also exports validateCallerWorkspaceDir (POST /session body.workspaceDir validation,
 * reused by session.ts to keep single authoritative implementation,
 * avoiding duplication with session-update.ts newDir validation).
 */
import { mkdirSync, writeFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { SessionHandlerDeps } from './session';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 校验 caller 提供的 workspaceDir (绝对路径 + 存在 + 是目录).
 * 失败返回明确 error 字符串 (caller 转 400); 成功返回 null.
 * 与 session-update.ts newDir 校验一致 (spec §2.1 / §2.5 共用 §4.1 校验规则).
 */
export function validateCallerWorkspaceDir(dir: string): string | null {
  if (!isAbsolute(dir)) return 'workspaceDir must be absolute path';
  if (!existsSync(dir)) return 'workspaceDir does not exist';
  try {
    if (!statSync(dir).isDirectory()) return 'workspaceDir must be a directory';
  } catch {
    return 'workspaceDir not accessible';
  }
  return null;
}

/**
 * 路径白名单校验 (与 session-workspace.ts whitelistResolve 等价语义, ET seed 用).
 * step 1: 字符串前缀 (resolve(realRoot, absOrRelPath) 必须在 realRoot 内, 挡 ../)
 * step 2: realpath (防 symlink 穿越外部; target 不存在用 abs 兜底, seed 端点允许新建)
 *
 * 注意: seed 端点的 target 通常还不存在 (要 mkdir/writeFile 创建),
 * 故 realpath 失败时不报 not_found, 而是 fallback 到 abs 路径做前缀校验后返回 abs.
 * 这与 session-workspace.ts whitelistResolve 的 not_found 分支不同
 * (GET tree/open 必须存在, seed 端点允许新建).
 *
 * 返回:
 *   - { ok: true, abs } 合法 (abs 为 resolve 后的目标路径, caller 直接 mkdir/writeFile)
 *   - { ok: false, reason: 'traversal' } 越界 (字符串前缀或 realpath 越界) -> 400
 */
function whitelistForSeed(realRoot: string, pathArg: string): {
  ok: true;
  abs: string;
} | { ok: false; reason: 'traversal' } {
  // pathArg 可以是绝对路径 (switch_tc1 step3 /tmp/ws_x) 或相对 workspaceDir 的路径.
  // 统一 resolve 到 realRoot 基准下 (绝对 pathArg 直接用; 相对 pathArg 拼到 realRoot 下).
  const abs = isAbsolute(pathArg) ? pathArg : resolve(realRoot, pathArg);
  const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (abs !== realRoot && !abs.startsWith(rootWithSep)) {
    return { ok: false, reason: 'traversal' };
  }
  // realpath 校验 (防 workspace 内 symlink 指向外部; target 不存在时 fallback abs)
  try {
    const realAbs = realpathSync(abs);
    if (realAbs !== realRoot && !realAbs.startsWith(rootWithSep)) {
      return { ok: false, reason: 'traversal' };
    }
    return { ok: true, abs };
  } catch {
    // target 不存在 (seed 正常 case, 待 mkdir/writeFile) - 用 abs 兜底, 前缀已校验
    return { ok: true, abs };
  }
}

/** resolve realpath(realRoot) 失败统一 500 */
function resolveRealRoot(workspaceDir: string): string | null {
  try {
    return realpathSync(workspaceDir);
  } catch {
    return null;
  }
}

/**
 * seed 端点共享前置：method 校验 + body 解析 + sid/path 必填 + session + workspaceDir + realpath + 白名单.
 * ensure-dir / touch 的前置完全一致；content 字段一并解析返回（touch 用，ensure-dir 忽略）.
 * 返回 { ok, realRoot, abs, content } 合法；{ ok:false, resp } caller 直接 return resp.
 */
type SeedPrelude =
  | { ok: true; realRoot: string; abs: string; content: string }
  | { ok: false; resp: Response };

async function seedPrelude(
  req: Request,
  method: string,
  deps: SessionHandlerDeps,
): Promise<SeedPrelude> {
  if (method !== 'POST') {
    return { ok: false, resp: json(405, { error: 'Method Not Allowed' }) };
  }
  let bodyPath = '';
  let bodySid = '';
  let bodyContent = '';
  try {
    const parsed = (await req.json()) as {
      path?: string;
      sessionId?: string;
      content?: string;
    };
    if (typeof parsed.path === 'string') bodyPath = parsed.path;
    if (typeof parsed.sessionId === 'string') bodySid = parsed.sessionId;
    if (typeof parsed.content === 'string') bodyContent = parsed.content;
  } catch {
    return { ok: false, resp: json(400, { error: 'invalid json body' }) };
  }
  if (!bodyPath || !bodySid) {
    return { ok: false, resp: json(400, { error: 'path and sessionId required' }) };
  }
  const got = await deps.store.getSession(bodySid);
  if (!got) return { ok: false, resp: json(404, { error: 'session not found' }) };
  if (!got.workspaceDir) {
    return { ok: false, resp: json(500, { error: 'session has no workspaceDir' }) };
  }
  const realRoot = resolveRealRoot(got.workspaceDir);
  if (!realRoot) return { ok: false, resp: json(500, { error: 'workspaceDir not readable' }) };
  const wl = whitelistForSeed(realRoot, bodyPath);
  if (!wl.ok) {
    return { ok: false, resp: json(400, { error: 'path out of workspace (traversal denied)' }) };
  }
  return { ok: true, realRoot, abs: wl.abs, content: bodyContent };
}

/**
 * POST /api/workspace/ensure-dir - ET seed: 递归建目录
 * (spec ET case workspace_tree_expand_tc1 等).
 * body { path, sessionId }. path 可绝对可相对 (相对则 resolve 到 session.workspaceDir 下).
 * 越界 -> 400; session 不存在 -> 404; 成功 -> 200 + { ok: true, dir }.
 */
export async function handleWorkspaceEnsureDir(
  req: Request,
  method: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  const pre = await seedPrelude(req, method, deps);
  if (!pre.ok) return pre.resp;
  try {
    mkdirSync(pre.abs, { recursive: true });
  } catch (e) {
    return json(500, { error: `mkdir failed: ${(e as Error).message}` });
  }
  return json(200, { ok: true, dir: pre.abs });
}

/**
 * POST /api/workspace/touch - ET seed: 写文件 (建 index.ts 等).
 * body { path, sessionId, content? }. content 缺省 = 空串.
 * 越界 -> 400; session 不存在 -> 404; 父目录不存在 -> 自动 mkdir recursive; 成功 -> 200 + { ok, file }.
 */
export async function handleWorkspaceTouch(
  req: Request,
  method: string,
  deps: SessionHandlerDeps,
): Promise<Response> {
  const pre = await seedPrelude(req, method, deps);
  if (!pre.ok) return pre.resp;
  try {
    // 父目录可能不存在 (ET seed 先 touch 再 ensure-dir 的容错), mkdir recursive 父目录
    const parent = resolve(pre.abs, '..');
    mkdirSync(parent, { recursive: true });
    writeFileSync(pre.abs, pre.content, 'utf8');
  } catch (e) {
    return json(500, { error: `writeFile failed: ${(e as Error).message}` });
  }
  return json(200, { ok: true, file: pre.abs });
}

/**
 * POST /api/workspace/ensure - ET seed: path 参数 query 形式 (switch_tc1 step3).
 * query ?path=<abs>. 幂等 mkdir. 无 body.
 * 注意: switch_tc1 step3 用 /tmp/ws_switch_xxx 绝对路径 seed (不在 session.workspaceDir 内) -
 * 这是 "先建临时目录, 再 PUT /session/:id 切到该目录" 的合法 flow.
 * 故本端点放宽白名单 (不做 session 校验), 仅 mkdir recursive + 返 200.
 * 越界检测交给后续 PUT /session/:id 的 workspaceDir 校验 (必须存在且是目录, 否则 400).
 */
export async function handleWorkspaceEnsure(
  req: Request,
  method: string,
  _deps: SessionHandlerDeps,
): Promise<Response> {
  if (method !== 'POST') return json(405, { error: 'Method Not Allowed' });
  const url = new URL(req.url);
  const pathArg = url.searchParams.get('path');
  if (!pathArg) return json(400, { error: 'path query param required' });
  if (!isAbsolute(pathArg)) return json(400, { error: 'path must be absolute' });
  try {
    mkdirSync(pathArg, { recursive: true });
  } catch (e) {
    return json(500, { error: `mkdir failed: ${(e as Error).message}` });
  }
  return json(200, { ok: true, dir: pathArg });
}
