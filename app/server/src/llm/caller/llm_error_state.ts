/**
 * LlmErrorState —— RunState.llmErrorState 跨 iteration overlay 的 schema + 工厂 + 派生函数
 * 参考: specs/tech/agent/llm_caller/[P0]llm_request_config.md §2（schema + 派生规则）
 *       specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md §1（伪代码）
 *
 * 设计要点（spec §2.2 §2.3 §2.4 §5.4）：
 *   - recentErrors：连续错误历史（attempt 内 + 跨 iteration 累积），上限 = max_attempts−1。
 *     每次 error append（带 category + modelEntry 快照 + at）；超上限丢最旧。
 *     成功（recordSuccess）→ clearRecentErrors 清空整个数组（连续错误真相源）。
 *   - maxTokens 降级因子**派生不存储**（deriveMaxTokens）：
 *       base × 0.7^(recentErrors 中 MAX_TOKENS_TOO_HIGH 次数)，向下取整，有下限保底。
 *     只数 TOO_HIGH（降），不数 EXCEEDED（升，走 length_handling one-shot bump，不 append recentErrors）。
 *   - precompress：粘性，不主动清（靠 compact 后自然不再触发）。
 *   - prefillPartial：一次性，应用后立即清。
 *   - consecutiveContextLength：仍独立存储（length_context 累加，达阈值设 precompress）。
 *   - EXCEEDED bump 直接覆盖 built.req.params.maxTokens（one-shot ceiling，不进 errorState，spec §2.2 §2.4）。
 *
 * 不落盘（spec §6.3）：RunState 是 per-run 内存态，重启即销毁。
 * 只含类型 + 工厂 + 纯函数 overlay 更新器 + maxTokens 派生。
 */
import type { Message } from '../protocol-types';
import type { Usage } from '../../message/types';
import { LlmErrorCategory, type LlmErrorCategory as Category } from './error_types';
import type { PartialMessage } from './length_types';

/**
 * recentErrors 单条记录（spec §2.1）。
 * modelEntry 是错误发生时的 (providerId, keyRef, modelId) 三元组快照。
 */
export interface RecentErrorEntry {
  category: Category;
  modelEntry: { providerId: string; keyRef: string; modelId: string };
  /** 错误发生时间（epoch ms）—— 用于 langfuse / debug 排序 */
  at: number;
}

/**
 * LlmErrorState schema（spec §2.1）。
 * 字段全部 optional —— 新 run 起始为空对象，按需写入。
 */
export interface LlmErrorState {
  /**
   * [连续错误历史] 最近 N 次连续错误（attempt 内 + 跨 iteration 累积）。
   * 上限 = config.retry.max_attempts − 1。每次 error append；超上限丢最旧。
   * 成功（recordSuccess）→ clearRecentErrors 清空整个数组。
   * 这是「连续错误」的真相源：maxTokens 派生 / precompress 触发判定 全读它。
   */
  recentErrors?: RecentErrorEntry[];
  /** [粘性] 预压缩标记（CONTEXT_LENGTH 连续达阈值后持续生效） */
  precompress?: boolean;
  /** [一次性] prefill 续写的 partial（下轮 buildRequest 应用后清） */
  prefillPartial?: PartialMessage;
  /** [计数] 连续 CONTEXT_LENGTH 次数（达阈值设 precompress，仍独立累加） */
  consecutiveContextLength?: number;
  /** [瞬时] 最近一次错误（debug / langfuse metadata） */
  lastError?: { category: Category; reason: string; at: number };
  /** [瞬时] partial 结果（abort 时保留，供 agent loop 决定是否上抛半截回复） */
  partialResult?: { message: Message; usage?: Usage };
  // 注：无 maxTokensOverlay 字段——EXCEEDED bump 由 attempt 内直接覆盖 req.params.maxTokens（spec §2.2）。
}

/** 工厂：创建空 LlmErrorState（新 run 起始态）。 */
export function createLlmErrorState(): LlmErrorState {
  return {};
}

/**
 * 判定 LlmErrorState 是否「干净」（无任何 overlay / partial / recentErrors）。
 * 用于 recordSuccess 后是否清理。
 */
export function isErrorStateClean(state: LlmErrorState): boolean {
  return (
    (state.recentErrors === undefined || state.recentErrors.length === 0) &&
    state.prefillPartial === undefined &&
    state.partialResult === undefined &&
    state.precompress !== true &&
    state.consecutiveContextLength === undefined
  );
}

