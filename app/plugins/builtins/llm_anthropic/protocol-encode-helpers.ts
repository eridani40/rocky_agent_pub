/**
 * builtin llm_anthropic plugin — encode 纯函数 helper 集
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.5/§4
 *       specs/tech/agent/providers_and_models/anthropic_impl.md §4（cache control 三断点体系，[v0.0.361]）
 *       specs/tech/agent/providers_and_models/[P0]cache_control.md §3.2/§3.3
 *
 * v0.0.191：从 protocol-encode.ts 拆出（参照 rocky_context/assemble/base_builder +
 * base_builder_helpers 范式），纯函数无逻辑依赖，搬文件不改 wire 输出。
 * 主文件 protocol-encode.ts 保留 encodeAnthropicMessages 入口 + EFFORT_WIRE_MAP 常量。
 *
 * [v0.0.361 T5] wire 层 reminder 过滤 + bp#2 避让扫描删除（change_plan §1.3 B' 裁决）：
 *   历史 reminder 块 append-only 全保留进 wire；bp#2 固定打最末 message 最末 block；
 *   encodeTools 末位注入 cache_control（bp#T 新增，老板 20:34）。TextBlock.isSystemReminder
 *   字段保留（前端契约），encode 不再读它。
 *
 * 包含：CACHE_CONTROL_EPHEMERAL 常量 + 7 个 encode 纯函数：
 *   encodeContentBlock / mergeAdjacentSameRole / encodeTools / encodeToolResultContent /
 *   extractSystemText / injectLastMessageCacheControl / encodeMessage
 */
import type { ContentBlock, Message } from '../../../server/src/llm/protocol-types';

/** anthropic cache_control wire 值（ttl 默认 ephemeral） */
export const CACHE_CONTROL_EPHEMERAL = Object.freeze({ type: 'ephemeral' });

/**
 * canonical ContentBlock → anthropic wire block（research §1 多模态表）
 */
export function encodeContentBlock(b: ContentBlock): Record<string, unknown> {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'image': {
      // ImageBlock（source.kind + mediaType 顶层）→ anthropic wire 形。
      // 禁直接透传 b.source（spec 形 ≠ wire 形，drift 致 LLM 收错字段名——source.kind/data 不是 anthropic 字段）。
      // base64 → { type:'base64', media_type, data }；url → { type:'url', url }。
      const src = b.source;
      const wireSource =
        src.kind === 'base64'
          ? { type: 'base64', media_type: b.mediaType, data: src.data }
          : { type: 'url', url: src.url };
      return { type: 'image', source: wireSource };
    }
    case 'thinking':
      // assistant 的 thinking block 回传（多轮续 thinking）；不主动产出
      return {
        type: 'thinking',
        thinking: b.thinking,
        ...(b.signature !== undefined ? { signature: b.signature } : {}),
      };
    case 'reasoning':
      // reasoning 思维链 → anthropic wire thinking block
      return { type: 'thinking', thinking: b.text };
    case 'tool_call':
      // tool_call（字段 arguments）→ anthropic wire tool_use（字段 input）
      return { type: 'tool_use', id: b.id, name: b.name, input: b.arguments };
    case 'tool_result':
      // tool_result（字段 toolCallId/isError）→ anthropic wire tool_result（tool_use_id）
      return {
        type: 'tool_result',
        tool_use_id: b.toolCallId,
        content: encodeToolResultContent(b.content),
        ...(b.isError ? { is_error: true } : {}),
      };
    default:
      // 兜底：原样透传未知 block（未来 block 兼容）
      return { ...(b as Record<string, unknown>) };
  }
}

/**
 * anthropic tool_result.content 接受 string | wire content block array。
 * 业务侧 tool_result.content 是 ContentBlock[]（业务权威），
 * encode 时把每块按 encodeContentBlock 翻译为 wire block（Record<string,unknown>）。
 */
export function encodeToolResultContent(
  blocks: ContentBlock[] | string,
): unknown {
  if (typeof blocks === 'string') return blocks;
  return blocks.map(encodeContentBlock);
}

/**
 * canonical Message → anthropic wire message（role + content blocks）。
 * role 映射 tool → user（库内仍 role:"tool"，仅 encode 边界转 user）。
 * [v0.0.361 T5] wire 层 reminder 过滤删除（change_plan §1.3 B'）：历史 reminder 块
 * append-only 全保留进 wire（transcript 字节不变 → 前缀稳定）；TextBlock.isSystemReminder
 * 字段不进 wire（encodeContentBlock 只映射 text 字段，前端契约字段不出协议边界）。
 */
