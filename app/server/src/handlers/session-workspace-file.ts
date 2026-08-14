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
 * 安全：复用 session-workspace.ts export 的 json() + session-workspace-path.ts 的 whitelistResolve()
 *   （字符串前缀 + 链式授权解析双层校验，防 ../ + 绝对路径注入；workspace 内 symlink = 用户放置 =
 *   授权，v0.0.263 起 symlink 文件读写放行，spec §2.6.7 MANDATORY）。
 * 打包护栏 BUG-004：realRoot 经 realpathSync(session.workspaceDir)（workspaceDir 已由
 *   server 启动时 resolveDataDir 展开为绝对路径）；禁字面 ~ / 禁裸 path.resolve 拼接。
 *
 * 拆独立文件对齐 session-workspace-save-image.ts 先例（session-workspace.ts 已 298 行）。
 */
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import type { SessionHandlerDeps } from './session';
import { json } from './session-workspace';
import { whitelistResolve } from './session-workspace-path';

/**
 * 计算文件版本标记（v0.0.320，PRD §3.3）：`${mtimeMs}:${size}`。
 * mtime 或 size 任一变化 → version 变化（冲突检测依据，VSCode 式乐观锁）。
 * statSync 失败抛错（caller 决定 409/500）。
 */
export function computeFileVersion(absPath: string): string {
  const st = statSync(absPath);
  return `${st.mtimeMs}:${st.size}`;
}

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
 * GET /session/:id/workspace/file —— 读 workspace 内文件。
 * 流程：method 校验 → getSession → query path 校验 → realRoot → whitelistResolve → readFileSync。
 * [v0.0.269] `?binary=1` → 读 Buffer 返 `{ content: base64 }`（image viewer 二进制通道）；
 *   无 binary 参数 / 非 '1' → UTF-8 文本现状（向后兼容）。
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
  // [v0.0.269] binary=1 → base64 二进制通道（image viewer 用）；非 '1'/缺失 → utf8 现状
  const binary = url.searchParams.get('binary') === '1';

  // 路径白名单 + realpath（spec §2.6.7 安全 MANDATORY；traversal→400 / not_found→404）
  const resolved = resolveWsFilePath(got.workspaceDir, pathParam);
  if (!resolved.ok) return resolved.response;

  try {
    if (binary) {
      // 读 Buffer → base64（image viewer 前端拼 data URL；白名单校验与文本同一路径安全面）
      const buf = readFileSync(resolved.absPath);
      return json(200, { content: buf.toString('base64') });
    }
    // 读 UTF-8 文本（.md 文本文件；race 极端删→catch 500）
    // [v0.0.320] 响应加 version（mtimeMs:size 冲突检测标记；binary 分支不加——image 无冲突语义）
    const content = readFileSync(resolved.absPath, 'utf8');
    const version = computeFileVersion(resolved.absPath);
    return json(200, { content, version });
  } catch {
    return json(500, { error: 'read failed' });
  }
}

/**
 * GET /session/:id/workspace/stat —— workspace 文件 stat（v0.0.339：文件大小判定，供前端分流）。
 * 流程：method 校验 → getSession → query path 校验 → realRoot → whitelistResolve → statSync → { size }。
 * 只返 size **不读文件内容**（>5MB 大文件先读再判大小 = 本末倒置；轻量 statSync）。
 * 错误：405 非 GET / 404 session+文件不存在 / 400 path 缺失或越界 / 500 workspace+realpath+stat 失败。
 * 目录/不存在 → 404（对齐 file read：whitelistResolve not_found→404；目录 stat 成功但语义上文件打开需要文件——
 *   resolveWsFilePath 白名单对目录 realpath 成功，此处 statSync 对目录也成功；按 change_plan「目录/不存在 404」：
 *   目录 isDirectory → 404（stat 端点只服务文件大小判定）。
 */
export async function handleWorkspaceStat(
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
  const pathParam = url.searchParams.get('path');
  if (typeof pathParam !== 'string' || pathParam === '') {
    return json(400, { error: 'path required' });
  }

  // 路径白名单 + realpath（与 file read 同一安全链；traversal→400 / not_found→404）
  const resolved = resolveWsFilePath(got.workspaceDir, pathParam);
  if (!resolved.ok) return resolved.response;

  try {
    const st = statSync(resolved.absPath);
    if (st.isDirectory()) return json(404, { error: 'path not found' }); // 目录无 size 语义（文件打开判定用）
    return json(200, { size: st.size });
  } catch {
    return json(404, { error: 'path not found' }); // stat 失败（不存在/无权限）→ 404（对齐 file read 语义）
  }
}

/**
 * POST /session/:id/workspace/file/save —— 覆盖写 workspace 文本文件（v0.0.320 起带乐观锁冲突检测）。
 * 流程：method 校验 → getSession → body {path,content,expectedVersion?,force?} 校验 → realRoot →
 *   whitelistResolve → 版本校验（可选）→ writeFileSync 覆盖。
 * [v0.0.320] PRD §3.3 + API change_log §1.2：
 *   - expectedVersion 缺失 或 force=true → 跳过校验直接覆盖（last-write-wins，向后兼容旧调用方）
 *   - expectedVersion 存在且非 force → 比对当前磁盘 version：匹配 → 覆盖写 200；不匹配 → 409 不写盘
 *   - 成功响应新增 version（写后重新 stat 的新版本标记）
 * 错误：405 非 POST / 404 session+文件不存在 / 400 body 非法或越界 / 409 版本冲突 / 500 workspace+realpath+写失败。
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

  // body 解析 { path, content, expectedVersion?, force? }：path/content 非 string / 缺失 → 400（spec §2.6.7）；
  // expectedVersion/force 宽松解析（非 string/boolean → 忽略，对齐 API change_log §1.2「宽松扩展不 400」）
  let bodyPath: string | undefined;
  let bodyContent: string | undefined;
  let expectedVersion: string | undefined;
  let force = false;
  try {
    const parsed = (await req.json()) as {
      path?: unknown; content?: unknown; expectedVersion?: unknown; force?: unknown;
    };
    if (typeof parsed.path === 'string') bodyPath = parsed.path;
    if (typeof parsed.content === 'string') bodyContent = parsed.content;
    if (typeof parsed.expectedVersion === 'string') expectedVersion = parsed.expectedVersion;
    if (typeof parsed.force === 'boolean') force = parsed.force;
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

  // [v0.0.320] 乐观锁冲突检测：expectedVersion 存在且非 force → 与当前磁盘 version 比对
  //   不匹配 → 409 { error:'conflict', currentVersion }，不写盘（文件保留外部改动后的最新状态）
  if (expectedVersion !== undefined && !force) {
    let currentVersion: string;
    try {
      currentVersion = computeFileVersion(resolved.absPath);
    } catch {
      // 文件不存在（竞态删）→ 沿用旧语义 404（不新建）
      return json(404, { error: 'path not found' });
    }
    if (currentVersion !== expectedVersion) {
      return json(409, { error: 'conflict', currentVersion });
    }
  }

  // writeFileSync 直接覆盖（无 expectedVersion / force=true → last-write-wins，PRD §6.3）
  try {
    writeFileSync(resolved.absPath, bodyContent, 'utf8');
    // [v0.0.320] 写后重新 stat 返回新 version（前端保存后更新 tab 版本标记）
    const newVersion = computeFileVersion(resolved.absPath);
    return json(200, { ok: true, version: newVersion });
  } catch {
    return json(500, { error: 'save failed' });
  }
}
