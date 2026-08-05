/**
 * builtin rocky_context plugin — system_reminder provider: squad_task
 * 参考: specs/tech/squad/[P1]squad_reminder_providers.md §4（squad_task provider）
 *       specs/tech/squad/[P1]panorama_builtin.md §5（reminder contract）
 *
 * 职责：每轮向 leader/mate 注入活跃 task 列表，让队员感知待办.
 *
 * **角色 filter**：leader → 全队活跃 task；mate → owner∪依赖我的（即我负责的 + 我在 block 别人的）.
 *   SquadChat/subagent/standalone → 不产出.
 * **数据源**：squadContext.listActiveTasks(squadId, viewerMemberId | null).
 *   - leader（viewerMemberId=null）→ 全队活跃
 *   - mate（viewerMemberId=self.memberId）→ owner==self ∪ dependencies 含 owner==self 的 task
 * **owner_name 软解析**：join memberStore 取 member.name；owner=null 显「未指派」.
 * **status_label**：task builtin display.status_labels 配死中文（未开始/等待中/进行中/已结束）.
 * **依赖提示**：waiting 状态显「（等 N 项）」（N=未 done 依赖数）.
 * **去重**：瞬时值型，每轮直接产出，交 dedup reducer 收敛（同 squad_workspace/squad_team_status）.
 *
 * EP: system_reminder，tier=info.
 */
import {
  ContextImplBase,
  type ReminderCtx,
  type SystemReminder,
  type SystemReminderProvider,
} from '../types';
import { readSessionType } from '../prompt/squad_reminder_shared';

/** task builtin display.status_labels 中文映射（与 server task-schema.ts 一致） */
const TASK_STATUS_LABELS: Record<string, string> = {
  todo: '未开始',
  waiting: '等待中',
  in_progress: '进行中',
  done: '已结束',
};

/** listMembers 返回的 member 形状（鸭子类型子集） */
interface MemberLike {
  id?: unknown;
  name?: unknown;
}

/**
 * squad_task provider：leader/mate → 活跃 task 列表 → reminder.
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）.
 */
export default class SquadTaskReminderProvider
  extends ContextImplBase
  implements SystemReminderProvider
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  async provide(ctx: ReminderCtx): Promise<SystemReminder[]> {
    // 角色 filter：仅 leader/mate 产出（squad_chat/subagent/standalone 不产出）
    const sessionType = readSessionType(ctx);
    if (sessionType !== 'leader' && sessionType !== 'mate') return [];

    const squadContext = ctx.squadContext;
    if (!squadContext || typeof squadContext.listActiveTasks !== 'function') return [];

    const cfg = ctx.config as { squadId?: unknown; memberId?: unknown };
    const squadId = cfg.squadId;
    if (typeof squadId !== 'string' || squadId.length === 0) return [];

    // leader → viewerMemberId=null（全队）；mate → config.memberId（self）
    const viewerMemberId = sessionType === 'leader'
      ? null
      : (typeof cfg.memberId === 'string' && cfg.memberId.length > 0 ? cfg.memberId : null);
    // mate 但缺 memberId → 无法过滤，返空（避免误给 leader 视角）
    if (sessionType === 'mate' && viewerMemberId === null) return [];

    const roleLabel = sessionType === 'leader' ? 'leader' : 'mate';

    const tasks = await squadContext.listActiveTasks(squadId, viewerMemberId);
    if (tasks.length === 0) {
      return [{
        id: 'squad_task',
        tier: 'info',
        content: `[squad:tasks] 待办任务（${roleLabel} 视角）：\n当前无待办任务\n（team task = 全景看板的 task 表；建任务用全景工具：panorama(action=create, entity='task', fields={title,owner,...})）`,
      }];
    }

    // owner_name 软解析：join memberStore
    const members = await squadContext.listMembers(squadId);
    const memberNameOf = new Map<string, string>();
    for (const m of members as MemberLike[]) {
      if (m && typeof m.id === 'string' && typeof m.name === 'string') {
        memberNameOf.set(m.id, m.name);
      }
    }

    // task id → status 查表（算 waiting 的「等 N 项」用，未 done 依赖数）
    const statusOf = new Map<string, string>();
    for (const t of tasks) statusOf.set(t.id, t.status);

    const lines = tasks.map((t) => {
      const ownerLabel = t.owner ? (memberNameOf.get(t.owner) ?? t.owner) : '未指派';
      const statusLabel = TASK_STATUS_LABELS[t.status] ?? t.status;
      // waiting 显依赖提示（等 N 项 = 未 done 依赖数）
      let suffix = '';
      if (t.status === 'waiting') {
        const pending = t.dependencies.filter((d) => statusOf.get(d) !== 'done').length;
        suffix = `（等 ${pending} 项）`;
      }
      return `- ${t.title}（${ownerLabel}，${statusLabel}）${suffix}`;
    });

    return [{
      id: 'squad_task',
      tier: 'info',
      content: `[squad:tasks] 待办任务（${roleLabel} 视角）：\n${lines.join('\n')}\n（team task = 全景看板的 task 表；改状态用全景工具：panorama(action=transition, entity='task', id, to=in_progress|done)；看全队用 panorama(action=query, entity='task')）`,
    }];
  }
}
