/**
 * attemptLoop —— 单 attempt 内 stream 消费 + watchdog + abort/error 归一化
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3 step 3b-3e
 *       specs/tech/agent/llm_caller/[P0]retry_and_timeout.md §2（watchdog）+ §3（abort）+ §4（partial）
 *
 * 单 attempt 生命周期：构造 CompositeAbortController → 启动 Watchdog（TTFB/stall/wall）
 *   → 消费 client.stream（chunk → watchdog.onChunk + onEvent + 聚合）
 *   → 正常结束：watchdog.stop + 聚合 → ok / max_tokens_finish / EMPTY_RESPONSE
 *   → catch：读 composite.reason 区分 user/watchdog_*；非 abort 时 classify 归一化
 *
 * 边界：本模块只负责「单次 attempt 的流消费 + 错误归一化」，不做重试决策
 *       （归 llm_caller.invoke：基于 hints + 健康表 + attempt 计数）。
 */
import type { CanonicalRequest, StreamEvent } from '../protocol';
import type { LlmClient } from '../client';
import type { Message } from '../protocol-types';
import type { Usage } from '../../message/types';
import type { ProviderName } from '../provider-types';
import type { TimeoutConfig } from '../../config/llm_request_config';
import type { AbortControllerHandle } from '../../agent/agent-interface';
import { CompositeAbortController } from './composite_abort';
import { Watchdog } from './watchdog';
import { classify } from './error_classify';
import { LlmErrorCategory, type ClassifiedLlmError } from './error_types';
import {
  shouldKeepPartialOnAbort,
  shouldKeepPartialOnError,
  type PartialErrorKind,
} from './partial_policy';
import type { WatchdogStreamEvent } from './config_types';
import type { PartialMessage } from './length_types';

/** attemptLoop 输入（spec §3.3b-3d）。 */
export interface AttemptLoopInput {
  /** 已选中的 client（resolveTarget 产出） */
  client: LlmClient;
  /** 应用 overlay 后的 canonical 请求 */
  req: CanonicalRequest;
  /** provider 标识（classify 派发用） */
  providerName: ProviderName;
  /** agent loop 的内存 controller（用户中断信号源） */
  userController: AbortControllerHandle;
  /** 超时配置（watchdog 阈值） */
  timeoutConfig: TimeoutConfig;
  /** chunk 转发回调（agent loop emit 责任保留） */
  onEvent?: (evt: StreamEvent) => void;
  /** 是否有多个 key（影响 classify hints 的 shouldRotateKey） */
  hasMultipleKeys: boolean;
  /** 当前 attempt 序号（1-based；影响 classify hints 的 shouldFallbackProvider） */
  attempt: number;
}

/** attemptLoop 输出（discriminated union）。 */
export type AttemptLoopResult =
  | { kind: 'ok'; message: Message; usage: Usage | null; stopReason: 'stop' | 'tool_use' | 'max_tokens' }
  | { kind: 'error'; err: ClassifiedLlmError; partial?: PartialMessage }
  | { kind: 'user_abort'; partial?: PartialMessage }
  /**
   * 流正常 finish 但 stop_reason=max_tokens（provider 等价终态）。
   * 调用方（llm_caller.invoke）应调 applyMaxTokensOverlay 决策 bump / throw（prefill 未启用）。
   */
  | { kind: 'max_tokens_finish'; partial: PartialMessage; usage: Usage | null };

/**
 * 执行单次 attempt：消费 client.stream，watchdog 守护，错误归一化（流程见文件头）。
 */
