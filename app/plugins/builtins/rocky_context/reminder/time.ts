/**
 * builtin rocky_context plugin — system_reminder provider: time
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.6
 *       specs/tech/agent/context/[P0]system_reminder.md §3 §5（time provider，含时分+时区）
 *
 * 职责：贡献系统时间 reminder（含时分 + 时区名）。
 *
 * 设计背景（v0.0.64）：
 *   - 旧版（v0.0.8-）只输出 "Current date: YYYY-MM-DD"（无时分、用 server 进程本地 tz）。
 *     根因：spec §5 误把「保 system prompt cache」当约束——但 reminder 注入最后一条 user message，
 *     **本来就不破 system prompt cache**（system_reminder.md §1/§5）；user message 段每 turn 失效，
 *     精度日→分钟无额外 cache 损失。
 *   - 新版注入完整 "Current date and time: YYYY-MM-DD HH:MM (TZ)"，让 agent 能正确回答「现在几点」
 *     和跨时区时间相关问题（旧版只剩日期，agent 只能瞎猜）。
 *
 * 时区来源（单一，不查 session）：
 *   Rocky 是 Electron 本地 app，server 进程跑在用户机器 → **server 进程 tz = client tz**。
 *   new Date() 本地方法（getHours 等）拿到的就是用户本地时间，无需 session.timezone 链路
 *   （那是 cron schedule 持久化 job.tz 的需求，不是 reminder 当前时间的需求）。
 *   LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone（进程本地，仅用于 tz 名展示）。
 *
 * EP: system_reminder，priority 800。
 */
import {
  ContextImplBase,
  type ReminderCtx,
  type SystemReminder,
  type SystemReminderProvider,
} from '../types';

/** 进程本地时区名（Electron server = client tz；与 cron-tool-shared LOCAL_TZ 同口径） */
const LOCAL_TZ =
  (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';

/**
 * time provider：贡献含时分 + 时区的系统时间 reminder。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class TimeReminderProvider
  extends ContextImplBase
  implements SystemReminderProvider
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  provide(_ctx: ReminderCtx): SystemReminder[] {
    // new Date() 本地方法 = 进程本地 = client tz（Electron server 跑用户机器）
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const HH = String(now.getHours()).padStart(2, '0');
    const MM = String(now.getMinutes()).padStart(2, '0');
    return [
      {
        id: 'time',
        tier: 'info',
        content: `Current date and time: ${yyyy}-${mm}-${dd} ${HH}:${MM} (${LOCAL_TZ}).`,
      },
    ];
  }
}