export function encodeMessage(
  m: Message,
): { role: string; content: Array<Record<string, unknown>> } {
  const role = m.role === 'tool' ? 'user' : m.role;
  return { role, content: m.content.map(encodeContentBlock) };
}

/**
 * cache_control bp#2（[v0.0.361 T5] 固定落位）：最末 wire message 的最末 block 注入
 * cache_control（mutate wire block）。不再反向扫非 reminder 避让——历史 reminder 块
 * 全保留后，最末 block 即本轮新增内容末端，bp 落此 = 前缀稳定（每轮命中上一轮缓存
 * 条目，只有新块计费）。messages 为空 / 最末 content 为空时 no-op。
 */
export function injectLastMessageCacheControl(
  wireMessages: Array<Record<string, unknown>>,
): void {
  const last = wireMessages[wireMessages.length - 1];
  if (!last) return;
  const content = last['content'];
  if (!Array.isArray(content) || content.length === 0) return;
  const block = content[content.length - 1] as Record<string, unknown>;
  block['cache_control'] = { ...CACHE_CONTROL_EPHEMERAL };
}

/** 抽出 messages[] 中 role:system 的纯文本（多 block 拼接）；无 system 返 null */
export function extractSystemText(messages: Message[]): string | null {
  const sysMsgs = messages.filter((m) => m.role === 'system');
  if (sysMsgs.length === 0) return null;
  return sysMsgs
    .flatMap((m) => m.content)
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}

/**
 * 合并相邻同 role 的 wire message（content 数组拼接）。
 * anthropic 要求 messages 数组严格 user/assistant 交替。role 映射 tool→user 后会破坏：
 *   - 多个连续 tool result（tool→user 后变连续 user）；
 *   - tool result 紧跟 user（tool→user 后与下条 user 连续）。
 * 此函数在 role 映射后做兜底合并，保证进 wire 严格交替。不丢内容、不改 block 内部。
 * 入参返新数组（不 mutate 入参元素；首个元素浅拷贝后 mutate content 数组）。
 */
export function mergeAdjacentSameRole(
  encoded: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged: Array<Record<string, unknown>> = [];
  for (const m of encoded) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last['role'] === m['role']) {
      // 同 role：content 数组拼接（保留顺序）
      const lastContent = last['content'] as unknown[];
      const curContent = m['content'] as unknown[];
      last['content'] = [...lastContent, ...curContent];
    } else {
      // 新 role：浅拷贝 message（content 数组后续可能被拼接 mutate，避免改到入参）
      merged.push({ ...m, content: [...(m['content'] as unknown[])] });
    }
  }
  return merged;
}

/**
 * 把 canonical request.tools（unknown[]，运行时通常是 ToolDefinition[]）
 * 映射为 anthropic wire tools 数组：{name, description, input_schema}。
 * 按形状 narrow：元素需有 string `name` 才采纳；description/inputSchema 缺则给空值兜底。
 * 非法元素（无 name）跳过。返回空数组表示「无工具可用」。
 *
 * [v0.0.361 T5] bp#T（老板 20:34 三断点体系）：最末位 tool 注入 cache_control——
 * tools 变更频率低（session 级稳定），bp 落末位使 system 段变更时 tools 前缀仍命中；
 * tools 为空数组时无断点（Anthropic 上限 4 断点，三断点体系下合规）。
 */
export function encodeTools(tools: unknown[] | undefined): Array<{
  name: string;
  description: string;
  input_schema: unknown;
  cache_control?: { type: 'ephemeral' };
}> {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const out: Array<{
    name: string;
    description: string;
    input_schema: unknown;
    cache_control?: { type: 'ephemeral' };
  }> = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const obj = t as Record<string, unknown>;
    const name = obj['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const description =
      typeof obj['description'] === 'string' ? obj['description'] : '';
    // inputSchema 缺省给空 object schema（anthropic 要求 input_schema 存在）
    const input_schema = obj['inputSchema'] ?? { type: 'object', properties: {} };
    out.push({ name, description, input_schema });
  }
  // bp#T：末位 tool 注入 cache_control（tools 非空才落）
  if (out.length > 0) {
    out[out.length - 1]!.cache_control = { ...CACHE_CONTROL_EPHEMERAL };
  }
  return out;
}
