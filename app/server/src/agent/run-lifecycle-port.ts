/**
 * run-lifecycle-port — profile 驱动 LifecyclePort 单 impl
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_loop_unified.md §3.2
 *       specs/tech/agent/session/[P0]session_type_profile.md §6（profile.runShape 字段）
 *
 * 三 hook 按 profile.runShape 字段分派：
 *   - onRunEnd：persistsRun → persistRun；touchesStateMachine → 五态机 CAS（error/tool_pending/idle）；旁路 run noop。
 *     其后追加 async subagent 回报兜底（仅装配 replySettle 时）：
 *     tool_pending → stash 未决请求跨 run 携带（不代发）；其余 reason → settleAgentReplyFallback 系统代发
 *   - onUsage：main 分区（current/sub）→ updateUsage（写+推一体，内部累计 + sid 链推送）；
 *     旁路分区（summary/consolidate → forked 桶）→ 跳过（旁路 run usage 由 caller 按 run 结束
 *     总量一次性累计：fork-1 在 context-compact-runner runCompact，fork-2 在
 *     post-compact-consolidation startConsolidation；tier2 三 run 公共全局整理不摊 session
 *     usage 零累计——防「逐调用 + 总量」双计）
 *   - onInterrupted：默认 noop（abort api 4 步接管——关键不变量，main/旁路都不做 transcript 收尾）；
 *     仅装配 replySettle（main && subagent）时开「系统代发回报」旁路（interrupted→结局通知），
 *     不做 transcript 收尾/emit（abort api 4 步不变）
 */
import type { Message, Usage } from '../message/types';
import type { SessionStore } from './session-store';
import { persistRun as persistRunFn } from './agent-loop-lifecycle';
import type { LifecyclePort, LoopState, AgentReplyRequest } from './loop-ports';
import type { SessionConfig } from './context-types';
import type { ResolvedSessionProfile, ProfileUsagePartition } from './session-type-profile-loader';
import type { UsagePartition } from './session-store-types';
import type { A2aReplyTracker } from './a2a-reply-tracker';
import { settleAgentReplyFallback, type ReplySettleReason } from './subagent-reply-fallback';

/**
 * profile.runShape.usagePartition（current/sub/summary/consolidate）→ store UsagePartition（current/sub/forked）。
 * store 三分区语义保留（spec session_usage.md §6/§7）；summary/consolidate 同落 'forked' 桶（语义=非主对话 run 累积）。
 */
function mapUsagePartition(p: ProfileUsagePartition): UsagePartition {
  if (p === 'current') return 'current';
  if (p === 'sub') return 'sub';
  return 'forked'; // summary / consolidate → forked 桶
}

/**
 * profile 驱动 LifecyclePort：构造时持 ResolvedSessionProfile，三 hook 按 profile 字段分派。
 */
export class RunLifecyclePort implements LifecyclePort {
  constructor(private readonly deps: {
    config: SessionConfig;
    store: SessionStore;
    runId: string;
    profile: ResolvedSessionProfile;
    /**
     * async subagent 回报兜底装配（buildRunDeps 注入；仅 main && derivation='subagent'）。
     * baseline/carried 由装配点快照/取出；缺省（forked/顶层/squad/测试）→ 全链路 noop。
     */
    replySettle?: {
      deliverTo(targetSid: string, msg: Message): Promise<unknown>;
      tracker: A2aReplyTracker;
      baseline: number;
      carried: AgentReplyRequest[];
    };
  }) {}

  async onRunEnd(state: LoopState): Promise<void> {
    if (!this.deps.profile.runShape.persistsRun) return; // 旁路 run noop（不 persistRun）
    await persistRunFn(this.deps.store, this.deps.config, this.deps.runId, state);
    if (this.deps.profile.runShape.touchesStateMachine) {
      // CAS 三分支：error→markError / tool_pending→markSuspended / 其余→markIdle
      const reason = state.stopReason;
      const sm = this.deps.store.stateMachine;
      const sid = this.deps.config.sessionId;
      if (reason === 'error') {
        await sm.markError(sid, this.deps.runId);
      } else if (reason === 'tool_pending') {
        await sm.markSuspended(sid, this.deps.runId);
      } else {
        await sm.markIdle(sid, this.deps.runId);
      }
    }
    // 回报兜底（persistRun/CAS 之后；tool_pending 只 stash 不代发）
    const rs = this.deps.replySettle;
    if (rs) {
      const reason = state.stopReason ?? 'error';
      if (reason === 'tool_pending') {
        // HITL 悬挂轮：未决请求 stash 跨 run 携带（续跑出真结果那轮才结算）
        const reqs = [...rs.carried, ...(state.agentReplyRequests ?? [])];
        if (reqs.length > 0) rs.tracker.stashPending(this.deps.config.sessionId, reqs);
      } else {
        await this.settle(state, reason);
      }
    }
  }

  async onUsage(usage: Usage | null): Promise<void> {
    if (!usage) return;
    const partition = mapUsagePartition(this.deps.profile.runShape.usagePartition);
    // 旁路 run（summary/consolidate → forked 桶）：不经 lifecycle 逐调用累计——
    //   由 caller 在 run 结束后按总量一次性累计（fork-1 在 context-compact-runner runCompact，
    //   fork-2 在 post-compact-consolidation startConsolidation；tier2 三 run 不摊 session usage
    //   零累计），否则 fork-1 双计（onUsage 逐调用 + run 结束总量 = 两遍）。
    //   notify 由 caller 补：accumulateUsage 拿到 sid 链后对每个 sid 调 notifyUsageChanged
    //   （让 forked 增量即时可见，不依赖下一轮 main assemble）；onUsage 此处仍 early return 防双计。
    if (partition === 'forked') return;
    // 写+推一体：内部累计（含递归 sub 上报 parent）后对 sid 链逐个推全量 view
    await this.deps.store.updateUsage(this.deps.config.sessionId, {
      usagePartition: partition,
      usage,
    });
  }

  async onInterrupted(state: LoopState): Promise<void> {
    // transcript 收尾仍归 abort api 4 步（本 hook 不做 emit/ingest/状态机）；
    // 仅装配 replySettle 的 main subagent run 开「系统代发回报」旁路（interrupted→结局通知）。
    await this.settle(state, 'interrupted');
  }

  /**
   * replySettle 代发旁路：replySettle 缺省 → noop（纯旧行为）。
   * 异常吞掉不阻断——调用点收尾主链（persistRun/CAS/abort 4 步）已完成，兜底失败仅 warn。
   */
  private async settle(state: LoopState, reason: ReplySettleReason): Promise<void> {
    const rs = this.deps.replySettle;
    if (!rs) return;
    try {
      await settleAgentReplyFallback(state, {
        childSid: this.deps.config.sessionId,
        store: this.deps.store,
        deliverTo: rs.deliverTo,
        tracker: rs.tracker,
        baseline: rs.baseline,
        carried: rs.carried,
      }, reason);
    } catch (e) {
      console.warn('[replySettle] settle failed (ignored):', e instanceof Error ? e.message : String(e));
    }
  }
}
