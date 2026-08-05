/**
 * Retry Backoff 算法（getRetryDelay + counter seed jitter + 默认值）
 * 参考: specs/tech/agent/llm_caller/[P0]retry_and_timeout.md §1
 *
 * 设计背景：
 *   - 半 jitter（claude-code 风格）而非全 jitter（hermes），保退避下限 + 散列（§5.1）
 *   - retry-after 优先但双层 cap（§5.2）：尊重 provider 反压，但 cap 在 backoff_cap_s 防病态
 *   - counter seed（§1.2）：进程级计数器防高并发瞬时同步重试
 *
 * 默认值（§1.3）：max_attempts=3 / backoff_base_s=2 / backoff_cap_s=30 / jitter=true
 */
import type { RetryConfig } from './config_types';
// DEFAULT_RETRY_CONFIG re-export 自 config_types（权威源）。
export { DEFAULT_RETRY_CONFIG } from './config_types';

/**
 * 进程级重试计数器（§1.2）：防高并发下瞬时同步退避。
 * 多 session 并发 getRetryDelay 时，counter 递增 + Date.now + Math.random 混合，
 * 避免同一毫秒 N 个 session 同步重试加剧限流。
 *
 * 注：模块级 let 变量，跨整个进程共享（符合 §1.2 进程级语义）。
 */
let __retryCounter = 0;

/**
 * counter seed jitter（§1.2）—— 混合 counter + Date.now + Math.random。
 * @returns [0, 1) 区间散列值（非纯 Math.random）
 */
export function getCounterSeedJitter(): number {
  __retryCounter = (__retryCounter + 1) % 1000;
  // counter 散列 + 毫秒时间戳 + 随机数三路混合，并发不撞 + 仍随机
  return ((Date.now() % 1000) + __retryCounter + Math.random() * 1000) % 1000 / 1000;
}

/** 测试钩子：重置 counter（仅 UT 用，生产勿调） */
export function __resetRetryCounterForTest(): void {
  __retryCounter = 0;
}

/**
 * 计算下一次重试的等待时间（毫秒）。
 *
 * 公式（§1.1）：
 *   1. retry-after 优先：min(retryAfter * 1000, backoff_cap_ms)（双层 cap，§5.2）
 *   2. 否则指数退避：min(base_ms * 2^(attempt-1), backoff_cap_ms)
 *   3. 半 jitter：+ floor(jitterSeed * 0.25 * base_ms)（§5.1 保下限 + 散列）
 *
 * @param attempt     当前 attempt 编号（1-based；attempt=1 失败后算第 1 次 delay）
 * @param retryAfter  分类错误携带的 Retry-After（秒），无则 undefined
 * @param config      RetryConfig（backoff_base_s / backoff_cap_s / jitter）
 * @returns 等待毫秒数
 */
export function getRetryDelay(
  attempt: number,
  retryAfter: number | undefined,
  config: RetryConfig,
): number {
  const baseMs = config.backoff_base_s * 1000;
  const capMs = config.backoff_cap_s * 1000;

  // 1. retry-after 优先（尊重 provider 反压）+ cap 防病态
  if (retryAfter !== undefined) {
    return Math.min(retryAfter * 1000, capMs);
  }

  // 2. 指数退避：min(base * 2^(attempt-1), cap)
  const exp = Math.min(baseMs * Math.pow(2, attempt - 1), capMs);

  // 3. 半 jitter（claude-code 风格）：+ random * 0.25 * base
  //    全 jitter（random * exp）会让最小延迟过低；半 jitter 保下限又散列
  if (config.jitter) {
    const jitterSeed = getCounterSeedJitter();
    return exp + Math.floor(jitterSeed * 0.25 * baseMs);
  }
  return exp;
}
