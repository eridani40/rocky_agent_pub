/**
 * builtin rocky_context plugin — system_reminder provider: tool_error
 * 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.6
 *       specs/tech/agent/context_and_memory/[P0]system_reminder.md §3（tool_error provider）
 *
 * 职责：贡献上一轮工具错误/警告 reminder。来源：上轮 tool_result（isError=true）。
 * 当前实现（D1.1 范围）：SessionConfig 未暴露「上一轮 tool_result」访问入口 → no-op 返回空。
 *   后续接入「上轮 tool result 历史」入口后，从此处读 isError=true 的结果生成 warn tier reminder。
 * EP: system_reminder，priority 600。
 */
import { ContextImplBase, type ReminderCtx, type SystemReminder, type SystemReminderProvider } from '../types';

/**
 * tool_error provider：聚合上轮工具错误为 warn reminder。
 * 当前 no-op（上一轮 tool_result 访问入口未建）→ 返回空数组。
 */
export default class ToolErrorReminderProvider
  extends ContextImplBase
  implements SystemReminderProvider
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  provide(_ctx: ReminderCtx): SystemReminder[] {
    // D1.1 no-op：上一轮 tool_result 访问入口未建
    // TODO(tool_error): 接入上轮 tool result 历史入口后读 isError=true 生成 warn reminder
    return [];
  }
}
