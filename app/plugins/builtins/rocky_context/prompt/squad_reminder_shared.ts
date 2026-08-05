/**
 * squad reminder/prompt 共享工具
 * 参考: specs/tech/squad/[P1]squad_reminder_providers.md §1（ReminderCtx 扩展）
 *
 * 职责：squad reminder / prompt 各 provider 共用的 session kind/type 解析 helper。
 *
 * 单文件 ≤300 行（纯工具，无副作用）。
 */

/**
 * [v0.0.56] duck-typed 读 config.kind（替代旧 config.sessionType）。
 * PromptCtx/ReminderCtx 通用，各 squad provider 共享，消除重复。
 * 返回 kind 对象（含 role/isSubagent/isStudio）或 undefined（standalone = 无 kind）。
 *
 * 消费方迁移规则：
 *   - 旧 sessionType === 'subagent' → kind?.isSubagent
 *   - 旧 sessionType === 'squad'|'leader'|'mate' → kind?.role === 'squad'|'leader'|'mate'
 *   - 旧 !sessionType（standalone）→ !kind（kind 不存在 / role==='rocky'）
 */
export function readSessionKind(ctx: {
  config: { kind?: { role?: unknown; isSubagent?: boolean; isStudio?: boolean } };
}): { role?: string; isSubagent?: boolean; isStudio?: boolean } | undefined {
  const k = ctx.config.kind;
  if (!k) return undefined;
  return { role: typeof k.role === 'string' ? k.role : undefined, isSubagent: k.isSubagent, isStudio: k.isStudio };
}

/**
 * role==='rocky' 归一化为 undefined，与 readSessionKind 注释语义一致（standalone
 * 等价 kind 不存在 或 role==='rocky'），使消费方以 `!sessionType` 做 standalone 判定时行为正确。
 */
export function readSessionType(ctx: { config: { kind?: { role?: unknown; isSubagent?: boolean; isStudio?: boolean } } }): string | undefined {
  const k = readSessionKind(ctx);
  if (!k) return undefined;
  if (k.isSubagent) return 'subagent';
  if (k.role === 'rocky') return undefined;
  return k.role;
}
