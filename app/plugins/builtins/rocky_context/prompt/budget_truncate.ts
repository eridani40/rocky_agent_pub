/**
 * builtin rocky_context plugin — system_prompt_reducer: budget_truncate
 * 参考: specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.5/§4.5
 *       specs/tech/agent/context_and_memory/[P0]system_prompt.md §3（budget_truncate reducer）+ §7
 *
 * 职责：token 预算裁剪——**只裁 context/volatile 动态段**（不裁 stable，裁了破坏 LLM 行为）。
 *   - 阈值 = clamp(contextWindow × budgetFraction, floor, ceiling) token
 *   - 默认 budgetFraction=0.06 / floor=20000 / ceiling=500000（manifest §4.5）
 *   - 超阈值：从动态段尾部裁（保留 stable 全部 + 动态段头部）
 *   - token 估算：char × ratio（当前 ratio=1.0，char 直接当 token 估算；S3 未激活）
 *
 * EP: system_prompt_reducer，priority 700。configSchema §4.5。
 */
import { ContextImplBase, type PromptCtx, type PromptFragment, type SystemPromptReducer } from '../types';

const DEFAULT_BUDGET_FRACTION = 0.06;
const DEFAULT_FLOOR = 100000;
const DEFAULT_CEILING = 500000;

/** 被裁掉的动态段尾部追加的标记 */
const TRUNCATE_NOTE = '…[dynamic context truncated by budget_truncate reducer]';

/**
 * budget_truncate reducer：token 预算只裁 context/volatile 动态段。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class BudgetTruncateReducer
  extends ContextImplBase
  implements SystemPromptReducer
{
  private readonly budgetFraction: number;
  private readonly floor: number;
  private readonly ceiling: number;

  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
    this.budgetFraction = this.getNumber(
      'budgetFraction',
      DEFAULT_BUDGET_FRACTION,
    );
    this.floor = this.getNumber('floor', DEFAULT_FLOOR);
    this.ceiling = this.getNumber('ceiling', DEFAULT_CEILING);
  }

  reduce(input: PromptFragment[], ctx: PromptCtx): PromptFragment[] {
    const budget = this.computeBudget(ctx);
    // stable 全保留；context/volatile 进裁剪候选池
    const stable = input.filter((f) => f.tier === 'stable');
    const dynamic = input.filter((f) => f.tier !== 'stable');

    // 动态段总 char 估算（ratio=1.0 时 char=token）
    const dynamicChars = dynamic.reduce((n, f) => n + f.content.length, 0);
    if (dynamicChars <= budget) return input; // 未超阈值不动

    // 超阈值：从动态段尾部裁——保留头部直到 budget 用尽（一旦某 fragment 放不下，
    // 其后全部丢弃——保「保留头部直到 budget 用尽」语义不变）。
    // v0.0.232: 收集全部被丢的 dynamic fragment id 进截断标记（PRD §13.2.2 截断可见性：
    // 让 agent/用户一眼溯源哪些片段被裁掉，而非只列第一个）。
    const kept: PromptFragment[] = [];
    const droppedIds: string[] = [];
    let used = 0;
    let truncated = false;
    for (const f of dynamic) {
      if (truncated) {
        droppedIds.push(f.id);
      } else if (used + f.content.length <= budget) {
        kept.push(f);
        used += f.content.length;
      } else {
        truncated = true;
        droppedIds.push(f.id);
      }
    }
    if (!truncated) return input;
    const note =
      droppedIds.length > 0
        ? `…[dynamic context truncated by budget_truncate reducer; dropped: ${droppedIds.join(', ')}]`
        : TRUNCATE_NOTE;
    const tailNote: PromptFragment = {
      id: 'budget_truncate_note',
      tier: 'volatile',
      content: note,
      priority: -1,
    };
    return [...stable, ...kept, tailNote];
  }

  /** 计算预算 = clamp(contextWindow × budgetFraction, floor, ceiling) */
  private computeBudget(ctx: PromptCtx): number {
    const cw = ctx.config.client.contextWindow;
    const raw = cw * this.budgetFraction;
    return Math.max(this.floor, Math.min(this.ceiling, raw));
  }
}
