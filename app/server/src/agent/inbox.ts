/**
 * InboxStore — agent session inbox 内存暂存（v0.0.8 + v0.0.12 cancel 扩展）
 * 参考: specs/tech/version_logs/v0.0.8/change_log.md §2.1 §4
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_loop.md §4（① Pre-Process）
 *       specs/tech/agent/agent_interface_and_loop/[P0]agent_inbox_enqueue.md §2（InboxEntry + enqueuedAt）
 *
 * 设计：
 *   - 内存 Map<sessionId, Entry[]>；不入主对话 store，仅作"待消费"暂存
 *   - enqueue：追加消息并分配 enqueueId（ULID）
 *   - cancel（v0.0.12）：追加一条 kind="cancel" 条目（cancelFor=enqueueId），
 *     不删原 message / 不删 inbox；drain 时由 loop 配对作废（详见 agent_enqueue_cancel.md）
 *   - drain：取出全部并清空（agent loop ① 每轮 eager drain）
 *   - peek：只读查看（normal mode 外层循环 / 诊断用）
 *
 * Entry 联合类型（v0.0.12）：
 *   - kind="message"：常规入队消息（含 Message 真身）
 *   - kind="cancel"：取消信号（cancelFor 指向被取消的 enqueueId；不是对话 Message）
 *
 * v0.0.31 升级（[P0]agent_inbox_enqueue.md §2）：两变体均含 enqueuedAt（isoDate）——
 * store 信封字段，append/appendCancel 注入（与 ULID enqueueId 分配同步）；put 时不传。
 *
 * 不持久化：进程重启即丢失（v0.0.8 接受；未来若需跨进程持久化改 CrudStore）。
 */
import { ulid } from '../config/ulid';
import type { Message } from '../message/types';
import type { LogWriter } from '../dev-logs/log-writer';

/**
 * inbox 条目联合类型（[P0]agent_inbox_enqueue.md §2）。
 *
 * v0.0.12 前 InboxEntry 是单一 message 形态；v0.0.12 扩为联合以支持 cancel。
 * 旧调用方（agent-loop）通过 `entry.kind === 'message'` 窄化拿 message。
 *
 * v0.0.31：两变体均含 `enqueuedAt`（isoDate）——store 信封字段，由 append/appendCancel
 * 注入（与 enqueueId 分配同步）；外部 put 时不传。
 */
export type InboxEntry =
  | {
      /** 入队句柄（ULID）—— 与 AgentEvent.enqueueId 对应 */
      enqueueId: string;
      /** 条目类型 */
      kind: 'message';
      /** 入队的消息（id 可能是临时的，处理时 agent loop 重新生成 messageId） */
      message: Message;
      /** 进 inbox 的时刻（isoDate，append 注入，与 enqueueId 同步） */
      enqueuedAt: string;
    }
  | {
      /** 入队句柄（cancel 条目自身的 ULID，不参与配对判定） */
      enqueueId: string;
      /** 条目类型 */
      kind: 'cancel';
      /** 被取消的 message 的 enqueueId（drain 配对判定的 key） */
      cancelFor: string;
      /** 进 inbox 的时刻（isoDate，appendCancel 注入，与 enqueueId 同步） */
      enqueuedAt: string;
    };

/**
 * 内存 inbox store（一个实例服务多个 session，按 sessionId 分桶）。
 * 不感知业务概念，只做 sessionId 分桶 + 顺序保持。
 */
export class InboxStore {
  private readonly buckets: Map<string, InboxEntry[]> = new Map();
  /** [dev-logs] agent 诊断日志（可选；undefined 时所有 log 调用 no-op） */
  private readonly logWriter?: LogWriter;

  /**
   * @param logWriter 可选 [dev-logs] agent 诊断日志写入器（默认 undefined，向后兼容）
   */
  constructor(logWriter?: LogWriter) {
    this.logWriter = logWriter;
  }

  /**
   * 入队消息到 session inbox。
   * - 为每条消息分配 enqueueId（ULID），条目 kind="message"
   * - 不写主对话 store（仅暂存到 inbox）
   * @returns 与 messages 等长、同序的 enqueueIds
   */
  enqueue(sessionId: string, messages: Message[]): string[] {
    const bucket = this.getOrCreate(sessionId);
    const enqueueIds: string[] = [];
    // enqueuedAt：store 信封字段，与 enqueueId 同步注入（spec §2）。整批共享同一时刻。
    const enqueuedAt = new Date().toISOString();
    for (const message of messages) {
      const enqueueId = ulid();
      bucket.push({ enqueueId, kind: 'message', message, enqueuedAt });
      enqueueIds.push(enqueueId);
    }
    // [dev-logs] inbox 入队（只记 id/计数，绝不记消息内容）
    this.logWriter?.write('agent', {
      event: 'inbox_enqueue', sessionId, count: enqueueIds.length, enqueueIds,
    });
    return enqueueIds;
  }

