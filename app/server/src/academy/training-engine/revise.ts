/**
 * training-engine/revise — reviseCandidate 原子 action（推进一轮训练）
 * 参考: specs/tech/academy/[P0]training_engine.md §3（reviseCandidate 详细流程）+ §4（acceptGate + reviseBaselineAvg）
 *
 * coach 主导修订模型：coach 已 edit task.candidateVersionId 的 workspace，调 revise 推进一轮：
 *     1. 前置校验 + pending→running + per-task lock
 *     2. sample+grade 当前 candidate（或 simple/learning 无 dataset → 直接采纳）
 *     3. acceptGate（baseline = reviseBaselineAvg；首次候选直接采纳不比）
 *     4. improve → 晋升 temporaryBaseline + fork 下轮新 candidate
 *     5. 落 turn record
 *     6. 早停 / maxTurns → paused+pausedReason（去 propose 链；design.md §5/§7.5）
 *     7. deliverTo revise 结果给 coach（含 reasoning + 新 candidate ws）
 *
 * 不变量：
 *   - candidate = coach 正在编辑的待评版本（task.candidateVersionId）；baseline = 当前最优已采纳版本
 *   - 首次候选（temporaryBaselineVersionId === baseVersionId）直接采纳不比
 *   - simple/learning（无 dataset）：跳 sample/grade，候选直接晋升（BUG-002）
 */
import { ulid } from '../../config/ulid';
import type { TrainingEngineDeps, TurnResult } from '../training-engine';
import type {
  AcademyStore,
  TrainingTaskEntity,
} from '../academy-store';
import type { TrainingTurnRecord } from '../schema_defs';
import { forkVersionWorkspace } from '../academy-store-ops';
import {
  acceptGate,
  checkEarlyStop,
  reviseBaselineAvg,
  type GateDecision,
  type BaselineTask,
  type BaselineTurn,
} from './gate';
import { assessVersion } from './assess';
import { buildReviseResultMessage } from './messages';
import { pauseTask } from './lifecycle';
import { stripEnvelope } from './helpers';
import type { SampleResult } from './sample';
import type { GradeResult } from './grade';

/**
 * reviseCandidate：推进一轮训练。
 * @param deps        引擎依赖
 * @param taskId      任务 id
 * @param classroomId 教室 id
 */
export async function reviseCandidate(
  deps: TrainingEngineDeps,
  taskId: string,
  classroomId: string,
): Promise<TurnResult> {
  const store = deps.academyStore;
  const task = await store.getTask(classroomId, taskId);
  if (!task) throw new Error(`reviseCandidate: task ${taskId} 不存在`);

  // 1. 前置校验 + pending→running
  if (task.status !== 'running' && task.status !== 'pending') {
    throw new Error(`reviseCandidate: task ${taskId} status ${task.status} 不允许 revise`);
  }
  let working: TrainingTaskEntity = task;
  if (working.status === 'pending') {
    const updated = await store.putTask({
      ...stripEnvelope(working),
      status: 'running',
      currentTurn: 0,
      temporaryBaselineVersionId: working.baseVersionId,
    });
    working = updated;
  }
  if (!working.candidateVersionId) {
    throw new Error(
      `reviseCandidate: task ${taskId} 缺 candidateVersionId（coach 无候选可评，需先 fork）`,
    );
  }
  if ((working.currentTurn ?? 0) >= (working.maxTurns ?? 0)) {
    throw new Error(`reviseCandidate: task ${taskId} 已达 maxTurns ${working.maxTurns}`);
  }

  // 2. per-task lock（防并发 revise/evaluate）
  const lockKey = `academy-task:${taskId}`;
  if (!deps.sessionTaskLock.acquire(lockKey, 'training-turn')) {
    throw new Error(`reviseCandidate: task ${taskId} 已有 in-flight 推进（lock 冲突）`);
  }
  try {
    return await reviseInternal(deps, store, working);
  } finally {
    deps.sessionTaskLock.release(lockKey, 'training-turn');
  }
}

