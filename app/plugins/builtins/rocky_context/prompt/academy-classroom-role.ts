/**
 * builtin rocky_context plugin — system_prompt_mapper: academy_classroom_role（v0.0.210 NEW）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §4.1（5 个 academy mapper）
 *
 * 职责：注入 academy session 的教室身份正文（"你是 X 教室的班主任/教练/学生"）。
 * - 读 role（kind.role ∈ {head_teacher, coach, student}）+ classroomId（sessionContext.classroomId）
 * - 从 academyContext.classroom 取教室名
 * - 三者任一缺失 → 返空（graceful 降级，不污染 prompt）
 *
 * 归属 scope：academy-head_teacher / academy-coach / academy-student 三个 main scope（§4.1）。
 * tier=stable，priority=980（identity/rules 之后，tool_guidance 之前）。
 *
 * EP: system_prompt_mapper。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { readAcademyContext, readAcademyRole, readClassroomId } from './academy-shared';

/** academy_classroom_role mapper：按 role + classroom 名 注入身份正文。 */
export default class AcademyClassroomRoleMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const role = readAcademyRole(ctx);
    const classroomId = readClassroomId(ctx);
    const academy = readAcademyContext(ctx);
    const classroom = academy?.classroom;
    // 三缺任一 → 降级返空（非 academy session 或装配层未注入）
    if (!role || !classroomId || !classroom) return [];
    const classroomName = classroom.name ?? classroomId;
    // head 扩多行：职责（manage-classroom 管学生+教室资产+任务监督）+ 训练产出五元组语义 + 分工
    // 详细行为指引见 academy_head_role mapper（task 内部 send_message coach；update_task 调大续训）
    if (role === 'head_teacher') {
      const content = [
        `你是「${classroomName}」教室的班主任。`,
        '- 职责：用 manage-classroom 工具管教室（学生 CRUD + 教室资产 dataset/grader/skill + 任务监督 start_task/list_tasks/get_task/update_task）。',
        '- 训练产出 = 学生版本五元组：AGENTS.md（系统提示）/ model（模型）/ memory（记忆）/ skills（技能）/ tools（工具白名单）。',
        '- 分工：你管教室层与任务监督；教练（coach）对 task 内部动作（evaluate/revise/adopt 等）有绝对主权，task 内部要效果走 send_message。',
      ].join('\n');
      return [
        {
          id: 'academy_classroom_role',
          tier: 'stable',
          content,
          priority: 980,
        },
      ];
    }
    // coach / student 保持单行身份正文（不动）
    const roleLabel = role === 'coach' ? '教练' : '学生';
    const content = `你是「${classroomName}」教室的${roleLabel}。`;
    return [
      {
        id: 'academy_classroom_role',
        tier: 'stable',
        content,
        priority: 980,
      },
    ];
  }
}
