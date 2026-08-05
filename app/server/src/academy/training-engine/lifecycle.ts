/**
 * training-engine/lifecycle — TrainingEngine 任务生命周期方法
 * 参考: specs/tech/academy/[P0]training_engine.md §2（接口）+ §6（断点续跑 + migration）
 *
 * v0.0.221 模型重构（design.md §3 + §5）：
 *   - 删除 proposeTask/acceptTask/rejectTask/stopTask（propose→accept/reject 链解耦）
 *   - 新增 pauseTask/resumeTask/adoptVersion（生产轴 ↔ 归档轴两正交动作）
 *   - resumeOnStartup 扩为「扫所有 tasks」+ 幂等 migration（旧 status → paused+pausedReason）
 *
 * 语义边界（design.md §5 三态机）：
 *   - pending → running ↔ paused(+pausedReason)；maxTurns 硬上限到顶须 update_task 调大续训
 *   - adoptVersion 是旁路动作（不改 task.status，可重复，多次产 major 递增 formal）
 *
 * 拆分原因：training-engine.ts 主文件若含全部生命周期方法会超 300 行。
 * lifecycle 函数以 deps 为首参，与 TrainingEngine class 解耦——便于单测 mock + 后续扩展。
 */
import type { TrainingEngineDeps } from '../training-engine';
import type { TrainingTaskEntity } from '../academy-store';
import { adoptToFormal } from '../academy-store-ops';
import {
  buildResumeMessage,
  buildResumeNeedManualMessage,
  buildPausedMessage,
  buildResumeFromPausedMessage,
  buildAdoptedMessage,
} from './messages';
import { stripEnvelope } from './helpers';

/** 旧 status → pausedReason 映射（migration 用；academy 还在 demo 阶段，pre-existing 数据破坏用户已接受） */
const LEGACY_STATUS_REASON_MAP: Record<string, string> = {
  done: 'completed',
  aborted: 'stopped',
  rejected: 'stopped',
  awaiting_confirm: 'stopped',
};

/**
 * pause：running/pending → paused(+pausedReason)。
 * 可逆（非 maxturns 时 coach 可 resume）；**不改 candidate/baseline 指针**（仅状态标记）。
 *
 * @param reason 缺省 'stopped'；'maxturns'/'earlystop' 由引擎到顶/早停时自动调（非 coach 手动）
 */
export async function pauseTask(
  deps: TrainingEngineDeps,
  taskId: string,
  classroomId: string,
  reason?: 'stopped' | 'earlystop' | 'maxturns' | 'completed',
): Promise<TrainingTaskEntity> {
  const store = deps.academyStore;
  const task = await store.getTask(classroomId, taskId);
  if (!task) throw new Error(`pauseTask: task ${taskId} 不存在`);
  if (task.status === 'paused') {
    throw new Error(`pauseTask: task ${taskId} status ${task.status} 不允许 pause`);
  }
  // running / pending 均可 pause（design.md §5：可逆暂停）
  const pausedReason = reason ?? 'stopped';
  const updated = await store.putTask({
    ...stripEnvelope(task),
    status: 'paused',
    pausedReason,
  });
  // 推给 coach（fire-and-forget；observability 自治）
  await deps.deliverTo(
    task.coachSessionId,
    buildPausedMessage(updated, task.coachSessionId),
  ).catch(() => { /* observability 自治 */ });
  return updated;
}

/**
 * resume：paused → running；maxTurns 硬门（reason=maxturns 不可 resume，须 update_task 调大）。
 *
 * **MUST NOT 自动 fork 新 candidate**（coach 自己调 revise/fork 起 round N+1；design.md §7.5）。
 */
export async function resumeTask(
  deps: TrainingEngineDeps,
  taskId: string,
  classroomId: string,
): Promise<TrainingTaskEntity> {
  const store = deps.academyStore;
  const task = await store.getTask(classroomId, taskId);
  if (!task) throw new Error(`resumeTask: task ${taskId} 不存在`);
  if (task.status !== 'paused') {
    throw new Error(`resumeTask: task ${taskId} status ${task.status} 不允许 resume`);
  }
  if (task.pausedReason === 'maxturns') {
    throw new Error(
      `resumeTask: task ${taskId} task_at_maxturns（maxTurns 到顶，须先 update_task 调大 maxTurns 才能续训）`,
    );
  }
  const updated = await store.putTask({
    ...stripEnvelope(task),
    status: 'running',
    pausedReason: undefined,
  });
  // 推给 coach：提示继续 edit+revise（区分 running 断点续跑的 buildResumeMessage）
  await deps.deliverTo(
    task.coachSessionId,
    buildResumeFromPausedMessage(updated, task.coachSessionId),
  ).catch(() => { /* observability 自治 */ });
  return updated;
}

