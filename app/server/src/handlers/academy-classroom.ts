/**
 * academy-classroom handlers — /academy/classroom/* 教室 CRUD + 学生列表
 * 参考: specs/api/overall/18-academy.md §1.1-1.7（教室 + 学生端点契约）
 *       specs/tech/academy/[P0]data_model.md §2-§3（classroom/student entity）
 *       specs/tech/version_logs/v0.0.210/change_plan.md G 节
 *
 * 职责：
 *   - POST /academy/classroom          建教室（事务：classroom record + head session + workspace 三件套）
 *   - GET  /academy/classroom          列教室
 *   - GET  /academy/classroom/:cid     教室详情（含 students/tasks/datasets/graders 概览）
 *   - PATCH /academy/classroom/:cid    改教室（name/logo）
 *   - POST /academy/classroom/:cid/student  建学生（事务：student record + 0.0 初始版本）
 *   - GET  /academy/classroom/:cid/student   列学生
 *
 * 不变量（INV-1）：
 *   - 建教室事务原子：classroom record + head session + head-workspace 三件套全成或全回滚
 *   - classroom.headTeacherSessionId ↔ session.biz='academy'/role='head_teacher' 双向关联
 *
 * 单文件 ≤300 行：纯 HTTP 适配 + 调 store/sessionStore；业务原语在 academy-store-ops.ts。
 */
import { ulid } from '../config/ulid';
import { mkdirSync } from 'node:fs';
import type {
  ClassroomEntity, StudentEntity,
} from '../academy/academy-store';
import {
  createStudentWithInitialVersion,
  StudentCoreError,
  STUDENT_CORE_HTTP_STATUS,
} from '../academy/academy-student-core';
import { headWorkspaceDir } from '../academy/academy-paths';
// academy session/版本 持久化 model 解析（resolveModel fallback 链封装；head/student 复用）
import {
  resolveAcademySessionModel,
  ModelNotConfiguredError,
} from '../academy/academy-session-model';
import { isReservedModelId } from '../services/model-validation';
import type { AcademyHandlerDeps } from '../routes/academy-routes';
import { attachBaseVersionLabel } from './academy-training-task-shared';

/** JSON Response 构造（与现有 handler 一致） */
function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** 教室级默认模型复合（对齐 squad.modelDefault：providerId optional + modelId） */
type ClassroomDefaultModel = { providerId?: string; modelId: string };

/** POST /academy/classroom 请求体 */
interface CreateClassroomBody {
  name: string;
  logo?: string;
  /** 教室级默认模型（v0.0.230 起「创建即必填」：缺省 → head session resolve 400 model_not_configured；
   *  建学生播种 + head/coach picker 默认项数据源） */
  defaultModel?: ClassroomDefaultModel;
}

/** PATCH /academy/classroom/:cid 请求体 */
interface PatchClassroomBody {
  name?: string;
  logo?: string;
  /**
   * 教室级默认模型（可选）。
   * null = 显式清除（picker 顶部默认项消失；教室无 defaultModel 后建学生播种 400，v0.0.230 无 app 兜底）；
   * 对象 = 设为该默认模型。
   */
  defaultModel?: ClassroomDefaultModel | null;
}

/** POST /academy/classroom/:cid/student 请求体 */
interface CreateStudentBody {
  name: string;
  logo?: string;
  /** 初始模型快照（缺省/保留字 → resolveModel fallback 到教室 defaultModel；教室也无 → 400，v0.0.230 无 app 兜底） */
  model?: { providerId?: string; modelId: string };
}

/**
 * /academy/classroom 路由分发（无 id：POST/GET；有 id：GET/PATCH；id/student：POST/GET）。
 *
 * @param req     入站 Request
 * @param method  HTTP method（大写）
 * @param path    pathname（/academy/classroom...）
 * @param deps    AcademyHandlerDeps（academyStore + sessionStore 必填）
 */
export async function handleClassroomRoute(
  req: Request,
  method: string,
  path: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  // /academy/classroom（无 cid）
  if (path === '/academy/classroom') {
    if (method === 'POST') return handleCreateClassroom(req, deps);
    if (method === 'GET') return handleListClassrooms(deps);
    return json(405, { error: 'Method Not Allowed' }, 'GET,POST');
  }

  // /academy/classroom/:cid/student（学生集合）
  const studentCollMatch = path.match(/^\/academy\/classroom\/([^/]+)\/student$/);
  if (studentCollMatch) {
    const cid = studentCollMatch[1]!;
    if (method === 'POST') return handleCreateStudent(req, cid, deps);
    if (method === 'GET') return handleListStudents(cid, deps);
    return json(405, { error: 'Method Not Allowed' }, 'GET,POST');
  }

  // /academy/classroom/:cid（item）
  const itemMatch = path.match(/^\/academy\/classroom\/([^/]+)$/);
  if (itemMatch) {
    const cid = itemMatch[1]!;
    if (method === 'GET') return handleGetClassroom(cid, deps);
    if (method === 'PATCH') return handlePatchClassroom(req, cid, deps);
    return json(405, { error: 'Method Not Allowed' }, 'GET,PATCH');
  }

  return json(404, { error: 'Not Found' });
}

