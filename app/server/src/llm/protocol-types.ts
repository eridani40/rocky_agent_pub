/**
 * canonical Message / ContentBlock 类型（protocol 翻译的框架规范输入）
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §2
 *       specs/tech/agent/message/[P0]agent_message_interface.md §1/§4
 *
 * 完整 Message 类型归 agent/message 模块；此处只声明 protocol 翻译所需的形状。
 * ContentBlock 字段名对齐 message/types.ts 权威源（message interface §4.6/§4.7/§4.8）：
 *   tool_call = id/name/arguments；tool_result = toolCallId/content/isError；reasoning = 思维链。
 * thinking 作 reasoning 别名保留：anthropic wire 响应可含 thinking block（带 signature），
 *   protocol.parse 原样透传到 canonical message.content。
 *
 * 注意：本 ContentBlock 与 message/types.ts 的 ContentBlock **未统一**，形状分叉
 *   （protocol-types 含 image/thinking，message/types 含 usage；tool_result.content 类型不同）。
 */

/** canonical content block（多模态统一形状） */
export type ContentBlock =
  // text block 镜像 message/types.ts TextBlock 的块级 reminder 标记（isSystemReminder?）：
  // context ingest 注入、protocol encode 读取识别（[P0]cache_control.md §3.2/§3.3）；
  // encodeContentBlock 对 text 只读 b.text → 字段不进 wire（LLM 零侵入）。
  | { type: 'text'; text: string; isSystemReminder?: boolean }
  // [v0.0.105] image block 是 encode 的**输入侧 canonical spec 形**（镜像 message/types.ts ImageBlock：
  //   source.kind 判别联合 + mediaType 顶层）——业务层 image 经 toProtocolMessage 原样透传到此，
  //   故此处必须是 spec 形而非 wire 形。encodeContentBlock case 'image' 负责翻译为 anthropic
  //   **输出侧 wire 形**（source:{type, media_type, data}）。spec↔wire 形态差异是 spec 落地的已知分叉，
  //   encode 是唯一翻译点（禁直接透传 source，否则 LLM 收错字段名）。
  | {
      type: 'image';
      source: { kind: 'url'; url: string } | { kind: 'base64'; data: string };
      mediaType: string;
    }
  // tool_call（字段名对齐 message interface §4.6）
  | { type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> }
  // tool_result（字段名对齐 message interface §4.7）
  | {
      type: 'tool_result';
      toolCallId: string;
      content: ContentBlock[];
      isError: boolean;
    }
  // reasoning（思维链，message interface §4.8）
  | { type: 'reasoning'; text: string }
  // thinking 保留作 reasoning 别名（/chat 协议解析路径仍依赖 thinking 多轮续传）
  | { type: 'thinking'; thinking: string; signature?: string };

/** canonical message（含 role：system/user/assistant/tool） */
export interface Message {
  id?: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentBlock[];
}