export async function attemptLoop(input: AttemptLoopInput): Promise<AttemptLoopResult> {
  const { client, req, providerName, userController, timeoutConfig, onEvent, hasMultipleKeys, attempt } = input;

  const composite = new CompositeAbortController();
  const watchdog = new Watchdog(composite, timeoutConfig);
  watchdog.start();

  const aggregator = createStreamAggregator();
  let gotFirstChunk = false;

  try {
    for await (const evt of client.stream(req, composite.signal)) {
      if (!gotFirstChunk) {
        gotFirstChunk = true;
        watchdog.onFirstChunk();
      }
      watchdog.onChunk(toWatchdogEvent(evt));
      onEvent?.(evt);
      aggregator.consume(evt);

      // 流内 error 事件（HTTP 2xx 但 body 含 error）→ 转错误归一化
      if (evt.type === 'error') {
        const err = classify(
          { message: evt.message, code: evt.code },
          providerName,
          { hasMultipleKeys, attempt },
        );
        return { kind: 'error', err, partial: aggregator.buildPartial() };
      }

      // 用户中断：abortByUser 后续 chunk 不再读（保留 partial）
      if (userController.aborted) {
        composite.abortByUser();
        break;
      }
    }
    watchdog.stop();

    if (composite.reason === 'user' || userController.aborted) {
      return { kind: 'user_abort', partial: aggregator.buildPartial() };
    }
    const built = aggregator.buildMessage();
    // MAX_TOKENS finish → bump 触发点（prefill 未启用）。
    // 流正常 finish + stop_reason='max_tokens'（provider 等价终态）→ 返 max_tokens_finish 让 invoke 决策。
    // STREAM_INCOMPLETE（§4）：流断被 watchdog/catch 捕获；此处仅再排除「partial 含未完成 tool_use」。
    if (built.stopReason === 'max_tokens') {
      const partial = aggregator.buildPartial();
      // 无 partial 或 partial 含未完成 tool_use（arguments 不是 object）→ STREAM_INCOMPLETE（不 bump，§4）
      if (!partial || hasUnfinishedToolUse(partial)) {
        const err = new Error('stream incomplete: max_tokens without salvageable partial') as ClassifiedLlmError;
        err.category = LlmErrorCategory.STREAM_INCOMPLETE;
        err.hints = {
          retryable: true, shouldRotateKey: false, shouldFallbackProvider: false,
          shouldCompressContext: false, shouldBumpMaxTokens: false,
        };
        return { kind: 'error', err, partial };
      }
      return { kind: 'max_tokens_finish', partial, usage: built.usage };
    }
    // EMPTY_RESPONSE 检测（spec error_normalization §4.3 + §6.7）：
    // 流正常 finish（stop）但 content 实质为空（无 tool_call 且无非空 text）→ EMPTY_RESPONSE（可重试瞬时）。
    // 纯 tool_call 响应走 stopReason='tool_use' 不进此分支；max_tokens 已上面处理。
    if (built.stopReason === 'stop' && isContentEmpty(built.message.content)) {
      const err = new Error('empty response: stream finished but no text and no tool_call') as ClassifiedLlmError;
      err.category = LlmErrorCategory.EMPTY_RESPONSE;
      err.hints = {
        retryable: true, shouldRotateKey: false, shouldFallbackProvider: false,
        shouldCompressContext: false, shouldBumpMaxTokens: false,
      };
      return { kind: 'error', err };
    }
    return { kind: 'ok', message: built.message, usage: built.usage, stopReason: built.stopReason };
  } catch (rawError) {
    watchdog.stop();
    return handleCatch(rawError, composite, userController, providerName, hasMultipleKeys, attempt, aggregator);
  }
}

/** catch 块：读 composite.reason 决定 category，归一化错误。 */
function handleCatch(
  rawError: unknown,
  composite: CompositeAbortController,
  userController: AbortControllerHandle,
  providerName: ProviderName,
  hasMultipleKeys: boolean,
  attempt: number,
  aggregator: StreamAggregator,
): AttemptLoopResult {
  const reason = composite.reason;
  if (reason === 'user' || userController.aborted) {
    return { kind: 'user_abort', partial: aggregator.buildPartial() };
  }
  if (reason === 'watchdog_ttfb') {
    const err = classify(rawError, providerName, { hasMultipleKeys, attempt });
    err.category = LlmErrorCategory.TIMEOUT_FIRST_CHUNK;
    err.hints = {
      retryable: true, shouldRotateKey: false, shouldFallbackProvider: false,
      shouldCompressContext: false, shouldBumpMaxTokens: false,
    };
    return { kind: 'error', err /* ttfb 无 partial */ };
  }
  if (reason === 'watchdog_stall' || reason === 'wall_max') {
    const err = classify(rawError, providerName, { hasMultipleKeys, attempt });
    err.category = LlmErrorCategory.TIMEOUT_INTER_CHUNK;
    err.hints = {
      retryable: true, shouldRotateKey: false, shouldFallbackProvider: false,
      shouldCompressContext: false, shouldBumpMaxTokens: false,
    };
    const partial = aggregator.buildPartial();
    const keep = partial
      ? shouldKeepPartialOnAbort(reason, hasUnfinishedToolUse(partial))
      : false;
    return { kind: 'error', err, partial: keep ? partial : undefined };
  }
  // 非 abort 的 HTTP/fetch 错误：classify 归一化
  const err = classify(rawError, providerName, { hasMultipleKeys, attempt });
  const partial = aggregator.buildPartial();
  const kind = partialKindForCategory(err.category);
  const keep = partial
    ? shouldKeepPartialOnError(kind, hasUnfinishedToolUse(partial))
    : false;
  return { kind: 'error', err, partial: keep ? partial : undefined };
}

