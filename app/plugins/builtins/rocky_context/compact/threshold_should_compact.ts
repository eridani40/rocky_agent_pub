/**
 * builtin rocky_context plugin — context_should_compact: threshold_should_compact
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.7/§4.6
 *       specs/tech/agent/context/[P0]context_compact_detail.md §2c.2
 *
 * 职责：compact 触发谓词——基于 context window **使用比例**判定。
 *   - 分母 = totalTokens / tokenLimit（**纯使用比例**，不含 estimated output）
 *   - 占比 > compactRatio（默认 0.6）→ 该压了（提前压，非撞墙压）
 *
 * [v0.0.81.compaction_bug] 阈值改纯使用比例（去 estimatedOutput）：
 *   - 旧口径 (total + maxOutput) / limit 把 estimated output 算进占用，导致刚到 60% 实际已逼近
 *     撞墙；estimated output 是为 assemble budget 留的 LLM 调用保护，不是已用量。
 *   - 新口径 total / limit：用户视角的真实占用，> 0.6 即触发——简洁可预期。
 *   - estimated output 仍由 base_builder assemble budget 消费（保护 LLM 调用），但不进阈值。
 *
 * EP: context_should_compact（exclusive）。configSchema §4.6。
 * 防递归：forked scope 不激活本 impl → getExtensionImpls 返空 → tryCompact 跳过。
 */
import {
  ContextImplBase,
  type ShouldCompactPredicate,
  type CompactCtx,
} from '../types';

/** 默认触发阈值：用量占比 > 0.6 即 compact（spec §4.6）*/
const DEFAULT_COMPACT_RATIO = 0.6;

/**
 * threshold_should_compact 谓词：用量/tokenLimit 占比超阈值 → true。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class ThresholdShouldCompactPredicate
  extends ContextImplBase
  implements ShouldCompactPredicate
{
  private readonly compactRatio: number;

  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
    this.compactRatio = this.getNumber('compactRatio', DEFAULT_COMPACT_RATIO);
  }

  async check(ctx: CompactCtx): Promise<boolean> {
    return this.shouldCompact(ctx);
  }

  /**
   * 判定： totalTokens / tokenLimit > compactRatio
   *
   * [v0.0.81.compaction_bug] 阈值改纯使用比例（去 estimatedOutput）：
   *   - 用户视角占用 = 已用 / 窗口；estimated output 不属已用，不参与阈值。
   *   - tokenLimit<=0 时返 false（容错）。
   */
  private shouldCompact(ctx: CompactCtx): boolean {
    const usage = ctx.snapshot.contextWindowUsage;
    if (!usage || !usage.tokenLimit || usage.tokenLimit <= 0) return false;
    const ratio = usage.totalTokens / usage.tokenLimit;
    return ratio > this.compactRatio;
  }
}
