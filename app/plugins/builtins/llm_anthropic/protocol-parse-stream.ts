/**
 * anthropic_messages 协议 parseStream 单帧解析实现
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.6
 *       specs/research/v0.0.3-anthropic-protocol.md §3/§4
 *
 * v0.0.191：impl 物理迁入 plugin（原主干 app/server/src/llm/protocol-parse-stream.ts）。
 * wire 行为逐字节不变（parseAnthropicSseFrame / parseAnthropicUsage 逻辑原样迁入）。
 *
 * thinking/text 分流决策（§3.6）：
 *   - content_block_delta.delta.type === 'thinking_delta' → thinking_delta 变体
 *   - content_block_delta.delta.type === 'text_delta'     → text_delta 变体
 *   - signature_delta（thinking block 内）→ 忽略（不续 thinking）
 *   - index 不泄露给消费方（UI 以 messageId:partIndex 维护顺序）
 *   - message_stop → finish(stop)；message_delta.stop_reason → finish(映射)
 *   - message_delta.usage → usage event
 *
 * tool_use 翻译（对齐工具子系统 StreamConsumer 契约）：
 *   - content_block_start(type:tool_use) → 注册 index→{id,name}，产 tool_call_delta 带 name
 *     （不带 argumentsDelta，触发 StreamConsumer.handleToolCall 首次 emit tool_call_start）
 *   - content_block_delta.input_json_delta → 产 tool_call_delta 带 argumentsDelta(partial_json)
 *     （StreamConsumer.handleToolCall 推 tool_call_delta + 累积 argumentsBuf）
 *   - content_block_stop(tool_use index) → 清理 mapping；不产事件（finish 关闭 active block）
 * error 兜底分支（主路径 client.stream status 检查抛错）：
 *   - type:'error' → 产 error StreamEvent（message + code）
 *
 * 注意：跨 chunk 的半帧缓冲归 protocol.ts 的 parseStream（按 \n\n 切帧）；
 * 本文件只负责解析「一个完整 SSE 帧」。
 *
 * index→toolCall 映射：parseAnthropicSseFrame 是纯函数，无法跨帧存状态，
 * 映射由 AnthropicMessagesProtocol 实例持有（parseStream 入口更新并传入）。
 */
import type { StreamEvent } from '../../../server/src/llm/protocol';
import type { Usage } from '../../../server/src/message/types';
import { mapStopReason } from './protocol';

/** index → toolUse block 元数据（id + name），跨帧累积 */
export type ToolUseIndexMap = Map<number, { id: string; name: string }>;

/**
 * 把 anthropic wire usage 对象翻译为 spec 完整 Usage 字段集（session_usage.md §1）。
 *
 * anthropic wire 字段映射：
 *   - input_tokens                → input_no_cache（启用 cache_control 时不含 cache 部分）
 *   - output_tokens               → output_response
 *   - cache_read_input_tokens     → input_cache_read
 *   - cache_creation_input_tokens → input_cache_write
 *
 * derived totals（spec §1 要求写入时固化）：
 *   - input_total_tokens  = input_cache_read + input_cache_write + input_no_cache
 *   - output_total_tokens = output_response + output_reasoning（reasoning wire 不单独给，置 0）
 *   - total_tokens        = input_total_tokens + output_total_tokens
 *
 * 注：
 *   - anthropic 的 input_tokens 在启用 cache_control 时**不含** cache_read/cache_creation
 *     （它表示本次实际计费的普通输入），故 no_cache 直接取 input_tokens。
 *   - **minimax wire 校准**（实测抓自 `states/v0.0.13/verify/usage_raw_calibration.md`）：
 *     MiniMax-M3 wire usage 字段名与原生 anthropic 完全一致
 *     （input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens），
 *     额外带 `service_tier`（忽略）。**input_tokens 语义 = 不含 cache 的普通输入**（与 derived
 *     一致，无双计）。**M3 reasoning token wire 不单独暴露**（output_tokens 已含全部输出，
 *     output_reasoning 恒 0）。cache_creation 实测恒 0（minimax 不计 cache write）。
 *   - cost / currency 不在此填——由 LlmClient.computeCost 在 call()/stream() 末尾按
 *     modelConfig.pricing 算（见 llm_client_interface §3.7）。
 *   - inputCharCount / outputCharCount 不在此填——由 agent loop 按数据来源填
 *     （snapshot.inputCharCount / StreamConsumer 累积纯 TextBlock 字符数，session_usage §1 D3.1）。
 *
 * @param raw anthropic wire 的 usage 对象（message.usage 或 message_delta.usage）
 * @returns spec 完整字段集的 Usage（token 部分；cost/char 留空由上层填）
 */
export function parseAnthropicUsage(raw: unknown): Usage {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const num = (k: string): number | undefined => {
    const v = r[k];
    return typeof v === 'number' ? v : undefined;
  };
  const cacheRead = num('cache_read_input_tokens') ?? 0;
  const cacheWrite = num('cache_creation_input_tokens') ?? 0;
  const inputNoCache = num('input_tokens') ?? 0;
  const outputResponse = num('output_tokens') ?? 0;
  const outputReasoning = 0; // anthropic wire 当前不单独暴露 reasoning token 计数
  const inputTotal = cacheRead + cacheWrite + inputNoCache;
  const outputTotal = outputResponse + outputReasoning;
  const total = inputTotal + outputTotal;
  // 只保留有真实值的字段（避免输出全 0 噪声；undefined 字段不序列化）
  const usage: Usage = {};
  if (cacheRead) usage.input_cache_read = cacheRead;
  if (cacheWrite) usage.input_cache_write = cacheWrite;
  if (inputNoCache) usage.input_no_cache = inputNoCache;
  usage.input_total_tokens = inputTotal;
  if (outputResponse) usage.output_response = outputResponse;
  // output_reasoning 恒 0，不写入（避免噪声；spec 允许 optional）
  usage.output_total_tokens = outputTotal;
  usage.total_tokens = total;
  return usage;
}

