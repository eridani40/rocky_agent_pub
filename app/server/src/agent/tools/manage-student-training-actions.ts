/**
 * manage-student-training-actions — manage-classroom 的任务监督 action（4 个；helper 模块）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §5.0/§7（统一核心模式）
 *       design.md §3.1（head 任务监督级：start/list/get/update）
 *
 * v0.0.221 模型重构（manage-student 并入 manage-classroom）：
 *   - runStartTraining → runStartTask（语义对齐 start_task；逻辑不变，薄壳调 createTrainingTaskAndCoach）
 *   - runTrainingStatus → runListTasks（看板模式；单 task 详情移到 runGetTask）
 *   - 新增 runGetTask（单 task 详情 + turns；监督级，不下钻 per-case）
 *   - 新增 runUpdateTask（仅 patch maxTurns/directive；不碰 task 内部状态）
 *
 * 设计：head 监督级（实体级 Id），不进 task 内场（task 内场归 coach manage-task）。
 */
import type { ToolInput, ToolRunResult } from '../../tools/types';
import { errorResult, textResult } from '../../tools/types';
import type { AgentToolRuntimeContext } from './runtime-context';
import { str, buildCoreDeps, coreErrorToResult } from './train-student-actions';
import { resolveStudent } from './manage-student-actions';
import { attachBaseVersionLabel } from '../../handlers/academy-training-task-shared';
import {
  createTrainingTaskAndCoach,
  type CreateTrainingTaskInput,
} from '../../academy/academy-training-core';

/** start_task：薄壳调统一核心（建 task + 建 coach + 投递任务书；默认 base=学生当前正式版） */
export async function runStartTask(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  // studentId 或 studentName 解析（歧义/不存在 → resolveStudent 已返候选 errorResult）
  const resolved = await resolveStudent(store, classroomId, input);
  if ('error' in resolved) return resolved.error;
  const student = resolved.student;

  const baseVersionId = str(input.baseVersionId) || student.currentFormalVersionId || '';
  if (!baseVersionId) {
    return errorResult(`manage-classroom.start_task: student ${student.id} has no formal version as base`);
  }
  const mode = str(input.mode, 'multi');
  const optimizeStyle = str(input.optimizeStyle, 'training');
  if (mode !== 'simple' && mode !== 'multi') {
    return errorResult(`manage-classroom.start_task: invalid mode "${mode}"`);
  }
  if (optimizeStyle !== 'learning' && optimizeStyle !== 'training') {
    return errorResult(`manage-classroom.start_task: invalid optimizeStyle "${optimizeStyle}"`);
  }
  const datasetId = typeof input.datasetId === 'string' ? input.datasetId : undefined;
  const graderId = typeof input.graderId === 'string' ? input.graderId : undefined;
  if (mode === 'multi' && (!datasetId || !graderId)) {
    return errorResult('manage-classroom.start_task: multi mode requires datasetId + graderId');
  }
  const coreInput: CreateTrainingTaskInput = {
    classroomId,
    studentId: student.id,
    baseVersionId,
    mode,
    optimizeStyle,
    ...(typeof input.directive === 'string' ? { directive: input.directive } : {}),
    ...(datasetId ? { datasetId } : {}),
    ...(graderId ? { graderId } : {}),
    ...(typeof input.maxTurns === 'number' ? { maxTurns: input.maxTurns } : {}),
  };
  try {
    const result = await createTrainingTaskAndCoach(buildCoreDeps(rtc), coreInput);
    return textResult(JSON.stringify({
      taskId: result.task.id,
      coachSessionId: result.coachSessionId,
      candidateVersionId: result.candidateVersionId,
      candidateWorkspaceDir: result.candidateWorkspaceDir,
    }));
  } catch (e) {
    return coreErrorToResult(e, 'manage-classroom.start_task');
  }
}

/**
 * list_tasks：教室任务看板（可选 studentId/studentName 过滤），按 createdAt 倒序摘要。
 * 单 task 详情走 get_task（design.md §3.1：list 只做看板，get 单独 action）。
 */
export async function runListTasks(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  // 看板模式：可选 student 过滤（studentName 经同一解析，歧义返候选）
  let studentIdFilter = str(input.studentId);
  if (!studentIdFilter && str(input.studentName)) {
    const resolved = await resolveStudent(store, classroomId, input);
    if ('error' in resolved) return resolved.error;
    studentIdFilter = resolved.student.id;
  }
  const tasks = await store.listTasksByClassroom(classroomId);
  const filtered = studentIdFilter ? tasks.filter((t) => t.studentId === studentIdFilter) : tasks;
  // createdAt 倒序（新任务在前；envelope 字段）
  filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const items = filtered.map((t) => ({
    taskId: t.id,
    taskSeq: t.taskSeq,
    studentId: t.studentId,
    coachSessionId: t.coachSessionId,
    status: t.status,
    pausedReason: t.pausedReason ?? null,
    currentTurn: t.currentTurn,
    maxTurns: t.maxTurns,
    directive: t.directive ?? null,
  }));
  return textResult(JSON.stringify(items));
}

/**
 * get_task：单 task 监督级详情（state / round 数 / history 摘要 / 已产出 formal 版本）。
 * head 监督级，不下钻 per-case reasoning（那是 coach 专属，走 manage-task.turn_result）。
 */
export async function runGetTask(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  const taskId = str(input.taskId);
  if (!taskId) return errorResult('manage-classroom.get_task: taskId required');
  const task = await store.getTask(classroomId, taskId);
  if (!task) return errorResult(`manage-classroom.get_task: task ${taskId} not found`);
  const turns = await store.listTurns(classroomId, taskId);
  const history = turns.map((t) => ({
    round: t.round,
    avgScore: t.avgScore,
    decision: t.decision,
    status: t.status,
  }));
  // 反规范化 baseVersionLabel（与 HTTP handler 共享 helper）
  const taskWithLabel = await attachBaseVersionLabel(store, classroomId, task);
  return textResult(JSON.stringify({ task: taskWithLabel, history }));
}

/**
 * update_task：仅 patch maxTurns / directive（其他字段忽略不报错）。
 *
 * 用途（design.md §7.5）：maxTurns 到顶（paused+reason='maxturns'）→ head 调大 maxTurns → coach resume 续训。
 * **MUST NOT 改 task.status / candidateVersionId / temporaryBaselineVersionId**（内部状态，归引擎）。
 */
export async function runUpdateTask(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  const taskId = str(input.taskId);
  if (!taskId) return errorResult('manage-classroom.update_task: taskId required');
  // 校验至少一字段（maxTurns / directive）
  const hasMaxTurns = typeof input.maxTurns === 'number';
  const hasDirective = typeof input.directive === 'string';
  if (!hasMaxTurns && !hasDirective) {
    return errorResult('manage-classroom.update_task: 至少提供 maxTurns 或 directive 之一（其他字段不支持 patch）');
  }
  const existing = await store.getTask(classroomId, taskId);
  if (!existing) return errorResult(`manage-classroom.update_task: task ${taskId} not found`);
  // strip 信封字段
  const { createdAt: _c, updatedAt: _u, version: _v, ...patch } = existing;
  // 仅 patch maxTurns / directive（其他字段忽略，design.md §3.1）
  if (hasMaxTurns) patch.maxTurns = input.maxTurns as number;
  if (hasDirective) patch.directive = input.directive as string;
  await store.putTask(patch);
  return textResult(JSON.stringify({
    taskId,
    ...(hasMaxTurns ? { maxTurns: input.maxTurns } : {}),
    ...(hasDirective ? { directive: input.directive } : {}),
  }));
}
