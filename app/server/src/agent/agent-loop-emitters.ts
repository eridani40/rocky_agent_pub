/**
 * AgentLoop 事件 emit 助手（agent-loop 拆分模块）
 * 参考: specs/tech/version_logs/v0.0.8/change_log.md §4（各阶段 emit）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md §4 §5
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md §5.1（drain 全量 emit SSE 原则）
 *
 * 职责：把 agent-loop 各阶段的 emit 逻辑抽成纯函数，避免 agent-loop.ts 超 300 行。
 *   - emitRunStart / emitRunEnd
 *   - emitMessageStart / emitMessageEnd（业务侧 message 用，role 任意）
 *   - emitEnqueuedProcessed
 *   - emitUserMessageBlocks（整段 content 一次性 emit；[v0.0.58.cron-fix] drain 的所有 source 都用此 helper，
 *     名字历史保留——内部 emitMessageStart 透传 message.role，支持 user/system/agent/approval）
 *   - emitToolResult（tool_result_start/delta/end）
 *
 * 共享参数：sessionId + runId + bus + now（时间生成函数）。
 * 由 agent-loop.ts 注入，保持无状态。
 */
import { ulid } from '../config/ulid';
import type { ContentBlock, Message, ToolResultBlock } from '../message/types';
import type { ReplayableEventBus } from './event-bus';
import type {
  AgentEvent,
  MessageStartSender,
  StopReason,
} from './agent-event-types';
import type { PendingToolCall } from '../tools/types';
import type { RunKind } from '../../../shared/src/types/session-kind';
import { groupKeyForRunKind } from './agent-interface';

/**
 * emit 助手共享上下文（agent-loop / agent-manager 每次调用时构造）。
 *
 * v0.0.15：加 runKind 字段（agent_event.md §2 v1.1 + agent_interface §4）。
 * runKind 决定 groupKey 路由（`session_id:<sid>_amt:<runKind>`）+ 写入事件体 runKind 字段。
 */
export interface EmitContext {
  sessionId: string;
  runId: string;
  /**
   * v0.0.15：agent mode type（current / summary / memory_extract）。
   * loop emit 用 loop.runKind（主对话固定 "current"）；manager emit 用业务对应 runKind。
   */
  runKind: RunKind;
  bus: ReplayableEventBus;
  /** 时间生成（注入便于测试控制时间） */
  now: () => string;
}

/**
 * v0.0.15：group key 命名（agent_event.md §6.1 v1.1 + agent_interface §4 v1.1）。
 * 注：旧 `groupKeyFor(sid)` 裸 sid 函数已废弃（v0.0.15 破坏性变更）。新代码直接用
 * `groupKeyForRunKind(sid, runKind)`（从 agent-interface 导入，带 _amt:<runKind> 后缀）。
 */

/** 向 bus 发布一个 AgentEvent（group 用 groupKeyForRunKind，带 _amt:<runKind> 后缀） */
function publish(ctx: EmitContext, event: AgentEvent): void {
  ctx.bus.emit(groupKeyForRunKind(ctx.sessionId, ctx.runKind), {
    data: event,
    timestamp: ctx.now(),
  });
}

/**
 * 构造基础字段（id/sessionId/createdAt/runId/runKind）。
 * v0.0.15：runKind 必填写入事件体（agent_event.md §2 v1.1）。
 */
function base(ctx: EmitContext, extra?: { messageId?: string }) {
  return {
    id: ulid(),
    sessionId: ctx.sessionId,
    createdAt: ctx.now(),
    runId: ctx.runId,
    runKind: ctx.runKind,
    ...(extra?.messageId ? { messageId: extra.messageId } : {}),
  };
}

/** emit run_start（inputMessageIds = 当前 inbox peek 的 id 列表） */
export function emitRunStart(
  ctx: EmitContext,
  inputMessageIds: string[],
): void {
  publish(ctx, {
    ...base(ctx),
    type: 'run_start',
    inputMessageIds,
  });
}

/** emit run_end（stopReason） */
export function emitRunEnd(ctx: EmitContext, stopReason: StopReason): void {
  publish(ctx, {
    ...base(ctx),
    type: 'run_end',
    stopReason,
  });
}

/**
 * emit message_start（业务侧 user message 用；LLM assistant 由 StreamConsumer 发）。
 *
 * metadata 可选 —— 业务侧非 LLM 流式产生的 message 通过本字段把 Message.metadata 透传前端。
 * LLM assistant 路径不发 metadata，保持原行为。
 *
 * [v0.0.107] origin 可选末参 —— 仅 role=user 携带（由 emitUserMessageBlocks 从 sender.channel 派生）。
 * origin 只挂 message_start 事件体（不进 base() 公共字段），供 accumulator/client 消费。
 *
 * [v0.0.119] sender 可选 —— 携带消息作者身份（目前只支持 source='agent' a2a 消息）。
 * 修复 BUG-001：a2a 消息通过 SSE 推送时前端无法判定 isA2aInbox，导致误显 YOU。
 */
