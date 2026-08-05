/**
 * builtin rocky_context plugin — system_prompt_mapper: academy_classroom_assets（v0.0.210 NEW）
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §4.1（5 个 academy mapper）
 *
 * 职责：把教室数据集/评估器/skill 概览注入 head prompt（班主任管辖教室资产）。
 * - 读 academyContext.classroom（datasetIds/graderIds/skillIds）+ datasets/graders 列表
 * - 任一缺失 → 返空（graceful 降级）
 *
 * 归属 scope：academy-head_teacher 主 scope（§4.1）。
 * tier=context，priority=860（academy_classroom_role 之后）。
 *
 * EP: system_prompt_mapper。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { readAcademyContext, readClassroomId } from './academy-shared';

/** academy_classroom_assets mapper：注入教室资产概览进 head prompt。 */
export default class AcademyClassroomAssetsMapper
  extends ContextImplBase
  implements SystemPromptMapper
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  map(ctx: PromptCtx): PromptFragment[] {
    const classroomId = readClassroomId(ctx);
    const academy = readAcademyContext(ctx);
    const classroom = academy?.classroom;
    if (!classroomId || !classroom) return [];
    const lines: string[] = ['## 教室资产'];
    // 数据集
    const datasets = academy?.datasets ?? [];
    if (datasets.length > 0) {
      lines.push(`- 数据集（${datasets.length}）：`);
      for (const d of datasets) {
        const name = d.name ?? d.id ?? '-';
        const desc = d.description ? `（${d.description}）` : '';
        lines.push(`  - ${name}${desc}`);
      }
    } else {
      lines.push('- 数据集：无');
    }
    // 评估器
    const graders = academy?.graders ?? [];
    if (graders.length > 0) {
      lines.push(`- 评估器（${graders.length}）：`);
      for (const g of graders) {
        const name = g.name ?? g.id ?? '-';
        const type = g.type ? `（${g.type}）` : '';
        lines.push(`  - ${name}${type}`);
      }
    } else {
      lines.push('- 评估器：无');
    }
    // skill（classroom.skillIds）
    const skillIds = classroom.skillIds ?? [];
    lines.push(`- 已装 skill：${skillIds.length > 0 ? skillIds.join(', ') : '无'}`);
    return [
      {
        id: 'academy_classroom_assets',
        tier: 'context',
        content: lines.join('\n'),
        priority: 860,
      },
    ];
  }
}