/**
 * 解析一个完整 SSE 帧（含 event: / data: 行，无尾 \n\n）。
 * 返回该帧产出的 StreamEvent[]（可能为空：text content_block_start 等不产出）。
 *
 * @param frame 完整 SSE 帧文本
 * @param toolUseIndex index→toolUse 元数据映射（content_block_start 时写入、content_block_stop 时清理）；
 *   调用方（AnthropicMessagesProtocol.parseStream）持有跨帧。
 */
export function parseAnthropicSseFrame(
  frame: string,
  toolUseIndex: ToolUseIndexMap,
): StreamEvent[] {
  // 按 \n 拆行；data: 行的 JSON 拼接（一帧可有多 data 行）
  const lines = frame.split('\n');
  let dataPayload: string | null = null;
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '');
    if (trimmed.startsWith('data:')) {
      const d = trimmed.slice(5).trim();
      // 多 data 行拼接（标准 SSE 允许）；本协议一帧一 data 够用
      dataPayload = dataPayload === null ? d : dataPayload + '\n' + d;
    }
    // event: 行本协议不依赖（type 在 data JSON 里），忽略
  }
  if (dataPayload === null) return [];
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(dataPayload) as Record<string, unknown>;
  } catch {
    // 非 JSON data（如部分厂商的心跳包）→ 忽略
    return [];
  }
  return eventsFromAnthropicPayload(json, toolUseIndex);
}

/** 把一个 anthropic SSE 事件 payload 翻译为 StreamEvent[] */
function eventsFromAnthropicPayload(
  json: Record<string, unknown>,
  toolUseIndex: ToolUseIndexMap,
): StreamEvent[] {
  const type = json['type'] as string | undefined;
  if (type === 'error') {
    // anthropic error 事件（HTTP 2xx 但 body 含 error 的兜底分支）
    const err = (json['error'] as Record<string, unknown> | undefined) ?? {};
    const message = String(err['message'] ?? 'unknown error');
    const code = err['type'] !== undefined ? String(err['type']) : undefined;
    return code !== undefined
      ? [{ type: 'error', message, code }]
      : [{ type: 'error', message }];
  }
  if (type === 'content_block_start') {
    const cb = json['content_block'] as Record<string, unknown> | undefined;
    if (cb && cb['type'] === 'tool_use') {
      // 注册 index→{id,name}，产 tool_call_delta 带 name（无 argumentsDelta）→
      // 触发 StreamConsumer.handleToolCall 首次 emit tool_call_start
      const idx = json['index'];
      const id = String(cb['id'] ?? '');
      const name = String(cb['name'] ?? '');
      if (typeof idx === 'number') toolUseIndex.set(idx, { id, name });
      return [{ type: 'tool_call_delta', toolCallId: id, name }];
    }
    // text/thinking 的 content_block_start → 不产出
    return [];
  }
  if (type === 'content_block_delta') {
    const delta = json['delta'] as Record<string, unknown> | undefined;
    if (!delta) return [];
    const dt = delta['type'] as string;
    if (dt === 'text_delta') {
      return [{ type: 'text_delta', text: String(delta['text'] ?? '') }];
    }
    if (dt === 'thinking_delta') {
      return [
        { type: 'thinking_delta', thinking: String(delta['thinking'] ?? '') },
      ];
    }
    if (dt === 'signature_delta') {
      // 不续 thinking，签名增量忽略（research §3）
      return [];
    }
    if (dt === 'input_json_delta') {
      // tool_use 参数增量 → tool_call_delta(argumentsDelta)
      // 通过 index→toolCallId 映射查到对应 tool_use 的 id
      const idx = json['index'];
      const partial = delta['partial_json'];
      if (typeof idx !== 'number' || typeof partial !== 'string') return [];
      const meta = toolUseIndex.get(idx);
      if (!meta) return [];
      return [
        {
          type: 'tool_call_delta',
          toolCallId: meta.id,
          argumentsDelta: partial,
        },
      ];
    }
    return [];
  }
  if (type === 'content_block_stop') {
    // tool_use block 结束 → 清理 mapping（finish 时由 StreamConsumer 关 active block）
    const idx = json['index'];
    if (typeof idx === 'number') toolUseIndex.delete(idx);
    return [];
  }
  if (type === 'message_stop') {
    return [{ type: 'finish', reason: 'stop' }];
  }
  if (type === 'message_delta') {
    const events: StreamEvent[] = [];
    const delta = json['delta'] as Record<string, unknown> | undefined;
    const stopReason = delta?.['stop_reason'] as string | undefined;
    if (stopReason !== undefined && stopReason !== null) {
      events.push({ type: 'finish', reason: mapStopReason(stopReason) });
    }
    const usageRaw = json['usage'];
    if (usageRaw !== undefined && usageRaw !== null) {
      // anthropic wire usage → spec 完整 Usage 字段（含 cache 字段透传 + derived totals）
      events.push({ type: 'usage', usage: parseAnthropicUsage(usageRaw) });
    }
    return events;
  }
  // message_start / ping 等 → 不产出
  return [];
}
