/**
 * manage-classroom-assets-actions — manage-classroom 工具的教室资产 action（dataset/grader/skill）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §7（manage-classroom 工具契约）
 *
 * v0.0.221 拆分原因：manage-classroom-tool.ts 扩为 20 action（+ 学生 CRUD 7 + 任务监督 4）后
 * 单文件超 300 行。把 dataset/grader/skill 9 action 实现下沉到本文件（原 9 action 逻辑不变，
 * 仅搬家）；学生 CRUD 在 manage-student-actions.ts（helper，保留）；任务监督 4 action 在
 * manage-student-training-actions.ts（helper，重命名 start_training→start_task 等）。
 *
 * 单文件 ≤300 行（资产 CRUD 实现 + str helper）。
 */
import type { ToolInput, ToolRunResult } from '../../tools/types';
import { errorResult, textResult } from '../../tools/types';
import { ulid } from '../../config/ulid';
import type { AcademyStore } from '../../academy/academy-store';

/** 资产 action 闭合枚举（9 值；不变） */
export const ASSET_ACTIONS = [
  'add_dataset', 'update_dataset', 'delete_dataset', 'list_datasets',
  'add_grader', 'update_grader', 'delete_grader', 'list_graders',
  'install_skill',
] as const;
export type AssetAction = (typeof ASSET_ACTIONS)[number];

/** dispatch 资产 action */
export async function dispatchAssetAction(
  action: AssetAction, input: ToolInput, classroomId: string, store: AcademyStore,
): Promise<ToolRunResult> {
  switch (action) {
    case 'add_dataset': return addDataset(input, classroomId, store);
    case 'update_dataset': return updateDataset(input, classroomId, store);
    case 'delete_dataset': return deleteDataset(input, classroomId, store);
    case 'list_datasets': {
      const list = await store.listDatasetsByClassroom(classroomId);
      return textResult(JSON.stringify(list));
    }
    case 'add_grader': return addGrader(input, classroomId, store);
    case 'update_grader': return updateGrader(input, classroomId, store);
    case 'delete_grader': return deleteGrader(input, classroomId, store);
    case 'list_graders': {
      const list = await store.listGradersByClassroom(classroomId);
      return textResult(JSON.stringify(list));
    }
    case 'install_skill':
      // v0.0.210 占位：真实 skill 安装链路由 handler 层 G section 实现（与 skill_manage 工具重叠）
      return errorResult('manage-classroom.install_skill: not yet implemented (placeholder; use skill_manage tool)');
  }
}

// ── dataset actions ───────────────────────────────────

async function addDataset(
  input: ToolInput, classroomId: string, store: AcademyStore,
): Promise<ToolRunResult> {
  const name = str(input.name);
  if (!name) return errorResult('manage-classroom.add_dataset: name required');
  if (!Array.isArray(input.items)) return errorResult('manage-classroom.add_dataset: items[] required');
  const id = ulid();
  const rec = await store.putDataset({
    id,
    classroomId,
    name,
    ...(typeof input.description === 'string' ? { description: input.description } : {}),
    items: input.items,
  });
  return textResult(JSON.stringify({ id: rec.id }));
}

async function updateDataset(
  input: ToolInput, classroomId: string, store: AcademyStore,
): Promise<ToolRunResult> {
  const id = str(input.datasetId);
  if (!id) return errorResult('manage-classroom.update_dataset: datasetId required');
  const existing = await store.getDataset(classroomId, id);
  if (!existing) return errorResult(`manage-classroom.update_dataset: dataset ${id} not found`);
  const { createdAt: _c, updatedAt: _u, version: _v, ...patch } = existing;
  if (typeof input.name === 'string') patch.name = input.name;
  if (typeof input.description === 'string') patch.description = input.description;
  if (Array.isArray(input.items)) patch.items = input.items;
  await store.putDataset(patch);
  return textResult(JSON.stringify({ id }));
}

async function deleteDataset(
  input: ToolInput, classroomId: string, store: AcademyStore,
): Promise<ToolRunResult> {
  const id = str(input.datasetId);
  if (!id) return errorResult('manage-classroom.delete_dataset: datasetId required');
  const existing = await store.getDataset(classroomId, id);
  if (!existing) return errorResult(`manage-classroom.delete_dataset: dataset ${id} not found`);
  const { createdAt: _c, updatedAt: _u, version: _v, ...patch } = existing;
  await store.putDataset({ ...patch, ...(existing as unknown as { _deleted?: boolean }) });
  return textResult(JSON.stringify({ id, deleted: true }));
}

// ── grader actions ────────────────────────────────────

async function addGrader(
  input: ToolInput, classroomId: string, store: AcademyStore,
): Promise<ToolRunResult> {
  const name = str(input.name);
  if (!name) return errorResult('manage-classroom.add_grader: name required');
  const type = str(input.type);
  if (type !== 'llm-judge' && type !== 'em') {
    return errorResult(`manage-classroom.add_grader: invalid type "${type}" (llm-judge|em)`);
  }
  if (type === 'llm-judge' && typeof input.promptTemplate !== 'string') {
    return errorResult('manage-classroom.add_grader: llm-judge requires promptTemplate');
  }
  const id = ulid();
  const rec = await store.putGrader({
    id,
    classroomId,
    name,
    type,
    ...(typeof input.promptTemplate === 'string' ? { promptTemplate: input.promptTemplate } : {}),
    ...(typeof input.providerId === 'string' ? { providerId: input.providerId } : {}),
    ...(typeof input.modelId === 'string' ? { modelId: input.modelId } : {}),
    ...(typeof input.threshold === 'number' ? { threshold: input.threshold } : {}),
    ...(input.matchRule !== undefined ? { matchRule: input.matchRule } : {}),
  });
  return textResult(JSON.stringify({ id: rec.id }));
}

async function updateGrader(
  input: ToolInput, classroomId: string, store: AcademyStore,
): Promise<ToolRunResult> {
  const id = str(input.graderId);
  if (!id) return errorResult('manage-classroom.update_grader: graderId required');
  const existing = await store.getGrader(classroomId, id);
  if (!existing) return errorResult(`manage-classroom.update_grader: grader ${id} not found`);
  const { createdAt: _c, updatedAt: _u, version: _v, ...patch } = existing;
  if (typeof input.name === 'string') patch.name = input.name;
  if (typeof input.promptTemplate === 'string') patch.promptTemplate = input.promptTemplate;
  if (typeof input.providerId === 'string') patch.providerId = input.providerId;
  if (typeof input.modelId === 'string') patch.modelId = input.modelId;
  if (typeof input.threshold === 'number') patch.threshold = input.threshold;
  if (input.matchRule !== undefined) patch.matchRule = input.matchRule;
  await store.putGrader(patch);
  return textResult(JSON.stringify({ id }));
}

async function deleteGrader(
  input: ToolInput, classroomId: string, store: AcademyStore,
): Promise<ToolRunResult> {
  const id = str(input.graderId);
  if (!id) return errorResult('manage-classroom.delete_grader: graderId required');
  const existing = await store.getGrader(classroomId, id);
  if (!existing) return errorResult(`manage-classroom.delete_grader: grader ${id} not found`);
  const { createdAt: _c, updatedAt: _u, version: _v, ...patch } = existing;
  await store.putGrader({ ...patch, ...(existing as unknown as { _deleted?: boolean }) });
  return textResult(JSON.stringify({ id, deleted: true }));
}

// ── helpers ──────────────────────────────────────────

function str(v: unknown, def?: string): string {
  return typeof v === 'string' ? v : (def ?? '');
}
