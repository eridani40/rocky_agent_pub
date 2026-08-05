/**
 * skill 管理 HTTP handlers
 * 参考: specs/api/overall/06-skill.md §2-§7
 *       specs/tech/agent/skills/[P0]skill_architecture.md §5 §6
 *
 * 6 个端点：
 *   - POST   /skill/install（multipart files → 解压/校验/落盘）→ 202 + SkillEntry
 *   - GET    /skill（列表，query ?workspace=，合并去重）→ items[]
 *   - PATCH  /skill/:name（toggle enabled）→ 200 + SkillEntry
 *   - DELETE /skill/:name（物理删，mv 到 soft_deleted）→ 200 + {ok}
 *   - GET    /skill/:name/tree（文件树，path 相对 skillDir）→ tree[]
 *   - GET    /skill/:name/file?path=（路径越界检测 + 截断 + 二进制标记）→ 文本
 *
 * session 调试端点 GET /session/:id/debug/system-prompt 在 ./session-debug.ts
 * （本文件职责为 /skill/* 组，session debug 属 /session/* 组）。
 *
 * handler 编排 resolver/installer/enabled-store，不持有业务状态。
 */
import { mkdirSync, renameSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { AppConfigService } from '../config/app-config-service';
import type { SessionStore } from '../agent/session-store';
import { SkillResolver, workspaceSkillRoot, builtinSkillRoot, appSkillRoot } from '../skills/resolver';
import { SkillEnabledStore } from '../skills/enabled-store';
import { installSkill, InstallError, scopeRoot } from '../skills/installer';
import { buildFileTree } from '../skills/tree';
import { readSkillFile } from '../skills/file-io';
import { handleSkillGovernance } from '../skills/governance';
import { handleSkillList } from './skill-list';
import type { SkillScope } from '../skills/types';

/** soft_deleted 目录名（项目 memory：rm 需审批中断自动化，改 mv） */
const SOFT_DELETED = 'soft_deleted';

/** 构造 JSON Response */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 解析 query 中的 scope（缺省 app）+ workspace，校验 workspace 存在 */
function parseScope(
  url: URL,
  defaultScope: SkillScope = 'app',
): { scope: SkillScope; workspace?: string } {
  const scopeParam = url.searchParams.get('scope');
  const scope: SkillScope = scopeParam === 'workspace' || scopeParam === 'app' ? scopeParam : defaultScope;
  const workspace = url.searchParams.get('workspace') ?? undefined;
  if (scope === 'workspace' && workspace) {
    if (!isAbsolute(workspace) || !isDir(workspace)) {
      throw new HttpError(404, 'workspace not found');
    }
  }
  return { scope, workspace };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 简单 HTTP 错误（status + message） */
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 接口入口：分发 skill 路径（不含 /session/:id/debug/system-prompt，见 sessionDebugHandler） */
export async function handleSkillRoute(
  req: Request,
  method: string,
  pathname: string,
  url: URL,
  appConfig: AppConfigService,
  dataDir: string,
  sessionStore: SessionStore,
): Promise<Response> {
  try {
    // POST /skill/install
    if (pathname === '/skill/install' && method === 'POST') {
      return await handleInstall(req, url, dataDir);
    }
    // GET /skill
    if (pathname === '/skill' && method === 'GET') {
      return await handleSkillList(url, appConfig, dataDir, sessionStore);
    }
    // /skill/:name/* 子路径（含 governance）
    const itemMatch = pathname.match(/^\/skill\/([^/]+)(\/(tree|file|governance))?$/);
    if (itemMatch) {
      const name = decodeURIComponent(itemMatch[1]!);
      const sub = itemMatch[3];
      if (!sub) {
        if (method === 'PATCH') return handlePatch(req, url, name, appConfig, dataDir);
        if (method === 'DELETE') return handleDelete(url, name, dataDir);
        return json(405, { error: 'Method Not Allowed' });
      }
      // PATCH /skill/:name/governance — UI 改 evolvable
      if (sub === 'governance' && method === 'PATCH') {
        return await handleSkillGovernance(req, name, appConfig, dataDir);
      }
      if (sub === 'tree' && method === 'GET') return handleTree(url, name, dataDir);
      if (sub === 'file' && method === 'GET') return handleFile(url, name, dataDir);
      return json(405, { error: 'Method Not Allowed' });
    }
    return json(404, { error: 'Not Found' });
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    if (e instanceof InstallError) return json(installStatus(e.code), { error: e.message });
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: msg });
  }
}

function installStatus(code: InstallError['code']): number {
  switch (code) {
    case 'bad_request':
      return 400;
    case 'conflict':
      return 409;
    case 'workspace_not_found':
      return 404;
    case 'too_large':
      return 413;
  }
}

/** POST /skill/install */
async function handleInstall(
  req: Request,
  url: URL,
  dataDir: string,
): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: 'invalid multipart form' });
  }
  const { scope, workspace } = parseScope(url, 'app');
  const result = await installSkill(form, dataDir, { scope, workspaceDir: workspace });
  // 安装成功不写 enabled record（fallback true）。返回 entry（enabled=true）
  return json(202, { skill: result.entry });
}

