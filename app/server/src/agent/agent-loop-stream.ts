/**
 * StreamEvent → AgentEvent 映射 + Message 累积（agent-loop 拆分模块）
 * 参考: specs/tech/version_logs/v0.0.8/change_log.md §4 / agent_event.md §9
 *
 * 职责：消费 LlmClient.stream 产出的 StreamEvent，按 block 边界 emit
 * text_block_* / reasoning_block_* / tool_call_* / usage_block，累积出 assistant Message。
 *
 * 设计（与 agent-loop.ts 解耦）：
 *   - StreamConsumer 持有 emit 回调（agent-loop 注入），消费完产出 finalMessage
 *   - block 切换自动 end 上一个 block（text/reasoning/tool_call 互斥按出现顺序）
 *   - tool_call arguments JSON.parse 拼接结果（容错：解析失败保留 raw）
 *
 * 字段映射（agent_event.md §5+§9）：text_delta→text_block_*；
 * thinking_delta→reasoning_block_*；tool_call_delta→tool_call_*；usage→usage_block；finish→关 active block
 */
import { ulid } from '../config/ulid';
import { normalizeContentBlocks } from './tools/send-message-tool';
import type {
  ContentBlock,
  TextBlock,
  ReasoningBlock,
  ToolCallBlock,
  Usage,
} from '../message/types';
import type { StreamEvent } from '../llm/protocol';
import type { AgentEvent } from './agent-event-types';

/** 当前打开的 block（任一时刻最多一种 active，切换时 close 旧的） */
type ActiveBlock =
  | { kind: 'text'; blockId: string; text: string }
  | { kind: 'reasoning'; blockId: string; text: string }
  | {
      kind: 'tool_call';
      blockId: string;
      toolCallId: string;
      toolName: string;
      argumentsBuf: string;
    }
  | null;

/** StreamConsumer 构造参数 */
export interface StreamConsumerOptions {
  /** 公共字段（每条事件自动附上） */
  sessionId: string;
  runId: string;
  /** assistant message 的 id（message_start / 各 block 事件 messageId 用） */
  messageId: string;
  /** emit 回调（agent-loop 注入，直接转发到 bus） */
  emit: (event: AgentEvent) => void;
  /** 时间生成函数（注入便于测试控制时间）；缺省用 new Date().toISOString() */
  now?: () => string;
  /** [v0.0.13 S3] 本轮 snapshot.inputCharCount；handleUsage 时写入 usage.inputCharCount（13 字段闭环） */
  inputCharCount?: number;
  /**
   * [v0.0.15 BUG-002] runKind：每条 emit 事件自动附上（agent_event.md §2 AgentEventBase 必填）。
   * caller（agent-loop / forked-agent）注入对应 mode 的 runKind。
   */
  runKind?: string;
}

/**
 * StreamEvent 消费器：吃 StreamEvent，emit AgentEvent，产出 final assistant message。
 *
 * 用法：
 *   const consumer = new StreamConsumer({ sessionId, runId, messageId, emit });
 *   emit(consumer.messageStart());             // 先发 message_start(role:assistant)
 *   for await (const evt of client.stream(req)) consumer.consume(evt);
 *   emit(consumer.finish());                    // 发 message_end（实际由 agent-loop 决定）
 *   const msg = consumer.buildMessage(sessionId);
 */
export class StreamConsumer {
  private readonly sessionId: string;
  private readonly runId: string;
  private readonly messageId: string;
  private readonly emit: (event: AgentEvent) => void;
  private readonly now: () => string;
  private readonly inputCharCount: number | undefined;
  private readonly runKind: string | undefined;

  private active: ActiveBlock = null;
  private readonly blocks: ContentBlock[] = [];
  private lastUsage: Usage | null = null;
  // [v0.0.13 S3 D3.1] outputCharCount = 纯 TextBlock 字符数（不含 reasoning/tool_call）；text_delta 时累加
  private outputCharCount = 0;

