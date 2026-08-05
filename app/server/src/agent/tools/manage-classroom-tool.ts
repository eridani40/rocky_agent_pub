/**
 * manage-classroom-tool — head 教室资产管理工具（20 action）
 * 参考: specs/tech/academy/[P0]train_student_tool.md §7（错误码）
 *       specs/tech/academy/[P0]session_kind_extension.md §3.1/§7（profile.toolBound + 20 action）
 *
 * v0.0.221 模型重构（design.md §3.1）：原 9 action（dataset/grader/skill）+ 学生 CRUD 7
 * （manage-student 并入）+ 任务监督 4（start_task/list_tasks/get_task/update_task）= 20 action。
 *
 * 设计：head 独有工具；coach/student profile.toolBound 不含 → resolveToolSet 自动裁剪。
 * 工具层额外做 role 兜底校验（防御）。
 *
 * 实现拆分（保持单文件 ≤300 行）：
 *   - 主壳（本文件）：schema + role 门 + dispatch switch
 *   - 资产 9 action：manage-classroom-assets-actions.ts
 *   - 学生 CRUD 7 action：manage-student-actions.ts（helper，保留原文件）
 *   - 任务监督 4 action：manage-student-training-actions.ts（helper，重命名导出）
 */
import type { Tool, ToolInput, ToolRunResult } from '../../tools/types';
import { errorResult } from '../../tools/types';
import { readRuntimeContext } from './runtime-context';
import { ASSET_ACTIONS, dispatchAssetAction, type AssetAction } from './manage-classroom-assets-actions';
import {
  runListStudents, runGetStudent, runCreateStudent, runUpdateStudent, runDeleteStudent,
  runListVersions, runGetVersion,
  ACTIVE_TASK_STATUSES,
} from './manage-student-actions';
import {
  runStartTask, runListTasks, runGetTask, runUpdateTask,
} from './manage-student-training-actions';

/** 学生 CRUD action（7 值，来自原 manage-student） */
const STUDENT_ACTIONS = [
  'list_students', 'get_student', 'create_student', 'update_student', 'delete_student',
  'list_versions', 'get_version',
] as const;
type StudentAction = (typeof STUDENT_ACTIONS)[number];

/** 任务监督 action（4 值；start_training→start_task / training_status→list_tasks + get_task + update_task） */
const TASK_ACTIONS = [
  'start_task', 'list_tasks', 'get_task', 'update_task',
] as const;
type TaskAction = (typeof TASK_ACTIONS)[number];

/** 20 action 闭合枚举 */
const MANAGE_ACTIONS = [
  ...ASSET_ACTIONS,
  ...STUDENT_ACTIONS,
  ...TASK_ACTIONS,
] as const;
type ManageAction = (typeof MANAGE_ACTIONS)[number];

function isManageAction(a: string): a is ManageAction {
  return (MANAGE_ACTIONS as readonly string[]).includes(a);
}

type ToolCtxLike = { config: { agentToolContext?: unknown } };

