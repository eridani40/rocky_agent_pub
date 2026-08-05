/**
 * builtin rocky_context plugin — system_reminder provider: squad_team_status（[v0.0.116] NEW）
 * 参考: specs/tech/squad/[P1]squad_reminder_providers.md §4.6（squad_team_status provider）
 *       specs/tech/squad/[P1]data_model.md §1.2b（currentWork 形状）
 *       specs/tech/version_logs/v0.0.116/change_plan-part2.md §7
 *
 * 职责：向 leader system prompt 注入「团队当前状态」段——只展示 session 正在 running 的成员
 * 及其 presence 标记（member.currentWork）。
 *
 * **角色 filter**：leader → 产出；mate / SquadChat / subagent / standalone → 不产出。
 * **数据源**：squadContext.listMembers(squadId) ∩ isSessionRunning(member.sessionId)。
 * **去重**：running 态是运行时瞬时值，每轮直接产出，交 dedup reducer 收敛（不走 shouldProduce）。
 *
 * EP: system_reminder，tier=info。
 */
import {
  ContextImplBase,
  type ReminderCtx,
  type SystemReminder,
  type SystemReminderProvider,
} from '../types';
import { readSessionType } from '../prompt/squad_reminder_shared';

/**
 * squad_team_status provider：leader only → running 成员 + presence 标记 → reminder。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class SquadTeamStatusReminderProvider
  extends ContextImplBase
  implements SystemReminderProvider
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  async provide(ctx: ReminderCtx): Promise<SystemReminder[]> {
    // 角色 filter：仅 leader 产出
    const sessionType = readSessionType(ctx);
    if (sessionType !== 'leader') return [];

    // 需要 squadContext 和 squadId
    const squadContext = ctx.squadContext;
    if (!squadContext) return [];

    const cfg = ctx.config as { squadId?: unknown };
    const squadId = cfg.squadId;
    if (typeof squadId !== 'string' || squadId.length === 0) return [];

    // 列出全部 member，过滤 isSessionRunning
    const allMembers = await squadContext.listMembers(squadId);
    const runningLines: string[] = [];

    for (const m of allMembers) {
      if (!m || typeof m !== 'object') continue;
      const member = m as {
        sessionId?: unknown;
        name?: unknown;
        role?: unknown;
        currentWork?: { text?: string; updatedAt?: string } | null;
      };

      const sessionId = typeof member.sessionId === 'string' ? member.sessionId : null;
      if (!sessionId) continue;

      // running 判定
      const running = await squadContext.isSessionRunning(sessionId);
      if (!running) continue;

      const name = typeof member.name === 'string' ? member.name : '（未知）';
      const role = typeof member.role === 'string' ? member.role : '';
      const currentText =
        member.currentWork && typeof member.currentWork.text === 'string' && member.currentWork.text.trim()
          ? member.currentWork.text.trim()
          : '（未标记）';

      runningLines.push(`- ${name}（${role}）：${currentText}`);
    }

    // 格式化输出
    let content: string;
    if (runningLines.length === 0) {
      content = '[squad:team-status] 团队当前状态（活跃成员）：\n当前无成员在活跃工作';
    } else {
      content = `[squad:team-status] 团队当前状态（活跃成员）：\n${runningLines.join('\n')}`;
    }

    return [
      {
        id: 'squad_team_status',
        tier: 'info',
        content,
      },
    ];
  }
}
