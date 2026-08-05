/**
 * buildCronUserMessage — cron job fire 时投递的 deliverTo-ready Message。
 * 参考: specs/tech/scheduling/[P1]cron_subsystem.md §4（权威契约）
 *       specs/tech/squad/[P1]scheduler.md §11（buildTickUserMessage 模式，本文件复用同结构）
 *       specs/tech/agent/message/[P0]agent_message_interface.md §5（MessageSender 'system' 子类）
 *
 * 设计（与 buildTickUserMessage 对偶，区别在 metadata key 与 system.kind）：
 *   - role:'user'（走 inbox enqueue，与 proactive_tick 同入口原语）
 *   - sender.source:'system' + system.kind:'cron'（启用 message/types.ts 预留的开放枚举值）
 *   - content = TextBlock `[cron:name] prompt`（agent prompt 识别后自主决定做不做）
 *   - metadata.cron 携带 {at,name,prompt}（programmatic access；与 TickMessage 的
 *     metadata.tickMessage 平行，不混 key 便于 audit 过滤）
 */
import { ulid } from '../config/ulid';
import type { Message, ContentBlock } from '../message/types';
import type { CronPayload } from './payloads';

/** cron Message 内嵌的 metadata 载荷（programmatic access 用） */
export interface CronMessageMeta {
  /** 触发时刻 ISO（caller 用 now.toISOString()，单一时间源） */
  at: string;
  /** 用户可读名（与 CronPayload.name 一致） */
  name: string;
  /** 触发提示词（与 CronPayload.prompt 一致） */
  prompt: string;
}

/**
 * 构造 cron fire 的 deliverTo-ready Message。
 *
 * @param payload  CronPayload（cron job 的业务载荷，含 sessionId/name/prompt）
 * @param at       触发时刻 ISO 字符串（caller 用同一 now.toISOString() 传入）
 * @returns 完整 Message（可直接喂 agentManager.deliverTo）
 */
export function buildCronUserMessage(payload: CronPayload, at: string): Message {
  const meta: CronMessageMeta = { at, name: payload.name, prompt: payload.prompt };
  const text = `[cron:${payload.name}] ${payload.prompt}`;
  return {
    id: ulid(),
    sessionId: payload.sessionId,
    role: 'user',
    content: [{ type: 'text', text }] as ContentBlock[],
    sender: {
      source: 'system',
      system: { kind: 'cron', refId: payload.sessionId },
    },
    metadata: { cron: meta },
  };
}
