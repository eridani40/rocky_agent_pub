/**
 * builtin llm_anthropic plugin — encode 纯函数 helper 集
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md §3.5/§4
 *       specs/tech/agent/providers_and_models/anthropic_impl.md §4（cache control 2bp）
 *       specs/tech/agent/providers_and_models/[P0]cache_control.md §3.2/§3.3
 *
 * v0.0.191：从 protocol-encode.ts 拆出（参照 rocky_context/assemble/base_builder +
 * base_builder_helpers 范式），纯函数无逻辑依赖，搬文件不改 wire 输出。
 * 主文件 protocol-encode.ts 保留 encodeAnthropicMessages 入口 + EFFORT_WIRE_MAP 常量。
 *
 * 包含：CACHE_CONTROL_EPHEMERAL 常量 + 8 个 encode 纯函数：
 *   encodeContentBlock / mergeAdjacentSameRole / encodeTools / encodeToolResultContent /
 *   extractSystemText / injectLastNonReminderCacheControl / encodeMessage / isReminderBlock
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
 * canonical Message → anthropic wire message（role + content blocks）+ reminder 过滤标记。
 * role 映射 tool → user（库内仍 role:"tool"，仅 encode 边界转 user）。
 * wire 层 reminder 过滤（[P0]cache_control.md §3.3）：非最末 message drop
 *   所有 reminder；最末 message 只保留最末一个 reminder。wire 是一次性产物，
 *   transcript 不动（两层独立，spec §5）。flags 平行标记保留的 wire block 是否原为
 *   reminder，供 bp#2 决定落点（spec §3.2）。返回 {role, content, flags}。
 */
export function encodeMessage(
  m: Message,
  isLastMessage: boolean,
): { role: string; content: Array<Record<string, unknown>>; flags: boolean[] } {
  const role = m.role === 'tool' ? 'user' : m.role;
  const blocks = m.content;

  // 计算保留的 reminder 索引（§3.3）：非最末 message 不保留（-1，全 drop）；
  // 最末 message 保留最末一个 reminder（其索引）；无 reminder 时 -1（自然全保留非 reminder 块）。
  let lastKeptReminderIdx = -1;
  if (isLastMessage) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (isReminderBlock(blocks[i]!)) {
        lastKeptReminderIdx = i;
        break;
      }
    }
  }
  // 单遍过滤：reminder 且不在保留位置 → drop；其余 encode + 平行标记 flag
  const content: Array<Record<string, unknown>> = [];
  const flags: boolean[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const isRem = isReminderBlock(b);
    if (isRem && i !== lastKeptReminderIdx) continue; // 历史/非保留 reminder → drop
    content.push(encodeContentBlock(b));
    flags.push(isRem);
  }
  return { role, content, flags };
}

/**
 * 判定 canonical block 是否为 reminder（context ingest 注入的 TextBlock 块级标记，
 * 见 protocol-types ContentBlock text variant 的 isSystemReminder 字段）。
 * 只有 text block 能携带此标记（对齐 message/types.ts TextBlock）。spec §3.2。
 */
export function isReminderBlock(b: ContentBlock): boolean {
  return b.type === 'text' && b.isSystemReminder === true;
}

/**
 * cache_control bp#2（spec §3.2）：跨所有 encoded message 从末尾向前扫，命中第一个
 * 非 reminder block 即注入 cache_control（mutate wire block）。bp 落 reminder 上会致下轮
 * cache miss。无 reminder 时退化为「最后 block」（与旧版一致）。reminderFlags 与 encoded
 * 平行：flags[mi][bi]=true 表示该 wire block 原是 reminder。
 */
export function injectLastNonReminderCacheControl(
  encoded: Array<Record<string, unknown>>,
  reminderFlags: boolean[][],
): void {
  for (let mi = encoded.length - 1; mi >= 0; mi--) {
    const content = encoded[mi]!['content'];
    const flags = reminderFlags[mi]!;
    if (!Array.isArray(content) || content.length === 0) continue;
    for (let bi = content.length - 1; bi >= 0; bi--) {
      if (flags[bi] === true) continue; // reminder block：bp 跳过（spec §3.2）
      const block = content[bi] as Record<string, unknown>;
      block['cache_control'] = { ...CACHE_CONTROL_EPHEMERAL };
      return; // 命中第一个非 reminder block，bp#2 完成
    }
  }
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
 */
export function encodeTools(tools: unknown[] | undefined): Array<{
  name: string;
  description: string;
  input_schema: unknown;
}> {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  const out: Array<{ name: string; description: string; input_schema: unknown }> = [];
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
  return out;
}
