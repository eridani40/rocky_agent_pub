/**
 * builtin rocky_context plugin — assemble_mapper: summary_reader
 * 参考: specs/tech/agent/context_and_memory/[P0]context_assemble_detail.md §4/§6
 *       specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.2
 *
 * 职责：读 summary（含 version/summaryUpTo/content/block），贡献 AssembleData.summary。
 *   - 数据来源：SessionStore.getSummary(sessionId)
 *   - 无 summary 返 null（base_builder 据此跳过 summary msg）
 *
 * [v0.0.186] 烘焙优先：summary 带 block（compact 烘焙文本）→ 不取 head/tail 候选
 *   （base_builder 直接用 block，零计算；省每轮 2 次 getMessages）。
 *   仅无 block 的存量旧 summary 才取候选（fallback 即时构建用），下次 compact 升级后停取。
 *
 * [v0.0.185] 同次 map 内取 head/tail 候选（单次 getSummary 读 → 候选与 summary 版本锚定一致，
 *   消除「transcript_reader 与 summary_reader 各读一次 summary」的双读竞态）：
 *   - headCandidates = getMessages({upToId: summaryUpTo, limit: candidateLimit, takeFromStart: true})
 *     → 会话真第一条起的前 N 条（锚定 transcript 起点，不随 recent 窗口滑动）
 *   - tailCandidates = getMessages({upToId: summaryUpTo, limit: candidateLimit})
 *     → summaryUpTo 结尾的末 N 条（锚定 summaryUpTo，掉出 recent 窗口仍稳定）
 *   - 候选获取是 mapper 层职责（reducer 同步、store 读取 async）；forked scope 本 mapper 不激活，
 *     in_memory store getSummary 恒 null → 不取候选（base_builder 回退 transcript 派生）。
 *
 * EP: context_assemble_mapper，priority 850。
 * configSchema: { candidateLimit: 500 }（head/tail 候选各取条数上限，最小 1）。
 */
import {
  AssembleData,
  AssembleCtx,
  AssembleMapper,
  ContextImplBase,
} from '../types';
// 默认值单源在 server summary-block（与 summary_do_compact 烘焙 candidateLimit 同默认）
import { DEFAULT_SUMMARY_CANDIDATE_LIMIT } from '../../../../server/src/agent/summary-block';

/**
 * summary_reader mapper：读当前 summary + [v0.0.185] head/tail 锚定候选（仅无烘焙 block 时）。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class SummaryReaderMapper
  extends ContextImplBase
  implements AssembleMapper
{
  /** head/tail 候选各取条数上限（cfg.candidateLimit 缺省 500） */
  private readonly candidateLimit: number;

  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
    this.candidateLimit = this.getNumber('candidateLimit', DEFAULT_SUMMARY_CANDIDATE_LIMIT);
  }

  /**
   * 读 summary 贡献 AssembleData.summary；有 summaryUpTo 且无烘焙 block 时同取 head/tail 候选。
   * 未注入 store → 返回空（不阻塞链，base_builder 视作无 summary）。
   */
  async map(ctx: AssembleCtx): Promise<Partial<AssembleData>> {
    if (!ctx.store) return {};
    const summary = await ctx.store.getSummary(ctx.config.sessionId);
    // 无 summaryUpTo → 无锚点，不取候选（base_builder 回退 transcript 派生）；
    // [v0.0.186] 有烘焙 block → base_builder 直接使用，候选不再消费，不取。
    if (!summary?.summaryUpTo || summary.block) return { summary };

    const sid = ctx.config.sessionId;
    // [v0.0.185] head 候选锚定会话真第一条（takeFromStart）；tail 候选锚定 summaryUpTo（末尾 N 条）
    const [headPage, tailPage] = await Promise.all([
      ctx.store.getMessages(sid, {
        upToId: summary.summaryUpTo,
        limit: this.candidateLimit,
        takeFromStart: true,
      }, ctx.opts),
      ctx.store.getMessages(sid, {
        upToId: summary.summaryUpTo,
        limit: this.candidateLimit,
      }, ctx.opts),
    ]);
    return { summary, headCandidates: headPage.items, tailCandidates: tailPage.items };
  }
}
