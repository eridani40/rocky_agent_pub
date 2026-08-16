/**
 * anthropic_messages 协议 encode 入口（canonical → wire body）
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.5/§4
 *       specs/tech/agent/providers_and_models/anthropic_impl.md §4（cache control 三断点体系，[v0.0.361]）
 *       specs/research/v0.0.3-anthropic-protocol.md §1（request body 形状）
 *
 * 入参约定：request.messages 假定**已是 logical 视图**（sender 已展平入首块
 * TextBlock 前缀，由上游 toLogicalMessages 完成）。本 encode 只读 role + content，
 * 不读 Message.sender；sender 展平职责归 llm/logical-view.ts，protocol 自身只做协议映射
 * （role tool→user、相邻同 role 合并、system 顶层、cache_control）。参考: change_log.md §3.6（边界）。
 *
 * v0.0.191：impl 物理迁入 plugin（原主干 app/server/src/llm/protocol-encode.ts）。
 * 纯函数 helper 已拆到 ./protocol-encode-helpers.ts（参照 rocky_context/assemble 范式）。
 *
 * [v0.0.361 T5] wire 层 reminder 过滤 + bp#2 避让扫描删除（change_plan §1.3 B' 裁决）：
 *   历史 reminder 块 append-only 全保留进 wire；bp#2 固定打最末 message 最末 block。
 *
 * cache control（[P0]cache_control.md §3，[v0.0.361] 三断点体系——老板 20:34 终版）：
 *   每次 encode 注入 3 个 cache_control breakpoint（Anthropic 上限 4，合规）：
 *     1. bp#1：system prompt 末 block（encode 转 content block array，若原始是 string）
 *     2. bp#T：tools 末位 tool（encodeTools 内注入——tools session 级稳定）
 *     3. bp#2：最末 message 的最末 block（固定落位，不反向扫避让）
 *   历史块进 transcript 后字节不变（append-only）→ bp#2 前缀 = 稳定历史 + 本轮新块
 *   → 每轮命中上一轮缓存条目，只有新块计费。ttl 默认 ephemeral。
 */
import type { CanonicalRequest, WireBody } from '../../../server/src/llm/protocol';
import {
  CACHE_CONTROL_EPHEMERAL,
  encodeMessage,
  encodeTools,
  extractSystemText,
  injectLastMessageCacheControl,
  mergeAdjacentSameRole,
} from './protocol-encode-helpers';

/**
 * [v0.0.148] canonical effort → anthropic wire effort 映射（PRD §1.1 映射表）。
   canonical 用语义键（非 wire 字面值）；映射在 encode 内部硬编码（protocol 是纯翻译 §3.1）。
   - 'low' → 'low' / 'high' → 'high' / 'max' → 'max'
   - 'default' 不在此表（= 不注入 output_config 字段，等价厂商默认行为）
 */
const EFFORT_WIRE_MAP: Record<'low' | 'high' | 'max', string> = {
  low: 'low',
  high: 'high',
  max: 'max',
};

/**
 * 把 canonical 请求编码为 anthropic /v1/messages 的 wire body。
 * 纯函数：不碰网络、不读 config；字段名映射在内部硬编码。
 * 注入 3 个 cache_control breakpoint（system 末 bp#1 + tools 末 bp#T + 最末 message
 * 最末 block bp#2，[v0.0.361] 三断点体系）+ 历史 reminder 块全保留（不 drop）。
 *
 * request.tools 必须映射到 wire `tools` 字段，否则真实 LLM 看不到工具。
 *   ToolDefinition.inputSchema → anthropic `input_schema`（字段名映射）。
 *   空/缺则不加 tools 字段（对齐 anthropic：无 tools = 纯对话）。
 *
 * role 映射 tool → user 后合并相邻同 role：
 *   anthropic Messages API 端点只接受 role ∈ {user,assistant}（system 提顶层），
 *   拒收 role:"tool"（422 literal_error）。encode 是 canonical→wire 边界最后一站，
 *   覆盖 eager（agent-loop）+ forked（forked-agent，不走 assemble 直接 push）两条路径。
 */
