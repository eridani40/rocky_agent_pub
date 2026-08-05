/**
 * academy-context — SessionConfig.academyContext 装配 helper（v0.0.210 波4）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §4.1（5 个 academy mapper）
 *       app/plugins/builtins/rocky_context/prompt/academy-shared.ts（AcademyContextLike 鸭子类型）
 *
 * 职责：在 resolveConfig 回调（每轮 prompt 组装都走）按 session kind + sessionContext
 *   从 AcademyStore 现拉 academy 实体，按 role 裁剪后注入 SessionConfig.academyContext，
 *   供 5 个 academy system_prompt_mapper 消费：
 *   - head_teacher：classroom + students/datasets/graders/tasks（教室资产 + 任务看板）
 *   - coach：classroom + task + turns（训练 directive + 迭代状态，每轮变必须现拉）
 *   - student：仅 classroom（其余 mapper 不读）
 *
 * 容错：任一实体查询失败/不存在 → 对应字段 undefined（mapper graceful degrade 返空），
 *   不 throw 阻塞 prompt 组装。
 *
 * 单文件 ≤300 行（纯装配，无副作用）。
 */
import type { SessionKind, SessionContext } from '@app/shared';
import type {
  AcademyStore,
  ClassroomEntity,
  TrainingTaskEntity,
  TrainingTurnEntity,
  DatasetEntity,
  GraderEntity,
  StudentEntity,
} from './academy-store';

/**
 * 注入 SessionConfig.academyContext 的形状。
 * 与 plugin 侧 AcademyContextLike（academy-shared.ts）鸭子类型对齐——
 * entity 是其超集（mapper 只读 id/name/status/directive 等子集字段）。
 *
 * v0.0.221 扩充（design.md §4.2）：
 *   - baseVersion：task.baseVersionId 解析（label + workspaceDir）
 *   - versionLineage：本 task 全部 process 版（filter createdFromTaskId === taskId）
 *   - adoptedFormalVersions：本 task 已采纳 formal（filter type==='formal' && adoptedFromProcessVersionId 非空）
 */
export interface AcademyContextShape {
  classroom?: ClassroomEntity;
  task?: TrainingTaskEntity;
  turns?: TrainingTurnEntity[];
  datasets?: DatasetEntity[];
  graders?: GraderEntity[];
  students?: StudentEntity[];
  tasks?: TrainingTaskEntity[];
  /** versionId → versionLabel（head 分支逐生解析正式版 label；students mapper 消费） */
  formalVersionLabels?: Record<string, string>;
  /**
   * 当前候选过程版本的 workspaceDir 绝对路径。
   * coach 分支由 task.candidateVersionId → getVersion 查 workspaceDir 填入；
   * iteration_state mapper 注入 prompt 供 coach edit 定位（修 cwd 错位）。
   */
  candidateWorkspaceDir?: string;
  /** task.baseVersionId 解析（label + workspaceDir；coach 读 base AGENTS.md 定位） */
  baseVersion?: { id: string; label: string; workspaceDir: string };
  /** 本 task 全部 process 版谱系（按 round asc） */
  versionLineage?: Array<{
    round: number;
    versionId: string;
    label: string;
    decision?: string;
    avgScore?: number;
    workspaceDir: string;
    type: string;
    status?: string;
  }>;
  /** 本 task 已采纳 formal 列表（adoptedFromProcessVersionId 非空） */
  adoptedFormalVersions?: Array<{
    versionId: string;
    label: string;
    adoptedFromProcessVersionId: string;
    adoptedFromProcessLabel?: string;
  }>;
}

/** academy 三角色（其余 role 不注入 academyContext） */
const ACADEMY_ROLES: ReadonlySet<string> = new Set(['head_teacher', 'coach', 'student']);

/**
 * academy session 判定：biz='academy' 或 role ∈ {head_teacher, coach, student}。
 * 非 academy → resolveConfig 不注入 academyContext（mapper 链也不含 academy impl，双保险）。
 */
export function isAcademySessionKind(kind: SessionKind): boolean {
  return kind.biz === 'academy' || ACADEMY_ROLES.has(kind.role);
}

/** 单查询容错包装：失败/异常 → undefined（不阻塞 prompt 组装） */
async function safe<T>(p: Promise<T>): Promise<T | undefined> {
  return p.catch(() => undefined);
}

/**
 * 按 kind.role 裁剪装配 academyContext。
 *
 * @param academyStore   academy 域 store（resolveConfig 闭包注入；生产 = bootstrap store-phase 实例）
 * @param kind           session 身份（biz/role 判定）
 * @param sessionContext 实例 ID 投影（classroomId 必填才注入；coach 还需 trainingTaskId）
 * @returns academy 实体裁剪包；非 academy / 无 classroomId → undefined
 */
