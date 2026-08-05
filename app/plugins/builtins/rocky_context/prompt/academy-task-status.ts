/**
 * builtin rocky_context plugin — system_prompt_mapper: academy_task_status（v0.0.210 NEW）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §4.1（5 个 academy mapper）
 *
 * 职责：把教室下所有训练任务的状态看板注入 head prompt（班主任看任务级进展）。
 * - 读 academyContext.tasks（教室全部训练任务：status / taskSeq / directive / currentTurn / maxTurns）
 * - 缺失 → 返空（graceful 降级）
 *
 * 归属 scope：academy-head_teacher 主 scope（§4.1）。
 * tier=context，priority=850（academy_classroom_assets 之后）。
 *
 * EP: system_prompt_mapper。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { readAcademyContext, readClassroomId } from './academy-shared';

/** academy_task_status mapper：注入任务状态看板进 head prompt。 */
export default class AcademyTaskStatusMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const classroomId = readClassroomId(ctx);
    const academy = readAcademyContext(ctx);
    const tasks = academy?.tasks;
    if (!classroomId || !tasks) return [];
    const lines: string[] = ['## 训练任务看板'];
    if (tasks.length === 0) {
      lines.push('- 当前无训练任务');
    } else {
      for (const t of tasks) {
        const seq = typeof t.taskSeq === 'number' ? `#${t.taskSeq}` : t.id ?? '-';
        const status = t.status ?? 'unknown';
        const turn = typeof t.currentTurn === 'number' ? t.currentTurn : 0;
        const max = typeof t.maxTurns === 'number' ? t.maxTurns : '?';
        const directive = typeof t.directive === 'string' && t.directive ? `「${t.directive}」` : '';
        const coachSession = t.coachSessionId ? ` coach=${t.coachSessionId}` : '';
        lines.push(`- 任务 ${seq}：${status}，轮次 ${turn}/${max} ${directive}${coachSession}`);
      }
    }
    return [
      {
        id: 'academy_task_status',
        tier: 'context',
        content: lines.join('\n'),
        priority: 850,
      },
    ];
  }
}
