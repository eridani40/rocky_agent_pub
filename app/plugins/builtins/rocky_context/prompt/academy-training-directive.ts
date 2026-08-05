/**
 * builtin rocky_context plugin — system_prompt_mapper: academy_training_directive（v0.0.210 NEW）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §4.1（5 个 academy mapper）
 *
 * 职责：把训练任务 directive 透传进 coach prompt（训练目标由 head 下发，coach 消费）。
 * - 读 trainingTaskId（sessionContext.trainingTaskId）+ academyContext.task.directive
 * - 任一缺失 → 返空（graceful 降级）
 *
 * 归属 scope：academy-coach 主 scope（§4.1）。
 * tier=context，priority=880（academy_classroom_role 之后）。
 *
 * EP: system_prompt_mapper。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { readAcademyContext, readTrainingTaskId } from './academy-shared';

/** academy_training_directive mapper：注入 task.directive 进 coach prompt。 */
export default class AcademyTrainingDirectiveMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const taskId = readTrainingTaskId(ctx);
    const academy = readAcademyContext(ctx);
    const task = academy?.task;
    if (!taskId || !task) return [];
    const directive = typeof task.directive === 'string' ? task.directive.trim() : '';
    if (!directive) return [];
    const content = `## 训练目标\n\n${directive}`;
    return [
      {
        id: 'academy_training_directive',
        tier: 'context',
        content,
        priority: 880,
      },
    ];
  }
}
