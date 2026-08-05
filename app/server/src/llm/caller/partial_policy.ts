/**
 * Partial 保留策略 — 根据 abortReason / 错误类别决定 partial 是否保留
 * 参考: specs/tech/agent/llm_caller/[P0]retry_and_timeout.md §4
 *
 * 策略表（§4）：
 *   | 场景                     | partial | 理由                                  |
 *   |--------------------------|---------|---------------------------------------|
 *   | 用户 abort               | 保留    | 用户主动，可能想看半截回复             |
 *   | watchdog_ttfb abort      | 丢弃    | 首 chunk 都没到，无 partial 可言      |
 *   | watchdog_stall abort     | 丢弃    | 流断 partial 不可信（除非无未完成 tool_use） |
 *   | wall_max abort           | 丢弃    | 同上                                  |
 *   | STREAM_INCOMPLETE        | 视 tool_use 完整性 | 无未完成 tool_use 则保留供 prefill |
 *   | MAX_TOKENS_EXCEEDED      | 保留    | 供 prefill 续写                       |
 *
 * 「partial 可保留」判定（§4 末）：partial message 无 ToolCallBlock，
 *   或所有 ToolCallBlock 的 arguments 已完整（JSON 可解析）。
 *
 * 边界：本模块只决定「是否保留」的布尔决策；partial 实际写入 errorState.partialResult 归 caller。
 *   用局部 PartialErrorKind 枚举（不耦合 LlmErrorCategory）；caller 接线时映射 LlmErrorCategory → 本枚举。
 */
import type { AbortReason } from './composite_abort';

/** partial 决策所用的错误种类（局部枚举，避免耦合 LlmErrorCategory） */
export type PartialErrorKind =
  | 'STREAM_INCOMPLETE'
  | 'MAX_TOKENS_EXCEEDED'
  | 'OTHER';

/** abort 来源对应的 partial 决策（§4） */
export type PartialAbortReason = AbortReason;

/**
 * 判断 abort 场景下 partial 是否保留（§4 表）。
 *
 * - user：保留
 * - watchdog_ttfb：丢弃（首 chunk 没到，无 partial）
 * - watchdog_stall / wall_max：保留仅当 partial 无未完成 tool_use（流断 partial 不可信）
 */
export function shouldKeepPartialOnAbort(
  reason: PartialAbortReason,
  hasUnfinishedToolUse: boolean,
): boolean {
  switch (reason) {
    case 'user':
      return true;
    case 'watchdog_ttfb':
      return false;
    case 'watchdog_stall':
    case 'wall_max':
      return !hasUnfinishedToolUse;
    default:
      return false;
  }
}

/**
 * 判断非 abort 错误下 partial 是否保留（§4 表）。
 *
 * - STREAM_INCOMPLETE：视 tool_use 完整性（无未完成 → 保留供 prefill）
 * - MAX_TOKENS_EXCEEDED：保留（供 prefill 续写）
 * - OTHER：丢弃（默认保守）
 */
export function shouldKeepPartialOnError(
  kind: PartialErrorKind,
  hasUnfinishedToolUse: boolean,
): boolean {
  switch (kind) {
    case 'STREAM_INCOMPLETE':
      return !hasUnfinishedToolUse;
    case 'MAX_TOKENS_EXCEEDED':
      return true;
    case 'OTHER':
    default:
      return false;
  }
}