  constructor(opts: StreamConsumerOptions) {
    this.sessionId = opts.sessionId;
    this.runId = opts.runId;
    this.messageId = opts.messageId;
    this.emit = opts.emit;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.inputCharCount = opts.inputCharCount;
    this.runKind = opts.runKind;
  }

  /** 生成 message_start(role:assistant)（agent-loop 在 stream 开头发）。
   *  必须带 role:'assistant'：前端 reducer/flatten 只认 role==='assistant' 才渲染气泡（BUG-005） */
  messageStart(): AgentEvent {
    return this.evt('message_start', { role: 'assistant' });
  }

  /** 生成 message_end（agent-loop 在 stream 结束、message 落库后发） */
  messageEnd(): AgentEvent {
    return this.evt('message_end', {});
  }

  /** 消费一个 StreamEvent（emit 对应 AgentEvent，累积 block 内容） */
  consume(event: StreamEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.handleText(event.text);
        break;
      case 'thinking_delta':
        this.handleReasoning(event.thinking);
        break;
      case 'tool_call_delta':
        this.handleToolCall(event);
        break;
      case 'usage':
        this.handleUsage(event.usage);
        break;
      case 'finish':
        // finish 表示 LLM 输出结束，关闭当前 active block
        this.closeActive();
        break;
    }
  }

  /** 构造累积出的 assistant Message（业务形态） */
  buildMessage(sessionId: string): {
    id: string;
    sessionId: string;
    role: 'assistant';
    content: ContentBlock[];
    runId: string;
  } {
    return {
      id: this.messageId,
      sessionId,
      role: 'assistant',
      content: [...this.blocks],
      runId: this.runId,
    };
  }

  // ── 内部 handler ──

  /** text_delta：首次打开 text block，后续拼接，切换/结束时关闭 */
  private handleText(delta: string): void {
    if (!this.active || this.active.kind !== 'text') {
      this.closeActive();
      const blockId = ulid();
      this.active = { kind: 'text', blockId, text: '' };
      this.emit(this.blockEvt('text_block_start', { blockId }));
    }
    const active = this.active as { kind: 'text'; blockId: string; text: string };
    active.text += delta;
    this.outputCharCount += delta.length; // [v0.0.13 S3 D3.1] 累积纯 TextBlock 字符数
    this.emit(this.blockEvt('text_block_delta', { blockId: active.blockId, delta }));
  }

  /** thinking_delta → reasoning_block_*（同 text 逻辑，累积 ReasoningBlock） */
  private handleReasoning(delta: string): void {
    if (!this.active || this.active.kind !== 'reasoning') {
      this.closeActive();
      const blockId = ulid();
      this.active = { kind: 'reasoning', blockId, text: '' };
      this.emit(this.blockEvt('reasoning_block_start', { blockId }));
    }
    const active = this.active as { kind: 'reasoning'; blockId: string; text: string };
    active.text += delta;
    this.emit(this.blockEvt('reasoning_block_delta', { blockId: active.blockId, delta }));
  }

  /** tool_call_delta：按 toolCallId 切换 block；arguments 拼接；name 首次出现时记录 */
  private handleToolCall(event: StreamEvent & { type: 'tool_call_delta' }): void {
    const sameTool =
      this.active &&
      this.active.kind === 'tool_call' &&
      this.active.toolCallId === event.toolCallId;
    if (!sameTool) {
      this.closeActive();
      const blockId = ulid();
      const toolName = event.name ?? '';
      this.active = {
        kind: 'tool_call',
        blockId,
        toolCallId: event.toolCallId,
        toolName,
        argumentsBuf: '',
      };
      this.emit(
        this.blockEvt('tool_call_start', {
          blockId,
          toolCallId: event.toolCallId,
          toolName,
        }),
      );
    }
    const active = this.active as { kind: 'tool_call'; blockId: string; toolCallId: string; toolName: string; argumentsBuf: string };
    if (event.name && !active.toolName) {
      active.toolName = event.name;
    }
    if (event.argumentsDelta) {
      active.argumentsBuf += event.argumentsDelta;
      this.emit(
        this.blockEvt('tool_call_delta', {
          blockId: active.blockId,
          toolCallId: active.toolCallId,
          delta: event.argumentsDelta,
        }),
      );
    }
  }

  /** usage → usage_block。[v0.0.13 S3] 补 char：outputCharCount=累积 TextBlock 字符数（D3.1），
   *  inputCharCount=构造期注入的 snapshot.inputCharCount。token/cost/currency 由其他层填 */
  private handleUsage(usage: Usage): void {
    const u: Usage = { ...usage };
    u.outputCharCount = this.outputCharCount;
    if (this.inputCharCount !== undefined && this.inputCharCount > 0) {
      u.inputCharCount = this.inputCharCount;
    }
    this.lastUsage = u;
    this.emit(this.evt('usage_block', { usage: u }));
  }

  /** 关闭当前 active block（emit *_end + 推入 blocks 累积数组） */
  private closeActive(): void {
    if (!this.active) return;
    const a = this.active;
    if (a.kind === 'text') {
      this.emit(this.blockEvt('text_block_end', { blockId: a.blockId }));
      const block: TextBlock = { type: 'text', text: a.text };
      this.blocks.push(block);
    } else if (a.kind === 'reasoning') {
      this.emit(this.blockEvt('reasoning_block_end', { blockId: a.blockId }));
      const block: ReasoningBlock = { type: 'reasoning', text: a.text };
      this.blocks.push(block);
    } else if (a.kind === 'tool_call') {
      this.emit(
        this.blockEvt('tool_call_end', {
          blockId: a.blockId,
          toolCallId: a.toolCallId,
        }),
      );
      const args = safeParseArgs(a.argumentsBuf);
      // [v0.0.331 P1] 落库前 normalize send_message 的 arguments.content（缺 type 补 'text'，
      // 治本：新数据永不空白 + 切断 LLM 上下文自增强）。仅 send_message 且非 _raw 半截路径生效。
      const finalArgs =
        a.toolName === 'send_message' && args._raw === undefined
          ? { ...args, content: normalizeContentBlocks(args.content) }
          : args;
      const block: ToolCallBlock = {
        type: 'tool_call',
        id: a.toolCallId,
        name: a.toolName,
        arguments: finalArgs,
      };
      this.blocks.push(block);
    }
    this.active = null;
  }

  // ── 事件构造 helper ──

  /** 构造事件（自动附公共字段 id/sessionId/createdAt/runId/messageId/runKind） */
  private evt(
    type: AgentEvent['type'],
    extra: Record<string, unknown>,
  ): AgentEvent {
    const base = {
      id: ulid(),
      type,
      sessionId: this.sessionId,
      createdAt: this.now(),
      runId: this.runId,
      messageId: this.messageId,
    };
    // [v0.0.15 BUG-002] runKind 缺省时回落 "current"（agent_event.md §2 AgentEventBase.runKind 必填）
    const withMode = this.runKind !== undefined
      ? { ...base, runKind: this.runKind }
      : base;
    return { ...withMode, ...extra } as unknown as AgentEvent;
  }

  /** block 类事件 helper（同 evt，语义别名） */
  private blockEvt(
    type: AgentEvent['type'],
    extra: Record<string, unknown>,
  ): AgentEvent {
    return this.evt(type, extra);
  }

  /** 暴露给测试：返回累积的 lastUsage（agent-loop 持久化用） */
  getLastUsage(): Usage | null {
    return this.lastUsage;
  }
}

/** 容错解析 tool_call arguments（拼接的 JSON 片段）；解析失败返回 {_raw, _rawTruncated:true} */
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
  // [v0.0.331 P1'] 加 _rawTruncated 标记：前端 D3 据此显示「发送失败（参数截断）」
  return { _raw: buf, _rawTruncated: true };
}
