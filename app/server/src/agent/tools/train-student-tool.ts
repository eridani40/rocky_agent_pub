/**
 * manage-task-tool — academy coach 专属 task 推进工具（原 train-student-tool 重命名）
 * 参考: specs/tech/academy/[P0]train_student_tool.md §1（action 表）+ §3（LLM schema）+ §4（权限矩阵）
 *       specs/tech/academy/[P0]training_engine.md §2/§3（evaluate/revise/forkCandidate + pause/resume/adopt）
 *
 * v0.0.221 模型重构（design.md §3.2）：
 *   - 工具名 `train-student` → `manage-task`（coach 专属，head 不再调）
 *   - action 收敛 13 值（去 start/stop/accept/reject/propose，加 adopt/pause/resume/history）
 *   - ROLE_PERMISSIONS 删 head_teacher 分支（head 不再调本工具，profile.toolBound 双收束）
 *   - taskId 隐式绑定：input.taskId 缺省 = rtc.sessionContext.trainingTaskId；传则必须 ===
 *
 * 单文件 ≤300 行（schema + dispatch + 权限校验；具体 action 实现拆到 train-student-actions.ts）。
 *
 * 注：文件名保留 train-student-tool.ts（git rename detection 更稳）；导出名改为 manageTaskTool。
 */
import type { Tool, ToolInput, ToolRunResult } from '../../tools/types';
import { errorResult, textResult } from '../../tools/types';
import { readRuntimeContext } from './runtime-context';
import type { AgentToolRuntimeContext } from './runtime-context';
import {
  runSample, runGrade, runFork, runEvaluate, runRevise, runAdopt, runPause, runResume, str,
} from './train-student-actions';

/** action 闭合枚举（13 值；coach 专属，head 无权） */
const MANAGE_TASK_ACTIONS = [
  'status', 'turn_result', 'history',
  'evaluate', 'revise', 'fork',
  'sample', 'grade',
  'adopt', 'pause', 'resume',
  'read_dataset', 'read_grader',
] as const;
type ManageTaskAction = (typeof MANAGE_TASK_ACTIONS)[number];

/** 工具层权限矩阵：coach 13 action 全权；head/student 无任何 action（profile.toolBound 双收束） */
const ROLE_PERMISSIONS: Record<string, ReadonlySet<ManageTaskAction>> = {
  // head_teacher 不再调本工具（design.md §1.3：head 不进 task 内场）
  head_teacher: new Set<ManageTaskAction>(),
  // coach 管 evaluate/revise/sample/grade/fork/adopt/pause/resume/status/turn_result/history/read_*
  coach: new Set<ManageTaskAction>([...MANAGE_TASK_ACTIONS]),
  // student 全不可见
  student: new Set<ManageTaskAction>(),
};

function isManageTaskAction(a: string): a is ManageTaskAction {
  return (MANAGE_TASK_ACTIONS as readonly string[]).includes(a);
}

/** 需要 engine 的 action（注入校验用） */
const ENGINE_REQUIRED = new Set<ManageTaskAction>([
  'evaluate', 'revise', 'fork', 'adopt', 'pause', 'resume',
]);

/** 依赖 task 绑定的 action（read_dataset/read_grader 是资产查询不依赖 task） */
const NEEDS_TASK: ReadonlySet<ManageTaskAction> = new Set([
  'status', 'turn_result', 'history',
  'evaluate', 'revise', 'fork', 'sample', 'grade',
  'adopt', 'pause', 'resume',
]);

type ToolCtxLike = { config: { agentToolContext?: unknown } };

