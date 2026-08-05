/**
 * academy-assets-grader — /academy/classroom/:cid/grader CRUD
 * 参考: specs/api/overall/18-academy.md §3（评估器端点契约）
 *       specs/tech/academy/[P0]data_model.md §5（grader entity）
 *
 * 职责：POST/GET 列/GET/PATCH/DELETE grader。
 * 不变量：type 闭合 enum 校验（'llm-judge' | 'em'）。
 */
import { ulid } from '../config/ulid';
import type { AcademyHandlerDeps } from '../routes/academy-routes';
import { json } from './academy-assets-shared';

/** POST grader body */
export interface CreateGraderBody {
  name: string;
  type: 'llm-judge' | 'em';
  promptTemplate?: string;
  providerId?: string;
  modelId?: string;
  threshold?: number;
  matchRule?: { caseInsensitive?: boolean; trim?: boolean };
}

/** PATCH grader body（全量替换语义） */
export type PatchGraderBody = Partial<CreateGraderBody>;

/** POST /academy/classroom/:cid/grader — 建评估器（type enum 校验） */
export async function handleCreateGrader(
  req: Request,
  cid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const classroom = await deps.academyStore.getClassroom(cid);
  if (!classroom) return json(404, { error: 'classroom_not_found' });
  let body: CreateGraderBody;
  try {
    body = (await req.json()) as CreateGraderBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object' || !body.name || body.name.length === 0) {
    return json(400, { error: 'invalid_input', detail: 'name required' });
  }
  if (body.type !== 'llm-judge' && body.type !== 'em') {
    return json(400, { error: 'invalid_input', detail: "type must be 'llm-judge'|'em'" });
  }

  const gid = ulid();
  const grader = await deps.academyStore.putGrader({
    id: gid,
    classroomId: cid,
    name: body.name,
    type: body.type,
    ...(body.promptTemplate !== undefined ? { promptTemplate: body.promptTemplate } : {}),
    ...(body.providerId !== undefined ? { providerId: body.providerId } : {}),
    ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
    ...(body.threshold !== undefined ? { threshold: body.threshold } : {}),
    ...(body.matchRule !== undefined ? { matchRule: body.matchRule } : {}),
  });
  return json(201, grader);
}

/** GET /academy/classroom/:cid/grader — 列表 */
export async function handleListGraders(
  cid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const classroom = await deps.academyStore.getClassroom(cid);
  if (!classroom) return json(404, { error: 'classroom_not_found' });
  const items = await deps.academyStore.listGradersByClassroom(cid);
  return json(200, { items });
}

/** GET /academy/classroom/:cid/grader/:gid — 详情 */
export async function handleGetGrader(
  cid: string,
  gid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const grader = await deps.academyStore.getGrader(cid, gid);
  if (!grader) return json(404, { error: 'grader_not_found' });
  return json(200, grader);
}

/** PATCH /academy/classroom/:cid/grader/:gid — 改（全量替换语义） */
export async function handlePatchGrader(
  req: Request,
  cid: string,
  gid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const grader = await deps.academyStore.getGrader(cid, gid);
  if (!grader) return json(404, { error: 'grader_not_found' });
  let body: PatchGraderBody;
  try {
    body = (await req.json()) as PatchGraderBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object') {
    return json(400, { error: 'invalid_input' });
  }
  if (body.type !== undefined && body.type !== 'llm-judge' && body.type !== 'em') {
    return json(400, { error: 'invalid_input', detail: "type must be 'llm-judge'|'em'" });
  }
  const { createdAt: _c, updatedAt: _u, version: _v, ...rec } = grader;
  const updated = await deps.academyStore.putGrader({
    ...rec,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.type !== undefined ? { type: body.type } : {}),
    ...(body.promptTemplate !== undefined ? { promptTemplate: body.promptTemplate } : {}),
    ...(body.providerId !== undefined ? { providerId: body.providerId } : {}),
    ...(body.modelId !== undefined ? { modelId: body.modelId } : {}),
    ...(body.threshold !== undefined ? { threshold: body.threshold } : {}),
    ...(body.matchRule !== undefined ? { matchRule: body.matchRule } : {}),
  });
  return json(200, updated);
}

/** DELETE /academy/classroom/:cid/grader/:gid — 软删（当前物理删） */
export async function handleDeleteGrader(
  cid: string,
  gid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const grader = await deps.academyStore.getGrader(cid, gid);
  if (!grader) return json(404, { error: 'grader_not_found' });
  const { GraderSchema } = await import('../academy/schema_defs');
  const crud = deps.academyStore.getCrud() as import('../persistence/composite').CompositeStore;
  await crud.deleteAsync(GraderSchema, gid, cid);
  return new Response(null, { status: 204 });
}
