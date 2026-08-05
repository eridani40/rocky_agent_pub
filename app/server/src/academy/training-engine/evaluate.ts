/**
 * training-engine/evaluate — evaluateVersion 原子 action（纯查询 sample+grade）
 * 参考: specs/tech/academy/[P0]training_engine.md §3.1（evaluateVersion 纯查询）
 *
 * 定位（coach 主导修订）：
 *   - coach 用 evaluate 探查 base 或 candidate 的表现（如先 evaluate(base) 拿基线分，再 edit candidate → revise 对比）
 *   - 纯查询：不改 task/turn 状态、不落 turn record
 *   - evaluate 对 head_teacher 也开放（head 可探查版本表现，不改状态）；revise 仅 coach
 *
 * 不变量：
 *   - 不改 task/turn 状态（无副作用）
 *   - 复用 per-task lock 防与 revise 并发（assess 跑 LLM 期间不可被 revise 抢）
 *   - 无 dataset/grader 抛错（evaluate 需要评估配置）
 */
import type { TrainingEngineDeps } from '../training-engine';
import { assessVersion, type AssessResult } from './assess';

/** evaluateVersion 出参（供 coach 反思：versionId + 评估三件套） */
export interface EvaluateResult extends AssessResult {
  /** 被评估的版本 id（显式入参或 task.candidateVersionId） */
  versionId: string;
}

/**
 * evaluateVersion：纯查询 sample+grade 指定 version。
 *
 * @param deps        引擎依赖
 * @param taskId      任务 id
 * @param classroomId 教室 id
 * @param versionId   被评估版本 id（缺省 = task.candidateVersionId）
 */
export async function evaluateVersion(
  deps: TrainingEngineDeps,
  taskId: string,
  classroomId: string,
  versionId?: string,
): Promise<EvaluateResult> {
  const store = deps.academyStore;
  const task = await store.getTask(classroomId, taskId);
  if (!task) throw new Error(`evaluateVersion: task ${taskId} 不存在`);

  const targetVersionId = versionId ?? task.candidateVersionId;
  if (!targetVersionId) {
    throw new Error(
      `evaluateVersion: task ${taskId} 缺 candidateVersionId（需显式传 versionId 或先建 candidate）`,
    );
  }
  if (!task.datasetId || !task.graderId) {
    throw new Error(
      `evaluateVersion: task ${taskId} 缺 datasetId/graderId（evaluate 需评估配置；simple/learning 走 revise 直接采纳）`,
    );
  }

  // per-task lock（防与 revise 并发；assess 跑 LLM 期间不可被推进抢）
  const lockKey = `academy-task:${taskId}`;
  if (!deps.sessionTaskLock.acquire(lockKey, 'training-turn')) {
    throw new Error(`evaluateVersion: task ${taskId} 已有 in-flight 推进（lock 冲突）`);
  }
  try {
    const result = await assessVersion(
      deps, store, classroomId, targetVersionId, task.datasetId, task.graderId,
    );
    return { versionId: targetVersionId, ...result };
  } finally {
    deps.sessionTaskLock.release(lockKey, 'training-turn');
  }
}