// ── classroom handlers ─────────────────────────────────────────

/** POST /academy/classroom — 建教室事务（spec §1.1） */
async function handleCreateClassroom(
  req: Request,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  let body: CreateClassroomBody;
  try {
    body = (await req.json()) as CreateClassroomBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object' || !body.name || body.name.length === 0) {
    return json(400, { error: 'invalid_input', detail: 'name required' });
  }

  const cid = ulid();
  const sessionId = ulid();
  const wsDir = headWorkspaceDir(deps.dataDir, cid);

  // 0. head session model 持久化预解析（INV：head session 也需配真 model 才能激活，
  //    否则 resolveConfig 走 env default → test env / 新装 prod 无 default_models 时
  //    activate fail "请配置模型后再发起会话"。复用建学生 fallback 链：
  //    body.defaultModel 具体 → resolveModel；缺省/保留字 → 链跑空 → 400 model_not_configured。
  //    v0.0.230 收窄：academy 无 app 默认兜底，「创建教室即必填默认模型」。
  let headSessionModel: { providerId: string; modelId: string };
  try {
    headSessionModel = resolveAcademySessionModel(deps.appConfig, body.defaultModel, undefined);
  } catch (e) {
    if (e instanceof ModelNotConfiguredError) {
      return json(400, {
        error: 'model_not_configured',
        detail: '无法解析班主任模型：请为教室选择默认模型（创建时必选，在表单中选具体 provider/model）',
      });
    }
    throw e;
  }

  // 1. head workspace 目录（spec §1.1：workspaceDir=<DATA_DIR>/academy/<cid>/head-workspace/）
  try {
    mkdirSync(wsDir, { recursive: true });
  } catch (e) {
    return json(500, { error: 'create head workspace failed', detail: (e as Error).message });
  }

  // 2. head session（biz='academy'/role='head_teacher'/derivation='parent'，持久化 providerId+modelId）
  try {
    await deps.sessionStore.createSession({
      id: sessionId,
      title: `${body.name} · 班主任`,
      workspaceDir: wsDir,
      biz: 'academy',
      role: 'head_teacher',
      derivation: 'parent',
      classroomId: cid,
      providerId: headSessionModel.providerId,
      modelId: headSessionModel.modelId,
    });
  } catch (e) {
    // 补偿回滚：删已建的 workspace 目录（session 未建，无需回滚 session）
    try { await safeRmdir(wsDir); } catch { /* best-effort */ }
    return json(500, { error: 'create head session failed', detail: (e as Error).message });
  }

  // 3. classroom record（headTeacherSessionId 双向关联 INV-1）
  try {
    const classroom = await deps.academyStore.putClassroom({
      id: cid,
      classroomId: cid,
      name: body.name,
      ...(body.logo !== undefined ? { logo: body.logo } : {}),
      headTeacherSessionId: sessionId,
      datasetIds: [],
      graderIds: [],
      skillIds: [],
      archived: false,
      // 教室级默认模型（可选；仅当 caller 传非保留字 modelId 时落盘——保留字无意义等同于 undefined）
      ...(body.defaultModel && !isReservedModelId(body.defaultModel.modelId)
        ? { defaultModel: body.defaultModel }
        : {}),
    });
    return json(201, { classroom, headSessionId: sessionId });
  } catch (e) {
    // 补偿回滚：删 session + workspace（classroom 未落盘不删）
    try { await deps.sessionStore.deleteSession(sessionId); } catch { /* best-effort */ }
    try { await safeRmdir(wsDir); } catch { /* best-effort */ }
    return json(500, { error: 'create classroom failed', detail: (e as Error).message });
  }
}

/** GET /academy/classroom — 列全部教室（spec §1.2） */
async function handleListClassrooms(deps: AcademyHandlerDeps): Promise<Response> {
  const items: ClassroomEntity[] = await deps.academyStore.listClassrooms();
  return json(200, { items });
}

