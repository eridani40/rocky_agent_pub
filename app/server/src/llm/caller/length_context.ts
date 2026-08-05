/**
 * Length 处理 —— CONTEXT_LENGTH_EXCEEDED 压缩 + STREAM_INCOMPLETE 区分
 * 参考: specs/tech/agent/llm_caller/[P0]length_handling.md §3（CONTEXT_LENGTH）/ §4（STREAM_INCOMPLETE）
 *
 * 核心原则（hermes 教训）：
 *   - CONTEXT_LENGTH 后不瞎猜 context window（§3.3）—— 只设粘性预压缩标记
 *   - STREAM_INCOMPLETE（流断 + tool args 未完成）严格不 bump（§4 + §7.3）
 */

import type { CanonicalRequest } from '../protocol';
import type { Message } from '../protocol-types';
import type { LengthErrorState, PartialMessage } from './length_types';
import {
  COMPRESS_TARGET_RATIO,
  PRECOMPRESS_TRIGGER_THRESHOLD,
} from './length_types';
import { isSalvageable } from './length_max_tokens';

// ──────────────────────────────────────────────────────────────────────────
// §3 CONTEXT_LENGTH_EXCEEDED 处理
// ──────────────────────────────────────────────────────────────────────────

/**
 * 上下文压缩器抽象（ContextEngine.compact 的最小契约）。
 * 实现归 context 模块（specs/tech/agent/context/），本模块只调用不重写。
 */
export interface ContextCompressor {
  /** 压缩 messages 到 targetRatio（如 0.8 = 压到 80%） */
  compact(messages: Message[], opts: { targetRatio: number }): Message[];
}

/**
 * 触发 CONTEXT_LENGTH_EXCEEDED 后更新粘性状态（§3.1 + §3.2）。
 *
 * 规则（§3.3 不瞎猜窗口）：
 *   - 不改 context window（modelConfig 固有属性，LlmCaller 无权改）
 *   - 累加 consecutiveContextLength；达阈值 → precompress=true（粘性）
 *   - precompress 一旦设置持续生效（不自动清；由上层 recordSuccess 清，本模块不管清）
 *
 * @param state 当前 LengthErrorState（不 mutate，返回新对象）
 * @returns 更新后的 LengthErrorState（precompress 可能被设为 true）
 */
export function applyContextLengthEscalation(
  state: LengthErrorState,
): LengthErrorState {
  const consecutive = (state.consecutiveContextLength ?? 0) + 1;
  // §3.2：达阈值 → 设粘性预压缩标记
  const precompress = state.precompress || consecutive >= PRECOMPRESS_TRIGGER_THRESHOLD;
  return {
    ...state,
    consecutiveContextLength: consecutive,
    precompress,
  };
}

/**
 * 应用压缩 overlay 到 baseReq（§3.2 buildRequest）。
 * 若 errorState.precompress=true，调 ContextEngine.compact 压到 COMPRESS_TARGET_RATIO（80%）。
 *
 * @param baseReq 原始请求
 * @param state LengthErrorState（读 precompress）
 * @param compressor ContextEngine 实现
 */
export function applyCompressOverlay(
  baseReq: CanonicalRequest,
  state: LengthErrorState,
  compressor: ContextCompressor,
): CanonicalRequest {
  if (!state.precompress) return baseReq;
  return {
    ...baseReq,
    messages: compressor.compact(baseReq.messages, {
      targetRatio: COMPRESS_TARGET_RATIO,
    }),
  };
}

/**
 * §3.1 触发后：若 provider 报告了 context window 且当前 max_tokens + 输入超窗，
 * 本次调用降 max_tokens 腾输入空间（不永久改 model.capabilities）。
 *
 * 注意（§3.3）：只在 provider 明确报告 reportedContextWindow 时本次降；
 * 不写 errorState 持久化（粘性只设 precompress，不改窗口）。
 *
 * @param currentMaxTokens 当前 max_tokens
 * @param inputTokens 输入 token 数（estimation）
 * @param reportedContextWindow provider 报告的 context window（CONTEXT_LENGTH 错误附带；undefined=未报告）
 * @param modelLowerBound max_tokens 安全下限（默认 1024，避免降到无意义值）
 */
export function computeContextLengthMaxTokensAdjustment(
  currentMaxTokens: number,
  inputTokens: number,
  reportedContextWindow: number | undefined,
  modelLowerBound = 1024,
): number {
  if (reportedContextWindow === undefined) return currentMaxTokens;
  // 当前 max_tokens + 输入未超窗 → 不动
  if (currentMaxTokens + inputTokens <= reportedContextWindow) {
    return currentMaxTokens;
  }
  // 超窗 → 降 max_tokens 腾输入空间，封底 modelLowerBound
  const adjusted = reportedContextWindow - inputTokens;
  return Math.max(modelLowerBound, adjusted);
}

// ──────────────────────────────────────────────────────────────────────────
// §4 STREAM_INCOMPLETE 区分（必学避坑）
// ──────────────────────────────────────────────────────────────────────────

/**
 * 判定是否 STREAM_INCOMPLETE（§4，必学避坑）。
 *
 * STREAM_INCOMPLETE 触发条件（任一）：
 *   - 无 stop_reason（流断无 finish 事件）
 *   - stop_reason 存在但 partial 含未完成 tool_call（arguments 不可解析）
 *
 * STREAM_INCOMPLETE 严格不 bump（§4 + §7.3）：bump 后 tool args 仍不完整
 * （真因流断），3 次浪费配额（hermes 教训 chat_completion_helpers.py:2054-2108）。
 *
 * @param stopReason 流的 finish 事件 reason（undefined = 流断无 finish）
 * @param partial partial assistant message（查 tool_call 完整性；undefined=无 partial）
 */
export function isStreamIncomplete(
  stopReason: 'stop' | 'tool_use' | 'max_tokens' | undefined,
  partial: PartialMessage | undefined,
): boolean {
  // §4 场景 3：流断无 finish
  if (stopReason === undefined) return true;
  // §4 场景 2：有 finish 但 partial 含未完成 tool_call → STREAM_INCOMPLETE
  if (partial && hasToolCall(partial) && !isSalvageable(partial)) {
    return true;
  }
  return false;
}

/** partial 是否含 tool_call block */
function hasToolCall(partial: PartialMessage): boolean {
  return partial.content.some((b) => b.type === 'tool_call');
}
