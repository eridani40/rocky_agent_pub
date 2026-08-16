/**
 * builtin rocky_context plugin — ingest handler: system_reminder_injector
 * 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.1
 *       specs/tech/agent/context_and_memory/[P0]context_ingest_detail.md §3（priority 400）
 *       specs/tech/agent/context_and_memory/[P0]system_reminder.md §4
 *       specs/tech/version_logs/v0.0.361/change_plan.md §1.1（双模式）/§1.6（time 退役）
 *
 * 职责（v0.0.361 T3 双模式重构，§1.1 心智模型）：
 *   - full（ctx.runState.useFullReminder !== false，undefined 视 true——run 首 / summary 重建后首
 *     / forked 恒 full）：跑瘦身动态 provider 链全量产出（todo/squad_task/squad_agents_status 动态半）
 *     + 时间固定段 + queueClearAll（full 已涵盖最新态，pending 作废）+ 置 useFullReminder=false
 *   - incremental（run 内后续轮）：时间固定段 + queueDrain 按序读 value（value 已渲染，直接拼行）
 *   - 触发条件不变（user/tool/a2a；assistant/system 显式排除）+ 块级 isSystemReminder 标记不变
 *   - 时间固定段逻辑自 reminder/time.ts 平移（v0.0.361 time provider 退役）；
 *     渲染格式按 change_plan §2 硬性样例：行首不加 `- ` 前缀、时间行无尾句点
 *
 * 注入器需要跑 provider 链，但 handler 不能直接持 PluginManager（避免循环依赖）。
 * 链执行通过 IngestCtx.reminderRunner 回调注入（ContextEngine 构造期 closure 注入）；
 * queue 句柄（runState/queueDrain/queueClearAll）由 ContextEngine.ingest 装配透传（T3 接线）。
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

/** 进程本地时区名（Electron server = client tz；逻辑自 reminder/time.ts 平移） */
const LOCAL_TZ =
  (typeof Intl !== 'undefined' && Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';

/**
 * system_reminder_injector impl：双模式渲染 reminder 块、追加到末尾 user/tool/a2a message。
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
   * [v0.0.361] 双模式注入（async 化：drain/clearAll 是 async 句柄）。
   * full=动态链全量+时间+清 queue+置 false；incremental=时间+drain 增量。
   * 句柄缺席（UT fixture 直调 / forked 无 fsRoot）→ 降级 full（时间+链产出），不 throw。
   */
  async handle(messages: Message[], ctx: IngestCtx): Promise<Message[]> {
    if (messages.length === 0) return messages;
    const last = messages[messages.length - 1]!;
    // 触发条件（v0.0.274/v0.0.33.3 不变）：user / tool / a2a（sender.source=agent）
    if (!shouldTriggerReminder(last)) return messages;

    // undefined 视同 true（§1.4：run 首新建 RunState 天然 full，零额外初始化接线）
    const useFull = ctx.runState?.useFullReminder !== false;
    let text: string;
    if (useFull) {
      const runner = ctx.reminderRunner;
      const reminders = runner ? runner(ctx) : [];
      text = renderFullBlock(reminders);
      // ④ full 已涵盖最新态 → pending queue 作废（拿锁清；失败降级不阻断注入，下轮 drain 兜底）
      if (ctx.queueClearAll) {
        try {
          await ctx.queueClearAll(ctx.config.sessionId);
        } catch {
          // 清失败降级：pending 留存，下轮 incremental drain 兜底消费
        }
      }
      // ⑤ 消费后置 false（run 内后续轮转 incremental；summary 版本变由 run-react-loop 置回 true）
      if (ctx.runState) ctx.runState.useFullReminder = false;
    } else {
      let values: string[] = [];
      if (ctx.queueDrain) {
        try {
          values = await ctx.queueDrain(ctx.config.sessionId);
        } catch {
          // drain 失败降级：本轮空增量（时间固定段仍注入）
        }
      }
      text = renderIncrementalBlock(values);
    }

    // 块级 isSystemReminder 唯一权威（v0.0.50；前端按块过滤；LLM 零侵入——encode 只读 text）
    const reminderBlock = { type: 'text' as const, text, isSystemReminder: true };
    const newLast: Message = {
      ...last,
      content: [...last.content, reminderBlock],
    };
    return [...messages.slice(0, -1), newLast];
  }
}

/** 时间固定段（逻辑平移自 reminder/time.ts；格式按 change_plan §2 样例：无尾句点） */
export function timeLine(): string {
  // new Date() 本地方法 = 进程本地 = client tz（Electron server 跑用户机器）
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const HH = String(now.getHours()).padStart(2, '0');
  const MM = String(now.getMinutes()).padStart(2, '0');
  return `Current date and time: ${yyyy}-${mm}-${dd} ${HH}:${MM} (${LOCAL_TZ})`;
}

/**
 * full 块渲染：时间固定段 + 动态链产出（provider content 原文逐行；warn tier 加 [warn] 标记）。
 * [v0.0.361] 行首不再加 `- ` 前缀（对齐 §2 样例；provider content 自带栏目前缀如 [todo]）。
 */
export function renderFullBlock(reminders: SystemReminder[]): string {
  const lines = [
    timeLine(),
    ...reminders.map((r) => (r.tier === 'warn' ? `[warn] ${r.content}` : r.content)),
  ];
  return `${REMINDER_HEADER}\n${lines.join('\n')}`;
}

/**
 * incremental 块渲染：时间固定段 + drain 按序 value（value 已渲染注入行，不二次渲染）。
 */
export function renderIncrementalBlock(values: string[]): string {
  return `${REMINDER_HEADER}\n${[timeLine(), ...values].join('\n')}`;
}

/**
 * 判定末尾 message 是否触发 reminder 注入（v0.0.274/v0.0.33.3 语义不变）：
 *   - role='user'（user 发消息，既有路径）
 *   - role='tool'（tool_result 消息，工具循环中也刷新 reminder）
 *   - sender.source='agent'（a2a message，squad 协作场景）
 * 不触发：assistant/system role 或 sender.source 非 agent。
 */
function shouldTriggerReminder(msg: Message): boolean {
  if (msg.role === 'user' || msg.role === 'tool') return true;
  const sender = (msg as { sender?: { source?: string } }).sender;
  return sender?.source === 'agent';
}
