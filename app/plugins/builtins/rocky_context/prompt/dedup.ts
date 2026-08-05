/**
 * builtin rocky_context plugin — system_prompt_reducer: dedup
 * 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.5
 *       specs/tech/agent/context_and_memory/[P0]system_prompt.md §3（dedup reducer）+ §9（priority 高的赢，不拼接）
 *
 * 职责：同 fragment.id 去重；同 id 多条保留 priority 最高的（不拼接）。
 *   input 已由 tier_sort 排序（tier 间固定 + tier 内 priority 降序），dedup 在此基础上
 *   只去同 id，保留首次出现（=priority 最高者，因 tier_sort 已按 priority 降序）。
 * EP: system_prompt_reducer，priority 800。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptReducer } from '../types';

/**
 * dedup reducer：同 id 去重，保留 priority 最高者（不拼接）。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4）。
 */
export default class DedupReducer
  extends ContextImplBase
  implements SystemPromptReducer
{
  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
  }

  reduce(input: PromptFragment[], _ctx: PromptCtx): PromptFragment[] {
    const seen = new Set<string>();
    const out: PromptFragment[] = [];
    for (const f of input) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
    }
    return out;
  }
}
