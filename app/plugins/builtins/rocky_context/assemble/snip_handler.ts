/**
 * builtin rocky_context plugin — clean_view_reducer: snip_handler
 * 参考: specs/tech/agent/context/[P0]context_assemble_detail.md §5b
 *       specs/tech/agent/context/[P0]extension point and implementations.md §3.10
 *
 * 职责（§5b 表）：被 snip 的 content block（message.snip 标记）替换为占位文本。
 *   - message.metadata.snip === true（或 content block 标 snip）→ 替换为占位 text block
 *   - 占位文本 `[content snipped]`，保留 message 结构（不删 message）
 *
 * snip 标记来源：上游（如 budget_truncate reducer 若超预算裁 content）打标。
 * v0.0.13 budget_truncate 归 system_prompt reducer（不裁 message），故 message snip
 * 实际触发少；本 reducer 仍按契约实现，保链完整性。
 *
 * EP: context_clean_view_reducer，order 1（链首；由 ContextEngine.getCleanSnapshot 在深克隆副本上跑）。
 */
import type { ContentBlock, Message } from '../../../../server/src/message/types';
import { AssembleData, AssembleCtx, AssembleReducer, ContextImplBase } from '../types';

/** 占位文本（§5 表） */
const SNIPPED_PLACEHOLDER = '[content snipped]';

/**
 * snip_handler reducer：被 snip 标记的 content block 替换为占位。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class SnipHandlerReducer
  extends ContextImplBase
  implements AssembleReducer
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  reduce(_data: AssembleData, input: Message[] | null, _ctx: AssembleCtx): Message[] {
    if (input === null) return [];
    return input.map((m) => {
      // message 整体被标 snip → 所有非空 block 替换为占位
      const msgSnip = m.metadata?.snip === true;
      if (msgSnip) {
        return { ...m, content: [{ type: 'text' as const, text: SNIPPED_PLACEHOLDER }] };
      }
      // 单 block 标 snip（block 自身无 metadata 字段，通过自定义属性判定；当前 v0.0.13 无此场景）
      // 兜底：检查 block 是否含 snip 标记（ContentBlock 联合无 snip 字段，跳过）
      const newContent = m.content.map((b) => maybeSnipBlock(b));
      return { ...m, content: newContent };
    });
  }
}

/** 单 block 若被标 snip → 替换占位；否则原样保留。当前 ContentBlock 无 snip 字段，恒保留。 */
function maybeSnipBlock(b: ContentBlock): ContentBlock {
  const flagged = (b as unknown as { snip?: boolean }).snip === true;
  if (flagged) return { type: 'text', text: SNIPPED_PLACEHOLDER };
  return b;
}
