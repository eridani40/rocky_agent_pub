/**
 * tickMessage payload + buildHeartbeatTickMessage (deliverTo-ready Message) —
 * scheduler 心跳的 proactive 唤醒消息。
 * 参考: specs/tech/squad/[P1]scheduler.md §11（tickMessage 格式 + 投递为 role:'user' Message
 *       with sender {source:'system'}）
 *       specs/tech/squad/[P1]squad_autonomy.md §5（role prompt 识别 proactive_tick 后自主决定做不做）
 *       specs/tech/scheduling/[P1]heartbeat_handler.md §0.1（心跳提示词权威文案）
 *
 * 分层：
 *   - TickMessage payload（{kind,at,reason}）：spec §11 概念权威。tickMessage() 构造纯载荷，
 *     嵌入 Message.metadata 供程序读取。
 *   - buildHeartbeatTickMessage：heartbeat 专属 deliverTo-ready Message，content=
 *     HeartbeatTickHandler 读 content/tick_heartbeat.md（§0.1 原文）。
 */
import { ulid } from '../../config/ulid';
import type { Message, ContentBlock } from '../../message/types';
import { HeartbeatTickHandler } from '../../prompts/handlers/heartbeat-tick-handler';

export interface TickMessage {
  kind: 'proactive_tick';
  /** 触发时刻 ISO（UTC 瞬时） */
  at: string;
  /** 触发原因（心跳到点） */
  reason: 'heartbeat';
}

/**
 * 构造 tick 消息载荷（spec §11 TickMessage 格式）。
 * @param at 触发时刻 ISO 字符串（caller 用同一 now.toISOString() 传入）
 * @returns TickMessage 载荷（不直接投递；deliverTo 用 buildHeartbeatTickMessage 包装成 Message）
 */
export function tickMessage(at: string): TickMessage {
  return { kind: 'proactive_tick', at, reason: 'heartbeat' };
}

/**
 * 构造 heartbeat deliverTo-ready Message。
 * content = content/tick_heartbeat.md 正文（§0.1 固定文案），
 * sender.system.kind='heartbeat'。
 *
 * @param sessionId 投递目标 session（member 的 sessionId）
 * @param at        触发时刻 ISO（caller 用 now.toISOString()）
 */
export function buildHeartbeatTickMessage(sessionId: string, at: string): Message {
  const payload = tickMessage(at);
  return {
    id: ulid(),
    sessionId,
    role: 'user',
    content: [{ type: 'text', text: new HeartbeatTickHandler().build({}).content }] as ContentBlock[],
    sender: { source: 'system', system: { kind: 'heartbeat' } },
    metadata: { tickMessage: payload },
  };
}
