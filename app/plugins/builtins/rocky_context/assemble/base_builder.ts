/**
 * builtin rocky_context plugin — assemble_reducer: base_builder
 * 参考: specs/tech/agent/context_and_memory/[P0]context_assemble_detail.md §2/§6
 *       specs/tech/agent/context_and_memory/[P0]extension point and implementations.md §3.3/§4.4
 *
 * 职责（context_assemble_detail.md §2 + §6 产出结构）：
 *   - input=null（链首）→ 构 snapshot.messages 框架：[summary msg?] + [recent]
 *
 * [v0.0.186] summary 烘焙优先（组装期零计算）：
 *   - summary 记录带 block（compact 烘焙的完整文本）→ msg[0] 直接用它：不 pickHead/pickTail、
 *     不查候选、不做 summary 侧 budget 判定 → ratio 漂移 / transcript 增长都不影响 msg[0]
 *     （prompt 缓存前缀逐字节稳定，修 v0.0.185 残留的第二机制：动态 ratio 撑缩 head 窗口）。
 *   - summary 无 block（存量旧记录）→ fallback v0.0.185 即时构建（锚定候选 + tokenCap +
 *     budget tailDropped），下次 compact 自动升级。
 *   - recent 区不变：仍每轮从新→旧 budget 放置（recent 本就逐轮变化，不是缓存前缀问题）。
 *
 * [v0.0.185] prompt 缓存前缀稳定（修 summary msg head 段滑动 bug）：
 *   - head/tail 候选由 summary_reader 锚定贡献（head=会话真第一条起、tail=summaryUpTo 结尾），
 *     不再从「最近 500 条」transcript 派生 → 同 summary version 下 summary block 逐字节一致。
 *   - 候选缺省（无 summary / forked / 旧测试 ctx）→ 回退 transcript 派生（兼容旧行为）。
 *
 * [v0.0.173] snapshot 永远 rebuild：确定性纯函数 f(summary, transcript)。
 * [v0.0.66 §2.5] system prompt 不走 base_builder（system 由 snapshot.system 独立承载）。
 * [v0.0.81.compaction_bug] summary 块 = 1 个 text content block（preamble+head+tail 3 段）
 *   + assemble budget 放置（summary 始终放置，自身超 budget 丢 tail；recent 新→旧累加）。
 *
 * summary block 算法（pickHead/pickTail/buildSummaryBlock/getEstimatedOutput）单源在
 *   server `agent/summary-block.ts`（[v0.0.186] 迁入，compact 烘焙与组装 fallback 共用）；
 *   recent 放置（pickRecentWithinBudget）在 ./base_builder_helpers.ts。
 *
 * EP: context_assemble_reducer，priority 1000（最高优先，链首构建框架）。
 * configSchema: { tokenCap }（仅 fallback 即时构建路径用；烘焙路径在 compact 时已定格）。
 */
import type { Message } from '../../../../server/src/message/types';
import {
  AssembleData,
  AssembleCtx,
  AssembleReducer,
  ContextImplBase,
} from '../types';
import {
  pickHead,
  pickTail,
  getEstimatedOutput,
  applySummaryBudget,
  DEFAULT_SUMMARY_TOKEN_CAP,
  SUMMARY_BUDGET_RATIO,
} from '../../../../server/src/agent/summary-block';
import { pickRecentWithinBudget } from './base_builder_helpers';