/** PATCH /skill/:name（toggle enabled） */
async function handlePatch(
  req: Request,
  url: URL,
  name: string,
  appConfig: AppConfigService,
  dataDir: string,
): Promise<Response> {
  let body: { enabled?: unknown; scope?: string; workspace?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (typeof body.enabled !== 'boolean') {
    return json(400, { error: 'body requires enabled: boolean' });
  }
  // 定位层：body.scope > query.scope > 合并层命中（含 builtin 层）
  const workspace = body.workspace ?? url.searchParams.get('workspace') ?? undefined;
  let scope: SkillScope;
  if (body.scope === 'app' || body.scope === 'workspace' || body.scope === 'builtin') scope = body.scope;
  else {
    const qscope = url.searchParams.get('scope');
    scope = (qscope === 'workspace' || qscope === 'app' || qscope === 'builtin')
      ? qscope
      : lookupScope(dataDir, workspace, name);
  }
  // 验证 name 在指定层存在
  const dir = join(scopeRoot(dataDir, { scope, workspaceDir: workspace }), name);
  if (!isDir(dir)) return json(404, { error: 'Not Found' });

  const enabledStore = new SkillEnabledStore(appConfig);
  enabledStore.setEnabled(name, body.enabled);
  // 重新 resolve 取最新 entry（含 enabled；传 builtinSkillRoot() 覆盖 builtin skill）
  const catalog = SkillResolver.resolve(dataDir, workspace, enabledStore, builtinSkillRoot());
  const entry = catalog.entries.find((e) => e.name === name && e.scope === scope);
  if (!entry) return json(404, { error: 'Not Found' });
  return json(200, { skill: entry });
}

/**
 * 查 name 在合并层命中（workspace → app → builtin）。
 * workspace/app 未命中再查 builtin 层（随 app 发版的内置 skill）。
 */
function lookupScope(dataDir: string, workspace: string | undefined, name: string): SkillScope {
  if (workspace && isDir(join(workspaceSkillRoot(workspace), name))) return 'workspace';
  if (isDir(join(appSkillRoot(dataDir), name))) return 'app';
  if (isDir(join(builtinSkillRoot(), name))) return 'builtin';
  return 'app'; // 默认返 app（caller isDir 校验兜底 404）
}

/** DELETE /skill/:name（物理删：mv 到 soft_deleted） */
function handleDelete(url: URL, name: string, dataDir: string): Response {
  const { scope, workspace } = parseScope(url, lookupScope(dataDir, url.searchParams.get('workspace') ?? undefined, name));
  // builtin skill 随 app 发版只读，禁止删除（防 mv 走内置目录）
  if (scope === 'builtin') return json(403, { error: 'builtin skill is read-only (shipped with app), cannot delete' });
  const dir = join(scopeRoot(dataDir, { scope, workspaceDir: workspace }), name);
  if (!isDir(dir)) return json(404, { error: 'Not Found' });

  // mv 到 <dataDir>/soft_deleted/skills/<scope>/<name>-<ts>（避免同名冲突 + 不触发 rm 审批）
  const trashBase = join(dataDir, SOFT_DELETED, 'skills', scope);
  try {
    mkdirSync(trashBase, { recursive: true });
    const dest = join(trashBase, `${name}-${Date.now()}`);
    renameSync(dir, dest);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(500, { error: `failed to delete skill: ${msg}` });
  }
  return json(200, { ok: true });
}

/** GET /skill/:name/tree */
function handleTree(url: URL, name: string, dataDir: string): Response {
  const skillDir = locateSkillDir(url, name, dataDir);
  if (!skillDir) return json(404, { error: 'Not Found' });
  const tree = buildFileTree(skillDir);
  return json(200, { tree });
}

/**
 * GET /skill/:name/file?path=
 * 读原语（越界守卫 + 二进制识别 + 截断）在 skills/file-io.ts，与 academy 版本 skill
 * 文件端点共用（18-academy §1.11）；本函数只做 skill 目录定位 + error→HTTP 映射。
 */
function handleFile(url: URL, name: string, dataDir: string): Response {
  const rel = url.searchParams.get('path');
  if (!rel) return json(400, { error: 'invalid path' });
  const skillDir = locateSkillDir(url, name, dataDir);
  if (!skillDir) return json(404, { error: 'Not Found' });

  const result = readSkillFile(skillDir, rel);
  if (!result.ok) {
    return result.error === 'not_found'
      ? json(404, { error: 'Not Found' })
      : json(400, { error: 'invalid path' });
  }
  return json(200, {
    path: result.path,
    content: result.content,
    truncated: result.truncated,
    binary: result.binary,
  });
}

/** 定位 skill 目录（query ?workspace= 优先 workspace 层，否则 app） */
function locateSkillDir(url: URL, name: string, dataDir: string): string | null {
  const workspace = url.searchParams.get('workspace') ?? undefined;
  const scope = lookupScope(dataDir, workspace, name);
  const dir = join(scopeRoot(dataDir, { scope, workspaceDir: workspace }), name);
  return isDir(dir) ? dir : null;
}