export function encodeAnthropicMessages(request: CanonicalRequest): WireBody {
  const { modelId, messages, params } = request;

  // system 落点 top_level：从 messages[] 抽出 role:system 的 text
  const systemText = extractSystemText(messages);
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // 编码 messages：role 映射 tool→user。[v0.0.361 T5] reminder 过滤已删——
  // 历史 reminder 块 append-only 全保留进 wire（transcript 字节不变 → 前缀稳定）。
  const encoded: Array<Record<string, unknown>> = nonSystem.map((m) => {
    const r = encodeMessage(m);
    return { role: r.role, content: r.content };
  });

  // BUG-002：role 映射后合并相邻同 role，保证 wire 严格 user/assistant 交替。
  const wireMessages = mergeAdjacentSameRole(encoded);

  // [v0.0.361 T5] bp#2 固定落位（merge 后）：最末 wire message 最末 block。
  // merge 可能拼接同 role content，落位以 wire 终态为准（不再依赖 pre-merge flags）。
  injectLastMessageCacheControl(wireMessages);

  const body: WireBody = {
    model: modelId,
    max_tokens: params.maxTokens ?? 0,
    messages: wireMessages,
    stream: params.stream ?? false,
    // tool_stream：部分厂商（volcengine ark 等）支持，控制 tool 调用参数增量流式（input_json_delta）。
    // 与 stream 并列顶层；不支持该字段的厂商（minimax/原生 anthropic）按 SSE 规范忽略未知字段。
    tool_stream: true,
  };

  // cache_control bp#1：system（encode 时转 content block array，末 block 加 cache_control）。
  // string system 自动转 array；ttl 默认 ephemeral（anthropic_impl.md §4）。
  if (systemText !== null) {
    body['system'] = [
      { type: 'text', text: systemText, cache_control: { ...CACHE_CONTROL_EPHEMERAL } },
    ];
  }

  if (params.temperature !== undefined) body['temperature'] = params.temperature;
  if (params.topP !== undefined) body['top_p'] = params.topP;
  // EOS 双保险（架构 §2.E）：params.stop → wire stop_sequences（Anthropic）。
  // SquadChat session 注入 ['<EOS>']，让 stream 在保留字处自然停（缓存友好）。
  // 空数组/缺省不加字段（对齐 anthropic：缺省 = 无 stop sequence 约束）。
  if (params.stop !== undefined && params.stop.length > 0) {
    body['stop_sequences'] = params.stop;
  }

  // [v0.0.148] effort 推理强度注入（PRD §1.1/§1.2，protocol §3.5）。
  // canonical effort（语义键）→ anthropic wire output_config.effort（EFFORT_WIRE_MAP 映射）。
  // 'default'/undefined 档不加 output_config 字段（= 厂商默认行为，非传字面 "default"）。
  // 源头 session.effort → config.effort → CallLLMInput.effort → params.effort → 此处注入。
  if (params.effort !== undefined && params.effort !== 'default') {
    const wireEffort = EFFORT_WIRE_MAP[params.effort];
    if (wireEffort !== undefined) {
      body['output_config'] = { effort: wireEffort };
    }
  }

  // BUG-007：request.tools → wire tools（ToolDefinition → anthropic {name,description,input_schema}）。
  // CanonicalRequest.tools 类型是 unknown[]（protocol 层不耦合 ToolDefinition），
  // 这里按形状 narrow：有 name/description/inputSchema 的元素才映射，缺字段默认空值（防御性）。
  // 空/缺则不加 tools 字段（对齐 anthropic：无 tools = 纯对话）。
  const wireTools = encodeTools(request.tools);
  if (wireTools.length > 0) body['tools'] = wireTools;

  return body;
}
