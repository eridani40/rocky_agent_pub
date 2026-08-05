/**
 * train-student-actions — manage-task 工具各 action 的具体执行逻辑
 * 参考: specs/tech/academy/[P0]train_student_tool.md §2（各 action schema）
 *       specs/tech/academy/[P0]training_engine.md §3（evaluate/revise/forkCandidate + lifecycle）
 *
 * v0.0.221 模型重构（design.md §3.2）：
 *   - 删除 runStart（start 移到 manage-classroom.start_task）
 *   - 新增 runAdopt / runPause / runResume（coach 专属生命周期 action）
 *   - TurnResult.proposed → paused 字段重命名（到顶/早停时 true）
 *
 * 各 action 委派：
 *   - evaluate：纯查询调 engine.evaluateVersion（coach 探查版本表现）
 *   - revise：推进一轮调 engine.reviseCandidate
 *   - fork：调 engine.forkCandidate（切基线时同步 temporaryBaseline）
 *   - sample/grade：直调 training-engine/sample.ts + grade.ts 子模块（容错单步调）
 *   - adopt/pause/resume：调 engine.adoptVersion/pauseTask/resumeTask
 *   - status/turn_result/read_dataset/read_grader：纯 store 读（在 tool 主文件 dispatch 内联）
 *
 * buildCoreDeps/coreErrorToResult/readLlmPort/str 仍被 manage-classroom 域 helper 复用（保留导出）。
 */
import type { ToolInput, ToolRunResult } from '../../tools/types';
import { errorResult, textResult } from '../../tools/types';
import type { AgentToolRuntimeContext } from './runtime-context';
import { resolveVersionContent } from '../../academy/academy-version-dir';
import { sampleOne } from '../../academy/training-engine/sample';
import { gradeOne } from '../../academy/training-engine/grade';
import {
  extractVersionModel,
  extractGraderConfig,
  joinSampleWithCases,
} from '../../academy/training-engine/helpers';
import type { AcademyLlmPort } from '../../academy/training-engine/llm-port';
import {
  TrainingCoreError,
  type TrainingCoreDeps,
} from '../../academy/academy-training-core';
/** 从 rtc.trainingEngine 读 llmPort（engine.deps 私有；structural duck 读出） */
export function readLlmPort(rtc: AgentToolRuntimeContext): AcademyLlmPort | undefined {
  if (!rtc.trainingEngine) return undefined;
  const engine = rtc.trainingEngine as unknown as {
    deps?: { llmPort?: AcademyLlmPort };
  };
  return engine.deps?.llmPort;
}

/** 取 string 入参（缺省返 def 或空串） */
export function str(v: unknown, def?: string): string {
  return typeof v === 'string' ? v : (def ?? '');
}

/** 从 rtc 构造 TrainingCoreDeps（HTTP/工具两入口共享核心的依赖形状；manage-student.start_training 复用） */
export function buildCoreDeps(rtc: AgentToolRuntimeContext): TrainingCoreDeps {
  return {
    academyStore: rtc.academyStore!,
    sessionStore: rtc.store,
    agentManager: rtc.agentManager,
    appConfig: rtc.sessionDeps.appConfig,
    dataDir: rtc.sessionDeps.dataDir,
  };
}