/**
 * adoptVersion：旁路归档（任意 process 版 → 新 formal 版；可重复；不改 task 状态）。
 *
 * **MUST NOT 校验 task.status**（旁路与状态机无关）；**MUST NOT 改 task.acceptedVersionId**
 * （那是旧 acceptTask 字段已废弃，不写）；adoptToFormal 内部校验 input.type==='process'。
 */
export async function adoptVersion(
  deps: TrainingEngineDeps,
  taskId: string,
  classroomId: string,
  processVersionId: string,
): Promise<{ newFormalVersionId: string; newLabel: string; newWorkspaceDir: string }> {
  const store = deps.academyStore;
  const task = await store.getTask(classroomId, taskId);
  if (!task) throw new Error(`adoptVersion: task ${taskId} 不存在`);
  // 旁路：不校验 task.status；adoptToFormal 内部校验 processVersion.type==='process'
  const result = await adoptToFormal(store, deps.dataDir, classroomId, processVersionId);
  // 推给 coach：task 状态未变（旁路）；告知新 formal 已落
  await deps.deliverTo(
    task.coachSessionId,
    buildAdoptedMessage(task, task.coachSessionId, result, processVersionId),
  ).catch(() => { /* observability 自治 */ });
  return result;
}

/**
 * 断点续跑 + 旧 status migration：扫所有 tasks。
 * ① status='running' 保持原断点续跑逻辑（推 buildResumeMessage）；
 * ② 旧 status（done/aborted/rejected/awaiting_confirm）→ migration putTask 重写为
 *    paused+pausedReason（done→completed, aborted/rejected/awaiting_confirm→stopped）；
 * ③ status='paused' 跳过（已是稳态，二次启动幂等）。
 *
 * migration MUST 幂等（不删 record，只重写 status 字段；二次扫 status='paused' 跳过）。
 */
export async function resumeOnStartup(deps: TrainingEngineDeps): Promise<void> {
  const classrooms = await deps.academyStore.listClassrooms();
  for (const cid of classrooms.map((c) => c.id)) {
    const tasks = await deps.academyStore.listTasksByClassroom(cid);
    for (const task of tasks) {
      if (task.status === 'running') {
        await resumeRunningTask(deps, task);
      } else if (LEGACY_STATUS_REASON_MAP[task.status]) {
        // migration：旧值 → paused+pausedReason（幂等：已 paused 的不会进此分支）
        const pausedReason = LEGACY_STATUS_REASON_MAP[task.status] as
          'maxturns' | 'completed' | 'stopped' | 'earlystop';
        await deps.academyStore.putTask({
          ...stripEnvelope(task),
          status: 'paused',
          pausedReason,
        });
        await deps.deliverTo(
          task.coachSessionId,
          buildResumeFromPausedMessage(
            { ...task, status: 'paused', pausedReason },
            task.coachSessionId,
          ),
        ).catch(() => { /* observability 自治 */ });
      }
      // status='paused' 跳过（稳态）；status='pending' 也跳过（未开跑无需 resume）
    }
  }
}

/** 单 task 断点续跑（按 lastTurn 状态分发） */
async function resumeRunningTask(
  deps: TrainingEngineDeps,
  task: TrainingTaskEntity,
): Promise<void> {
  const turns = await deps.academyStore.listTurns(task.classroomId, task.id);
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : undefined;

  if (!lastTurn || lastTurn.status === 'decided' || lastTurn.status === 'adopted') {
    // 上一轮已完整结束 — 提醒 coach 决定下一步
    await deps.deliverTo(
      task.coachSessionId,
      buildResumeMessage(task, lastTurn, task.coachSessionId),
    ).catch(() => { /* observability 自治 */ });
    return;
  }

  // 上一轮中途断（status='running'/'sampled'/'graded'）→ 兜底降级为 graded + 标记需人工
  await deps.academyStore.appendTurn({ ...stripEnvelope(lastTurn), status: 'graded' });
  await deps.deliverTo(
    task.coachSessionId,
    buildResumeNeedManualMessage(task, lastTurn, task.coachSessionId),
  ).catch(() => { /* observability 自治 */ });
}
