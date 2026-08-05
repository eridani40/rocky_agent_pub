/**
 * outbound 有序发送队列（per-accumulator）
 * 参考: reqs/[working] v0.0.118/analysis.md（发送与消费解耦 + 发送重试）
 *
 * 设计目标：
 *   - 消费 loop 不被发送阻塞（入队立即返回，串行异步发送）
 *   - 串行保序：同 session 的 answer/tool 摘要按事件顺序发出
 *   - 有界：队列上限 SEND_QUEUE_MAX，满时丢弃新任务 + error 日志
 *   - abort 感知：controller.aborted 后剩余任务跳过（打 log 后丢弃）
 *   - 发送重试：每条最多 3 次（1+2），退避 2s/5s，abort 时不再重试；
 *     3 次耗尽丢弃该条 + error 日志，继续下一条（保证队列不卡死）
 */
import type { ChannelHandle } from './types';
import type { AccumulatorController } from './channel-accumulator';
import type { Message } from '../message/types';
import { ulid } from '../config/ulid';

/** 队列积压超此阈值打 warn（发送变慢提示） */
const SEND_QUEUE_WARN_DEPTH = 10;
/** 队列上限，超限丢弃 + error 日志 */
const SEND_QUEUE_MAX = 100;
/** 最大尝试次数（1 次 + 2 次重试） */
const SEND_MAX_ATTEMPTS = 3;
/** 重试退避时间：第 1 次失败后等 2s，第 2 次失败后等 5s */
const RETRY_DELAYS_MS = [2000, 5000];

/** 延迟 ms（可被测试替换） */
const sleep = (ms: number) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  t.unref?.();
});

/**
 * 有序发送队列：入队返回即刻，串行异步执行 handle.sendOutbound。
 * 单例：每个 accumulator 实例持一个 SendQueue。
 */
export class SendQueue {
  private readonly handle: ChannelHandle;
  private readonly controller: AccumulatorController;
  private readonly sessionId: string;
  /** promise-chain 串行器（模式参考 feishu-connection.ts enqueueSequential） */
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;

  constructor(handle: ChannelHandle, controller: AccumulatorController, sessionId: string) {
    this.handle = handle;
    this.controller = controller;
    this.sessionId = sessionId;
  }

  /**
   * 入队一条 outbound 文本（立即返回，异步发送）。
   * @param text 要发出的完整 outbound 文本
   * @param runId 当前 runId（可选，填入 Message.runId）
   */
  enqueue(text: string, runId?: string): void {
    if (this.depth >= SEND_QUEUE_MAX) {
      console.error('[channel][accumulator] 发送队列满（%d），丢弃任务 sessionId=%s content=%d字符', SEND_QUEUE_MAX, this.sessionId, text.length);
      return;
    }
    this.depth++;
    if (this.depth > SEND_QUEUE_WARN_DEPTH) {
      console.warn('[channel][accumulator] 发送队列积压 depth=%d sessionId=%s（发送可能变慢）', this.depth, this.sessionId);
    }

    this.tail = this.tail.then(async () => {
      this.depth--;
      if (this.controller.aborted) {
        console.log('[channel][accumulator] 队列任务跳过（已 abort）sessionId=%s', this.sessionId);
        return;
      }
      await this._sendWithRetry(text, runId);
    });
  }

  /** 当前队列剩余未发任务数（退出日志用） */
  get pending(): number { return this.depth; }

  /** 等待队列清空（UT 用） */
  drain(): Promise<void> { return this.tail; }

  /**
   * 带重试的发送（最多 SEND_MAX_ATTEMPTS 次，退避 RETRY_DELAYS_MS）。
   * abort 时中止重试；3 次耗尽丢弃 + error 日志。
   */
  private async _sendWithRetry(text: string, runId?: string): Promise<void> {
    const msg: Message = {
      id: ulid(),
      sessionId: this.sessionId,
      role: 'assistant',
      content: [{ type: 'text', text }],
      runId,
    };
    for (let attempt = 1; attempt <= SEND_MAX_ATTEMPTS; attempt++) {
      if (this.controller.aborted) {
        console.log('[channel][accumulator] 重试中止（已 abort）sessionId=%s attempt=%d', this.sessionId, attempt);
        return;
      }
      const start = Date.now();
      try {
        await this.handle.sendOutbound(msg);
        return; // 成功
      } catch (e) {
        const elapsed = Date.now() - start;
        console.error('[channel][accumulator] 发送失败 attempt=%d/%d 耗时=%dms sessionId=%s', attempt, SEND_MAX_ATTEMPTS, elapsed, this.sessionId, e);
        if (attempt < SEND_MAX_ATTEMPTS && !this.controller.aborted) {
          const delay = RETRY_DELAYS_MS[attempt - 1] ?? 5000;
          await sleep(delay);
        }
      }
    }
    console.error('[channel][accumulator] 发送 %d 次耗尽，丢弃该条 sessionId=%s content=%d字符', SEND_MAX_ATTEMPTS, this.sessionId, text.length);
  }
}
