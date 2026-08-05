/**
 * builtin rocky_context plugin — system_reminder provider: squad_workspace（v0.0.111 NEW）
 * 参考: specs/tech/squad/[P1]squad_reminder_providers.md（squad 团队盘根路径）
 *       states/v0.0.111.workitem_visibility/design-plan.md §块④
 *       specs/tech/version_logs/v0.0.111/change_plan.md 块④
 *
 * 职责：向 leader/mate 注入「团队盘根路径」reminder，配合 system prompt「团队盘」outputs/reports 规范。
 *
 * **角色 filter**：leader + mate（readSessionType；standalone/subagent 无 squadId 天然返空）。
 *   与个人 workspace（reminder/workspace.ts）**并存**——个人盘继续由 workspace.ts 注入，两条各司其职。
 *
 * **数据源**：config.squadId（leader/mate 必有）+ config.dataDir（session 通用）
 *   → path.join(dataDir, 'squads', squadId) = 团队根（等价 squad-store.ts squadRootDir）。
 *   任一缺 → 空贡献。
 *
 * **去重**：路径静态（不随 store 变），本 provider 不做变化检测/去重，每轮产出交 dedup reducer。
 *
 * EP: system_reminder，tier=info。
 */
import * as path from 'node:path';
import {
  ContextImplBase,
  type ReminderCtx,
  type SystemReminder,
  type SystemReminderProvider,
} from '../types';
import { readSessionType } from '../prompt/squad_reminder_shared';

/**
 * squad_workspace provider：leader/mate → 团队盘根路径 → reminder。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class SquadWorkspaceReminderProvider
  extends ContextImplBase
  implements SystemReminderProvider
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  provide(ctx: ReminderCtx): SystemReminder[] {
    // 角色 filter：leader/mate 才产出（standalone/subagent 无 squadId，即便漏过此关也会在下方缺 squadId 返空）
    const sessionType = readSessionType(ctx);
    if (sessionType !== 'leader' && sessionType !== 'mate') return [];

    const cfg = ctx.config as { dataDir?: unknown; squadId?: unknown };
    const dataDir = cfg.dataDir;
    const squadId = cfg.squadId;
    if (typeof dataDir !== 'string' || dataDir.length === 0) return [];
    if (typeof squadId !== 'string' || squadId.length === 0) return [];

    // 团队根 = <dataDir>/squads/<squadId>（等价 squad-store.ts squadRootDir）
    const teamRoot = path.join(dataDir, 'squads', squadId);
    return [
      {
        id: 'squad_workspace',
        tier: 'info',
        content: `Team workspace: ${teamRoot}`,
      },
    ];
  }
}