export function emitMessageStart(
  ctx: EmitContext,
  messageId: string,
  role: Message['role'],
  metadata?: Record<string, unknown>,
  origin?: { type: string; configId: string },
  sender?: MessageStartSender,
): void {
  publish(ctx, {
    ...base(ctx, { messageId }),
    type: 'message_start',
    role,
    ...(metadata ? { metadata } : {}),
    ...(origin ? { origin } : {}),
    ...(sender ? { sender } : {}),
  });
}

/**
 * 从 Message.sender 派生 message_start 事件的 origin 信封。
 *
 * gate 按 sender.source==='user'（语义锚 source 非 role；source='user' 必 role='user'）：
 *   - user + channel（IM 入站）→ { type: channel.type, configId: channel.configId }
 *   - user 无 channel（web client）→ { type: 'client', configId: '0' }（缺省语义）
 *   - 非 user source（system/agent/approval/tool_reply）→ undefined（不误标来源）
 */
function deriveUserOrigin(
  sender: Message['sender'],
): { type: string; configId: string } | undefined {
  if (sender?.source !== 'user') return undefined;
  if (sender.channel) {
    return { type: sender.channel.type, configId: sender.channel.configId };
  }
  return { type: 'client', configId: '0' };
}

/**
 * [v0.0.119] 从 Message.sender 派生 message_start 事件的 sender 身份字段（BUG-001 修复）。
 *
 * 只处理 source='agent' 的 a2a 消息——携带 agent.ref 最小子集（type/sessionId/name）：
 *   - 前端 isA2aInbox 判定需要 source==='agent' && !!sender.agent?.ref
 *   - resolveGroupActor/resolveMemberActorFactory 成员名解析需要 ref.type + ref.name
 * 其他 source（user/system/approval/tool_reply）→ undefined（user 走 origin 字段，向后兼容）。
 */
function deriveEventSender(sender: Message['sender']): MessageStartSender | undefined {
  if (sender?.source !== 'agent') return undefined;
  const { ref } = sender.agent;
  return {
    source: 'agent',
    agent: {
      ref: { type: ref.type, sessionId: ref.sessionId, name: ref.name },
    },
  };
}

/** emit message_end */
export function emitMessageEnd(ctx: EmitContext, messageId: string): void {
  publish(ctx, {
    ...base(ctx, { messageId }),
    type: 'message_end',
  });
}

/** emit enqueued_message_processed（处理 enqueued 消息时发） */
export function emitEnqueuedProcessed(
  ctx: EmitContext,
  enqueueId: string,
  messageId: string,
  role: Message['role'],
): void {
  publish(ctx, {
    ...base(ctx),
    messageId,
    type: 'enqueued_message_processed',
    enqueueId,
    role,
  });
}

/**
 * v0.0.12：emit enqueued_message_canceled（drain 同批 message+cancel 配对作废时发）。
 * 该 message 被作废，不生成 messageId、不写主 store（design 板块 3.4 / agent_event.md §4.3）。
 */
export function emitEnqueuedCanceled(
  ctx: EmitContext,
  enqueueId: string,
): void {
  publish(ctx, {
    ...base(ctx),
    type: 'enqueued_message_canceled',
    enqueueId,
  });
}

/**
 * 整段 user message content 一次性 emit（非真实流式；user 消息本就是完整发出的）。
 * 仅处理 TextBlock（v0.0.8 子集；其他 block 类型 future 扩展）。
 *
 * [v0.0.119] a2a 消息携带 sender 字段（BUG-001 修复）：
 *   origin 处理 source='user' 的 channel 信封；sender 处理 source='agent' 的 a2a 身份。
 *   二者各司其职，不互相覆盖（向后兼容）。
 */
export function emitUserMessageBlocks(
  ctx: EmitContext,
  message: Message,
): void {
  const origin = deriveUserOrigin(message.sender);
  const sender = deriveEventSender(message.sender);
  emitMessageStart(ctx, message.id, message.role, undefined, origin, sender);
  emitTextBlocks(ctx, message);
  emitMessageEnd(ctx, message.id);
}

/**
 * 整段 message content（TextBlock）emit start/delta/end 序列。
 *
 * 抽自 emitUserMessageBlocks 供复用：在 message_start 之后需要 emit
 * text_block_{start,delta,end} 把文案推给前端，否则前端收到空壳 message（content=[]）。
 * 本 helper 只负责 text block 序列，caller 负责前后 message_start/end。
 */
export function emitTextBlocks(ctx: EmitContext, message: Message): void {
  for (const block of message.content) {
    if (block.type === 'text') {
      const blockId = ulid();
      publish(ctx, {
        ...base(ctx, { messageId: message.id }),
        type: 'text_block_start',
        blockId,
      });
      publish(ctx, {
        ...base(ctx, { messageId: message.id }),
        type: 'text_block_delta',
        blockId,
        delta: block.text,
      });
      publish(ctx, {
        ...base(ctx, { messageId: message.id }),
        type: 'text_block_end',
        blockId,
      });
    }
  }
}

