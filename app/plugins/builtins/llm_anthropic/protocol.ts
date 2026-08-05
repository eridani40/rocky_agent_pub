/**
 * builtin llm_anthropic plugin — protocol impl（AnthropicMessagesProtocol 真实 impl）
 * 参考: specs/tech/plugin_system/[P0]builtin_plugins_directory.md §2.2（impl 模块路径相对 plugin 目录）
 *       specs/tech/plugin_system/[P0]plugin_manager_interface.md §3.4（impl 模块 default export 类）
 *       specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2/§3.5/§3.6
 *       specs/research/v0.0.3-anthropic-protocol.md §1/§2/§3/§4
 *
 * v0.0.191：impl 物理迁入 plugin（原主干 app/server/src/llm/protocol.ts 的类）。
 * 主干只留 LlmProtocol 接口 + CanonicalRequest/Response/WireBody/WireResponse/RequestParams/
 * StreamEvent 类型（plugin type-only import）。wire 行为逐字节不变（encode/parse/parseStream 逻辑原样迁入）。
 *
 * 设计（protocol §3.1/§3.2）：
 *   - 标准值（path/contentType/label）自承载为 readonly 常量
 *   - 纯翻译（encode/parse/parseStream）不碰网络；I/O 归 LlmClient
 *   - encode 不收 config——字段名映射在 impl 内部硬编码（委派 ./protocol-encode）
 *   - parseStream 把 anthropic SSE 翻译为统一 StreamEvent，
 *     thinking_delta / text_delta 平行变体（§3.6），index 不泄露给消费方
 */
import type {
  LlmProtocol,
  CanonicalRequest,
  CanonicalResponse,
  WireBody,
  WireResponse,
  StreamEvent,
} from '../../../server/src/llm/protocol';
import type {
  ContentBlock,
  Message,
} from '../../../server/src/llm/protocol-types';
import { encodeAnthropicMessages } from './protocol-encode';
import { parseAnthropicSseFrame, parseAnthropicUsage } from './protocol-parse-stream';

/**
 * anthropic_messages 协议实现（唯一 protocol ext impl）。
 * 构造签名约定：(implId, cfg)；cfg 为 ext_impl_config overlay（P0 基本空）。
 *
 * parseStream 需跨 chunk 缓冲半帧，故实例持有可变 buffer——
 * 每个 LlmClient.stream 应持有一个独立 protocol 实例（或重置 buffer）。
 * 为简化：每个 client 构造期 new 一个 protocol 实例，单 client 单流并发。
 */
export default class AnthropicMessagesProtocol implements LlmProtocol {
  readonly implId: string;
  protected readonly cfg: Record<string, unknown>;

  /** endpoint path（自承载代码常量） */
  readonly path = '/v1/messages';
  /** content-type（自承载代码常量） */
  readonly contentType = 'application/json';
  /**
   * UI 展示名（中文，人类可读）。handler 投影到 ProtocolMeta.label
   * 给前端 protocol 下拉渲染（与 implId 'anthropic_messages' 正交）。
   * 参考: specs/tech/agent/providers_and_models/anthropic_impl.md §2 标准值表
   */
  readonly label = 'Anthropic Messages 风格';

  /** 跨 chunk 的 SSE 半帧缓冲（parseStream 复用同一实例时累积） */
  private buffer = '';

  /**
   * content_block_start tool_use 时记录的 index→{id,name} 映射。
   * input_json_delta 帧只带 index，需查映射拿到 toolCallId 才能产 tool_call_delta。
   * content_block_stop 时清理对应 index。
   */
  private toolUseIndex: Map<number, { id: string; name: string }> = new Map();

  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    this.implId = implId;
    this.cfg = cfg;
  }

  /** canonical → wire（字段映射 / system 落点 top_level / 多模态编码在 impl 内部） */
  encode(request: CanonicalRequest): WireBody {
    return encodeAnthropicMessages(request);
  }

  /** wire 响应 → canonical */
  parse(response: WireResponse): CanonicalResponse {
    const body = response.body as Record<string, unknown>;
    const content = (body['content'] as ContentBlock[]) ?? [];
    const stopReasonRaw = body['stop_reason'] as string | undefined;
    const message: Message = {
      id: (body['id'] as string) ?? '',
      role: 'assistant',
      content,
    };
    return {
      message,
      // anthropic wire usage → spec 完整 Usage 字段（parseAnthropicUsage 翻译 +
      // 计算 derived totals）。cost/currency 由 LlmClient.computeCost 在 call() 末尾填。
      usage: parseAnthropicUsage(body['usage']),
      stopReason: mapStopReason(stopReasonRaw),
    };
  }

  /** SSE chunk → StreamEvent[]（跨 chunk 缓冲半帧，index 不泄露） */
  parseStream(chunk: string): StreamEvent[] {
    // 追加到缓冲，按 \n\n（标准 SSE）或 \r\n\r\n（CRLF）切帧；完整帧解析，半帧留缓冲
    this.buffer += chunk;
    const events: StreamEvent[] = [];
    let split = nextFrameSplit(this.buffer);
    while (split !== null) {
      const { index, sepLen } = split;
      const frame = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + sepLen);
      events.push(...parseAnthropicSseFrame(frame, this.toolUseIndex));
      split = nextFrameSplit(this.buffer);
    }
    return events;
  }
}

/** 找 buffer 中第一个 SSE 帧分隔符位置与长度；无返 null */
function nextFrameSplit(
  buf: string,
): { index: number; sepLen: number } | null {
  const lf = buf.indexOf('\n\n');
  const crlf = buf.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf === -1 || (lf !== -1 && lf < crlf)) {
    return { index: lf, sepLen: 2 };
  }
  return { index: crlf, sepLen: 4 };
}

/** anthropic stop_reason → canonical stopReason（research §2） */
export function mapStopReason(
  raw: string | undefined,
): 'stop' | 'tool_use' | 'max_tokens' {
  switch (raw) {
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
      return 'tool_use';
    default:
      // end_turn / stop_sequence / pause_turn / sensitive / 缺省 → stop
      return 'stop';
  }
}
