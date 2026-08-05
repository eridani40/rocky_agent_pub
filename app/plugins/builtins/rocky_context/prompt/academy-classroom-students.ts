/**
 * builtin rocky_context plugin — system_prompt_mapper: academy_classroom_students（v0.0.215 NEW）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §4.1（academy mapper 表）+ §5.2（head 拉 students 契约）
 *
 * 职责：把学生名单注入 head prompt（head 认识学生的数据源）。
 * - 读 academyContext.students + tasks + formalVersionLabels
 * - 每人渲染：名字 / id / 当前正式版 label+versionId / 版本数 / 在跑任务（#seq status 轮次）
 * - 在跑任务 = tasks 中 studentId 匹配且 status ∈ pending/running/awaiting_confirm
 * - 空名单渲染「无学生 + create_student 指针」
 * - 非 academy / 缺 classroomId / students undefined → 返 []（graceful 降级，不 throw）
 *
 * 归属 scope：academy-head_teacher 主 scope（§4.1）。
 * tier=context，priority=855（assets=860 之后、task_status=850 之前）。
 *
 * EP: system_prompt_mapper。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { readAcademyContext, readClassroomId } from './academy-shared';

/** 在跑任务状态闭合集（与 training-task schema status enum 对齐） */
const ACTIVE_TASK_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'awaiting_confirm']);

/** academy_classroom_students mapper：注入学生名单进 head prompt。 */
export default class AcademyClassroomStudentsMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const classroomId = readClassroomId(ctx);
    const academy = readAcademyContext(ctx);
    const students = academy?.students;
    // 三缺任一 → 降级返空（非 academy session 或装配层未注入/查询失败）
    if (!classroomId || !academy?.classroom || students === undefined) return [];

    const tasks = academy.tasks ?? [];
    const labels = academy.formalVersionLabels ?? {};
    const lines: string[] = ['## 学生名单'];

    if (students.length === 0) {
      lines.push('（暂无学生。用 manage-student 工具的 create_student 创建学生。）');
    } else {
      lines.push(`共 ${students.length} 名学生：`);
      for (const s of students) {
        const name = s.name ?? s.id ?? '-';
        lines.push(`- ${name}（id: ${s.id ?? '-'}）`);
        // 当前正式版（label 由 formalVersionLabels 解析；缺 label 只给 versionId）
        const vid = s.currentFormalVersionId;
        if (vid) {
          const label = labels[vid];
          lines.push(`  - 当前正式版：${label ? `${label}（versionId: ${vid}）` : `versionId: ${vid}`}`);
        } else {
          lines.push('  - 当前正式版：无');
        }
        lines.push(`  - 版本数：${s.versionIds?.length ?? 0}`);
        // 在跑任务交叉（studentId 匹配 + 状态 ∈ pending/running/awaiting_confirm）
        const active = tasks.filter(
          (t) => t.studentId === s.id && t.status !== undefined && ACTIVE_TASK_STATUSES.has(t.status),
        );
        if (active.length === 0) {
          lines.push('  - 在跑任务：无');
        } else {
          const desc = active
            .map((t) => `#${t.taskSeq ?? '-'} ${t.status} ${t.currentTurn ?? 0}/${t.maxTurns ?? '-'}`)
            .join('；');
          lines.push(`  - 在跑任务：${desc}`);
        }
      }
    }

    return [
      {
        id: 'academy_classroom_students',
        tier: 'context',
        content: lines.join('\n'),
        priority: 855,
      },
    ];
  }
}
