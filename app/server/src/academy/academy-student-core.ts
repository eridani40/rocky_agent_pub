/**
 * academy-student-core — 建学生两入口统一核心（HTTP handleCreateStudent + manage-student.create_student）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §5.0（两入口统一核心模式，仿 createTrainingTaskAndCoach）
 *       specs/tech/version_logs/v0.0.215/change_plan.md
 *
 * 编排（从 handleCreateStudent 平移，不改编排）：
 *   1. classroom 存在校验 + name 校验
 *   2. resolveAcademySessionModel 播种（input.model → classroom.defaultModel → 未配则 model_not_configured；v0.0.230 去 app 默认兜底；禁写死保留字——训练 sample 读 version.json.model 直调 LLM）
 *   3. putStudent → createInitialFormalVersion（0.0 空版）→ 回写 currentFormalVersionId + versionIds
 *   4. getVersion 重读 initialVersion → 返 { student, initialVersion }（与 HTTP 201 响应形状一致）
 *
 * 错误契约：抛 StudentCoreError(code) → HTTP 按 STUDENT_CORE_HTTP_STATUS 映射 / 工具按 code 转 errorResult。
 * 不依赖 HTTP Request/Response（纯核心，两入口共享）。
 */
import { ulid } from '../config/ulid';
import type { AcademyStore, StudentEntity, StudentVersionEntity } from './academy-store';
import type { AppConfigService } from '../config/app-config-service';
import { createInitialFormalVersion } from './academy-store-ops';
import {
  resolveAcademySessionModel,
  ModelNotConfiguredError,
  type AcademyModelRef,
} from './academy-session-model';

/** 核心错误码（HTTP 按 STUDENT_CORE_HTTP_STATUS 映射；manage-student 按 code 转 errorResult） */
export type StudentCoreErrorCode = 'classroom_not_found' | 'model_not_configured' | 'invalid_input';

/** 核心抛出的带 code 错误（HTTP handler / 工具各自映射） */
export class StudentCoreError extends Error {
  constructor(
    public readonly code: StudentCoreErrorCode,
    message?: string,
    public readonly detail?: string,
  ) {
    super(message ?? code);
    this.name = 'StudentCoreError';
  }
}

/** 各 code 对应 HTTP 状态码（与 handleCreateStudent 现状一致） */
export const STUDENT_CORE_HTTP_STATUS: Record<StudentCoreErrorCode, number> = {
  classroom_not_found: 404,
  model_not_configured: 400,
  invalid_input: 400,
};

/** 核心依赖（HTTP AcademyHandlerDeps / 工具 sessionDeps 双向满足，同 TrainingCoreDeps 风格） */
export interface StudentCoreDeps {
  academyStore: AcademyStore;
  appConfig: AppConfigService;
  /** dataDir 绝对路径（resolveDataDir 展开后，packaged 护栏 BUG-004） */
  dataDir: string;
}

/** 建学生入参（classroomId 由 caller 从 path/rtc 注入） */
export interface CreateStudentCoreInput {
  classroomId: string;
  name: string;
  logo?: string;
  /** 初始模型快照（缺省 → classroom.defaultModel → 未配则 model_not_configured；v0.0.230 去 app 默认兜底） */
  model?: { providerId?: string; modelId: string };
}

/**
 * 建学生 + 0.0 初始正式版本（两入口统一核心）。
 * 返 { student, initialVersion }（initialVersion 经 getVersion 重读，与 HTTP 响应形状一致）。
 */
export async function createStudentWithInitialVersion(
  deps: StudentCoreDeps,
  input: CreateStudentCoreInput,
): Promise<{ student: StudentEntity; initialVersion: StudentVersionEntity | undefined }> {
  const { academyStore, appConfig, dataDir } = deps;

  // ── 1. 校验 ─────────────────────────────────────────────
  const classroom = await academyStore.getClassroom(input.classroomId);
  if (!classroom) throw new StudentCoreError('classroom_not_found');
  if (!input.name || input.name.length === 0) {
    throw new StudentCoreError('invalid_input', undefined, 'name required');
  }

  // ── 2. 初始模型播种（五元组契约：version.json 必须自含真 providerId+modelId）──
  // CrudStore json 字段读侧 unknown，按 AcademyModelRef 形断言（写入侧已严控形状）。
  const classroomDefaultModel = classroom.defaultModel as AcademyModelRef | undefined;
  let seedModel: { providerId: string; modelId: string };
  try {
    seedModel = resolveAcademySessionModel(appConfig, input.model, classroomDefaultModel);
  } catch (e) {
    if (e instanceof ModelNotConfiguredError) {
      throw new StudentCoreError(
        'model_not_configured',
        undefined,
        '无法解析学生初始模型：请先在教室设置中选择默认模型，或在创建请求显式提供 model.providerId + model.modelId',
      );
    }
    throw e;
  }

  // ── 3. student record → 0.0 初始版本 → 回写 ──────────────
  const sid = ulid();
  const student = await academyStore.putStudent({
    id: sid,
    classroomId: input.classroomId,
    name: input.name,
    ...(input.logo !== undefined ? { logo: input.logo } : {}),
  });
  const initial = await createInitialFormalVersion(
    academyStore, dataDir, input.classroomId, sid, seedModel,
  );
  // strip 信封字段（putAsync 会重算）后回写版本指针
  const { createdAt: _c, updatedAt: _u, version: _v, ...sRec } = student;
  const updatedStudent = await academyStore.putStudent({
    ...sRec,
    currentFormalVersionId: initial.versionId,
    versionIds: [initial.versionId],
  });

  // ── 4. 重读 initialVersion（与 HTTP 201 响应形状一致）────
  const initialVersion = await academyStore.getVersion(input.classroomId, initial.versionId);
  return { student: updatedStudent, initialVersion };
}
