/**
 * ReplayCollector — abort api step2 重组 half-data 用（v0.0.12 新建）
 * 参考: specs/tech/agent/agent_interface_and_loop/[P0]agent_interrupt.md §3.2 §4
 *       states/v0.0.12/design.md 板块 6
 *
 * 订阅 session 的 replayable bus（replayable buffer 灌入），收集本次 run 的事件流，
 * 用于 abort api 重组「LLM 流式 partial text」（场景 A）：
 *   - message_start ... text_block_{start,delta,end} / tool_call_{start,delta,end}
 *     序列中没有对应 message_end → 半截 message，abort api 需重组 partial 并 ingest
 *   - 复用 message_start 的 messageId（design §6.3 硬约束：禁重新生成）
 *
 * 用法：collector.collect(bus, group, timeoutMs) → collector.reconstitutePartials()
 */
import type { ReplayableEventBus } from './event-bus';
import type { EventBusEvent } from './event-bus';
import type { AgentEvent } from './agent-event-types';
import type { ContentBlock, ToolCallBlock } from '../message/types';

/** 重组出的 partial message（复用 message_start 的 messageId） */
export interface PartialMessage {
  messageId: string;
  blocks: ContentBlock[];
}

/** tool_call 累积态：arguments 的流式 JSON 片段先累积进 _argumentsBuf，reconstitute 时统一容错解析 */
type ToolCallAccum = ToolCallBlock & { _order: number; _argumentsBuf: string };

/** pending 内的 block 累积态：text 直接成形；tool_call 额外带 _argumentsBuf */
type PendingBlock = (ContentBlock & { _order: number }) | ToolCallAccum;

/**
 * 订阅 bus → 收集 replay buffer 内事件 → 重组 partial messages。
 * 重组 text 与 tool_call 两类 block（tool_call 缺配对 result 由 abort-finalize 的
 * fillInterruptedToolResults 兜底补 interrupted tool_result）。
 */
export class ReplayCollector {
  /** 当前未关闭的 message（messageStart 后、messageEnd 前的累积 buffer） */
  private readonly pending = new Map<string, { role?: string; blocks: Map<string, PendingBlock> }>();
  /** 已收到的 message_start 事件序（同一 message 可能多 block） */
  private blockOrder = 0;

  /**
   * 订阅 group，限时消费 buffer。
   * replayable bus 订阅时同步把 buffer 灌入 queue，超时（兜底）或队列消费完后退出。
   */
  async collect(
    bus: ReplayableEventBus,
    group: string,
    timeoutMs: number,
  ): Promise<void> {
    const iter = bus.subscribe<AgentEvent>(group)[Symbol.asyncIterator]();
    const start = Date.now();
    try {
      while (Date.now() - start < timeoutMs) {
        // 限时 next：若 100ms 内无新事件且超时未到，继续循环；超时则 break
        const result = await Promise.race([
          iter.next(),
          new Promise<IteratorResult<EventBusEvent<AgentEvent>>>((resolve) =>
            setTimeout(
              () => resolve({ value: undefined as never, done: true }),
              100,
            ),
          ),
        ]);
        if (result.done) {
          // replay buffer 灌完（订阅时一次性灌入，next 迅速消费空 → done）；
          // setTimeout 兜底也返 done。两种情况都 break（外层 while 条件已含超时）。
          break;
        }
        const evt = result.value?.data;
        if (evt) this.consume(evt);
      }
    } finally {
      try { await iter.return?.(); } catch { /* ignore */ }
    }
  }

