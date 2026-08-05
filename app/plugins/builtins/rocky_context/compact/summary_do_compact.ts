/**
 * builtin rocky_context plugin — context_do_compact: summary_do_compact
 * 参考: specs/tech/agent/context/[P0]extension point and implementations.md §3.7
 *       specs/tech/agent/context/[P0]context_compact_detail.md §2c.3
 *       specs/tech/agent/session/[P0]session_task_lock.md（v0.0.55 统一锁）
 *
 * 职责：compact 执行动作——sideRun(summary,NO_TOOLS,maxIter=1) → extractTag → setSummary
 *   + accumulateUsage('forked') write → lock.markDone/markFailed。
 *   [v0.0.81.compaction_bug] compact_notice 留痕已删（compact 是纯生产者，零 transcript 副作用）。
 *
 * [v0.0.186] 烘焙参数透传：cfg.tokenCap / cfg.candidateLimit 经 runCompact → bakeSummaryBlock，
 *   compact 产 summary 时一次构建完整 block 文本（preamble+head+tail）持久化；
 *   组装期 msg[0] 直接读 block（零计算，prompt 缓存前缀逐字节稳定）。
 *
 * 防递归不变量（spec §2c.3）：本 impl 调 sideRun(summary)，summary run 的 scopeId=forked，
 * forked scope 显式选 reject_should_compact（恒返 false）→ tryCompact 在谓词检查处 return
 * → 结构上不可能递归 compact。
 *
 * EP: context_do_compact（exclusive）。
 * configSchema: { tokenCap: 10000, candidateLimit: 500 }（烘焙 head/tail 选取参数，
 *   与 base_builder tokenCap / summary_reader candidateLimit 同默认值——fallback 与烘焙两路径口径一致）。
 */
import {
  ContextImplBase,
  type DoCompactAction,
  type CompactCtx,
} from '../types';
import { runCompact } from '../../../../server/src/agent/context-compact-runner';
import {
  DEFAULT_SUMMARY_TOKEN_CAP,
  DEFAULT_SUMMARY_CANDIDATE_LIMIT,
} from '../../../../server/src/agent/summary-block';

/**
 * summary_do_compact 动作：薄壳委托 runCompact（现状逻辑）。
 *
 * CompactCtx 携带的运行时依赖（assembleFn/sideRunner/taskLock）
 * 由 tryCompact 胶水注入；缺依赖时 runCompact 自身抛错降级
 * （sideRunner 未配置 → "sideRunner not configured"）。
 *
 * 构造器签名约定 (implId, cfg)（plugin_manager §3.4 实例化）。
 */
export default class SummaryDoCompactAction
  extends ContextImplBase
  implements DoCompactAction
{
  /** [v0.0.186] 烘焙 head/tail 各自 token 累加上限（char×ratio 口径） */
  private readonly tokenCap: number;
  /** [v0.0.186] 烘焙 head/tail 候选各取条数上限 */
  private readonly candidateLimit: number;

  constructor(implId: string, cfg: Record<string, unknown> = {}) {
    super(implId, cfg);
    this.tokenCap = this.getNumber('tokenCap', DEFAULT_SUMMARY_TOKEN_CAP);
    this.candidateLimit = this.getNumber('candidateLimit', DEFAULT_SUMMARY_CANDIDATE_LIMIT);
  }

  async run(ctx: CompactCtx): Promise<void> {
    // tryCompact 胶水注入运行时依赖；未 wire 时显式报错（action 不应被调）。
    // runCompact 的 assembleFn/sideRunner 为必填，缺则 runCompact 自身会抛错，
    // 这里前置校验给出更清晰的「未装配」语义。
    if (!ctx.sideRunner) {
      throw new Error(
        'summary_do_compact: CompactCtx.sideRunner not wired ' +
          '(tryCompact 胶水负责注入；EP 仅注册 impl)',
      );
    }
    // v0.0.49：CompactCtx.store optional（forked 不注入）。summary_do_compact 仅 default scope 激活，
    // main 必注入 store；缺省（极端 UT fixture）抛错显式告警，避免 runCompact 拿到 undefined。
    if (!ctx.store) {
      throw new Error('summary_do_compact: CompactCtx.store not wired (main scope must inject wireStore)');
    }
    // 薄壳委托现有 runCompact（acquire/sideRun/setSummary/accumulateUsage write 全流程
    // + 末尾 post-compact EP 派发）。runCompact 返 boolean（true=完成 / false=acquire 失败跳过），
    // 动作契约返 void。
    // 透传 triggerMessageId/triggerUsage → 旁路 run trace meta；
    //   false 时记日志便于观测「compact 锁失败跳过」（不改变 action.run 契约，仍 Promise<void>）
    // [v0.0.186] 第 8 参透传烘焙参数（tokenCap/candidateLimit）→ bakeSummaryBlock
    // 第 9 参透传 pluginCtx（tryCompact 胶水注入）→ runCompact 末尾 post-compact EP 派发
    const ok = await runCompact(
      ctx.store,
      ctx.taskLock,
      ctx.config,
      ctx.snapshot,
      ctx.sideRunner,
      ctx.triggerMessageId,
      ctx.triggerUsage,
      { tokenCap: this.tokenCap, candidateLimit: this.candidateLimit },
      ctx.pluginCtx,
    );
    if (!ok) {
      // acquire 'compact' 失败（并发已有 compact 在跑）→ sibling 静默跳过
      console.warn(
        `[summary_do_compact] compact lock acquire failed (concurrent compact running, skipped): sid=${ctx.config.sessionId}`,
      );
    }
  }
}
