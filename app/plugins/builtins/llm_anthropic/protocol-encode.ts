/**
 * anthropic_messages 协议 encode 入口（canonical → wire body）
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.5/§4
 *       specs/tech/agent/providers_and_models/anthropic_impl.md §4（cache control 2bp）
 *       specs/research/v0.0.3-anthropic-protocol.md §1（request body 形状）
 *
 * 入参约定：request.messages 假定**已是 logical 视图**（sender 已展平入首块
 * TextBlock 前缀，由上游 toLogicalMessages 完成）。本 encode 只读 role + content，
 * 不读 Message.sender；sender 展平职责归 llm/logical-view.ts，protocol 自身只做协议映射
 * （role tool→user、相邻同 role 合并、system 顶层、cache_control）。参考: change_log.md §3.6（边界）。
 *
 * v0.0.191：impl 物理迁入 plugin（原主干 app/server/src/llm/protocol-encode.ts）。
 * 纯函数 helper 已拆到 ./protocol-encode-helpers.ts（参照 rocky_context/assemble 范式）。
 * wire 行为逐字节不变，UT 守护（含本版本刚修 reminder 过滤口径「最末 message」+
 * cache_control bp#2「最后非 reminder block」）。
 *
 * cache control（[P0]cache_control.md §3，prompt caching 显式 breakpoint 路线）：
 *   每次 encode 注入 2 个 cache_control breakpoint，最大化缓存命中：
 *     1. system prompt：encode 时转 content block array（若原始是 string），给最后一个 block 加 cache_control（bp#1）
 *     2. 跨所有 message 从末尾向前扫第一个非 reminder block：加 cache_control（bp#2，spec §3.2）
 *   并在 encode 各 message 时做 wire 层 reminder 过滤（spec §3.3）：历史 reminder 全 drop、
 *   只有最末 message 保留其最末一个 reminder。ttl 默认 ephemeral（Anthropic 默认 5 分钟）。
 */
import type { CanonicalRequest, WireBody } from '../../../server/src/llm/protocol';
import {
  CACHE_CONTROL_EPHEMERAL,
  encodeMessage,
  encodeTools,
  extractSystemText,
  injectLastNonReminderCacheControl,
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
 * 注入 2 个 cache_control breakpoint（system 末 block bp#1 + 跨 message 最末非 reminder block bp#2，
 * spec §3）+ wire 层 reminder 过滤（spec §3.3，历史 reminder 不进 wire）。
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

  // 最末 message 索引（role 不限）：发送给 LLM 的最后一条永远是 user/tool（wire 上映射后都是
  // user）。[修正] reminder 保留口径从「最末 canonical user message」改为「最末 message」——
  // 旧口径在 tool 密集 loop 里把 reminder 钉死在历史深处的 user 消息上，指针移动时旧位置
  // reminder 被 retroactive drop → 已发送前缀在深位置变化 → 隐式 prompt cache（无法控断点，
  // 只能逐字节持有已发消息）整段崩。新口径：历史 reminder 全 drop，只有最末 message 保留，
  // drop 只发生在尾部（reminder 恒为所在 message 末块，前缀损失≈零）。
  const lastMsgIdx = nonSystem.length - 1;

  // 编码 messages：role 映射 tool→user + wire 层 reminder 过滤（§3.3：只留最末 message 的）。
  // reminderFlags 平行标记每个保留 wire block 是否原为 reminder，供 bp#2 跳过（spec §3.2）。
  const encoded: Array<Record<string, unknown>> = [];
  const reminderFlags: boolean[][] = [];
  nonSystem.forEach((m, idx) => {
    const r = encodeMessage(m, idx === lastMsgIdx);
    encoded.push({ role: r.role, content: r.content });
    reminderFlags.push(r.flags);
  });

  // bp#2 必须在 merge 前：reminder 标记仅 pre-merge 可读；merge 只拼 content、不改顺序。
  injectLastNonReminderCacheControl(encoded, reminderFlags);

  // BUG-002：role 映射后合并相邻同 role，保证 wire 严格 user/assistant 交替。
  const wireMessages = mergeAdjacentSameRole(encoded);

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
