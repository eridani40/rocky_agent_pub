/**
 * builtin rocky_context plugin — system_prompt_reducer: tier_sort
 * 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.5
 *       specs/tech/agent/context_and_memory/[P0]system_prompt.md §3（tier_sort reducer）
 *
 * 职责：按 tier 排序 fragment（stable→context→volatile，tier 间固定）；
 *   tier 内按 fragment.priority 降序（priority 缺省 0）。
 * 不做去重（dedup reducer 负责）、不做裁剪（budget_truncate 负责）。
 * EP: system_prompt_reducer，priority 900。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptReducer } from '../types';

/** tier 排序权重（数字小者靠前） */
const TIER_ORDER: Record<string, number> = {
  stable: 0,
  context: 1,
  volatile: 2,
};

/**
 * tier_sort reducer：tier 间固定排序（stable→context→volatile），tier 内 priority 降序。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class TierSortReducer
  extends ContextImplBase
  implements SystemPromptReducer
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  reduce(input: PromptFragment[], _ctx: PromptCtx): PromptFragment[] {
    return [...input].sort((a, b) => {
      const ta = TIER_ORDER[a.tier] ?? 99;
      const tb = TIER_ORDER[b.tier] ?? 99;
      if (ta !== tb) return ta - tb;
      // tier 内 priority 降序（大者靠前）
      return (b.priority ?? 0) - (a.priority ?? 0);
    });
  }
}
