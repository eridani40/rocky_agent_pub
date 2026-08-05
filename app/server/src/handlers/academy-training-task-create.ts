/**
 * academy-training-task-create — POST /academy/classroom/:cid/student/:sid/training-task
 * 参考: specs/api/overall/18-academy.md §2.1（发起训练）
 *       specs/tech/academy/[P0]session_kind_extension.md §5（两入口统一核心）
 *
 * v0.0.213 重构为薄壳：解析 body → 调 createTrainingTaskAndCoach（统一核心）→
 * 把 TrainingCoreError(code) 映射回 HTTP 错误码（API 18-academy §7 契约不变）。
 *
 * 不变量：
 *   - HTTP 错误码映射不变（invalid_base_version/missing_evaluation_config/model_not_configured→400；
 *     task_already_running→409；*_not_found→404）
 *   - 校验 + coach session 建链 + 任务书投递统一在核心（HTTP 与 head 工具 start 共享）
 */
import {
  createTrainingTaskAndCoach,
  TrainingCoreError,
  TRAINING_CORE_HTTP_STATUS,
  type CreateTrainingTaskInput,
} from '../academy/academy-training-core';
import type { AcademyHandlerDeps } from '../routes/academy-routes';
import { json } from './academy-assets-shared';
import { attachBaseVersionLabel } from './academy-training-task-shared';

/** POST 请求体（spec §2.1） */
export interface CreateTaskBody {
  baseVersionId: string;
  mode: 'simple' | 'multi';
  optimizeStyle: 'learning' | 'training';
  directive: string;
  datasetId?: string;
  graderId?: string;
  maxTurns?: number;
}

/** POST /academy/classroom/:cid/student/:sid/training-task — 发起训练（薄壳 → 核心统一装配） */
export async function handleCreateTask(
  req: Request,
  cid: string,
  sid: string,
  deps: AcademyHandlerDeps,
): Promise<Response> {
  let body: CreateTaskBody;
  try {
    body = (await req.json()) as CreateTaskBody;
  } catch {
    return json(400, { error: 'invalid json body' });
  }
  if (!body || typeof body !== 'object' || !body.baseVersionId || !body.mode || !body.optimizeStyle) {
    return json(400, { error: 'invalid_input' });
  }
  if (body.mode !== 'simple' && body.mode !== 'multi') {
    return json(400, { error: 'invalid_input', detail: 'mode must be simple|multi' });
  }
  if (body.optimizeStyle !== 'learning' && body.optimizeStyle !== 'training') {
    return json(400, { error: 'invalid_input', detail: 'optimizeStyle must be learning|training' });
  }

  const input: CreateTrainingTaskInput = {
    classroomId: cid,
    studentId: sid,
    baseVersionId: body.baseVersionId,
    mode: body.mode,
    optimizeStyle: body.optimizeStyle,
    ...(body.directive !== undefined ? { directive: body.directive } : {}),
    ...(body.datasetId !== undefined ? { datasetId: body.datasetId } : {}),
    ...(body.graderId !== undefined ? { graderId: body.graderId } : {}),
    ...(body.maxTurns !== undefined ? { maxTurns: body.maxTurns } : {}),
  };

  try {
    const result = await createTrainingTaskAndCoach(deps, input);
    // task DTO 反规范化 baseVersionLabel（spec §2.1/§2.2）：建后立即可显版本前缀名。
    const taskWithLabel = await attachBaseVersionLabel(deps.academyStore, cid, result.task);
    return json(201, {
      task: taskWithLabel,
      coachSessionId: result.coachSessionId,
      candidateVersionId: result.candidateVersionId,
      candidateWorkspaceDir: result.candidateWorkspaceDir,
    });
  } catch (e) {
    if (e instanceof TrainingCoreError) {
      const status = TRAINING_CORE_HTTP_STATUS[e.code];
      return json(status, {
        error: e.code,
        ...(e.detail ? { detail: e.detail } : {}),
      });
    }
    throw e;
  }
}
