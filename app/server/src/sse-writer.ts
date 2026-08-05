/**
 * sse-writer — 把 protocol StreamEvent 序列化为 SSE 帧字符串
 * 参考: specs/api/overall/02-llm-chat.md §3.3（SSE wire event）
 *       specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2（StreamEvent）
 *
 * 每条 StreamEvent 一帧：`event: <type>\ndata: <json>\n\n`（data 为紧凑 JSON）。
 * server 在 /chat 流中循环把 LlmClient.stream() 的 StreamEvent 喂给本函数。
 */
import type { StreamEvent } from './llm/protocol';

/**
 * 把单条 StreamEvent 序列化为 SSE 帧字符串。
 * @param evt protocol StreamEvent（thinking_delta / text_delta / usage / finish / tool_call_delta）
 * @returns 形如 `event: text_delta\ndata: {"type":"text_delta","text":"..."}\n\n`
 */
export function serializeStreamEvent(evt: StreamEvent): string {
  const type = evt.type;
  const data = JSON.stringify(evt);
  return `event: ${type}\ndata: ${data}\n\n`;
}