/**
 * emit 单个 ToolResult 的 start/delta/end（toolCallId 绑定）。
 *
 * [v0.0.19 BUG-fix] 生成**一个** messageId 供 start/delta/end 三事件共享，
 * 代表该 tool result 对应的 role='tool' 消息节点 id（对齐 chat _overview §2 rule4/rule6）。
 * 客户端 reducer 据此 messageId 建/更新该 tool 消息节点；多个 result 各自独立 messageId
 * → 各自独立绑定到对应 tool_call（修复前三个事件全用 base(ctx) 不带 messageId，导致
 * reducer 用 evt.messageId(=undefined) 建消息，多工具场景第 2 个起的结果丢失）。
 */
export function emitToolResult(
  ctx: EmitContext,
  result: ToolResultBlock,
): void {
  const blockId = ulid();
  const messageId = ulid();
  publish(ctx, {
    ...base(ctx, { messageId }),
    type: 'tool_result_start',
    blockId,
    toolCallId: result.toolCallId,
  });
  const delta = toolResultToDelta(result);
  publish(ctx, {
    ...base(ctx, { messageId }),
    type: 'tool_result_delta',
    blockId,
    toolCallId: result.toolCallId,
    delta,
  });
  publish(ctx, {
    ...base(ctx, { messageId }),
    type: 'tool_result_end',
    blockId,
    toolCallId: result.toolCallId,
    isError: result.isError,
  });
}

/**
 * emit error 事件（任一阶段抛错时先 emit error）。
 *
 * [v0.0.25 rev2] 不再硬编 'LOOP_ERROR'。caller 传 category（LlmErrorCategory）+ 可选
 * RunErrorInfo（displayReason/errorDetail）→ emit 结构化 error 事件（spec api change_log §1.2）。
 * code 字段保留（向后兼容；旧 caller 仍读 message/code）。category 也写入 errorCategory。
 */
export function emitError(
  ctx: EmitContext,
  message: string,
  code: string,
  errorInfo?: { errorCategory: string; displayReason: string; errorDetail?: string },
): void {
  publish(ctx, {
    ...base(ctx),
    type: 'error',
    message,
    code,
    ...(errorInfo
      ? {
          errorCategory: errorInfo.errorCategory as never,
          displayReason: errorInfo.displayReason,
          ...(errorInfo.errorDetail !== undefined ? { errorDetail: errorInfo.errorDetail } : {}),
        }
      : {}),
  });
}

/**
 * [v0.0.101] emit require_human_input 事件（HITL 悬挂，携队首单个 PendingToolCall）。
 *
 * 调用时机：runReActLoop ③ 段 executeToolsForSpec 返 pending.length>0 →
 *   setPendingToolCalls 落盘 + 回填 id/index 后 emit 本事件（队首）。
 *
 * 前端订阅本事件（useMessages reducer）→ 据 pending.subState 渲染提问卡（need_feedback）/
 * 审批卡（need_approval）；多 pending 串行：队首 resolve 后 emit 下一个。
 *
 * @param ctx     emit 上下文（runKind 路由用）
 * @param pending 队首 PendingToolCall（caller 保证是落盘后的完整字段——含 resultMessageId/resultBlockIndex）
 */
export function emitRequireHumanInput(
  ctx: EmitContext,
  pending: PendingToolCall,
): void {
  publish(ctx, {
    ...base(ctx),
    type: 'require_human_input',
    pending,
  });
}

/** tool_result → delta 文本（拼接 content 内的 text） */
function toolResultToDelta(result: ToolResultBlock): string {
  return result.content
    .map((b: ContentBlock) => (b.type === 'text' ? b.text : ''))
    .join('\n');
}

/**
 * [v0.0.130.hang] emit tool_execution_start（③段执行前，与 agent.log loop_tools_begin 同址）。
 * 参考: specs/tech/version_logs/v0.0.130.hang/change_plan.md 模块 P6-backend
 */
export function emitToolExecutionStart(
  ctx: EmitContext,
  toolNames: string[],
  toolCallIds: string[],
): void {
  publish(ctx, {
    ...base(ctx),
    type: 'tool_execution_start',
    toolNames,
    toolCallIds,
  });
}

/**
 * [v0.0.130.hang] emit tool_execution_end（③段 ingest 后，与 agent.log loop_tools_end 同址）。
 */
export function emitToolExecutionEnd(
  ctx: EmitContext,
  resultCount?: number,
  pendingCount?: number,
): void {
  publish(ctx, {
    ...base(ctx),
    type: 'tool_execution_end',
    resultCount,
    pendingCount,
  });
}
