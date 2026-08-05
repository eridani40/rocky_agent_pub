/**
 * academy-assets-dataset — /academy/classroom/:cid/dataset CRUD
 * 参考: specs/api/overall/18-academy.md §3（数据集端点契约）
 *       specs/tech/academy/[P0]data_model.md §5（dataset entity）
 *
 * 职责：POST/GET 列/GET/PATCH/DELETE dataset。
 * 不变量：items 全量替换（不做增量 diff）；items 元素结构校验。
 */
import { ulid } from '../config/ulid';
import type { AcademyHandlerDeps } from '../routes/academy-routes';
import { json, type DatasetItem } from './academy-assets-shared';

/** POST dataset body */
export interface CreateDatasetBody {
  name: string;
  description?: string;
  items: DatasetItem[];
}

/** PATCH dataset body */
export interface PatchDatasetBody {
  name?: string;
  description?: string;
  items?: DatasetItem[];
}

/** POST /academy/classroom/:cid/dataset — 建数据集 */
export async function handleCreateDataset(
  req: Request,
  cid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const classroom = await deps.academyStore.getClassroom(cid);
  if (!classroom) return json(404, { error: 'classroom_not_found' });
  let body: CreateDatasetBody;
  try {
    body = (await req.json()) as CreateDatasetBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object' || !body.name || body.name.length === 0) {
    return json(400, { error: 'invalid_input', detail: 'name required' });
  }
  const itemsErr = validateDatasetItems(body.items);
  if (itemsErr) return json(400, { error: 'invalid_input', detail: itemsErr });

  const did = ulid();
  const dataset = await deps.academyStore.putDataset({
    id: did,
    classroomId: cid,
    name: body.name,
    ...(body.description !== undefined ? { description: body.description } : {}),
    items: body.items,
  });
  return json(201, dataset);
}

/** GET /academy/classroom/:cid/dataset — 列表 */
export async function handleListDatasets(
  cid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const classroom = await deps.academyStore.getClassroom(cid);
  if (!classroom) return json(404, { error: 'classroom_not_found' });
  const items = await deps.academyStore.listDatasetsByClassroom(cid);
  return json(200, { items });
}

/** GET /academy/classroom/:cid/dataset/:did — 详情 */
export async function handleGetDataset(
  cid: string,
  did: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const dataset = await deps.academyStore.getDataset(cid, did);
  if (!dataset) return json(404, { error: 'dataset_not_found' });
  return json(200, dataset);
}

/** PATCH /academy/classroom/:cid/dataset/:did — 改（items 全量替换） */
export async function handlePatchDataset(
  req: Request,
  cid: string,
  did: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const dataset = await deps.academyStore.getDataset(cid, did);
  if (!dataset) return json(404, { error: 'dataset_not_found' });
  let body: PatchDatasetBody;
  try {
    body = (await req.json()) as PatchDatasetBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object') {
    return json(400, { error: 'invalid_input' });
  }
  if (body.items !== undefined) {
    const itemsErr = validateDatasetItems(body.items);
    if (itemsErr) return json(400, { error: 'invalid_input', detail: itemsErr });
  }
  const { createdAt: _c, updatedAt: _u, version: _v, ...rec } = dataset;
  const updated = await deps.academyStore.putDataset({
    ...rec,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.description !== undefined ? { description: body.description } : {}),
    ...(body.items !== undefined ? { items: body.items } : {}),
  });
  return json(200, updated);
}

/** DELETE /academy/classroom/:cid/dataset/:did — 软删（当前物理删） */
export async function handleDeleteDataset(
  cid: string,
  did: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  const dataset = await deps.academyStore.getDataset(cid, did);
  if (!dataset) return json(404, { error: 'dataset_not_found' });
  // 软删语义暂未实现（待 classroom.archived 同款标记字段）；先走物理删（CompositeStore.deleteAsync）
  const { DatasetSchema } = await import('../academy/schema_defs');
  const crud = deps.academyStore.getCrud() as import('../persistence/composite').CompositeStore;
  await crud.deleteAsync(DatasetSchema, did, cid);
  return new Response(null, { status: 204 });
}

/** 校验 dataset items 元素结构（spec §5：{id, question, gradingCriteria?, expectedAnswer?}） */
function validateDatasetItems(items: unknown): string | null {
  if (!Array.isArray(items)) return 'items must be array';
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as DatasetItem;
    if (!it || typeof it !== 'object') return `items[${i}] must be object`;
    if (typeof it.id !== 'string' || it.id.length === 0) return `items[${i}].id required`;
    if (typeof it.question !== 'string' || it.question.length === 0) return `items[${i}].question required`;
  }
  return null;
}
