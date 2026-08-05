/**
 * manage-student-actions — manage-student 工具的学生 CRUD + 版本读取 action 实现
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §7（manage-student 工具契约）
 *       specs/tech/version_logs/v0.0.215/change_plan.md
 *
 * 拆分原因：manage-student-tool.ts 主文件只做 schema/role 门/dispatch（仿 manage-classroom 两文件结构）。
 * 本文件 = 学生域 7 action（list/get/create/update/delete student + list_versions/get_version）；
 * 训练域 2 action（start_training/training_status）在 manage-student-training-actions.ts。
 *
 * delete_student 语义：在跑任务（pending/running/awaiting_confirm）守卫拒绝；
 *   级联硬删（CrudStore 查询侧不过滤 _deleted，软删会污染 mapper 数据源）——
 *   全部 version records + student record + fs.rm studentRoot。不可恢复。
 */
import { rm, readdir } from 'node:fs/promises';
import type { ToolInput, ToolRunResult } from '../../tools/types';
import { errorResult, textResult } from '../../tools/types';
import type { AgentToolRuntimeContext } from './runtime-context';
import { str } from './train-student-actions';
import type { AcademyStore, StudentEntity, TrainingTaskEntity } from '../../academy/academy-store';
import { StudentSchema, StudentVersionSchema } from '../../academy/schema_defs';
import type { CompositeStore } from '../../persistence/composite';
import { studentRoot } from '../../academy/academy-paths';
import { resolveVersionContent } from '../../academy/academy-version-dir';
import { createStudentWithInitialVersion, StudentCoreError } from '../../academy/academy-student-core';

/** 在跑任务状态闭合集（delete 守卫 + enrich 交叉共用） */
export const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'paused']);

/** 名字二段匹配：先精确（大小写不敏感），后子串；无 name 过滤 → 全量 */
export function matchStudentsByName(students: StudentEntity[], name: string): StudentEntity[] {
  const lower = name.toLowerCase();
  const exact = students.filter((s) => s.name.toLowerCase() === lower);
  if (exact.length > 0) return exact;
  return students.filter((s) => s.name.toLowerCase().includes(lower));
}

/** 学生 enrich：正式版 label + 版本数 + 在跑任务交叉 */
async function enrichStudent(
  store: AcademyStore, classroomId: string, student: StudentEntity, tasks: TrainingTaskEntity[],
): Promise<Record<string, unknown>> {
  const vid = student.currentFormalVersionId;
  const formal = vid ? await store.getVersion(classroomId, vid) : undefined;
  const versionIds = (student.versionIds as string[] | undefined) ?? [];
  const activeTasks = tasks
    .filter((t) => t.studentId === student.id && ACTIVE_TASK_STATUSES.has(t.status))
    .map((t) => ({
      taskId: t.id, taskSeq: t.taskSeq, status: t.status,
      currentTurn: t.currentTurn, maxTurns: t.maxTurns,
    }));
  return {
    id: student.id,
    name: student.name,
    ...(student.logo !== undefined ? { logo: student.logo } : {}),
    currentFormalVersionId: vid ?? null,
    currentFormalVersionLabel: formal?.versionLabel ?? null,
    versionCount: versionIds.length,
    activeTasks,
  };
}

/**
 * 按 studentId 或 studentName 解析单生。
 * 返 { student } 或 { error }（不存在 / 名字歧义返候选列表 errorResult）。
 */
export async function resolveStudent(
  store: AcademyStore, classroomId: string, input: ToolInput,
): Promise<{ student: StudentEntity } | { error: ToolRunResult }> {
  const studentId = str(input.studentId);
  if (studentId) {
    const student = await store.getStudent(classroomId, studentId);
    if (!student) return { error: errorResult(`manage-student: student ${studentId} not found`) };
    return { student };
  }
  const studentName = str(input.studentName);
  if (!studentName) return { error: errorResult('manage-student: studentId or studentName required') };
  const all = await store.listStudentsByClassroom(classroomId);
  const matched = matchStudentsByName(all, studentName);
  if (matched.length === 0) {
    return { error: errorResult(`manage-student: no student matches name "${studentName}"`) };
  }
  if (matched.length > 1) {
    const candidates = matched.map((s) => ({ id: s.id, name: s.name }));
    return {
      error: errorResult(
        `manage-student: name "${studentName}" is ambiguous, candidates: ${JSON.stringify(candidates)}`,
      ),
    };
  }
  return { student: matched[0]! };
}

/** list_students：全量 + 可选 name 过滤（二段匹配）+ 逐生 enrich；匹配不到返空数组不报错 */
export async function runListStudents(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  const all = await store.listStudentsByClassroom(classroomId);
  const nameFilter = str(input.name);
  const students = nameFilter ? matchStudentsByName(all, nameFilter) : all;
  const tasks = await store.listTasksByClassroom(classroomId);
  const items = await Promise.all(
    students.map((s) => enrichStudent(store, classroomId, s, tasks)),
  );
  return textResult(JSON.stringify(items));
}

/** get_student：按 studentId 或 studentName 取单生 + enrich 摘要 */
export async function runGetStudent(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  const resolved = await resolveStudent(store, classroomId, input);
  if ('error' in resolved) return resolved.error;
  const tasks = await store.listTasksByClassroom(classroomId);
  return textResult(JSON.stringify(await enrichStudent(store, classroomId, resolved.student, tasks)));
}

