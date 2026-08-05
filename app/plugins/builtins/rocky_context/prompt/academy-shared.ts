/**
 * builtin rocky_context plugin — academy mapper 共享工具（v0.0.210 NEW）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §4.1（5 个 academy mapper）
 *
 * 职责：6 个 academy mapper（academy_classroom_role / academy_training_directive /
 *   academy_iteration_state / academy_classroom_assets / academy_classroom_students /
 *   academy_task_status）共用的：
 *   - AcademyContextLike：academyContext 鸭子类型（config.academyContext 的约定形状）
 *   - readAcademyContext：从 PromptCtx 读 academyContext（缺省 undefined）
 *   - readClassroomId / readTrainingTaskId：从 sessionContext 读实例 ID
 *   - readAcademyRole：从 kind.role 派生 academy 三角色之一
 *
 * 单文件 ≤300 行（纯工具，无副作用）。
 */
import type { PromptCtx } from '../types';

/**
 * academy 上下文鸭子类型（SessionConfig.academyContext 的约定形状）。
 * 装配层（academy-context.ts buildAcademyContext）注入：
 *   - classroom：教室 entity（classroomId → academyStore.getClassroom）
 *   - task：训练任务 entity（coach 的 trainingTaskId → academyStore.getTask，含 candidateVersionId）
 *   - candidateWorkspaceDir：当前候选过程版本的 workspaceDir 绝对路径
 *     （coach edit 定位用；由 buildAcademyContext 从 task.candidateVersionId
 *     → academyStore.getVersion 查 workspaceDir 填入，round2+ candidate 换目录时每轮现拉）
 *   - turns：任务轮次历史（academyStore.listTurns）
 *   - datasets / graders / students / tasks：教室资产/学生/任务列表
 *
 * v0.0.221 扩充（design.md §4.2 iteration_state）：
 *   - task.pausedReason：task 停在 paused 时区分为何而停（mapper 注入 resumable 标志用）
 *   - baseVersion：coach 临时基线版本的 workspaceDir 绝对路径（只读参考，修 log 里 coach bash ls 摸路）
 *   - versionLineage：本 task 全部 process 版（round/versionId/label/decision/avgScore/workspaceDir）
 *   - adoptedFormalVersions：本 task 已采纳的 formal 列表（adoptedFromProcessVersionId 非空）
 *   - tasks[].coachSessionId：head send_message 目标（schema 自带，type 闭合即可）
 *
 * 缺省任何字段 → 对应 mapper 返空。
 */
export interface AcademyContextLike {
  classroom?: { id?: string; name?: string; datasetIds?: string[]; graderIds?: string[]; skillIds?: string[] };
  task?: {
    id?: string;
    status?: string;
    /** task 停在 paused 时区分为何而停（maxturns/completed/stopped/earlystop） */
    pausedReason?: string;
    directive?: string;
    currentTurn?: number;
    maxTurns?: number;
    temporaryBaselineVersionId?: string;
    /** 当前 coach 在编辑的候选过程版本 id（与 TrainingTaskSchema 对齐） */
    candidateVersionId?: string;
    taskSeq?: number;
    coachSessionId?: string;
    /** task 的 base formal 版本 id（coach 拉取 baseVersion workspaceDir 用） */
    baseVersionId?: string;
    studentId?: string;
  };
  /** 当前候选过程版本的 workspaceDir 绝对路径（coach edit 定位） */
  candidateWorkspaceDir?: string;
  /**
   * base 版本（task.baseVersionId 解析）的 workspaceDir 绝对路径 + label。
   * iteration_state mapper 注入 prompt 供 coach 读 base AGENTS.md（不靠相对 cwd / bash ls 摸路）。
   */
  baseVersion?: { id?: string; label?: string; workspaceDir?: string };
  /**
   * 本 task 全部 process 版谱系（design.md §4.2 版本谱系；coach 据此选 adopt 目标）。
   * 按 round asc 排序；每项含 round/versionId/label/decision/avgScore/workspaceDir/type。
   */
  versionLineage?: Array<{
    round?: number;
    versionId?: string;
    label?: string;
    decision?: string;
    avgScore?: number;
    workspaceDir?: string;
    type?: string;
    status?: string;
  }>;
  /**
   * 本 task 已采纳 formal 列表（design.md §4.2 已采纳 formal；coach 据此知归档历史）。
   * 过滤 type==='formal' && adoptedFromProcessVersionId 非空 && createdFromTaskId === taskId。
   */
  adoptedFormalVersions?: Array<{
    versionId?: string;
    label?: string;
    adoptedFromProcessVersionId?: string;
    adoptedFromProcessLabel?: string;
  }>;
  turns?: Array<{
    round?: number;
    decision?: string;
    avgScore?: number;
    status?: string;
  }>;
  datasets?: Array<{ id?: string; name?: string; description?: string }>;
  graders?: Array<{ id?: string; name?: string; type?: string }>;
  students?: Array<{
    id?: string;
    name?: string;
    currentFormalVersionId?: string;
    /** 全部版本 id（版本数来源；students mapper 消费） */
    versionIds?: string[];
  }>;
  tasks?: Array<{
    id?: string;
    status?: string;
    taskSeq?: number;
    directive?: string;
    currentTurn?: number;
    maxTurns?: number;
    /** 任务所属学生 id（students mapper 在跑任务交叉键） */
    studentId?: string;
    /** 该 task 绑定的 coach session id（head send_message 目标；schema 自带） */
    coachSessionId?: string;
  }>;
  /** versionId → versionLabel（正式版 label 解析结果；buildAcademyContext head 分支注入） */
  formalVersionLabels?: Record<string, string>;
}

/** academy 三角色之一（head_teacher / coach / student）；其他 role 返 undefined */
export type AcademyRole = 'head_teacher' | 'coach' | 'student';

/** 从 PromptCtx 读 academyContext（缺省 undefined） */
export function readAcademyContext(ctx: PromptCtx): AcademyContextLike | undefined {
  const c = ctx.config as { academyContext?: unknown };
  return c.academyContext as AcademyContextLike | undefined;
}

/** 从 SessionConfig.sessionContext 读 classroomId（缺省 undefined） */
export function readClassroomId(ctx: PromptCtx): string | undefined {
  const sc = (ctx.config as { sessionContext?: { classroomId?: unknown } }).sessionContext;
  const id = sc?.classroomId;
  return typeof id === 'string' && id ? id : undefined;
}

/** 从 SessionConfig.sessionContext 读 trainingTaskId（缺省 undefined） */
export function readTrainingTaskId(ctx: PromptCtx): string | undefined {
  const sc = (ctx.config as { sessionContext?: { trainingTaskId?: unknown } }).sessionContext;
  const id = sc?.trainingTaskId;
  return typeof id === 'string' && id ? id : undefined;
}

/** 从 kind.role 派生 academy 三角色；非 academy role 返 undefined */
export function readAcademyRole(ctx: PromptCtx): AcademyRole | undefined {
  const role = (ctx.config as { kind?: { role?: unknown } }).kind?.role;
  if (role === 'head_teacher' || role === 'coach' || role === 'student') return role;
  return undefined;
}