/** GET /academy/classroom/:cid — 教室详情（含 students/tasks/datasets/graders） */
async function handleGetClassroom(
  cid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const classroom = await deps.academyStore.getClassroom(cid);
  if (!classroom) return json(404, { error: 'classroom_not_found' });
  const [students, tasks, datasets, graders] = await Promise.all([
    deps.academyStore.listStudentsByClassroom(cid),
    deps.academyStore.listTasksByClassroom(cid),
    deps.academyStore.listDatasetsByClassroom(cid),
    deps.academyStore.listGradersByClassroom(cid),
  ]);
  // task DTO 反规范化 baseVersionLabel（spec §2.2）：教室训练 tab 无 versions 上下文，
  // 后端 read 时挂 base 版本 label，供前端拼任务名（PRD §2.5）。
  const tasksWithLabel = await Promise.all(
    tasks.map((t) => attachBaseVersionLabel(deps.academyStore, cid, t)),
  );
  return json(200, { classroom, students, tasks: tasksWithLabel, datasets, graders });
}

/** PATCH /academy/classroom/:cid — 改 name/logo */
async function handlePatchClassroom(
  req: Request,
  cid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const classroom = await deps.academyStore.getClassroom(cid);
  if (!classroom) return json(404, { error: 'classroom_not_found' });
  let body: PatchClassroomBody;
  try {
    body = (await req.json()) as PatchClassroomBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object') {
    return json(400, { error: 'invalid_input' });
  }
  // strip 信封字段（putAsync 会重算）+ 把 defaultModel 单独拆出便于干净合并。
  //   CrudStore json 字段读侧为 unknown，按 ClassroomDefaultModel 形断言（写入侧已严控形状）。
  const existingDefaultModel = classroom.defaultModel as ClassroomDefaultModel | undefined;
  const { createdAt: _c, updatedAt: _u, version: _v, ...recRest } = classroom;
  // defaultModel 单独从 existing 读，避免 spread 进 recRest 后再覆盖混淆
  const { defaultModel: _drop, ...recWithoutDefaultModel } = recRest;
  // defaultModel 合并语义：undefined=不动（保现状）；null=清除；对象=覆写。
  //   保留字 modelId（'default'/'none'/空）视同清除（无意义等同于不设默认）。
  //   清除 = 不带 defaultModel 字段（JSON.stringify 不含该键 → 读侧 undefined）。
  let resolvedDefaultModel: ClassroomDefaultModel | undefined;
  if (body.defaultModel === undefined) {
    resolvedDefaultModel = existingDefaultModel;
  } else if (body.defaultModel === null || isReservedModelId(body.defaultModel.modelId)) {
    resolvedDefaultModel = undefined; // 清除
  } else {
    resolvedDefaultModel = body.defaultModel;
  }
  const updated = await deps.academyStore.putClassroom({
    ...recWithoutDefaultModel,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.logo !== undefined ? { logo: body.logo } : {}),
    ...(resolvedDefaultModel !== undefined ? { defaultModel: resolvedDefaultModel } : {}),
  });
  return json(200, updated);
}

// ── student handlers ───────────────────────────────────────────

/** POST /academy/classroom/:cid/student — 建学生 + 0.0 初始版本（薄壳调 createStudentWithInitialVersion 核心） */
async function handleCreateStudent(
  req: Request,
  cid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  // 教室必须存在（先于 body 解析——保持原响应码顺序：404 优先于 400）
  const classroom = await deps.academyStore.getClassroom(cid);
  if (!classroom) return json(404, { error: 'classroom_not_found' });
  let body: CreateStudentBody;
  try {
    body = (await req.json()) as CreateStudentBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  try {
    const result = await createStudentWithInitialVersion(
      { academyStore: deps.academyStore, appConfig: deps.appConfig, dataDir: deps.dataDir },
      {
        classroomId: cid,
        name: body && typeof body === 'object' && typeof body.name === 'string' ? body.name : '',
        ...(body?.logo !== undefined ? { logo: body.logo } : {}),
        ...(body?.model !== undefined ? { model: body.model } : {}),
      },
    );
    return json(201, result);
  } catch (e) {
    if (e instanceof StudentCoreError) {
      return json(STUDENT_CORE_HTTP_STATUS[e.code], {
        error: e.code,
        ...(e.detail ? { detail: e.detail } : {}),
      });
    }
    return json(500, { error: 'create student failed', detail: (e as Error).message });
  }
}

/** GET /academy/classroom/:cid/student — 列教室学生（spec §1.6） */
async function handleListStudents(
  cid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  // 教室存在性校验（spec §7 错误码：classroom_not_found 404）
  const classroom = await deps.academyStore.getClassroom(cid);
  if (!classroom) return json(404, { error: 'classroom_not_found' });
  const items: StudentEntity[] = await deps.academyStore.listStudentsByClassroom(cid);
  return json(200, { items });
}

// ── helpers ────────────────────────────────────────────────────

/** best-effort 删目录（补偿回滚用；忽略不存在） */
async function safeRmdir(dir: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  await rm(dir, { recursive: true, force: true });
}
