/**
 * academy-training-core — 两入口统一核心（建训练任务 + 建 coach + 投递任务书）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §5（装配链 + createTrainingTaskAndCoach 5 步）
 *       specs/tech/academy/[P0]training_engine.md §7（任务书投递）
 *       specs/tech/version_logs/v0.0.213/change_plan.md E 节
 *
 * 两入口统一（消除原 train-student-actions.ts start 占位偏离）：
 *   - HTTP handleCreateTask（POST /academy/classroom/:cid/student/:sid/training-task）
 *   - head 工具 train-student start（runStart）
 *   两者都调本核心；薄壳层只做入参解析 + 错误映射。
 *
 * 5 步顺序（护栏——tid 先 gen 满足 C5；candidate 先 fork 才能给 coach 当 workspace）：
 *   1. 校验（classroom/student/base formal/multi 必填 dataset+grader/同 student 无 running）+ taskSeq + tid
 *   2. fork 初始 candidate（round=1 自 base；必填 createdFromTaskId=tid——forkCandidate round 推进依赖）
 *   3. resolveAcademySessionModel + createSession(coach, workspaceDir=candidateWs, trainingTaskId=tid)
 *   4. putTask(coachSessionId, candidateVersionId=初始 candidate, temporaryBaseline=base, status='pending')
 *   5. 读 base resolveVersionContent + 组装 TaskBookPayload → deliverTo(coach, buildTaskBookMessage)
 *
 * 不变量：
 *   - createSession 先于 putTask（C5 coach 必填 trainingTaskId=tid 先 gen）
 *   - coach workspaceDir = 初始 candidate workspaceDir（修原 cwd 错位，coach 默认 cwd=候选）
 *   - fork 初始 candidate 必填 createdFromTaskId=tid（INV：forkCandidate round 推进靠此过滤本任务历史版本）
 *   - deliverTo 失败不阻塞返 201（fire-and-forget；UI 兜底手动指挥）
 *
 * 错误契约：抛 TrainingCoreError(code) → 薄壳层按 TRAINING_CORE_HTTP_STATUS 映射 HTTP 码 / 按 code 转 errorResult。
 */
import { ulid } from '../config/ulid';
import type { AcademyStore, TrainingTaskEntity } from './academy-store';
import type { SessionStore } from '../agent/session-store';
import type { AgentManagerImpl } from '../agent/agent-manager';
import type { AppConfigService } from '../config/app-config-service';
import {
  resolveAcademySessionModel,
  ModelNotConfiguredError,
  type AcademyModelRef,
} from './academy-session-model';
import { forkVersionWorkspace } from './academy-store-ops';
import { resolveVersionContent } from './academy-version-dir';
import {
  buildTaskBookMessage,
  type TaskBookPayload,
  type TaskBookModel,
} from './training-engine/messages';

/** 两入口共享的建训练任务入参（classroomId/studentId 由 caller 从 path/rtc 注入） */
export interface CreateTrainingTaskInput {
  classroomId: string;
  studentId: string;
  baseVersionId: string;
  mode: 'simple' | 'multi';
  optimizeStyle: 'learning' | 'training';
  directive?: string;
  datasetId?: string;
  graderId?: string;
  maxTurns?: number;
}

/** 核心依赖（HTTP AcademyHandlerDeps / 工具 AgentToolRuntimeContext.sessionDeps 双向满足） */
export interface TrainingCoreDeps {
  academyStore: AcademyStore;
  sessionStore: SessionStore;
  agentManager: AgentManagerImpl;
  appConfig: AppConfigService;
  /** dataDir 绝对路径（resolveDataDir 展开后，packaged 护栏 BUG-004） */
  dataDir: string;
}

/** 核心错误码（HTTP handler 按 TRAINING_CORE_HTTP_STATUS 映射；API 18-academy §7 契约） */
export type TrainingCoreErrorCode =
  | 'classroom_not_found'
  | 'student_not_found'
  | 'version_not_found'
  | 'invalid_base_version'
  | 'missing_evaluation_config'
  | 'dataset_not_found'
  | 'grader_not_found'
  | 'task_already_running'
  | 'model_not_configured';