  /** 消费一个 AgentEvent，累积到 pending */
  consume(evt: AgentEvent): void {
    switch (evt.type) {
      case 'message_start': {
        if (evt.messageId) {
          // 记录 role 用于 reconstitutePartials 过滤（只返 assistant partial；
          // user 消息已由 loop ingest 落库，不重复处理）
          const role = (evt as { role?: string }).role;
          this.pending.set(evt.messageId, { role, blocks: new Map() });
        }
        break;
      }
      case 'message_end': {
        if (evt.messageId) this.pending.delete(evt.messageId);
        break;
      }
      case 'text_block_start': {
        const p = evt.messageId ? this.pending.get(evt.messageId) : undefined;
        if (p && evt.blockId) {
          p.blocks.set(evt.blockId, { type: 'text', text: '', _order: this.blockOrder++ });
        }
        break;
      }
      case 'text_block_delta': {
        const p = evt.messageId ? this.pending.get(evt.messageId) : undefined;
        if (p && evt.blockId) {
          const cur = p.blocks.get(evt.blockId) as ({ type: 'text'; text: string; _order: number } | undefined);
          if (cur) {
            cur.text += evt.delta;
          }
        }
        break;
      }
      case 'text_block_end': {
        // 保留在 pending 直到 message_end（可能多 block）
        break;
      }
      // tool_call_* 与 text_block_* 同走 evt() 构造（agent-loop-stream.ts），messageId 必带，
      // 故归属方式与 text_block 一致（直接按 messageId 找 pending message）
      case 'tool_call_start': {
        const p = evt.messageId ? this.pending.get(evt.messageId) : undefined;
        if (p && evt.blockId) {
          p.blocks.set(evt.blockId, {
            type: 'tool_call',
            id: evt.toolCallId,
            name: evt.toolName,
            arguments: {}, // 占位；reconstitute 时用 _argumentsBuf 容错解析回填
            _order: this.blockOrder++,
            _argumentsBuf: '',
          });
        }
        break;
      }
      case 'tool_call_delta': {
        const p = evt.messageId ? this.pending.get(evt.messageId) : undefined;
        if (p && evt.blockId) {
          const cur = p.blocks.get(evt.blockId);
          if (cur && cur.type === 'tool_call') {
            (cur as ToolCallAccum)._argumentsBuf += evt.delta;
          }
        }
        break;
      }
      case 'tool_call_end': {
        // 同 text_block_end：保留在 pending；arguments 解析统一在 reconstitute 做
        // （半截 tool_call 无 end 也走同一解析点，天然容错）
        break;
      }
      default:
        // tool_result / usage / error 等不在此处理
        break;
    }
  }

  /**
   * 重组所有未 message_end 的 partial messages（design §6.2 场景 A）。
   * 复用 message_start 的 messageId（design §6.3 硬约束）。
   * 按 block._order 排序保证多 block 顺序。
   *
   * v0.0.12 BUG-001 修复：message_start 已 emit 但 LLM 尚未产出任何 block 即被 abort
   * 的情况（pending 中 messageId 存在但 blocks 为空）——也视为 partial，落库一个空
   * content 的 assistant message（保留 messageId 占位以维持对话顺序，前端可显示
   * 「已中断」）。design §6.2 硬约束：abort 期间所有 message_start 都必须最终落库。
   */
  reconstitutePartials(): PartialMessage[] {
    const out: PartialMessage[] = [];
    for (const [messageId, p] of this.pending) {
      // 只返 assistant partial（user 消息已由 loop ingest 落库）
      if (p.role && p.role !== 'assistant') continue;
      if (p.blocks.size === 0) {
        // 空 partial（message_start 后无 block）：仍落库以保持 messageId 占位
        out.push({ messageId, blocks: [] });
        continue;
      }
      const blocks = [...p.blocks.values()]
        .map((b) => {
          const { _order, ...rest } = b;
          // tool_call：用累积的 _argumentsBuf 容错解析出 arguments（完整或半截统一在此收尾）
          if (rest.type === 'tool_call') {
            const { _argumentsBuf, ...tc } = rest as ToolCallBlock & { _argumentsBuf: string };
            return { block: { ...tc, arguments: safeParseArgs(_argumentsBuf) } as ContentBlock, order: _order };
          }
          return { block: rest as ContentBlock, order: _order };
        })
        .sort((a, b) => a.order - b.order)
        .map((x) => x.block);
      out.push({ messageId, blocks });
    }
    return out;
  }
}

/** 容错解析 tool_call arguments（拼接的 JSON 片段）；同 agent-loop-stream.ts 的 safeParseArgs */
function safeParseArgs(buf: string): Record<string, unknown> {
  if (!buf) return {};
  try {
    const parsed = JSON.parse(buf);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 解析失败：保留 raw（容错）
  }
  return { _raw: buf };
}
