/**
 * academy-student-skill handlers — 版本工作区 skill 单文件读 / 写
 * 参考: specs/api/overall/18-academy.md §1.11（GET/PATCH .../version/:vid/skill/:name/file）
 *       specs/tech/academy/[P0]data_model.md §6.1（版本目录原语）
 *
 * 职责：
 *   - GET   .../version/:vid/skill/:name/file?path=  读单文件（文本/二进制/截断）
 *   - PATCH .../version/:vid/skill/:name/file        覆写单文件（formal 版本 only）
 *
 * 不变量：
 *   - formal 版本可写；process 版本（训练临时区）只读 → 409 process_version_readonly
 *   - **绝不经 writeVersionDirFiles**（那是 AGENTS.md + version.json 的全量重写，
 *     曾把 skill 目录名列表写进 AGENTS.md 造成数据丢失）——写只走 writeSkillFile 单文件覆写
 *   - 读写原语（越界守卫 / 二进制 / 截断 / 只覆写已存在文本文件）全在 skills/file-io.ts，
 *     与 /skill/:name/file 共用同一实现 → 响应 shape 一致
 *
 * 本文件从 academy-student.ts 分出（后者已 233 行，≤300 硬约束）。
 */
import { existsSync, statSync } from 'node:fs';
import { versionSkillDir } from '../academy/academy-version-skills';
import { readSkillFile, writeSkillFile } from '../skills/file-io';
import type { SkillFileIoError } from '../skills/file-io';
import { resolveVersion } from './academy-student';
import type { AcademyHandlerDeps } from '../routes/academy-routes';

/** JSON Response 构造（与 academy-student.ts 一致） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** PATCH .../skill/:name/file 请求体（spec §1.11.2） */
interface PatchSkillFileBody {
  path?: unknown;
  content?: unknown;
}

/**
 * `/academy/classroom/:cid/student/:sid/version/:vid/skill/:name/file` 分发。
 * 由 handleStudentRoute 二次分发调入（该 pattern 必须排在 `/version/:vid` 精确匹配之前）。
 *
 * @param req       入站 Request（GET 从 URL query 取 path；PATCH 从 body 取）
 * @param method    HTTP method（大写）
 * @param cid       classroom id
 * @param sid       student id
 * @param vid       version id
 * @param skillName skill 目录名（已 decodeURIComponent）
 * @param deps      AcademyHandlerDeps
 */
export async function handleVersionSkillRoute(
  req: Request,
  method: string,
  cid: string,
  sid: string,
  vid: string,
  skillName: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  if (method === 'GET') return handleGetVersionSkillFile(req, cid, sid, vid, skillName, deps);
  if (method === 'PATCH') return handlePatchVersionSkillFile(req, cid, sid, vid, skillName, deps);
  return json(405, { error: 'Method Not Allowed' }, 'GET,PATCH');
}

/** GET .../skill/:name/file?path= — 读单文件（spec §1.11.1） */
export async function handleGetVersionSkillFile(
  req: Request,
  cid: string,
  sid: string,
  vid: string,
  skillName: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const rel = new URL(req.url).searchParams.get('path');
  if (!rel) return json(400, { error: 'invalid path' });

  const located = await locateVersionSkillDir(cid, sid, vid, skillName, deps);
  if ('error' in located) return located.error;

  const result = readSkillFile(located.skillDir, rel);
  if (!result.ok) return ioErrorResponse(result);
  return json(200, {
    path: result.path,
    content: result.content,
    truncated: result.truncated,
    binary: result.binary,
  });
}

/**
 * PATCH .../skill/:name/file — 覆写单文件（formal only，spec §1.11.2）。
 * 只覆写已存在的文本文件（不新建/不建目录/不删/不写二进制），由 writeSkillFile 保证。
 */
export async function handlePatchVersionSkillFile(
  req: Request,
  cid: string,
  sid: string,
  vid: string,
  skillName: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const ver = await resolveVersion(cid, sid, vid, deps);
  if (!ver.ok) return json(ver.status, { error: ver.error });
  // 仅 formal 版本可写（与 §1.9 PATCH version 同判定同错误码）
  if (ver.meta.type !== 'formal') {
    return json(409, { error: 'process_version_readonly' });
  }

  let body: PatchSkillFileBody;
  try {
    body = (await req.json()) as PatchSkillFileBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object') return json(400, { error: 'invalid_input' });
  if (typeof body.path !== 'string' || !body.path) return json(400, { error: 'invalid path' });
  if (typeof body.content !== 'string') return json(400, { error: 'invalid_input' });

  const located = resolveSkillDir(ver.meta.workspaceDir, skillName);
  if ('error' in located) return located.error;

  const result = writeSkillFile(located.skillDir, body.path, body.content);
  if (!result.ok) return ioErrorResponse(result);
  return json(200, { ok: true, path: result.path });
}

// ── helpers ────────────────────────────────────────────────────

/**
 * 三层 id 校验（复用 academy-student.ts resolveVersion）+ skill 目录定位。
 * 命中返 skillDir；未命中返已构造好的错误 Response。
 */
async function locateVersionSkillDir(
  cid: string,
  sid: string,
  vid: string,
  skillName: string,
  deps: AcademyHandlerDeps,
): Promise<{ skillDir: string } | { error: Response }> {
  const ver = await resolveVersion(cid, sid, vid, deps);
  if (!ver.ok) return { error: json(ver.status, { error: ver.error }) };
  return resolveSkillDir(ver.meta.workspaceDir, skillName);
}

/**
 * 版本工作区内的 skill 目录定位（GET 与 PATCH 共用同一份 400/404 语义）。
 * PATCH 不整段复用 locateVersionSkillDir —— 它必须先 resolveVersion + formal 判定再解析 body。
 */
function resolveSkillDir(wsDir: string, skillName: string): { skillDir: string } | { error: Response } {
  const skillDir = versionSkillDir(wsDir, skillName);
  // skillName 非法（含 `/`、`..`、非 kebab）→ 400（spec §1.11.3）
  if (!skillDir) return { error: json(400, { error: 'invalid path' }) };
  if (!isDir(skillDir)) return { error: json(404, { error: 'skill_not_found' }) };
  return { skillDir };
}

/** file-io 错误 → HTTP（invalid_path→400 / not_found→404 / binary_target→400） */
function ioErrorResponse(e: SkillFileIoError): Response {
  if (e.error === 'not_found') return json(404, { error: 'Not Found' });
  if (e.error === 'binary_target') return json(400, { error: 'binary_not_writable' });
  return json(400, { error: 'invalid path' });
}

/** 存在且是目录 */
function isDir(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}
