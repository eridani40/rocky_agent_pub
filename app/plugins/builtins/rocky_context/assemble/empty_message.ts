/**
 * builtin rocky_context plugin — clean_view_reducer: empty_message
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §5b
 *       specs/tech/agent/context/[P0]extension point and implementations.md §3.10
 *
 * 职责（§5b 表）：剔除 content blocks 为空的 message。
 *   - content.length === 0 → 移除整条 message
 *   - system 恒保留（避免误删 summary/system msg）
 *
 * EP: context_clean_view_reducer，order 5（由 ContextEngine.getCleanSnapshot 在深克隆副本上跑）。
 */
import type { Message } from '../../../../server/src/message/types';
import { AssembleData, AssembleCtx, AssembleReducer, ContextImplBase } from '../types';

/**
 * empty_message reducer：剔空 content 的 message。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class EmptyMessageReducer
  extends ContextImplBase
  implements AssembleReducer
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  reduce(_data: AssembleData, input: Message[] | null, _ctx: AssembleCtx): Message[] {
    if (input === null) return [];
    return input.filter((m) => m.role === 'system' || m.content.length > 0);
  }
}
