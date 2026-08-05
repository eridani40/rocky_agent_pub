/**
 * academy-student handlers — /academy/classroom/:cid/student/:sid/version/* 版本内容/会话
 * 参考: specs/api/overall/18-academy.md §1.7-1.10（学生详情/版本内容/版本编辑/版本会话）
 *       specs/tech/version_logs/v0.0.210/change_plan.md G 节（行 84）
 *
 * 职责：
 *   - GET  /academy/classroom/:cid/student/:sid                       学生详情（含版本树）
 *   - GET  /academy/classroom/:cid/student/:sid/version/:vid          版本内容（五元组）
 *   - PATCH /academy/classroom/:cid/student/:sid/version/:vid         版本编辑（formal 可编辑，process 只读）
 *   - POST /academy/classroom/:cid/student/:sid/version/:vid/session  基于版本启动学生会话
 *   - GET/PATCH .../version/:vid/skill/:name/file                     版本 skill 单文件读写
 *     （本文件只做路由分发，实现在 ./academy-student-skill.ts）
 *
 * 不变量：
 *   - formal 版本可编辑；process 只读（训练临时区）
 *   - student session 启动时 subAgentConfig.tools = version.json.tools（装配工具白名单）
 *
 * 单文件 ≤300 行。
 */
import { ulid } from '../config/ulid';
import { listVersionSkills } from '../academy/academy-version-skills';
import { resolveVersionContent, writeVersionDirFiles } from '../academy/academy-version-dir';
import type { VersionJson } from '../academy/academy-version-dir';
import type { StudentVersionEntity } from '../academy/academy-store';
import { handleVersionSkillRoute } from './academy-student-skill';
import { attachBaseVersionLabel } from './academy-training-task-shared';
import type { AcademyHandlerDeps } from '../routes/academy-routes';

/** JSON Response 构造（与现有 handler 一致） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** PATCH version 请求体（spec §1.9） */
interface PatchVersionBody {
  agentsMd?: string;
  versionJson?: Partial<VersionJson>;
}

/** POST version/:vid/session 请求体（spec §1.10） */
interface StartSessionBody {
  title?: string;
}

/**
 * /academy/classroom/:cid/student/:sid[/version[/:vid[/session]]] 路由分发。
 *
 * @param req     入站 Request
 * @param method  HTTP method（大写）
 * @param path    pathname
 * @param deps    AcademyHandlerDeps
 */
export async function handleStudentRoute(
  req: Request,
  method: string,
  path: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  // /academy/classroom/:cid/student/:sid/version/:vid/session
  const sessionMatch = path.match(/^\/academy\/classroom\/([^/]+)\/student\/([^/]+)\/version\/([^/]+)\/session$/);
  if (sessionMatch) {
    const [_, cid, sid, vid] = sessionMatch;
    if (method === 'POST') return handleStartStudentSession(req, cid!, sid!, vid!, deps);
    return json(405, { error: 'Method Not Allowed' }, 'POST');
  }

  // /academy/classroom/:cid/student/:sid/version/:vid/skill/:name/file（spec §1.11）
  // MUST 排在下面 /version/:vid 精确匹配之前：本路径比它长，若顺序颠倒会一路落到兜底 404。
  const skillFileMatch = path.match(
    /^\/academy\/classroom\/([^/]+)\/student\/([^/]+)\/version\/([^/]+)\/skill\/([^/]+)\/file$/,
  );
  if (skillFileMatch) {
    const [_, cid, sid, vid, skillName] = skillFileMatch;
    return handleVersionSkillRoute(req, method, cid!, sid!, vid!, decodeURIComponent(skillName!), deps);
  }

  // /academy/classroom/:cid/student/:sid/version/:vid
  const versionMatch = path.match(/^\/academy\/classroom\/([^/]+)\/student\/([^/]+)\/version\/([^/]+)$/);
  if (versionMatch) {
    const [_, cid, sid, vid] = versionMatch;
    if (method === 'GET') return handleGetVersionContent(cid!, sid!, vid!, deps);
    if (method === 'PATCH') return handlePatchVersion(req, cid!, sid!, vid!, deps);
    return json(405, { error: 'Method Not Allowed' }, 'GET,PATCH');
  }

  // /academy/classroom/:cid/student/:sid
  const itemMatch = path.match(/^\/academy\/classroom\/([^/]+)\/student\/([^/]+)$/);
  if (itemMatch) {
    const [_, cid, sid] = itemMatch;
    if (method === 'GET') return handleGetStudent(cid!, sid!, deps);
    return json(405, { error: 'Method Not Allowed' }, 'GET');
  }

  return json(404, { error: 'Not Found' });
}

// ── handlers ───────────────────────────────────────────────────

/** GET /academy/classroom/:cid/student/:sid — 学生详情（含版本树，spec §1.7） */
async function handleGetStudent(
  cid: string,
  sid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const classroom = await deps.academyStore.getClassroom(cid);
  if (!classroom) return json(404, { error: 'classroom_not_found' });
  const student = await deps.academyStore.getStudent(cid, sid);
  if (!student) return json(404, { error: 'student_not_found' });
  // 并行读 versions + 教室全部 tasks（filter studentId 得该学生任务）。
  // response 含 tasks 使前端 useStudentDetail 自足检测 active task 驱动轮询（spec §1.7）。
  const [versions, allTasks] = await Promise.all([
    deps.academyStore.listVersions(cid, sid),
    deps.academyStore.listTasksByClassroom(cid),
  ]);
  const tasks = allTasks.filter((t) => t.studentId === sid);
  // task DTO 反规范化 baseVersionLabel（spec §2.2）：学生详情任务卡用 detail.tasks 拼任务名
  // 「v{baseMajor}.{taskSeq}」，无 versions 上下文需后端 read 时挂字段（与 handleGetClassroom 一致，
  // BUG-001 修复：原 6b 漏覆盖此 handler 导致前端降级显「v?.1」）。
  const tasksWithLabel = await Promise.all(
    tasks.map((t) => attachBaseVersionLabel(deps.academyStore, cid, t)),
  );
  return json(200, { student, versions, tasks: tasksWithLabel });
}