/** 核心抛出的带 code 错误（HTTP handler/tool 各自映射成 HTTP 错误码 / errorResult） */
export class TrainingCoreError extends Error {
  constructor(
    public readonly code: TrainingCoreErrorCode,
    message?: string,
    public readonly detail?: string,
  ) {
    super(message ?? code);
    this.name = 'TrainingCoreError';
  }
}

/** 各 code 对应 HTTP 状态码（HTTP handler 用；API 18-academy §7 错误码契约） */
export const TRAINING_CORE_HTTP_STATUS: Record<TrainingCoreErrorCode, number> = {
  classroom_not_found: 404,
  student_not_found: 404,
  version_not_found: 404,
  dataset_not_found: 404,
  grader_not_found: 404,
  invalid_base_version: 400,
  missing_evaluation_config: 400,
  task_already_running: 409,
  model_not_configured: 400,
};

/**
 * 创建训练任务并装配 coach session（两入口统一核心）。
 * 5 步顺序见文件头注释。返 { task, coachSessionId, candidateVersionId, candidateWorkspaceDir }。
 */
export async function createTrainingTaskAndCoach(
  deps: TrainingCoreDeps,
  input: CreateTrainingTaskInput,
): Promise<{
  task: TrainingTaskEntity;
  coachSessionId: string;
  candidateVersionId: string;
  candidateWorkspaceDir: string;
}> {
  const { academyStore, sessionStore, agentManager, appConfig, dataDir } = deps;
  const { classroomId, studentId, baseVersionId, mode, optimizeStyle } = input;

  // ── 步骤 1：校验 + taskSeq + tid ──────────────────────────
  const classroom = await academyStore.getClassroom(classroomId);
  if (!classroom) throw new TrainingCoreError('classroom_not_found');
  const student = await academyStore.getStudent(classroomId, studentId);
  if (!student) throw new TrainingCoreError('student_not_found');

  const baseVersion = await academyStore.getVersion(classroomId, baseVersionId);
  if (!baseVersion || baseVersion.studentId !== studentId) {
    throw new TrainingCoreError('version_not_found');
  }
  if (baseVersion.type !== 'formal') {
    throw new TrainingCoreError('invalid_base_version');
  }

  // multi 模式必填 datasetId + graderId（同时取 name 供任务书展示）
  let datasetName: string | undefined;
  let graderName: string | undefined;
  if (mode === 'multi') {
    if (!input.datasetId || !input.graderId) {
      throw new TrainingCoreError('missing_evaluation_config');
    }
    const dataset = await academyStore.getDataset(classroomId, input.datasetId);
    if (!dataset) throw new TrainingCoreError('dataset_not_found');
    datasetName = dataset.name;
    const grader = await academyStore.getGrader(classroomId, input.graderId);
    if (!grader) throw new TrainingCoreError('grader_not_found');
    graderName = grader.name;
  }

  // 同 student 已有 pending/running/paused 任务 → 拒（v0.0.221：status enum 三态，
  // awaiting_confirm 删除；但 paused 算「在跑」—— coach 可 resume 续训，不允许多任务并行）
  const existingTasks = await academyStore.listTasksByClassroom(classroomId);
  const hasRunning = existingTasks.some(
    (t) => t.studentId === studentId &&
      ['pending', 'running', 'paused'].includes(t.status),
  );
  if (hasRunning) throw new TrainingCoreError('task_already_running');

  // taskSeq 分配（同 base 下递增）
  const sameBase = existingTasks.filter((t) => t.baseVersionId === baseVersionId);
  const taskSeq = sameBase.length + 1;

  // tid 先 gen（coach session 需绑定 trainingTaskId；validation C5 要求）
  const tid = ulid();

  // ── 步骤 2：fork 初始 candidate（round=1 自 base；必填 createdFromTaskId=tid）────
  // 关键装配契约：createdFromTaskId 必填真实 tid，forkCandidate/reviseCandidate 后续 round 推进
  // 靠 max(process versions where createdFromTaskId===task.id).roundNumber + 1 保唯一。
  const initialCandidate = await forkVersionWorkspace(
    academyStore, dataDir, baseVersionId,
    classroomId, studentId, taskSeq, 1, tid,
  );

  // ── 步骤 3：resolveAcademySessionModel + createSession(coach, ws=candidateWs)──
  const classroomDefault = classroom.defaultModel as AcademyModelRef | undefined;
  let coachModel: { providerId: string; modelId: string };
  try {
    coachModel = resolveAcademySessionModel(appConfig, undefined, classroomDefault);
  } catch (e) {
    if (e instanceof ModelNotConfiguredError) {
      throw new TrainingCoreError(
        'model_not_configured',
        undefined,
        '无法解析教练模型：请先在教室设置中选择默认模型后再发起训练',
      );
    }
    throw e;
  }

  const coachSessionId = ulid();
  await sessionStore.createSession({
    id: coachSessionId,
    title: `coach · ${student.name} · task${taskSeq}`,
    workspaceDir: initialCandidate.workspaceDir,
    biz: 'academy',
    role: 'coach',
    derivation: 'parent',
    classroomId,
    trainingTaskId: tid,
    providerId: coachModel.providerId,
    modelId: coachModel.modelId,
  });

  // ── 步骤 4：putTask（candidateVersionId=初始 candidate；temporaryBaseline=base）──
  const maxTurns = input.maxTurns !== undefined
    ? input.maxTurns
    : (mode === 'multi' ? 5 : 1);
  const task = await academyStore.putTask({
    id: tid,
    classroomId,
    studentId,
    baseVersionId,
    taskSeq,
    coachSessionId,
    mode,
    optimizeStyle,
    maxTurns,
    status: 'pending',
    directive: input.directive,
    currentTurn: 0,
    temporaryBaselineVersionId: baseVersionId,
    candidateVersionId: initialCandidate.versionId,
    ...(input.datasetId !== undefined ? { datasetId: input.datasetId } : {}),
    ...(input.graderId !== undefined ? { graderId: input.graderId } : {}),
  });

  // ── 步骤 5：组装 TaskBookPayload → deliverTo(coach, buildTaskBookMessage) ─────
  const baseContent = await resolveVersionContent(baseVersion.workspaceDir);
  const payload: TaskBookPayload = {
    task,
    classroom: { id: classroomId, name: classroom.name },
    student: { id: studentId, name: student.name },
    baseVersion: {
      id: baseVersionId,
      label: baseVersion.versionLabel,
      agentsMd: baseContent.agentsMd,
      model: extractTaskBookModel(baseContent.versionJson?.model),
    },
    candidateVersion: {
      id: initialCandidate.versionId,
      workspaceDir: initialCandidate.workspaceDir,
    },
    ...(datasetName && input.datasetId
      ? { dataset: { id: input.datasetId, name: datasetName } }
      : {}),
    ...(graderName && input.graderId
      ? { grader: { id: input.graderId, name: graderName } }
      : {}),
    ...(input.directive ? { directive: input.directive } : {}),
  };

  // fire-and-forget：投递失败不阻塞返 201（UI 兜底：用户可在训练观察页手动指挥 coach）
  void Promise.resolve()
    .then(() => agentManager.deliverTo(coachSessionId, buildTaskBookMessage(payload, coachSessionId)))
    .catch((e) => {
      console.warn(
        `[academy-training-core] deliverTo coach 失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    });

  return {
    task,
    coachSessionId,
    candidateVersionId: initialCandidate.versionId,
    candidateWorkspaceDir: initialCandidate.workspaceDir,
  };
}

/** version.json.model → TaskBookModel（容错：缺省 modelId 占位，与 buildTaskBookMessage 展示一致） */
function extractTaskBookModel(
  m: { providerId?: string; modelId: string } | null | undefined,
): TaskBookModel {
  if (!m) return { modelId: '(未配)' };
  return { providerId: m.providerId, modelId: m.modelId };
}
