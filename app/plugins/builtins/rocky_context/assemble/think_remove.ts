/**
 * builtin rocky_context plugin — clean_view_reducer: think_remove
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §5b
 *       specs/tech/agent/context/[P0]extension point and implementations.md §3.10
 *
 * 职责（§5b 表）：删除所有 message 里的 reasoning(think) content block。
 *   - 仅按 block.type === 'reasoning' 过滤（reasoning 只存在于 assistant 消息）
 *   - 不删 message 本身（删 block 后变空的 message 由其后的 empty_message reducer 兜底清理）
 *   - 必须排在 empty_message 之前（scope yaml 固化 order），否则空 assistant 会被 empty_message
 *     当作「自然空」漏过（empty_message 只剔 content.length===0 的非 system msg）
 *
 * EP: context_clean_view_reducer，order 3（由 ContextEngine.getCleanSnapshot 在深克隆副本上跑）。
 */
import type { Message } from '../../../../server/src/message/types';
import { AssembleData, AssembleCtx, AssembleReducer, ContextImplBase } from '../types';

/**
 * think_remove reducer：删除每条 message 的 reasoning(think) content block。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class ThinkRemoveReducer
  extends ContextImplBase
  implements AssembleReducer
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  reduce(_data: AssembleData, input: Message[] | null, _ctx: AssembleCtx): Message[] {
    if (input === null) return [];
    // 过滤掉 reasoning block；不删 message 本身（空 message 由 empty_message reducer 清理）
    return input.map((m) => ({ ...m, content: m.content.filter((b) => b.type !== 'reasoning') }));
  }
}
