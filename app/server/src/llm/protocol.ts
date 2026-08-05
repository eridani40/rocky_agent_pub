/**
 * LlmProtocol 契约 + canonical/wire 类型定义（impl 已迁 builtin plugin llm_anthropic）
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2/§3.5/§3.6
 *       specs/research/v0.0.3-anthropic-protocol.md §1/§2/§3/§4
 *
 * v0.0.191：AnthropicMessagesProtocol 类 + mapStopReason 已物理迁入
 *   app/plugins/builtins/llm_anthropic/protocol.ts（builtin plugin impl）。
 * 本文件只保留 LlmProtocol 接口 + 所有 canonical/wire 类型定义（30+ 调用点
 * `import type` 依赖，类型留主干 → 调用点零改动）。
 */
import type { Message } from './protocol-types';
import type { Usage } from '../message/types';

/** wire 请求体（各 protocol 自定义，可 JSON 序列化） */
export type WireBody = Record<string, unknown>;

/** wire 响应（已解析的 JSON） */
export interface WireResponse {
  status: number;
  body: unknown;
}

/** canonical 响应（parse 产出；usage 为 spec 完整字段集，见 session_usage.md §1） */
export interface CanonicalResponse {
  message: Message;
  usage: Usage;
  stopReason: 'stop' | 'tool_use' | 'max_tokens';
}

/** canonical 请求（LlmClient.call/stream 入参） */
export interface CanonicalRequest {
  modelId: string;
  messages: Message[];
  tools?: unknown[];
  params: RequestParams;
}

/** 框架统一参数键名（字段名映射归 protocol impl） */
export interface RequestParams {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stream?: boolean;
  /**
   * stop sequence（EOS 双保险 caller 层注入，架构 §2.E）。
   * SquadChat session（sessionType='squad'）调 LLM 时注入 `['<EOS>']`，
   * 让 token stream 在保留字 `<EOS>` 处自然停（缓存友好）。
   * provider 不支持 stop seq 时由 stage-llm ingest 前 strip `<EOS>` 兜底。
   * encode 映射 wire：Anthropic `stop_sequences`（protocol-encode.ts）。
   */
  stop?: string[];
  /**
   * [v0.0.148] effort 推理强度（canonical 语义键，4 档；非 wire 字面值）。
   * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.5
   * - 'default' = 厂商默认行为（encode 不注入 output_config 字段，等价未挂 effort）
   * - 'low'/'high'/'max' = encode 映射注入 anthropic wire `output_config.effort`（同名值）
   * 映射在 encode 内部硬编码（protocol 是纯翻译，§3.1）。源头 = session.effort → config.effort。
   */
  effort?: 'default' | 'low' | 'high' | 'max';
}

/**
 * SSE chunk 解析后的统一事件流（protocol §2 流式）。
 * - thinking_delta / text_delta 平行独立变体（§3.6）；index 不在变体中（不泄露给消费方）
 * - 仅 anthropic_messages impl 产出 thinking_delta
 */
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call_delta'; toolCallId: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: 'stop' | 'tool_use' | 'max_tokens' }
  // anthropic error 事件（HTTP 2xx 但 body 含 error 的兜底分支）；
  // 主路径（HTTP 非 2xx）由 client.stream status 检查抛错
  | { type: 'error'; message: string; code?: string }
  /**
   * LlmCaller retry / fallback 进度外显事件（非 provider 流事件，由 invoke 在
   * decide 产 action 时合成发到 ctx.onEvent）。
   * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3.1
   * agent-loop-call-via-invoker 的 onEvent 拦截本类型转 AgentEvent emit 到 bus（同 SSE 流）。
   */
  | {
      type: 'llm_attempt';
      category: import('./caller/error_types').LlmErrorCategory;
      providerId: string;
      modelId: string;
      keyRef?: string;
      attempt: number;
      /** 本次 invoke 的最大 attempt 次数（= config.retry.max_attempts，前端「重试中 x/x」分母） */
      maxAttempts: number;
      action: 'RETRY' | 'ROTATE_KEY' | 'FALLBACK' | 'FAIL';
      /** category 对应的用户可读文案（前端 hover 展示，deriveDisplayReason 派生） */
      message: string;
    };

/** protocol 行为契约（纯翻译，无状态，不碰网络，标准值自承载为 readonly 常量） */
export interface LlmProtocol {
  readonly path: string;
  readonly contentType: string;
  /**
   * 人类可读展示名（UI 下拉用）。与 ProtocolName id 正交：
   * id 是 wire/持久化标识（如 'anthropic_messages'），label 是 UI 展示文本（如「Anthropic Messages 风格」）。
   * handler.buildProtocolMeta 投影到 ProtocolMeta.label 给前端下拉渲染。
   * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2
   */
  readonly label: string;
  encode(request: CanonicalRequest): WireBody;
  parse(response: WireResponse): CanonicalResponse;
  parseStream(chunk: string): StreamEvent[];
}
