/**
 * builtin rocky_context plugin — system_prompt_mapper: academy_iteration_state
 * 参考: specs/tech/academy/[P0]session_kind_extension.md §4.1（academy_iteration_state mapper）
 *
 * v0.0.221 扩充（design.md §4.2）：
 *   - base：versionId + versionLabel + workspaceDir 绝对路径（只读参考，修 coach bash ls 摸路）
 *   - 版本谱系（本 task 全部 process 版）：[{round,versionId,label,decision,avgScore,workspaceDir}]
 *   - 已采纳 formal（本 task 归档的）：[{versionId,label,adoptedFromProcessLabel}]
 *   - 生命周期：status + resumable 标志 + maxTurns 软提示 + roundsUsed
 *   - 保留 candidate + temporaryBaseline + 历史轮次摘要
 *
 * 归属 scope：academy-coach 主 scope（§4.1）。
 * tier=context，priority=870（academy_training_directive 之后）。
 *
 * EP: system_prompt_mapper。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptMapper } from '../types';
import { readAcademyContext, readTrainingTaskId } from './academy-shared';

/** academy_iteration_state mapper：注入训练进度进 coach prompt。 */
export default class AcademyIterationStateMapper
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
    const lines: string[] = ['## 训练进度'];
    // 任务 ID（manage-task 各 action 的 taskId 参数；coach 必须从 prompt 可得）
    lines.push(`- 任务 ID：${taskId}`);
    // 状态 + 轮次 + resumable + maxTurns 软提示
    const status = task.status ?? 'unknown';
    const pausedReason = task.pausedReason;
    const currentTurn = typeof task.currentTurn === 'number' ? task.currentTurn : 0;
    const maxTurns = typeof task.maxTurns === 'number' ? task.maxTurns : undefined;
    const resumable = status === 'paused' && pausedReason !== 'maxturns';
    lines.push(`- 状态：${status}${pausedReason ? `（原因：${pausedReason}）` : ''}`);
    lines.push(`- 当前轮次：${currentTurn}${maxTurns !== undefined ? ` / ${maxTurns}` : ''}`);
    lines.push(`- 可续训（resumable）：${resumable ? '是（manage-task resume 可续）' : '否'}`);
    if (pausedReason === 'maxturns') {
      lines.push('  - maxTurns 已到顶（硬上限）；要让 coach 续训，请让 head_teacher 通过 manage-classroom.update_task 调大 maxTurns');
    }
    // 当前候选版本 id + workspace 绝对路径
    if (task.candidateVersionId) {
      lines.push(`- 当前候选版本：${task.candidateVersionId}`);
    }
    const candidateWs = academy?.candidateWorkspaceDir;
    if (candidateWs) {
      lines.push(`- candidate workspace 路径：${candidateWs}`);
    }
    // base 版本（workspaceDir 绝对路径 + label，coach 读 base AGENTS.md 定位）
    const baseVersion = academy?.baseVersion;
    if (baseVersion) {
      lines.push(`- base 版本：${baseVersion.label ?? '?'}（${baseVersion.id ?? '?'}）`);
      if (baseVersion.workspaceDir) {
        lines.push(`- base workspace 路径：${baseVersion.workspaceDir}`);
      }
    }
    // 临时基线
    if (task.temporaryBaselineVersionId) {
      lines.push(`- 临时基线版本：${task.temporaryBaselineVersionId}`);
    }
    // 版本谱系（本 task 全部 process 版）
    const lineage = academy?.versionLineage ?? [];
    if (lineage.length > 0) {
      lines.push('- 版本谱系（本 task 全部 process 版；可任选 adopt 定稿）：');
      for (const v of lineage) {
        const round = v.round ?? '?';
        const label = v.label ?? '?';
        const decision = v.decision ?? '-';
        const avg = typeof v.avgScore === 'number' ? v.avgScore.toFixed(2) : '-';
        lines.push(`  - round ${round}：${label}（${v.versionId ?? '?'}）decision=${decision}, avgScore=${avg}`);
      }
    }
    // 已采纳 formal
    const adopted = academy?.adoptedFormalVersions ?? [];
    if (adopted.length > 0) {
      lines.push('- 已采纳 formal 版本（旁路归档历史）：');
      for (const f of adopted) {
        const from = f.adoptedFromProcessLabel ?? f.adoptedFromProcessVersionId ?? '?';
        lines.push(`  - ${f.label ?? '?'}（${f.versionId ?? '?'}）← 采纳自 ${from}`);
      }
    }
    // 历史轮次摘要（最近 5 轮，round asc；与版本谱系互补——turns 是已完成的 round 摘要）
    const turns = academy?.turns ?? [];
    if (turns.length > 0) {
      const recent = turns.slice(-5);
      lines.push('- 历史轮次摘要（最近 5 轮）：');
      for (const t of recent) {
        const round = t.round ?? '?';
        const decision = t.decision ?? 'unknown';
        const avg = typeof t.avgScore === 'number' ? t.avgScore.toFixed(2) : '-';
        lines.push(`  - round ${round}: decision=${decision}, avgScore=${avg}`);
      }
    }
    return [
      {
        id: 'academy_iteration_state',
        tier: 'context',
        content: lines.join('\n'),
        priority: 870,
      },
    ];
  }
}