/**
 * 追加一条 recentError，裁剪到上限（spec §2.1 §2.2）。
 *
 * 上限 = maxAttempts − 1（默认 max_attempts=3 → 上限 2 条）。
 * 超过上限时丢最旧（数组头滑出），保留最近 N 条。
 * 不 mutate 原 state，返回新对象。
 *
 * @param state       原 LlmErrorState
 * @param entry       新错误条目（category + modelEntry + at）
 * @param maxAttempts config.retry.max_attempts（用于算上限）
 * @returns 追加并裁剪后的新 LlmErrorState
 */
export function appendRecentError(
  state: LlmErrorState,
  entry: RecentErrorEntry,
  maxAttempts: number,
): LlmErrorState {
  // 上限 = max_attempts − 1（至少 0；max_attempts=1 → 不存历史，append 后裁剪到 0）
  const cap = Math.max(0, maxAttempts - 1);
  const prev = state.recentErrors ?? [];
  // append + 裁剪：超过 cap 时丢最旧（取末尾 cap 条）。
  // 注：cap=0 时 slice(-0) 会返回整个数组（JS 坑：-0 === 0），需特判返空。
  const appended = [...prev, entry];
  const next = cap === 0 ? [] : appended.slice(-cap);
  return { ...state, recentErrors: next };
}

/**
 * 清空整个 recentErrors 数组（spec §2.2 清时机表）。
 *
 * 成功调用（attemptLoop 返 ok → recordSuccess）时调用此函数。
 * 连续错误一旦被成功打断，降级因子立即归零（派生值 maxTokens 自动回 base）。
 * 不 mutate 原 state，返回新对象。
 */
export function clearRecentErrors(state: LlmErrorState): LlmErrorState {
  if (state.recentErrors === undefined) return state;
  return { ...state, recentErrors: [] };
}

/**
 * maxTokens 派生（spec §2.4）—— 按 recentErrors 中
 * MAX_TOKENS_TOO_HIGH 出现次数做指数衰减：base × 0.7^downHits，向下取整，下限保底。
 *
 * **只数 TOO_HIGH**（降），不数 EXCEEDED（升，走 length_handling one-shot bump）/
 * NETWORK / 其他（与本派生无关）。
 *
 * @param base             caller 传入的输出预算（model/config 的 maxTokens，如 20000）
 * @param recentErrors     连续错误历史（只读 category 计数）
 * @param modelLowerBound  下限保底（防止指数衰减到无意义的极小值，spec §2.4 MIN_MAX_TOKENS 概念）
 * @returns 派生后的 maxTokens（≥ modelLowerBound，≤ base）
 */
export function deriveMaxTokens(
  base: number,
  recentErrors: RecentErrorEntry[] | undefined,
  modelLowerBound: number,
): number {
  const downHits = (recentErrors ?? []).filter(
    (e) => e.category === LlmErrorCategory.MAX_TOKENS_TOO_HIGH,
  ).length;
  // 每次 MAX_TOKENS_TOO_HIGH 降一档：× 0.7^downHits（指数衰减防病态循环）
  // downHits=0 → base；downHits=1 → base×0.7；downHits=2 → base×0.49
  const derived = Math.floor(base * Math.pow(0.7, downHits));
  // 先保底（下限），再 cap 到 base（派生值不会超过 base，也不会低于 lowerBound）。
  // 注：若 base 本身 < lowerBound，min(base, ...) 保证不把 base 抬高（base 是权威上限）。
  return Math.min(base, Math.max(modelLowerBound, derived));
}

/**
 * recordSuccess 时清理瞬时态（spec §2.2 §2.3 清时机表）。
 *
 * 清理规则：
 *   - recentErrors：清空（clearRecentErrors）—— 连续错误真相源，成功即归零
 *   - prefillPartial：清（应用后即清；防御性，正常路径已在 buildRequest 清）
 *   - partialResult：清（成功后无 partial 可言）
 *   - consecutiveContextLength：清（成功表示本次 length 问题已解决）
 *   - lastError：清（瞬时 debug 字段）
 *   - precompress：不清（粘性，靠 compact 后自然不再触发）
 *
 * @param state 原 LlmErrorState（不 mutate，返回新对象）
 * @returns 清理后的 LlmErrorState
 */
export function clearTransientOnErrorState(state: LlmErrorState): LlmErrorState {
  const next: LlmErrorState = { ...state };
  next.recentErrors = [];
  delete next.prefillPartial;
  delete next.partialResult;
  delete next.consecutiveContextLength;
  delete next.lastError;
  // 注：precompress 按设计保留（粘性）。
  return next;
}
