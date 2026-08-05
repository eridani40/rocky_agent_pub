/**
 * A2aReplyTracker — 进程内 a2a 履约追踪器（async subagent 回报兜底的判据 A 数据源）
 * 参考: specs/tech/version_logs/v0.0.255/change_plan.md（设计总述）
 *       specs/tech/multi_agent/[P1]a2a_protocol.md §4.2（needReply 语义）
 *
 * 职责：
 *   1. 出站投递追踪（判据 A）：deliverTo 成功投递后记「from→to 最新投递 seq」，
 *      child run 装配时快照 baseline epoch，run 收尾用 hasDeliverySince 判定本 run 有无履约
 *      ——零 transcript 扫描、零 LLM 语义依赖。
 *   2. tool_pending 未决请求的跨 run 携带桶（stash/take）：HITL 悬挂轮 drain 到的
 *      needReply 请求不结算，stash 到本桶；续跑 run 装配时 take 出并入结算。
 *
 * 约束：纯内存态不持久化（对齐 ChildrenTracker 先例），MUST NOT 读写 store；
 *   崩溃后靠后续 run 自然重建（兜底语义：最坏情况多代发一次，不丢）。
 */
import type { AgentReplyRequest } from './loop-ports';

export class A2aReplyTracker {
  /** 全局单调 epoch：每次 markDelivery ++（投递序号的唯一权威源） */
  private epoch = 0;
  /** fromSid → (toSid → 最新投递 seq) */
  private readonly deliveries = new Map<string, Map<string, number>>();
  /** childSid → 跨 run 携带的未决 needReply 请求（tool_pending 悬挂轮 stash） */
  private readonly pending = new Map<string, AgentReplyRequest[]>();

  /**
   * 记录一次成功投递（仅 deliverTo 成功投递后调用；deliver 失败不算履约）。
   * fromSid 取 message 自身 sender.agent.ref.sessionId（user/system 来源不记）。
   */
  markDelivery(fromSid: string, toSid: string): void {
    const seq = ++this.epoch;
    let bucket = this.deliveries.get(fromSid);
    if (!bucket) {
      bucket = new Map();
      this.deliveries.set(fromSid, bucket);
    }
    bucket.set(toSid, seq);
  }

  /** 当前 epoch 快照（child run 装配时取作 baseline：本 run 的 mark 全部晚于它） */
  deliveryEpoch(): number {
    return this.epoch;
  }

  /**
   * 判据 A：sinceEpoch 之后 from→to 有无投递（纯读无副作用；无记录返 false）。
   */
  hasDeliverySince(fromSid: string, toSid: string, sinceEpoch: number): boolean {
    const seq = this.deliveries.get(fromSid)?.get(toSid);
    return seq !== undefined && seq > sinceEpoch;
  }

  /**
   * tool_pending 未决请求跨 run 存（reqs 为空不写桶）。
   * 覆盖写：caller 传的是「carried + 本 run 新收集」的全量合并，非增量。
   */
  stashPending(childSid: string, reqs: AgentReplyRequest[]): void {
    if (reqs.length === 0) return;
    this.pending.set(childSid, reqs);
  }

  /** 取出并清空 childSid 的未决请求（take 即清，防双 run 重复结算） */
  takePending(childSid: string): AgentReplyRequest[] {
    const reqs = this.pending.get(childSid) ?? [];
    this.pending.delete(childSid);
    return reqs;
  }
}