  /**
   * v0.0.12：追加一条 kind="cancel" 的 inbox 条目（cancelFor=enqueueId）。
   *
   * 语义（design §3.4 / agent_enqueue_cancel.md §2 §5）：
   *   - 不删原 message / 不删 inbox，仅追加 cancel 条目
   *   - 不查原 message 是否存在 / 是否已被处理（drain 配对时自然处理幂等）
   *   - 不 emit 事件（enqueued_message_canceled 由 agent_loop drain 同批作废时 emit）
   */
  appendCancel(sessionId: string, cancelFor: string): void {
    const bucket = this.getOrCreate(sessionId);
    // enqueuedAt：store 信封字段，与 cancel 条目 enqueueId 同步注入（spec §2）
    bucket.push({ enqueueId: ulid(), kind: 'cancel', cancelFor, enqueuedAt: new Date().toISOString() });
    // [dev-logs] inbox cancel 追加（只记 cancelFor id）
    this.logWriter?.write('agent', { event: 'inbox_cancel', sessionId, cancelFor });
  }

  /**
   * v0.0.13：同步从 inbox 移除指定 enqueueId 的 message 条目（如果存在）。
   *
   * 背景：v0.0.12 的 cancel 仅 appendCancel，依赖「下一轮 drain 同批配对作废」。但真 LLM 下
   * agent_loop 处理速度快，可能出现「cancel POST 到达 inbox 前，message 已被 drain 消费」的
   * 竞态（cancel 来晚 → drain 时找不到配对 message → cancel 条目无害丢弃，但 message 已 processed
   * 落库）。这破坏了 cancel 的核心语义（让排队消息不要被处理）。
   *
   * v0.0.13 修复（agent_enqueue_cancel.md §4 增补）：cancel handler 调用本方法**同步移除**
   * inbox 中对应 enqueueId 的 message 条目（如果还在），保证 cancel 在任何时序下生效：
   *   - message 还在 inbox（cancel 早于 drain）→ 同步移除，立即生效（不进对话流，不落库）
   *   - message 已 drain（cancel 来晚）→ 无条目可移除，返回 false（前端已收 processed 移除 enqueue view）
   *
   * 注意：本方法只移除 message 条目，不影响 cancel 条目（appendCancel 仍照常追加作 drain 兜底；
   * 若 message 已被同步移除，drain 时 cancel 条目找不到配对自然丢弃，幂等无害）。
   *
   * @returns true=找到并移除；false=未找到（已被 drain 消费 或 enqueueId 不存在）
   */
  removeMessage(sessionId: string, enqueueId: string): boolean {
    const bucket = this.buckets.get(sessionId);
    if (!bucket || bucket.length === 0) {
      this.logWriter?.write('agent', { event: 'inbox_remove', sessionId, enqueueId, removed: false });
      return false;
    }
    const idx = bucket.findIndex(
      (e) => e.kind === 'message' && e.enqueueId === enqueueId,
    );
    if (idx < 0) {
      this.logWriter?.write('agent', { event: 'inbox_remove', sessionId, enqueueId, removed: false });
      return false;
    }
    bucket.splice(idx, 1);
    this.logWriter?.write('agent', { event: 'inbox_remove', sessionId, enqueueId, removed: true });
    return true;
  }

  /**
   * 取出该 session 全部入队条目（message + cancel）并清空（agent loop ① 每轮 eager drain 用）。
   * @returns Entry[]（按入队顺序；清空后再次 drain 返回 []）
   */
  drain(sessionId: string): InboxEntry[] {
    const bucket = this.buckets.get(sessionId);
    if (!bucket || bucket.length === 0) {
      this.logWriter?.write('agent', { event: 'inbox_drain', sessionId, count: 0, kinds: [] });
      return [];
    }
    const drained = bucket.splice(0);
    // [dev-logs] inbox drain（只记 count + kinds 数组，绝不记 message 内容）
    this.logWriter?.write('agent', {
      event: 'inbox_drain', sessionId, count: drained.length, kinds: drained.map((e) => e.kind),
    });
    return drained;
  }

  /** 只读查看（不取出）当前 inbox 内容；normal mode 外层循环用 */
  peek(sessionId: string): InboxEntry[] {
    return this.buckets.get(sessionId) ?? [];
  }

  /** 清空指定 session 的 inbox（测试 / 强制清理用） */
  clear(sessionId: string): void {
    this.buckets.delete(sessionId);
  }

  private getOrCreate(sessionId: string): InboxEntry[] {
    let bucket = this.buckets.get(sessionId);
    if (!bucket) {
      bucket = [];
      this.buckets.set(sessionId, bucket);
    }
    return bucket;
  }
}
