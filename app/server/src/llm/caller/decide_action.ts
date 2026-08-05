/**
 * decideAction —— attempt 失败后读 hints 综合上下文产最终 action
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3 step 3e（decide 调度）
 *
 * 决策矩阵（hermes 模式：classify 产 hints，decide 读 hints）：
 *   1. shouldCompressContext → FIX_AND_RETRY_CONTEXT_LENGTH
 *   2. shouldBumpMaxTokens → FIX_AND_RETRY_MAX_TOKENS
 *   3. shouldRotateKey + provider 有可轮换 per_key key → ROTATE_KEY
 *   4. retryable + attempt < max → RETRY_BACKOFF
 *   5. retryable + attempt >= max + shouldFallbackProvider → FALLBACK
 *   6. shouldFallbackProvider（非瞬时） → FALLBACK
 *   7. 否则 NO_RETRY
 *
 * 只含纯函数 + 类型。
 */
import type { ClassifiedLlmError } from './error_types';
import type { ResolvedTarget } from './resolve_target';
import { isAccountWideQuota } from '../credentials';
import { hasRotatableKey } from './fallback_key_selector';

/** decide 决策的最终 action（5 选 1）。 */
export type DecideAction =
  | 'NO_RETRY'
  | 'RETRY_BACKOFF'
  | 'FIX_AND_RETRY_MAX_TOKENS'
  | 'FIX_AND_RETRY_CONTEXT_LENGTH'
  | 'ROTATE_KEY'
  | 'FALLBACK';

/**
 * 决策矩阵（hermes 模式：读 hints 综合上下文产最终 action）。
 *
 * @param err          ClassifiedLlmError（含 hints）
 * @param target       当前 target（查 credentials 是否有可轮换 key）
 * @param attempt      当前 attempt（1-based）
 * @param maxAttempts  config.retry.max_attempts
 */
export function decideAction(
  err: ClassifiedLlmError,
  target: ResolvedTarget,
  attempt: number,
  maxAttempts: number,
): DecideAction {
  const h = err.hints;

  // 1. length 修复类（优先，spec §3 step 3e）
  if (h.shouldCompressContext) return 'FIX_AND_RETRY_CONTEXT_LENGTH';
  if (h.shouldBumpMaxTokens) {
    // EXCEEDED 走 one-shot ceiling bump（spec §2.2），
    // prefill 未启用（§2.1 / §7.1，decideMaxTokensAction 不返 'prefill' 分支）。
    // 由 applyMaxTokensOverlay 在已到硬上限时（current ≥ ceiling）自然 throw 终止，本处不再重复判定。
    return 'FIX_AND_RETRY_MAX_TOKENS';
  }

  // 2. 凭证：可轮换 + provider 有备用 per_key key → ROTATE_KEY
  if (h.shouldRotateKey) {
    const accountWide = isAccountWideQuota(target.provider.credentials, target.keyRef);
    if (!accountWide && hasRotatableKey(target.provider.credentials, target.keyRef)) {
      return 'ROTATE_KEY';
    }
    // account-wide 或无备用 key → FALLBACK
    return 'FALLBACK';
  }

  // 3. 瞬时错误：先退避重试，超 max 后 fallback
  if (h.retryable) {
    if (attempt < maxAttempts) return 'RETRY_BACKOFF';
    if (h.shouldFallbackProvider) return 'FALLBACK';
    return 'NO_RETRY'; // 单 provider 无 fallback chain 时，超 max 即 NO_RETRY
  }

  // 4. shouldFallbackProvider（非瞬时场景，如连续 AUTH 全 dead）
  if (h.shouldFallbackProvider) return 'FALLBACK';

  return 'NO_RETRY';
}
