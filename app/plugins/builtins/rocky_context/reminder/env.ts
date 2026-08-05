/**
 * builtin rocky_context plugin — system_reminder provider: env
 * 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.6
 *       specs/tech/agent/context_and_memory/[P0]system_reminder.md §3（env provider）
 *
 * 职责：贡献环境 reminder（test/dev/prod、平台、模型）。来源：config（modelId/client）+ process.env。
 * EP: system_reminder，priority 900。
 */
import * as os from 'node:os';
import { ContextImplBase, type ReminderCtx, type SystemReminder, type SystemReminderProvider } from '../types';

/**
 * env provider：聚合环境/平台/模型信息为单条 reminder。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class EnvReminderProvider
  extends ContextImplBase
  implements SystemReminderProvider
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  provide(ctx: ReminderCtx): SystemReminder[] {
    const appEnv = (process.env.APP_ENV ?? 'dev').trim() || 'dev';
    const platform = os.platform();
    const model = ctx.config.modelId ?? 'unknown';
    return [
      {
        id: 'env',
        tier: 'info',
        content: `Environment: app=${appEnv}, platform=${platform}, model=${model}.`,
      },
    ];
  }
}