/** GET /academy/classroom/:cid/student/:sid/version/:vid — 版本内容（spec §1.8） */
async function handleGetVersionContent(
  cid: string,
  sid: string,
  vid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const ver = await resolveVersion(cid, sid, vid, deps);
  if (!ver.ok) return json(ver.status, { error: ver.error });
  const content = await resolveVersionContent(ver.meta.workspaceDir);
  // skills = 目录 + 文件树 + 每文件 hash（spec §1.8 SkillSummary），不是目录名列表
  const skills = await listVersionSkills(ver.meta.workspaceDir);
  return json(200, {
    meta: ver.meta,
    content: {
      agentsMd: content.agentsMd,
      skills,
      // memory 真实条目（resolveVersionContent 已读 .rocky/memory/*.md，spec §1.8）
      memory: content.memoryEntries,
      versionJson: content.versionJson,
    },
  });
}

/** PATCH /academy/classroom/:cid/student/:sid/version/:vid — 编辑版本（spec §1.9） */
async function handlePatchVersion(
  req: Request,
  cid: string,
  sid: string,
  vid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const ver = await resolveVersion(cid, sid, vid, deps);
  if (!ver.ok) return json(ver.status, { error: ver.error });
  // 仅 formal 版本可编辑（spec §1.9：process 只读）
  if (ver.meta.type !== 'formal') {
    return json(409, { error: 'process_version_readonly' });
  }
  let body: PatchVersionBody;
  try {
    body = (await req.json()) as PatchVersionBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object') {
    return json(400, { error: 'invalid_input' });
  }

  // 1. 重写 AGENTS.md（如提供）
  const content = await resolveVersionContent(ver.meta.workspaceDir);
  const existingVJson = content.versionJson;
  const mergedVJson: VersionJson = {
    versionLabel: ver.meta.versionLabel,
    model: body.versionJson?.model ?? existingVJson?.model ?? { modelId: 'default' },
    ...(body.versionJson?.tools !== undefined ? { tools: body.versionJson.tools } : (existingVJson?.tools !== undefined ? { tools: existingVJson.tools } : {})),
  };
  // 用 writeVersionDirFiles 全量覆盖（带 AGENTS.md 重写）
  await writeVersionDirFiles(ver.meta.workspaceDir, {
    versionLabel: ver.meta.versionLabel,
    model: mergedVJson.model,
    agentsMd: body.agentsMd ?? content.agentsMd,
    ...(mergedVJson.tools !== undefined ? { tools: mergedVJson.tools } : {}),
  });

  // 2. version record 仅回读（内容以 fs 为准，record 不变）
  return json(200, ver.meta);
}

/** POST /academy/classroom/:cid/student/:sid/version/:vid/session — 启动学生会话（spec §1.10） */
async function handleStartStudentSession(
  req: Request,
  cid: string,
  sid: string,
  vid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const ver = await resolveVersion(cid, sid, vid, deps);
  if (!ver.ok) return json(ver.status, { error: ver.error });

  let body: StartSessionBody = {};
  try {
    const text = await req.text();
    if (text.length > 0) body = JSON.parse(text) as StartSessionBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }

  const sessionId = ulid();
  // 读 version.json.tools 装配 subAgentConfig（spec §1.10）
  const content = await resolveVersionContent(ver.meta.workspaceDir);
  const tools = content.versionJson?.tools;
  // student 读 AGENTS.md 作 systemPrompt（buildSessionConfigFromDeps 会覆盖；subAgentConfig 是最小契约）
  const subAgentConfig = {
    systemPrompt: content.agentsMd,
    tools: tools && tools.length > 0 ? tools : ['read', 'glob', 'grep', 'bash', 'skill', 'memory', 'web_search', 'web_fetch', 'see_image'],
    ...(content.skillNames.length > 0 ? { skills: content.skillNames } : {}),
    maxIter: 30,
  };

  await deps.sessionStore.createSession({
    id: sessionId,
    title: body.title ?? `${ver.meta.versionLabel} · 学生会话`,
    workspaceDir: ver.meta.workspaceDir,
    biz: 'academy',
    role: 'student',
    derivation: 'parent',
    classroomId: cid,
    studentId: sid,
    versionId: vid,
    subAgentConfig,
  });
  return json(201, { sessionId });
}

// ── helpers ────────────────────────────────────────────────────

/**
 * 解析 classroom/student/version 三层 id；任一不存在返错误响应。
 * export 供 ./academy-student-skill.ts 复用（同一份三层 404 语义，不复制校验逻辑）。
 */
export async function resolveVersion(
  cid: string,
  sid: string,
  vid: string,
  deps: AcademyHandlerDeps,
): Promise<
  | { ok: true; meta: StudentVersionEntity }
  | { ok: false; status: 404; error: string }
> {
  const classroom = await deps.academyStore.getClassroom(cid);
  if (!classroom) return { ok: false, status: 404, error: 'classroom_not_found' };
  const student = await deps.academyStore.getStudent(cid, sid);
  if (!student) return { ok: false, status: 404, error: 'student_not_found' };
  const version = await deps.academyStore.getVersion(cid, vid);
  if (!version || version.studentId !== sid) {
    return { ok: false, status: 404, error: 'version_not_found' };
  }
  return { ok: true, meta: version };
}