/** create_student：薄壳调 createStudentWithInitialVersion 统一核心（不重写建 0.0 版逻辑） */
export async function runCreateStudent(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const name = str(input.name);
  if (!name) return errorResult('manage-student.create_student: name required');
  try {
    const result = await createStudentWithInitialVersion(
      {
        academyStore: rtc.academyStore!,
        appConfig: rtc.sessionDeps.appConfig,
        dataDir: rtc.sessionDeps.dataDir,
      },
      {
        classroomId,
        name,
        ...(typeof input.logo === 'string' ? { logo: input.logo } : {}),
        ...(input.model !== undefined
          ? { model: input.model as { providerId?: string; modelId: string } }
          : {}),
      },
    );
    return textResult(JSON.stringify(result));
  } catch (e) {
    if (e instanceof StudentCoreError) {
      return errorResult(`manage-student.create_student: ${e.code}${e.detail ? ` — ${e.detail}` : ''}`);
    }
    return errorResult(`manage-student.create_student: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** update_student：只允许 patch name/logo */
export async function runUpdateStudent(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  const studentId = str(input.studentId);
  if (!studentId) return errorResult('manage-student.update_student: studentId required');
  const existing = await store.getStudent(classroomId, studentId);
  if (!existing) return errorResult(`manage-student.update_student: student ${studentId} not found`);
  // strip 信封字段（CrudStore put 不接受 createdAt/updatedAt/version）
  const { createdAt: _c, updatedAt: _u, version: _v, ...patch } = existing;
  if (typeof input.name === 'string') patch.name = input.name;
  if (typeof input.logo === 'string') patch.logo = input.logo;
  await store.putStudent(patch);
  return textResult(JSON.stringify({ id: studentId }));
}

/**
 * delete_student：在跑任务守卫 + 级联硬删（version records + student record + studentRoot 目录）。
 * 不可恢复（工具 description 已明示）。
 */
export async function runDeleteStudent(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  const studentId = str(input.studentId);
  if (!studentId) return errorResult('manage-student.delete_student: studentId required');
  const existing = await store.getStudent(classroomId, studentId);
  if (!existing) return errorResult(`manage-student.delete_student: student ${studentId} not found`);
  // 守卫：有在跑任务 → 拒绝（提示先 stop）
  const tasks = await store.listTasksByClassroom(classroomId);
  const active = tasks.filter((t) => t.studentId === studentId && ACTIVE_TASK_STATUSES.has(t.status));
  if (active.length > 0) {
    const desc = active.map((t) => `#${t.taskSeq} ${t.status}`).join('；');
    return errorResult(
      `manage-student: student has active tasks (${desc}); pause them first (coach 调 manage-task.pause)`,
    );
  }
  // 级联硬删：全部 version records → student record → workspace 目录树
  // （getCrud() 声明类型是 CrudStore 接口（无 deleteAsync）；实际实例是 CompositeStore，断言收窄）
  const crud = store.getCrud() as CompositeStore;
  const versions = await store.listVersions(classroomId, studentId);
  for (const v of versions) {
    await crud.deleteAsync(StudentVersionSchema, v.id, classroomId);
  }
  await crud.deleteAsync(StudentSchema, studentId, classroomId);
  await rm(studentRoot(rtc.sessionDeps.dataDir, classroomId, studentId), { recursive: true, force: true });
  return textResult(JSON.stringify({ id: studentId, deleted: true, deletedVersions: versions.length }));
}

/** list_versions：某学生全部版本摘要（label/type/status/taskSeq/round） */
export async function runListVersions(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  const studentId = str(input.studentId);
  if (!studentId) return errorResult('manage-student.list_versions: studentId required');
  const student = await store.getStudent(classroomId, studentId);
  if (!student) return errorResult(`manage-student.list_versions: student ${studentId} not found`);
  const versions = await store.listVersions(classroomId, studentId);
  const items = versions.map((v) => ({
    versionId: v.id,
    versionLabel: v.versionLabel,
    type: v.type,
    status: v.status ?? null,
    taskSeq: v.taskSeq ?? null,
    round: v.roundNumber ?? null,
  }));
  return textResult(JSON.stringify(items));
}

/**
 * get_version：版本五元组读取（AGENTS.md 全文 / model / tools / skillNames / memoryFiles）。
 * 缺 version.json → model/tools 返 null 不报错。
 */
export async function runGetVersion(
  input: ToolInput, rtc: AgentToolRuntimeContext, classroomId: string,
): Promise<ToolRunResult> {
  const store = rtc.academyStore!;
  const versionId = str(input.versionId);
  if (!versionId) return errorResult('manage-student.get_version: versionId required');
  const version = await store.getVersion(classroomId, versionId);
  if (!version) return errorResult(`manage-student.get_version: version ${versionId} not found`);
  const content = await resolveVersionContent(version.workspaceDir);
  // memory 文件名列表（目录缺失/读失败 → []，不阻塞）
  const memoryFiles = await readdir(content.memoryDir).catch(() => [] as string[]);
  return textResult(JSON.stringify({
    versionId: version.id,
    studentId: version.studentId,
    versionLabel: version.versionLabel,
    type: version.type,
    status: version.status ?? null,
    agentsMd: content.agentsMd,
    model: content.versionJson?.model ?? null,
    tools: content.versionJson?.tools ?? null,
    skillNames: content.skillNames,
    memoryFiles,
  }));
}