export async function buildAcademyContext(input: {
  academyStore: AcademyStore;
  kind: SessionKind;
  sessionContext: SessionContext;
}): Promise<AcademyContextShape | undefined> {
  const { academyStore, kind, sessionContext } = input;
  if (!isAcademySessionKind(kind)) return undefined;
  const classroomId = sessionContext.classroomId;
  if (!classroomId) return undefined;

  // 三 role 都要 classroom（academy_classroom_role mapper 的身份正文数据源）
  const classroom = await safe(academyStore.getClassroom(classroomId));

  if (kind.role === 'head_teacher') {
    // head：教室资产（数据集/评估器）+ 学生 + 任务看板
    const [students, datasets, graders, tasks] = await Promise.all([
      safe(academyStore.listStudentsByClassroom(classroomId)),
      safe(academyStore.listDatasetsByClassroom(classroomId)),
      safe(academyStore.listGradersByClassroom(classroomId)),
      safe(academyStore.listTasksByClassroom(classroomId)),
    ]);
    // 逐生解析当前正式版 label（students mapper 渲染「当前正式版：x.y」用）。
    // safe() 容错：单生 getVersion 失败跳过该生，不阻塞 prompt 组装。
    const formalVersionLabels: Record<string, string> = {};
    if (students) {
      await Promise.all(
        students.map(async (s) => {
          const vid = s.currentFormalVersionId;
          if (!vid) return;
          const v = await safe(academyStore.getVersion(classroomId, vid));
          if (v) formalVersionLabels[vid] = v.versionLabel;
        }),
      );
    }
    return {
      ...(classroom ? { classroom } : {}),
      ...(students ? { students } : {}),
      ...(datasets ? { datasets } : {}),
      ...(graders ? { graders } : {}),
      ...(tasks ? { tasks } : {}),
      ...(Object.keys(formalVersionLabels).length > 0 ? { formalVersionLabels } : {}),
    };
  }

  if (kind.role === 'coach') {
    // coach：当前任务 + 轮次历史（training_directive / iteration_state mapper）
    const taskId = sessionContext.trainingTaskId;
    const task = taskId ? await safe(academyStore.getTask(classroomId, taskId)) : undefined;
    const turns = taskId ? await safe(academyStore.listTurns(classroomId, taskId)) : undefined;
    // candidate workspaceDir 绝对路径（iteration_state 注入 prompt，修 cwd 错位）。
    // task.candidateVersionId 由 schema 自带；缺省/查询失败 → undefined。
    const candidateVersionId = task?.candidateVersionId;
    const candidateVersion = candidateVersionId
      ? await safe(academyStore.getVersion(classroomId, candidateVersionId))
      : undefined;
    const candidateWorkspaceDir = candidateVersion?.workspaceDir;

    // v0.0.221 扩充（design.md §4.2）：base + 版本谱系 + 已采纳 formal
    // 所有读取容错（safe）— 任一失败 graceful 返 undefined 不阻塞 prompt 组装。
    const baseVersionId = task?.baseVersionId;
    const studentId = task?.studentId;
    const baseVersionEntity = baseVersionId
      ? await safe(academyStore.getVersion(classroomId, baseVersionId))
      : undefined;
    const baseVersion = baseVersionEntity
      ? {
          id: baseVersionEntity.id,
          label: baseVersionEntity.versionLabel,
          workspaceDir: baseVersionEntity.workspaceDir,
        }
      : undefined;

    // 版本谱系 + 已采纳 formal：只拉本 task 的版本（filter createdFromTaskId === taskId 是硬条件）
    let versionLineage: AcademyContextShape['versionLineage'] = undefined;
    let adoptedFormalVersions: AcademyContextShape['adoptedFormalVersions'] = undefined;
    if (studentId) {
      const allStudentVersions = await safe(academyStore.listVersions(classroomId, studentId));
      if (allStudentVersions) {
        const taskVersions = allStudentVersions.filter((v) => v.createdFromTaskId === taskId);
        // process 版谱系（按 round asc；含 decision/avgScore 需交叉 turns）
        const processVersions = taskVersions
          .filter((v) => v.type === 'process')
          .sort((a, b) => (a.roundNumber ?? 0) - (b.roundNumber ?? 0));
        if (processVersions.length > 0) {
          // 交叉 turns 取 decision/avgScore（round 匹配）
          const turnByRound = new Map((turns ?? []).map((t) => [t.round, t]));
          versionLineage = processVersions.map((v) => {
            const turn = turnByRound.get(v.roundNumber ?? 0);
            return {
              round: v.roundNumber ?? 0,
              versionId: v.id,
              label: v.versionLabel,
              decision: turn?.decision,
              avgScore: turn?.avgScore,
              workspaceDir: v.workspaceDir,
              type: v.type,
              status: v.status,
            };
          });
        }
        // 已采纳 formal（filter type==='formal' && adoptedFromProcessVersionId 非空）
        const adopted = taskVersions.filter(
          (v) => v.type === 'formal' && v.adoptedFromProcessVersionId,
        );
        if (adopted.length > 0) {
          // 解析 adoptedFromProcessLabel（交叉 process 版）
          const procById = new Map(taskVersions.map((v) => [v.id, v]));
          adoptedFormalVersions = adopted.map((v) => {
            const proc = procById.get(v.adoptedFromProcessVersionId!);
            return {
              versionId: v.id,
              label: v.versionLabel,
              adoptedFromProcessVersionId: v.adoptedFromProcessVersionId!,
              ...(proc ? { adoptedFromProcessLabel: proc.versionLabel } : {}),
            };
          });
        }
      }
    }

    return {
      ...(classroom ? { classroom } : {}),
      ...(task ? { task } : {}),
      ...(turns ? { turns } : {}),
      ...(candidateWorkspaceDir ? { candidateWorkspaceDir } : {}),
      ...(baseVersion ? { baseVersion } : {}),
      ...(versionLineage ? { versionLineage } : {}),
      ...(adoptedFormalVersions ? { adoptedFormalVersions } : {}),
    };
  }

  // student（及其他 academy role 兜底）：仅 classroom
  return classroom ? { classroom } : {};
}