/** manage-classroom 工具（head 独有；单例导出） */
export const manageClassroomTool: Tool = {
  definition: {
    name: 'manage-classroom',
    description:
      'Manage classroom (head_teacher only): classroom assets (datasets/graders/skills CRUD), ' +
      'student CRUD + version reading (list_students/get_student/create_student/update_student/delete_student/' +
      'list_versions/get_version), task supervision (start_task/list_tasks/get_task/update_task). ' +
      'task-internal actions (evaluate/revise/adopt/pause/resume) belong to coach (manage-task); ' +
      'head coordinates via send_message to coach. ' +
      'ACTIVE_TASK_STATUSES 含 paused（v0.0.221 三态）。',
    intro: 'Manage classroom assets, students, and task supervision (head only).',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [...MANAGE_ACTIONS],
          description: 'manage-classroom action (20 values)',
        },
        // ── dataset/grader 资产字段（原 9 action 不变）──
        datasetId: { type: 'string', description: 'update_dataset/delete_dataset 目标' },
        graderId: { type: 'string', description: 'update_grader/delete_grader 目标' },
        name: { type: 'string', description: 'add_*/create_student: 名称；list_students 可选过滤' },
        description: { type: 'string', description: 'add_dataset/update_dataset: 数据集说明' },
        items: {
          type: 'array',
          items: { type: 'object' },
          description: 'add_dataset/update_dataset 必填：[{id,question,gradingCriteria?,expectedAnswer?}]',
        },
        type: { type: 'string', enum: ['llm-judge', 'em'], description: 'add_grader 必填：评估器类型' },
        promptTemplate: { type: 'string', description: 'llm-judge 必填（含 {question}/{student_output}/{criteria}）' },
        providerId: { type: 'string', description: 'llm-judge 可选 judge provider' },
        modelId: { type: 'string', description: 'llm-judge 可选 judge model' },
        threshold: { type: 'number', description: 'llm-judge 阈值（默认 0.5）' },
        matchRule: {
          type: 'object',
          description: 'em 可选匹配规则：{caseInsensitive?, trim?}',
          properties: { caseInsensitive: { type: 'boolean' }, trim: { type: 'boolean' } },
        },
        skillName: { type: 'string', description: 'install_skill: 目标 skill 名（占位）' },
        skillSource: { type: 'string', description: 'install_skill: 来源（占位）' },
        // ── 学生 CRUD 字段（manage-student 原 9 字段）──
        studentId: { type: 'string', description: '目标学生 id' },
        studentName: { type: 'string', description: '按名字解析学生（二段匹配）' },
        logo: { type: 'string', description: 'create/update_student 可选：学生 logo' },
        model: {
          type: 'object',
          description: 'create_student 可选：初始模型 {providerId?, modelId}',
          properties: { providerId: { type: 'string' }, modelId: { type: 'string' } },
        },
        versionId: { type: 'string', description: 'get_version 目标版本 id' },
        // ── 任务监督字段 ──
        taskId: { type: 'string', description: 'get_task/update_task 目标 task id' },
        baseVersionId: { type: 'string', description: 'start_task 可选：基线正式版 id（缺省 = 学生当前正式版）' },
        mode: {
          type: 'string',
          enum: ['simple', 'multi'],
          description: 'start_task 可选：simple/multi，默认 multi',
        },
        optimizeStyle: {
          type: 'string',
          enum: ['learning', 'training'],
          description: 'start_task 可选：优化风格，默认 training',
        },
        directive: { type: 'string', description: 'start_task 可选：训练指令；update_task 可选：调整指令' },
        maxTurns: { type: 'number', description: 'start_task/update_task 可选：最大轮次（update_task 用于调大续训）' },
      },
    },
  },

  async run(input: ToolInput, ctx: ToolCtxLike): Promise<ToolRunResult> {
    const action = String(input.action ?? '').trim();
    if (!isManageAction(action)) {
      return errorResult(`manage-classroom: invalid action "${action}"`);
    }
    let rtc: ReturnType<typeof readRuntimeContext>;
    try {
      rtc = readRuntimeContext(ctx.config);
    } catch (e) {
      return errorResult(`manage-classroom: ${e instanceof Error ? e.message : String(e)}`);
    }
    // role 兜底校验（profile.toolBound 已收束；防御）
    const role = rtc.kind?.role;
    if (role !== 'head_teacher') {
      return errorResult(`manage-classroom.${action}: forbidden for role "${role ?? 'none'}" (head_teacher only)`);
    }
    if (!rtc.academyStore) {
      return errorResult(`manage-classroom.${action}: academyStore not injected`);
    }
    if (!rtc.sessionContext?.classroomId) {
      return errorResult(`manage-classroom.${action}: caller has no classroomId`);
    }
    const classroomId = rtc.sessionContext.classroomId;
    try {
      // dispatch：按 action 归属委派（资产/学生/任务三组）
      if ((ASSET_ACTIONS as readonly string[]).includes(action)) {
        return await dispatchAssetAction(action as AssetAction, input, classroomId, rtc.academyStore);
      }
      if ((STUDENT_ACTIONS as readonly string[]).includes(action)) {
        return await dispatchStudentAction(action as StudentAction, input, rtc, classroomId);
      }
      if ((TASK_ACTIONS as readonly string[]).includes(action)) {
        return await dispatchTaskAction(action as TaskAction, input, rtc, classroomId);
      }
      return errorResult(`manage-classroom.${action}: unhandled action（内部 dispatch 漏分支）`);
    } catch (e) {
      return errorResult(`manage-classroom.${action}: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

/** 学生 CRUD 7 action 分发 */
async function dispatchStudentAction(
  action: StudentAction, input: ToolInput,
  rtc: ReturnType<typeof readRuntimeContext>, classroomId: string,
): Promise<ToolRunResult> {
  switch (action) {
    case 'list_students': return runListStudents(input, rtc, classroomId);
    case 'get_student': return runGetStudent(input, rtc, classroomId);
    case 'create_student': return runCreateStudent(input, rtc, classroomId);
    case 'update_student': return runUpdateStudent(input, rtc, classroomId);
    case 'delete_student': return runDeleteStudent(input, rtc, classroomId);
    case 'list_versions': return runListVersions(input, rtc, classroomId);
    case 'get_version': return runGetVersion(input, rtc, classroomId);
  }
}

/** 任务监督 4 action 分发 */
async function dispatchTaskAction(
  action: TaskAction, input: ToolInput,
  rtc: ReturnType<typeof readRuntimeContext>, classroomId: string,
): Promise<ToolRunResult> {
  switch (action) {
    case 'start_task': return runStartTask(input, rtc, classroomId);
    case 'list_tasks': return runListTasks(input, rtc, classroomId);
    case 'get_task': return runGetTask(input, rtc, classroomId);
    case 'update_task': return runUpdateTask(input, rtc, classroomId);
  }
}

// re-export ACTIVE_TASK_STATUSES 便于外部断言（manage-student-actions 实际定义）
export { ACTIVE_TASK_STATUSES };
