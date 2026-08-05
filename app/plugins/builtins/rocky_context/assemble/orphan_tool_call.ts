/**
 * builtin rocky_context plugin — clean_view_reducer: orphan_tool_call
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §5b
 *       specs/tech/agent/context/[P0]extension point and implementations.md §3.10
 *
 * 职责（§5b 表）：移除无配对的 tool_use/tool_result。
 *   - tool_use block（assistant 发的 tool_call）其后无对应 tool_result → 移除该 block
 *   - tool_result block（tool 角色消息）无对应 tool_use → 移除该 block
 *   - 按 toolCallId ↔ tool_use_id（本系统 tool_call.id 即 toolCallId）配对
 *
 * EP: context_clean_view_reducer，order 2（base_builder 之后第一个清理；由 ContextEngine.getCleanSnapshot 在深克隆副本上跑）。
 */
import type { ContentBlock, Message } from '../../../../server/src/message/types';
import { AssembleData, AssembleCtx, AssembleReducer, ContextImplBase } from '../types';

/**
 * orphan_tool_call reducer：清理无配对的 tool_use/tool_result。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class OrphanToolCallReducer
  extends ContextImplBase
  implements AssembleReducer
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  reduce(_data: AssembleData, input: Message[] | null, _ctx: AssembleCtx): Message[] {
    if (input === null) return []; // base_builder 未跑过 → 空（理论不会发生）
    // 收集所有 tool_call id（配对 key）
    const callIds = new Set<string>();
    for (const m of input) {
      for (const b of m.content) {
        if (b.type === 'tool_call') callIds.add(b.id);
      }
    }
    // 收集所有 tool_result 的 toolCallId
    const resultIds = new Set<string>();
    for (const m of input) {
      for (const b of m.content) {
        if (b.type === 'tool_result') resultIds.add(b.toolCallId);
      }
    }
    // 过滤：tool_call 必须有对应 tool_result；tool_result 必须有对应 tool_call
    const filtered = input
      .map((m) => ({
        ...m,
        content: m.content.filter((b) => keepBlock(b, callIds, resultIds)),
      }))
      .filter((m) => m.content.length > 0 || m.role === 'system');

    // 邻接重排：确保 tool 消息紧跟在其对应的 assistant 消息之后（Anthropic API 要求）
    return reorderToolAdjacency(filtered);
  }
}

/** 单 block 是否保留：tool_call 需有 result 配对；tool_result 需有 call 配对；其他类型保留 */
function keepBlock(
  b: ContentBlock,
  callIds: Set<string>,
  resultIds: Set<string>,
): boolean {
  if (b.type === 'tool_call') return resultIds.has(b.id);
  if (b.type === 'tool_result') return callIds.has(b.toolCallId);
  return true;
}

/**
 * 邻接重排：确保每个含 tool_call 的 assistant 消息之后紧跟其对应的 tool 消息。
 * 若中间插入了其他消息（如用户在 tool 执行期间发送的消息），将 tool 消息前移，
 * 被跨过的消息顺延到 tool 消息之后。
 */
function reorderToolAdjacency(messages: Message[]): Message[] {
  const result: Message[] = [];
  const placed = new Set<number>();

  for (let i = 0; i < messages.length; i++) {
    if (placed.has(i)) continue;
    const m = messages[i];
    result.push(m);

    // 非 assistant 或无 tool_call → 不需要拉取后续 tool 消息
    if (m.role !== 'assistant') continue;
    const tcIds = new Set<string>();
    for (const b of m.content) {
      if (b.type === 'tool_call') tcIds.add(b.id);
    }
    if (tcIds.size === 0) continue;

    // 向后扫描：找到所有匹配的 tool 消息并拉到紧邻位置
    for (let j = i + 1; j < messages.length; j++) {
      if (placed.has(j)) continue;
      const candidate = messages[j];
      if (candidate.role !== 'tool') continue;
      const matches = candidate.content.some(
        (b) => b.type === 'tool_result' && tcIds.has(b.toolCallId),
      );
      if (matches) {
        result.push(candidate);
        placed.add(j);
      }
    }
  }
  return result;
}