/** 把 protocol StreamEvent 映射为 watchdog 的阶段感知事件。 */
function toWatchdogEvent(evt: StreamEvent): WatchdogStreamEvent {
  switch (evt.type) {
    case 'text_delta': return { type: 'text_delta' };
    case 'thinking_delta': return { type: 'thinking_delta' };
    case 'tool_call_delta': return { type: 'tool_call_delta' };
    case 'usage': return { type: 'usage' };
    case 'finish': return { type: 'finish' };
    case 'error': return { type: 'error' };
    default: return { type: 'text_delta' };
  }
}

/**
 * Stream 聚合器（局部 closure，每次 attemptLoop 调用新建一个）。
 * 职责：text 累加 / tool_calls 收集 / usage 末值 / stopReason 末值。
 *
 * 设计理由：用 closure 把状态封装在 attemptLoop 局部作用域，避免全局污染
 * （同一进程多个 invoke 并发时 tool_call 不会串台）。
 */
interface StreamAggregator {
  consume(evt: StreamEvent): void;
  buildMessage(): { message: Message; usage: Usage | null; stopReason: 'stop' | 'tool_use' | 'max_tokens' };
  buildPartial(): PartialMessage | undefined;
}

/** 创建一个局部 stream 聚合器。 */
function createStreamAggregator(): StreamAggregator {
  let textBuf = '';
  const toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  const seenToolCallIds = new Set<string>();
  let usage: Usage | null = null;
  let stopReason: 'stop' | 'tool_use' | 'max_tokens' = 'stop';

  return {
    consume(evt) {
      if (evt.type === 'text_delta') {
        textBuf += evt.text;
      } else if (evt.type === 'tool_call_delta') {
        // 同 toolCallId 仅记录首次（argumentsDelta 累积由 protocol-parse-stream 闭合）
        if (!seenToolCallIds.has(evt.toolCallId)) {
          seenToolCallIds.add(evt.toolCallId);
          toolCalls.push({
            id: evt.toolCallId,
            name: evt.name ?? '',
            arguments: tryParseArgs(evt.argumentsDelta ?? '') ?? {},
          });
        }
      } else if (evt.type === 'usage') {
        usage = evt.usage;
      } else if (evt.type === 'finish') {
        stopReason = evt.reason;
      }
    },
    buildMessage() {
      const content: Message['content'] = [];
      if (textBuf.length > 0) content.push({ type: 'text', text: textBuf });
      for (const tc of toolCalls) {
        content.push({ type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments });
      }
      const message = { id: '', sessionId: '', role: 'assistant' as const, content } as Message;
      return { message, usage, stopReason };
    },
    buildPartial() {
      if (textBuf.length === 0 && toolCalls.length === 0) return undefined;
      const built = this.buildMessage();
      return { ...built.message, usage: usage ?? undefined };
    },
  };
}

/** 尝试 JSON.parse argumentsDelta（防御性）。 */
function tryParseArgs(s: string): Record<string, unknown> | undefined {
  if (!s) return undefined;
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** 判定 partial 是否含未完成 tool_use（arguments 不完整）。 */
function hasUnfinishedToolUse(partial: PartialMessage): boolean {
  return partial.content.some(
    (b) => b.type === 'tool_call' && typeof (b as { arguments: unknown }).arguments !== 'object',
  );
}

/**
 * 判定 content 是否「实质为空」（spec error_normalization §6.7）。
 * 空 = 无 tool_call block，且无 text block 的 text.trim() 非空。
 * 注：aggregator 不收集 thinking/reasoning block，故「有 thinking 但无 text 无 tool」
 * 表现为 content.length===0 → 空。纯 tool_call 响应有 tool_call block → 不空。
 */
function isContentEmpty(content: Message['content']): boolean {
  if (content.some((b) => b.type === 'tool_call')) return false; // 有 tool_call → 不空
  return !content.some((b) => b.type === 'text' && b.text.trim().length > 0);
}

/** LlmErrorCategory → PartialErrorKind 映射（partial_policy 局部枚举解耦）。 */
function partialKindForCategory(cat: LlmErrorCategory): PartialErrorKind {
  if (cat === LlmErrorCategory.STREAM_INCOMPLETE) return 'STREAM_INCOMPLETE';
  if (cat === LlmErrorCategory.MAX_TOKENS_EXCEEDED) return 'MAX_TOKENS_EXCEEDED';
  return 'OTHER';
}
