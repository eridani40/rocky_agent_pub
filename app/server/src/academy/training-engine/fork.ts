/**
 * training-engine/fork — forkCandidate 原子 action（显式废弃当前候选重来）
 * 参考: specs/tech/academy/[P0]training_engine.md §3.2（forkCandidate 显式重来）
 *
 * 定位（coach 主导修订）：
 *   - coach 觉得当前 candidate 改坏了 → forkCandidate 废弃重来
 *   - 从 baseVersionId（缺省 task.temporaryBaselineVersionId）fork 新 candidate workspace
 *   - 更新 task.candidateVersionId 指向新 fork 版本
 *
 * 不变量：
 *   - 新 candidate 是唯一 process 版本（唯一 round 避免目录撞；用 max(roundNumber)+1）
 *   - 旧 candidate 不删（INV-6 保留可回看）
 *   - 用 forkVersionWorkspace（INV-5 原子性）
 */
import type { TrainingEngineDeps } from '../training-engine';
import type { TrainingTaskEntity } from '../academy-store';
import { forkVersionWorkspace } from '../academy-store-ops';
import { stripEnvelope } from './helpers';

/** forkCandidate 出参 */
export interface ForkCandidateResult {
  /** 新 candidate version id */
  versionId: string;
  /** 新 candidate workspace 绝对路径（coach edit 目标） */
  workspaceDir: string;
  /** 更新后的 task（candidateVersionId 已指向新版本） */
  task: TrainingTaskEntity;
}

/**
 * forkCandidate：显式 fork 新 candidate workspace，更新 task.candidateVersionId。
 *
 * @param deps           引擎依赖
 * @param taskId         任务 id
 * @param classroomId    教室 id
 * @param baseVersionId  fork 源版本 id（缺省 = task.temporaryBaselineVersionId）
 */
export async function forkCandidate(
  deps: TrainingEngineDeps,
  taskId: string,
  classroomId: string,
  baseVersionId?: string,
): Promise<ForkCandidateResult> {
  const store = deps.academyStore;
  const task = await store.getTask(classroomId, taskId);
  if (!task) throw new Error(`forkCandidate: task ${taskId} 不存在`);

  const baseId = baseVersionId ?? task.temporaryBaselineVersionId;
  if (!baseId) {
    throw new Error(
      `forkCandidate: task ${taskId} 缺 temporaryBaselineVersionId（需显式传 baseVersionId）`,
    );
  }

  // 新 candidate 的 round = 本任务历史 process 版本最大 roundNumber + 1（保证目录唯一，INV-6 旧候选不删）
  const versions = await store.listVersions(classroomId, task.studentId);
  const sameTaskVersions = versions.filter(
    (v) => v.type === 'process' && v.createdFromTaskId === task.id,
  );
  const maxRound = sameTaskVersions.reduce(
    (m, v) => Math.max(m, v.roundNumber ?? 0), 0,
  );
  const nextRound = maxRound + 1;

  const forked = await forkVersionWorkspace(
    store, deps.dataDir, baseId,
    task.classroomId, task.studentId, task.taskSeq, nextRound, task.id,
  );

  // v0.0.221 切基线语义：显式传 baseVersionId ≠ task.temporaryBaselineVersionId 时，
  // 同步替换 temporaryBaselineVersionId（不只是 candidateVersionId）——否则后续 revise 的
  // acceptGate 还比旧基线，acceptGate 失真；design.md §2.1b/§3.2 fork 切基线。
  // 不带 baseVersionId 参数时不动 temporaryBaseline（保持原「废弃重来」语义）。
  const switchingBaseline = baseVersionId !== undefined && baseVersionId !== task.temporaryBaselineVersionId;
  const updated = await store.putTask({
    ...stripEnvelope(task),
    candidateVersionId: forked.versionId,
    ...(switchingBaseline ? { temporaryBaselineVersionId: baseVersionId } : {}),
  });

  return {
    versionId: forked.versionId,
    workspaceDir: forked.workspaceDir,
    task: updated,
  };
}