/** manage-task 工具（coach 专属；单例导出，registry defaultTools 引用） */
export const manageTaskTool: Tool = {
  definition: {
    name: 'manage-task',
    description:
      'Coach-only task progression tool: atomic evaluation ops (evaluate/revise/sample/grade/fork), ' +
      'lifecycle (adopt/pause/resume), task history (status/turn_result/history), ' +
      'classroom assets read (read_dataset/read_grader). ' +
      'taskId is implicitly bound to rtc.sessionContext.trainingTaskId (coach ↔ task 1:1).',
    intro: 'Manage academy training task progression (coach-only).',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [...MANAGE_TASK_ACTIONS],
          description: 'manage-task action (13 values; coach-only)',
        },
        taskId: { type: 'string', description: 'task id（缺省 = 绑定的 trainingTaskId；传则必须匹配）' },
        versionId: { type: 'string', description: 'evaluate/fork/adopt: 目标 version id' },
        round: { type: 'number', description: 'turn_result: specific round (default: latest)' },
        caseId: { type: 'string', description: 'sample/grade: single case' },
        caseIds: { type: 'array', items: { type: 'string' }, description: 'sample: batch cases' },
        cases: {
          type: 'array',
          items: { type: 'object' },
          description: 'grade batch: [{caseId, studentOutput}]',
        },
        studentOutput: { type: 'string', description: 'grade: pre-sampled student output' },
        reason: { type: 'string', description: 'pause: 可选 reason（stopped/earlystop/maxturns/completed）' },
        datasetId: { type: 'string', description: 'read_dataset: target' },
        graderId: { type: 'string', description: 'read_grader: target' },
        baseVersionId: { type: 'string', description: 'fork: 切历史版作基线（缺省 = 当前临时基线）' },
      },
    },
  },

  async run(input: ToolInput, ctx: ToolCtxLike): Promise<ToolRunResult> {
    const action = String(input.action ?? '').trim();
    if (!isManageTaskAction(action)) {
      return errorResult(`manage-task: invalid action "${action}"`);
    }
    let rtc: AgentToolRuntimeContext;
    try {
      rtc = readRuntimeContext(ctx.config);
    } catch (e) {
      return errorResult(`manage-task: ${e instanceof Error ? e.message : String(e)}`);
    }
    // role 权限校验（spec §4；head 不再有 manage-task 权限）
    const role = rtc.kind?.role;
    if (!role) {
      return errorResult(`manage-task.${action}: missing caller role (rtc.kind undefined)`);
    }
    const allowed = ROLE_PERMISSIONS[role];
    if (!allowed || !allowed.has(action)) {
      return errorResult(`manage-task.${action}: forbidden for role "${role}"（manage-task 是 coach 专属）`);
    }
    if (!rtc.academyStore) {
      return errorResult(`manage-task.${action}: academyStore not injected`);
    }
    if (ENGINE_REQUIRED.has(action) && !rtc.trainingEngine) {
      return errorResult(`manage-task.${action}: trainingEngine not injected`);
    }
    if (!rtc.sessionContext?.classroomId) {
      return errorResult(`manage-task.${action}: caller has no classroomId (not academy session?)`);
    }
    // taskId 隐式绑定（design.md §7.4：coach session ↔ task 1:1）
    const boundTaskId = rtc.sessionContext.trainingTaskId;
    const inputTaskId = str(input.taskId);
    if (inputTaskId) {
      if (!boundTaskId) {
        return errorResult(`manage-task.${action}: input.taskId provided but rtc has no trainingTaskId（无法校验归属）`);
      }
      if (inputTaskId !== boundTaskId) {
        return errorResult(`manage-task.${action}: task_not_bound（input.taskId=${inputTaskId} ≠ rtc.trainingTaskId=${boundTaskId}; manage-task 仅能操作本 session 绑定的 task）`);
      }
    }
    const taskId = boundTaskId;
    try {
      return await dispatch(action, { ...input, taskId }, rtc);
    } catch (e) {
      return errorResult(`manage-task.${action}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

/** action 分发到 store/engine 子模块 */
async function dispatch(
  action: ManageTaskAction, input: ToolInput, rtc: AgentToolRuntimeContext,
): Promise<ToolRunResult> {
  const classroomId = rtc.sessionContext!.classroomId!;
  const store = rtc.academyStore!;
  const taskId = typeof input.taskId === 'string' ? input.taskId : '';
  if (NEEDS_TASK.has(action) && !taskId) {
    return errorResult(`manage-task.${action}: taskId required（rtc.trainingTaskId 未绑定）`);
  }
  switch (action) {
    case 'status': {
      const task = await store.getTask(classroomId, taskId);
      if (!task) return errorResult(`manage-task.status: task ${taskId} not found`);
      const turns = await store.listTurns(classroomId, taskId);
      return textResult(JSON.stringify({ task, history: turns }));
    }
    case 'turn_result': {
      const turns = await store.listTurns(classroomId, taskId);
      if (turns.length === 0) return errorResult(`manage-task.turn_result: task ${taskId} has no turns`);
      const round = typeof input.round === 'number' ? input.round : undefined;
      const turn = round !== undefined ? turns.find((t) => t.round === round) : turns[turns.length - 1];
      if (!turn) return errorResult(`manage-task.turn_result: round ${round} not found`);
      return textResult(JSON.stringify(turn));
    }
    case 'history': {
      const turns = await store.listTurns(classroomId, taskId);
      const summary = turns.map((t) => ({
        round: t.round,
        candidateVersionId: t.candidateVersionId,
        decision: t.decision,
        avgScore: t.avgScore,
        status: t.status,
      }));
      return textResult(JSON.stringify(summary));
    }
    case 'evaluate':
      return runEvaluate(input, rtc, classroomId);
    case 'revise':
      return runRevise(input, rtc, classroomId);
    case 'sample':
      return runSample(input, rtc, classroomId);
    case 'grade':
      return runGrade(input, rtc, classroomId);
    case 'fork':
      return runFork(input, rtc, classroomId);
    case 'adopt':
      return runAdopt(input, rtc, classroomId);
    case 'pause':
      return runPause(input, rtc, classroomId);
    case 'resume':
      return runResume(input, rtc, classroomId);
    case 'read_dataset': {
      const dsId = str(input.datasetId);
      if (!dsId) return errorResult('manage-task.read_dataset: datasetId required');
      const ds = await store.getDataset(classroomId, dsId);
      if (!ds) return errorResult(`manage-task.read_dataset: dataset ${dsId} not found`);
      return textResult(JSON.stringify(ds));
    }
    case 'read_grader': {
      const grId = str(input.graderId);
      if (!grId) return errorResult('manage-task.read_grader: graderId required');
      const gr = await store.getGrader(classroomId, grId);
      if (!gr) return errorResult(`manage-task.read_grader: grader ${grId} not found`);
      return textResult(JSON.stringify(gr));
    }
  }
}