/** 把 TrainingCoreError 映射为 errorResult 文本（保留 code+detail 供 LLM 识别；manage-student.start_training 复用） */
export function coreErrorToResult(e: unknown, prefix: string): ToolRunResult {
  if (e instanceof TrainingCoreError) {
    return errorResult(`${prefix}: ${e.code}${e.detail ? ` — ${e.detail}` : ''}`);
  }
  return errorResult(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
}

/** evaluate：纯查询调 engine.evaluateVersion（coach 探查版本表现，不改状态） */
export async function runEvaluate(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const engine = rtc.trainingEngine;
  if (!engine) return errorResult('manage-task.evaluate: trainingEngine not injected');
  const taskId = str(input.taskId);
  if (!taskId) return errorResult('manage-task.evaluate: taskId required');
  const versionId = typeof input.versionId === 'string' ? input.versionId : undefined;
  try {
    const result = await engine.evaluateVersion(taskId, classroomId, versionId);
    return textResult(JSON.stringify(result));
  } catch (e) {
    return errorResult(`manage-task.evaluate: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** revise：推进一轮调 engine.reviseCandidate（improve 时候选晋升 + fork 新 candidate） */
export async function runRevise(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const engine = rtc.trainingEngine;
  if (!engine) return errorResult('manage-task.revise: trainingEngine not injected');
  const taskId = str(input.taskId);
  if (!taskId) return errorResult('manage-task.revise: taskId required');
  try {
    const r = await engine.reviseCandidate(taskId, classroomId);
    // 回推新 candidate versionId（improve 时 fork 出的下一轮候选；coach 下轮 edit 定位用，
    // 对应 workspaceDir 由 iteration_state mapper 注入）
    const newCandidateVersionId = r.task.candidateVersionId;
    return textResult(JSON.stringify({
      task: r.task,
      turn: r.turn,
      paused: r.paused,
      ...(newCandidateVersionId ? { candidateVersionId: newCandidateVersionId } : {}),
    }));
  } catch (e) {
    return errorResult(`manage-task.revise: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** sample：直调 sampleOne（dataset case 直调 LlmPort；coach 容错场景，推荐用 evaluate 替代） */
export async function runSample(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  const taskId = str(input.taskId);
  if (!taskId) return errorResult('manage-task.sample: taskId required');
  const task = await store.getTask(classroomId, taskId);
  if (!task) return errorResult(`manage-task.sample: task ${taskId} not found`);
  if (!task.temporaryBaselineVersionId) return errorResult(`manage-task.sample: task ${taskId} no baseline`);
  if (!task.datasetId) return errorResult('manage-task.sample: task has no datasetId');
  const version = await store.getVersion(classroomId, task.temporaryBaselineVersionId);
  if (!version) return errorResult(`manage-task.sample: version ${task.temporaryBaselineVersionId} not found`);
  const versionContent = await resolveVersionContent(version.workspaceDir);
  const ds = await store.getDataset(classroomId, task.datasetId);
  if (!ds) return errorResult(`manage-task.sample: dataset ${task.datasetId} not found`);
  const items = ds.items as Array<{ id: string; question: string }>;
  const caseIds = Array.isArray(input.caseIds) ? input.caseIds.map(String)
    : typeof input.caseId === 'string' ? [input.caseId]
    : items.map((i) => i.id);
  const cases = caseIds
    .map((cid) => items.find((i) => i.id === cid))
    .filter((c): c is { id: string; question: string } => c !== undefined);
  const llmPort = readLlmPort(rtc);
  if (!llmPort) return errorResult('manage-task.sample: llmPort not accessible (engine.deps hidden)');
  const results = await Promise.all(
    cases.map((c) => sampleOne(llmPort, versionContent, { id: c.id, question: c.question })),
  );
  return textResult(JSON.stringify(results));
}

/** grade：直调 gradeOne（em 纯函数 / llm-judge 直调；coach 容错场景，推荐用 evaluate 替代） */
export async function runGrade(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  const taskId = str(input.taskId);
  if (!taskId) return errorResult('manage-task.grade: taskId required');
  const task = await store.getTask(classroomId, taskId);
  if (!task) return errorResult(`manage-task.grade: task ${taskId} not found`);
  if (!task.graderId) return errorResult('manage-task.grade: task has no graderId');
  if (!task.datasetId) return errorResult('manage-task.grade: task has no datasetId');
  const grader = await store.getGrader(classroomId, task.graderId);
  if (!grader) return errorResult(`manage-task.grade: grader ${task.graderId} not found`);
  const ds = await store.getDataset(classroomId, task.datasetId);
  if (!ds) return errorResult(`manage-task.grade: dataset ${task.datasetId} not found`);
  const items = ds.items as Array<{ id: string; question: string; gradingCriteria?: string; expectedAnswer?: string }>;
  type Pair = { caseId: string; studentOutput: string };
  const pairs: Pair[] = Array.isArray(input.cases) && input.cases
    ? (input.cases as Pair[]).map((p) => ({ caseId: String(p.caseId), studentOutput: String(p.studentOutput) }))
    : typeof input.caseId === 'string' && typeof input.studentOutput === 'string'
      ? [{ caseId: input.caseId, studentOutput: input.studentOutput }]
      : [];
  if (pairs.length === 0) return errorResult('manage-task.grade: caseId+studentOutput or cases[] required');
  const llmPort = readLlmPort(rtc);
  if (!llmPort) return errorResult('manage-task.grade: llmPort not accessible (engine.deps hidden)');
  const baselineVersion = task.temporaryBaselineVersionId
    ? await store.getVersion(classroomId, task.temporaryBaselineVersionId)
    : undefined;
  const versionContent = baselineVersion ? await resolveVersionContent(baselineVersion.workspaceDir) : undefined;
  const fallbackModel = extractVersionModel(versionContent?.versionJson?.model);
  const joined = joinSampleWithCases(
    pairs.map((p) => ({ caseId: p.caseId, studentOutput: p.studentOutput, rateLimited: false })),
    items,
  );
  const results = await Promise.all(
    joined.map((c) => gradeOne({
      llmPort,
      grader: extractGraderConfig({
        ...grader,
        matchRule: grader.matchRule as { caseInsensitive?: boolean; trim?: boolean } | undefined,
      }),
      fallbackStudentModel: fallbackModel,
      caseInput: c,
    })),
  );
  return textResult(JSON.stringify(results));
}

/** fork：调 engine.forkCandidate（统一通过 engine 暴露 + 更新 task.candidateVersionId） */
export async function runFork(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const engine = rtc.trainingEngine;
  if (!engine) return errorResult('manage-task.fork: trainingEngine not injected');
  const taskId = str(input.taskId);
  if (!taskId) return errorResult('manage-task.fork: taskId required');
  const baseVersionId = typeof input.baseVersionId === 'string' ? input.baseVersionId : undefined;
  try {
    const result = await engine.forkCandidate(taskId, classroomId, baseVersionId);
    return textResult(JSON.stringify({
      versionId: result.versionId,
      workspaceDir: result.workspaceDir,
    }));
  } catch (e) {
    return errorResult(`manage-task.fork: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * adopt：调 engine.adoptVersion（任意 process 版 → 新 formal；旁路，不改 task 状态；可重复）。
 * 入参 taskId + versionId（必填，指定具体 process 版）。
 */
export async function runAdopt(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const engine = rtc.trainingEngine;
  if (!engine) return errorResult('manage-task.adopt: trainingEngine not injected');
  const taskId = str(input.taskId);
  if (!taskId) return errorResult('manage-task.adopt: taskId required');
  const versionId = str(input.versionId);
  if (!versionId) return errorResult('manage-task.adopt: versionId required（指定要采纳的 process 版本）');
  try {
    const result = await engine.adoptVersion(taskId, classroomId, versionId);
    return textResult(JSON.stringify(result));
  } catch (e) {
    return errorResult(`manage-task.adopt: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** pause：调 engine.pauseTask（reason 可选，缺省 'stopped'） */
export async function runPause(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const engine = rtc.trainingEngine;
  if (!engine) return errorResult('manage-task.pause: trainingEngine not injected');
  const taskId = str(input.taskId);
  if (!taskId) return errorResult('manage-task.pause: taskId required');
  const reason = typeof input.reason === 'string'
    ? (input.reason as 'stopped' | 'earlystop' | 'maxturns' | 'completed')
    : undefined;
  try {
    const task = await engine.pauseTask(taskId, classroomId, reason);
    return textResult(JSON.stringify({ taskId, status: task.status, pausedReason: task.pausedReason }));
  } catch (e) {
    return errorResult(`manage-task.pause: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * resume：调 engine.resumeTask（paused → running）。
 * catch `task_at_maxturns` 错 → errorResult 提示「maxTurns 到顶，先调 manage-classroom update_task 调大」。
 */
export async function runResume(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const engine = rtc.trainingEngine;
  if (!engine) return errorResult('manage-task.resume: trainingEngine not injected');
  const taskId = str(input.taskId);
  if (!taskId) return errorResult('manage-task.resume: taskId required');
  try {
    const task = await engine.resumeTask(taskId, classroomId);
    return textResult(JSON.stringify({ taskId, status: task.status }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/task_at_maxturns/.test(msg)) {
      return errorResult(
        `manage-task.resume: ${msg}（提示：maxTurns 到顶是硬上限，请让 head_teacher 通过 manage-classroom.update_task 调大 maxTurns 后再 resume）`,
      );
    }
    return errorResult(`manage-task.resume: ${msg}`);
  }
}
