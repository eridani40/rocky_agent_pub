/**
 * builtin rocky_context plugin — ingest handler: system_reminder_injector
 * 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.1
 *       specs/tech/agent/context_and_memory/[P0]context_ingest_detail.md §3（priority 400）
 *       specs/tech/agent/context_and_memory/[P0]system_reminder.md §4
 *
 * 职责（system_reminder.md §4 注入规则）：
 *   - 跑 system_reminder provider 链聚合 reminder
 *   - 只针对 ingest 进来的 messages 最后一条；触发条件：
 *     · role="user"（user 发消息）—— 既有路径
 *     · [v0.0.33.3] sender.source="agent"（a2a 消息）—— squad 协作场景必需
 *       （squad_reminder_providers §8：a2a message 也需触发 reminder，leader/mate 群聊交互频繁）
 *   - 把 reminder 聚合成一个 text content block，追加到该 message content 末尾
 *   - 经 ingest 落库 → 持久化进 transcript；后续 assemble 透明读
 *
 * 注入器需要跑 provider 链，但 handler 不能直接持 PluginManager（避免循环依赖 +
 * plugin_manager 不该被 ext impl 反向依赖）。链执行通过 IngestCtx.reminderRunner
 * 回调注入（ContextEngine 构造期 closure 注入 PluginManager.getExtensionImpls）。
 *
 * EP: context_ingest_handler，priority 400（truncate 之后）。
 */
import type { Message } from '../../../../server/src/message/types';
import {
  ContextImplBase,
  type IngestCtx,
  type IngestHandler,
  type SystemReminder,
} from '../types';

/** reminder 聚合块的标头（让 LLM 知道这是系统提醒） */
const REMINDER_HEADER = '[system_reminder]';

/**
 * system_reminder_injector impl：跑 provider 链、聚合 reminder、追加到最后一条 user message。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class SystemReminderInjectorHandler
  extends ContextImplBase
  implements IngestHandler
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  /**
   * 注入 reminder：跑 provider 链 → 聚合 → 追加到末尾 user message。
   * 无 reminder / 空链 / 末尾非 user message → 不动 messages。
   */
  handle(messages: Message[], ctx: IngestCtx): Message[] {
    if (messages.length === 0) return messages;
    const runner = ctx.reminderRunner;
    if (!runner) return messages; // 未注入 runner（如单元测试）→ 不动

    const reminders = runner(ctx);
    if (!reminders || reminders.length === 0) return messages;

    const last = messages[messages.length - 1]!;
    // [v0.0.33.3] 触发扩展：末尾 message role='user' OR sender.source='agent'（squad a2a）
    //   - 修前仅 role='user' 触发 → mate/leader 群聊交互（a2a message）不注入 reminder
    //   - 修后 a2a message 也触发（squad_reminder_providers §8 / req7 §8.4）
    //   - 注：tool/assistant/system role 不触发（既不接 user 也不接 a2a）
    if (!shouldTriggerReminder(last)) return messages;

    const text = formatReminders(reminders);
    if (!text) return messages;

    // [v0.0.39] reminder block 设块级 isSystemReminder 标记（前端按块精确过滤，只隐这一块 text）。
    // [v0.0.50] 停写消息级 metadata.isSystemReminder（块级 TextBlock.isSystemReminder 为唯一权威，
    //   见 system_reminder.md §4 + change_log §0.5）。metadata 字段本身经 ...last 透传（其他 kv 存活）。
    // LLM 零侵入：protocol-encode.ts encodeContentBlock 对 text block 只读 b.text，此字段不进 wire。
    const reminderBlock = { type: 'text' as const, text, isSystemReminder: true };
    const newLast: Message = {
      ...last,
      content: [...last.content, reminderBlock],
    };
    return [...messages.slice(0, -1), newLast];
  }
}

/**
 * 聚合 reminder 列表为单 text block 文本。
 * 格式：标头 + 各 reminder 顺序拼接（id + content；warn tier 加 [warn] 标记）。
 */
export function formatReminders(reminders: SystemReminder[]): string {
  const lines = reminders.map((r) => {
    const tag = r.tier === 'warn' ? '[warn] ' : '';
    return `- ${tag}${r.content}`;
  });
  return `${REMINDER_HEADER}\n${lines.join('\n')}`;
}

/**
 * [v0.0.33.3] 判定末尾 message 是否触发 reminder 注入。
 * 触发条件（squad_reminder_providers §8 / req7 §8.4）：
 *   - role='user'（user 发消息，既有路径）
 *   - sender.source='agent'（a2a message，squad 协作场景）
 * 不触发：tool/assistant/system role 或 sender.source 非 user/agent（system/approval）。
 */
function shouldTriggerReminder(msg: Message): boolean {
  if (msg.role === 'user') return true;
  // a2a message：sender.source='agent'（user role 之外的另一触发源）
  const sender = (msg as { sender?: { source?: string } }).sender;
  return sender?.source === 'agent';
}