/**
 * base_builder reducer：链首构建框架 + 增量判定。
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class BaseBuilderReducer
  extends ContextImplBase
  implements AssembleReducer
{
  /** head/tail 各自的 token 累加上限（char×ratio 口径；仅无烘焙 block 的 fallback 路径用） */
  private readonly tokenCap: number;

  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
    this.tokenCap = this.getNumber('tokenCap', DEFAULT_SUMMARY_TOKEN_CAP);
  }

  reduce(data: AssembleData, input: Message[] | null, ctx: AssembleCtx): Message[] {
    // 链中后续 reducer 不会调本 reducer（base_builder priority 最高）；仍兼容 input != null
    if (input !== null) return input;

    // [v0.0.173] 永远 rebuild：snapshot = 确定性纯函数 f(summary, transcript)。
    //   不再读 ctx.prevSnapshot / 不再判 summary version；transcript id 严格单调 → [...transcript] 天然有序。
    return this.buildRebuild(data, ctx);
  }

  /**
   * 构建 snapshot.messages 框架（§6 产出结构 + [v0.0.81] assemble budget 放置）。
   *
   * 产出：[summary msg?]（1 个 text content block，文本 3 段：preamble+head+tail）+ [recent messages]。
   * 无 summary → [...transcript]（system 由 snapshot.system 独立承载）。
   *
   * [v0.0.186] 烘焙优先：summary.block 存在 → msg[0] 文本 = block（零计算）；
   *   否则 fallback v0.0.185 即时构建（锚定候选 + tokenCap + budget tailDropped）。
   *   边界：烘焙后 head/tail 窗口内历史消息被 HITL 编辑不回刷 block（recent 区每轮最新不受影响）。
   */
  private buildRebuild(data: AssembleData, ctx: AssembleCtx): Message[] {
    const sid = ctx.config.sessionId;
    const transcript = data.transcript;

    const summary = data.summary;
    const hasSummary = !!(summary && summary.content);

    if (!hasSummary) {
      // 无 summary → [全 transcript]（system 由 snapshot.system 独立承载，不在 messages 里）
      return [...transcript];
    }

    // 有 summary → 计算 summaryUpTo 在 recent 窗口内的索引（切 recent 用）
    const summaryUpToId = summary!.summaryUpTo;
    const upToIdx =
      summaryUpToId == null
        ? -1
        : transcript.findIndex((m) => m.id === summaryUpToId);

    // summaryUpTo 之后的是 recent；掉出窗口（-1）时整个窗口都比 summaryUpTo 新 → 全作 recent
    const recentAll = upToIdx >= 0 ? transcript.slice(upToIdx + 1) : transcript;

    // [v0.0.52 P2-3] ratio 动态化：从 ctx.ratio 拿（budget char 换算用）。
    //   生产路径 runAssemblePipeline 恒注入 ratio；旧测试 ctx 不带 ratio 时 fallback 1.0
    const ratio = ctx.ratio ?? 1.0;

    // [v0.0.81] assemble budget（recent 放置用）：budget_tokens = 0.95 × tokenLimit − estimatedOutput
    // [v0.0.186] estimatedOutput 源修正 devConfig → appConfig（v0.0.89 迁移遗漏：
    //   config.devConfig 生产恒 undefined → 恒默认 20000；烘焙路径同用 appConfig，两口径一致）
    const tokenLimit = ctx.config.client.contextWindow;
    const estimatedOutput = getEstimatedOutput(ctx.config.appConfig);
    const budgetTokens = Math.max(0, SUMMARY_BUDGET_RATIO * tokenLimit - estimatedOutput);
    // 累积口径 char×ratio ≈ token；budget 转 char 上限 = budgetTokens / ratio（ratio>0）
    const budgetChars = ratio > 0 ? budgetTokens / ratio : budgetTokens;

    let summaryText: string;
    if (summary!.block) {
      // [v0.0.186] 烘焙优先：msg[0] 直接用 compact 烘焙文本（零选取/零候选/零 budget 降级判定）。
      //   ratio 漂移 / transcript 增长 / recent 窗口滑动都不影响本分支输出。
      summaryText = summary!.block;
    } else {
      // fallback（存量旧 summary 无 block）：v0.0.185 即时构建——锚定候选 + tokenCap + budget tailDropped。
      // [v0.0.185] head/tail 候选：summary_reader 锚定贡献优先（head=会话真第一条起 / tail=summaryUpTo 结尾）；
      //   缺省回退 transcript 派生（forked / 旧测试 ctx 兼容——此时 transcript 即候选全集）。
      const windowBefore = upToIdx >= 0 ? transcript.slice(0, upToIdx + 1) : [];
      const headCandidates = data.headCandidates ?? windowBefore;
      const tailCandidates = data.tailCandidates ?? windowBefore;
      const head = pickHead(headCandidates, this.tokenCap, ratio);
      const tail = pickTail(tailCandidates, this.tokenCap, ratio);
      // head∩tail 去重（head 优先；summary 区间短时 head/tail 可能重叠）
      const headIds = new Set(head.map((m) => m.id));
      const tailDeduped = tail.filter((m) => !headIds.has(m.id));
      // summary 自身超 budget → 丢 tail 段（保 preamble+head；spec 标记）
      summaryText = applySummaryBudget(summary!, head, tailDeduped, budgetChars);
    }
    const summaryUsedChars = summaryText.length;

    // recent 从新→旧累加至剩余预算，超额丢最旧
    const remainingChars = Math.max(0, budgetChars - summaryUsedChars);
    const recent = pickRecentWithinBudget(recentAll, remainingChars);

    // [v0.0.81.compaction_bug] summary role = user（不是 system）：
    //   summary 是对话历史的 recap，作 user 提供的上下文（Claude Code 口径），不是 system 指令。
    //   role=system 会让 LLM 把对话 recap 误读为系统指令。
    const summaryMsg: Message = {
      id: `summary:${summary!.version}`,
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: summaryText }],
    };

    return [summaryMsg, ...recent];
  }
}
