/**
 * outbound 累积 loop（D3 改版：block 级发送 + 发送/消费解耦 + stale block 回收）
 * 参考: specs/tech/channel/[P0]channel_manager.md §3.5（累积管线）/ §3.5.1（user echo 屏蔽）
 *       reqs/[done] v0.0.103.channel/design-usecases.md UC-D2
 *       reqs/[working] v0.0.118/analysis.md（解耦 + stale + 重试 + 防连累）
 *
 * 核心架构：消费 loop 与发送队列（SendQueue）解耦。
 *   - 识别要发的内容 → 入队（不 await）→ 立即继续消费下一事件
 *   - SendQueue 串行异步发送（有界 100 + 重试 3 次，见 channel-send-queue.ts）
 *   - echo 屏蔽/跨渠道分流仍在消费 loop 内做
 *   - 单事件处理异常：try/catch 丢弃 + error 日志，loop 不退出（防连累）
 *   - stale block 回收：60s sweep，5 分钟无活动的 buffer/toolName/origin 槽清理
 *
 * 生命周期可观测：启动/退出/异常各有日志（sessionId/configId/事件数/队列剩余）。
 */
import type { AgentEvent } from '../agent/agent-event-types';
import type { ChannelHandle } from './types';
import { SendQueue } from './channel-send-queue';

/** accumulator loop 的 abort 控制器（unsubscribeOutbound 时 aborted=true） */
export interface AccumulatorController { aborted: boolean; }

/** block 缓冲槽（带最后活动时间，用于 stale 回收） */
interface BufferSlot { text: string; lastAt: number; }
/** 含时间的 Map 槽（toolCallNames / userOrigins 通用） */
interface TimedSlot<T> { val: T; lastAt: number; }

/** stale 阈值（5 分钟无活动的 buffer 槽视为泄漏，清理） */
const BLOCK_STALE_MS = 5 * 60_000;
/** stale sweep 间隔 */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * 起 accumulator loop（fire-and-forget；调用方不 await）。
 * @param sessionId 被绑定的 agent session
 * @param handle 出站接收方连接句柄（sendOutbound/updateInputState）
 * @param controller abort 控制器（aborted=true 时 break + 队列任务跳过）
 * @param subscribe 取 agent_loop AsyncIterable<AgentEvent> 的工厂
 */
export async function runChannelAccumulator(
  sessionId: string,
  handle: ChannelHandle,
  controller: AccumulatorController,
  subscribe: (sessionId: string) => AsyncIterable<AgentEvent>,
): Promise<void> {
  console.log('[channel][accumulator] 启动 sessionId=%s configId=%s', sessionId, handle.configId);
  const iter = subscribe(sessionId);
  const queue = new SendQueue(handle, controller, sessionId);

  // per-block 状态（带时间戳，供 stale sweep 使用）
  const textBuffers = new Map<string, BufferSlot>();
  const toolCallNames = new Map<string, TimedSlot<string>>();
  const userOrigins = new Map<string, TimedSlot<{ type: string; configId: string }>>();
  let currentRunId: string | undefined;
  let eventCount = 0;

  // stale sweep：60s 定时扫三个 Map，清理 5min 无活动的槽（空 Map 迭代 O(0)，开销可忽略）
  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, slot] of textBuffers) {
      if (now - slot.lastAt > BLOCK_STALE_MS) {
        console.warn('[channel][accumulator] stale block 回收 blockId=%s 已累计=%d字符 sessionId=%s', id, slot.text.length, sessionId);
        textBuffers.delete(id);
      }
    }
    for (const [id, slot] of toolCallNames) {
      if (now - slot.lastAt > BLOCK_STALE_MS) { toolCallNames.delete(id); }
    }
    for (const [id, slot] of userOrigins) {
      if (now - slot.lastAt > BLOCK_STALE_MS) { userOrigins.delete(id); }
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  try {
    for await (const ev of iter) {
      if (controller.aborted) break;
      eventCount++;

      try {
        // run 生命周期：typing indicator（直接 await）
        if (ev.type === 'run_start') {
          currentRunId = ev.runId;
          try { await handle.updateInputState('typing'); } catch { /* swallow */ }
          continue;
        }
        if (ev.type === 'run_end') {
          try { await handle.updateInputState('idle'); } catch { /* swallow */ }
          currentRunId = undefined;
          continue;
        }
        if (ev.type === 'error') {
          console.error('[channel][accumulator] error 事件（agent/LLM 失败）sessionId=%s', sessionId, JSON.stringify(ev).slice(0, 400));
          continue;
        }

        // user 级 message_start：记录 origin（带时间戳）
        if (ev.type === 'message_start') {
          if (ev.role === 'user' && ev.origin && ev.messageId) userOrigins.set(ev.messageId, { val: ev.origin, lastAt: Date.now() });
          continue;
        }
        if (ev.type === 'message_end') {
          if (ev.messageId) userOrigins.delete(ev.messageId);
          continue;
        }

        // answer block
        if (ev.type === 'text_block_start') { textBuffers.set(ev.blockId, { text: '', lastAt: Date.now() }); continue; }
        if (ev.type === 'text_block_delta') {
          const slot = textBuffers.get(ev.blockId);
          if (!slot) continue; // 错过 start → 丢弃
          slot.text += ev.delta;
          slot.lastAt = Date.now();
          continue;
        }
        if (ev.type === 'text_block_end') {
          const slot = textBuffers.get(ev.blockId);
          if (!slot) continue;
          const text = slot.text;
          textBuffers.delete(ev.blockId);
          if (!text) continue;
          const originSlot = ev.messageId ? userOrigins.get(ev.messageId) : undefined;
          if (originSlot) {
            if (originSlot.val.configId === handle.configId) continue; // self echo → DROP
            queue.enqueue(`User (from ${originSlot.val.type}): ${text}`, currentRunId);
            continue;
          }
          queue.enqueue(text, currentRunId);
          continue;
        }

        // reasoning block：忽略
        if (ev.type === 'reasoning_block_start' || ev.type === 'reasoning_block_delta' || ev.type === 'reasoning_block_end') continue;

        // tool_call
        if (ev.type === 'tool_call_start') { toolCallNames.set(ev.toolCallId, { val: ev.toolName, lastAt: Date.now() }); continue; }
        if (ev.type === 'tool_call_end') {
          const slot = toolCallNames.get(ev.toolCallId);
          if (!slot) continue;
          toolCallNames.delete(ev.toolCallId);
          queue.enqueue(`🔧 调用工具：${slot.val}`, currentRunId);
          continue;
        }
        if (ev.type === 'tool_result_end') {
          queue.enqueue(ev.isError ? '📋 工具回复：失败' : '📋 工具回复：成功', currentRunId);
          continue;
        }
        // 其余事件忽略
      } catch (evErr) {
        // 单事件处理异常：打 error 日志 + 丢弃该事件，loop 不退出（防连累）
        console.error('[channel][accumulator] 事件处理异常（丢弃继续）sessionId=%s ev.type=%s', sessionId, (ev as { type?: string }).type ?? '?', evErr);
      }
    }

    const exitReason = controller.aborted ? 'aborted' : 'iterator done';
    console.log('[channel][accumulator] 退出(%s) sessionId=%s configId=%s 已消费=%d 事件 队列剩余=%d', exitReason, sessionId, handle.configId, eventCount, queue.pending);
  } catch (e) {
    console.error('[channel][accumulator] 异常退出 sessionId=%s configId=%s 已消费=%d 事件 队列剩余=%d', sessionId, handle.configId, eventCount, queue.pending, e);
    throw e;
  } finally {
    clearInterval(sweepTimer);
  }
}