/** revise 主逻辑（已持 lock；拆出便于 finally 释放） */
async function reviseInternal(
  deps: TrainingEngineDeps,
  store: AcademyStore,
  task: TrainingTaskEntity,
): Promise<TurnResult> {
  const round = (task.currentTurn ?? 0) + 1;
  // currentTurn 推进到本轮
  let working = await store.putTask({ ...stripEnvelope(task), currentTurn: round });

  // 3. sample+grade 当前 candidate（或 simple/learning 无 dataset 直接采纳）
  let samples: SampleResult[] = [];
  let grades: GradeResult[] = [];
  let avgScore = 0;
  let decision: GateDecision;

  if (working.datasetId && working.graderId) {
    const assessed = await assessVersion(
      deps, store, working.classroomId, working.candidateVersionId!,
      working.datasetId, working.graderId,
    );
    samples = assessed.samples;
    grades = assessed.grades;
    avgScore = assessed.avgScore;
    // acceptGate（baseline = reviseBaselineAvg；首次候选返 undefined → 直接采纳不比）
    const history = await store.listTurns(working.classroomId, working.id);
    const baselineAvg = reviseBaselineAvg(
      working as BaselineTask,
      history as BaselineTurn[],
    );
    decision = baselineAvg === undefined
      ? 'improve'
      : acceptGate({ candidateAvg: avgScore, baselineAvg });
  } else {
    // simple/learning 无 dataset → 候选直接采纳（对齐旧 simpleModeFlow，BUG-002）
    decision = 'improve';
  }

  // 4. 落 turn record
  const turn: TrainingTurnRecord = {
    id: ulid(),
    taskId: working.id,
    classroomId: working.classroomId,
    studentId: working.studentId,
    round,
    candidateVersionId: working.candidateVersionId!,
    status: decision === 'improve' ? 'adopted' : 'decided',
    sampleResults: samples,
    gradeResults: grades,
    avgScore,
    decision,
  };
  const finalTurn = await store.appendTurn(turn);

  // 5. improve → 晋升 temporaryBaseline + fork 下轮新 candidate
  let newCandidateWs: string | undefined;
  if (decision === 'improve') {
    working = await store.putTask({
      ...stripEnvelope(working),
      temporaryBaselineVersionId: working.candidateVersionId,
    });
    const forked = await forkVersionWorkspace(
      store, deps.dataDir, working.candidateVersionId!, // = new baseline
      working.classroomId, working.studentId, working.taskSeq, round + 1, working.id,
    );
    working = await store.putTask({
      ...stripEnvelope(working),
      candidateVersionId: forked.versionId,
    });
    newCandidateWs = forked.workspaceDir;
  }

  // 6. 早停 / maxTurns → paused+pausedReason（design.md §5/§7.5；去 propose 链）
  // pauseTask 内部 putTask(status='paused', pausedReason=...)；不再写 legacy earlyStopReason 字段
  // （pausedReason='earlystop' 已涵盖；用户偏好 simple-direct，不留冗余字段）。
  const recentTurns = await store.listTurns(working.classroomId, working.id);
  const reachedMax = (working.currentTurn ?? 0) >= (working.maxTurns ?? 0);
  if (checkEarlyStop(recentTurns)) {
    const pausedTask = await pauseTask(deps, working.id, working.classroomId, 'earlystop');
    return { task: pausedTask, turn: finalTurn, paused: true };
  }
  if (reachedMax) {
    // maxTurns 到顶 → paused+reason='maxturns'（硬终态：coach 不可 resume 越过，须 update_task 调大）
    const pausedTask = await pauseTask(deps, working.id, working.classroomId, 'maxturns');
    return { task: pausedTask, turn: finalTurn, paused: true };
  }

  // 7. deliverTo revise 结果给 coach（fire-and-forget；失败不影响状态机推进）
  await deps.deliverTo(
    working.coachSessionId,
    buildReviseResultMessage(working, finalTurn, newCandidateWs, working.coachSessionId),
  ).catch((e) => {
    console.warn(`[training-engine] deliverTo coach failed: ${(e as Error).message}`);
  });

  return { task: working, turn: finalTurn, paused: false };
}
