/**
 * buildRequest —— 按 errorState overlay 动态构建实参
 * 参考: specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §3 step 3a
 *       specs/tech/agent/llm_caller/[P0]llm_request_config.md §2.4（maxTokens 派生）
 *       specs/tech/agent/llm_caller/[P0]length_handling.md §2 §3
 *
 * overlay 顺序（spec §3.3a + §2.4）：
 *   1. maxTokens 派生：deriveMaxTokens(base, recentErrors, lowerBound)
 *      —— 按 recentErrors 中 MAX_TOKENS_TOO_HIGH 次数 × 0.7 指数衰减（降级）。
 *      （无 maxTokensOverlay 字段——EXCEEDED bump 由 attempt 内直接覆盖
 *       built.req.params.maxTokens，不进 recentErrors 派生，spec §2.2 §2.4）
 *   2. precompress（粘性预压缩，调 ContextEngine.compact 压到 0.8）
 *   3. prefillPartial（partial 作 messages 最后一条 assistant turn 续写）
 *      —— prefill 未启用，decideMaxTokensAction 不返 'prefill'，此分支实际不触发；
 *      保留以兼容 future prefill 实现。
 *
 * 关键不变式：
 *   - maxTokens 降级因子派生不存储（recentErrors 是真相源，成功清空即归零）
 *   - precompress 粘性（不清，靠 compact 后自然不再触发）
 *   - prefillPartial 一次性（应用后清，由调用方在 attemptLoop 后清 errorState）
 */
import type { CanonicalRequest } from '../protocol';
import type { LlmModelConfig } from '../provider-types';
import type { LlmRequestConfig, MaxTokensBumpStrategy } from '../../config/llm_request_config';
import type { LlmErrorState } from './llm_error_state';
import { deriveMaxTokens } from './llm_error_state';
import {
  applyPrefillOverlay,
  decideMaxTokensAction,
  isSalvageable,
} from './length_max_tokens';
import { applyContextLengthEscalation, applyCompressOverlay, type ContextCompressor } from './length_context';
import type { LengthModelInfo, PartialMessage } from './length_types';

/**
 * maxTokens 派生下限保底（spec §2.4 MIN_MAX_TOKENS 概念）。
 * 防止指数衰减到无意义的极小值；取 1024（足够模型产出有意义回复的最小预算）。
 */
const MIN_MAX_TOKENS_LOWER_BOUND = 1024;

/**
 * 从 LlmModelConfig 取 LengthModelInfo（capabilities 子集）。
 * 旧 modelConfig 可能缺 capabilities → 兜底 supportsPrefill=false / supportsThinking=false。
 */
export function resolveLengthModelInfo(model: LlmModelConfig): LengthModelInfo {
  const cap = model.capabilities ?? {
    maxOutputTokens: model.maxOutputTokens,
    supportsPrefill: false,
    supportsThinking: false,
  };
  return { modelId: model.modelId, capabilities: cap };
}

/**
 * 按 errorState overlay 动态构建实参（spec §3 step 3a）。
 *
 * @param baseReq      agent loop 组装的 canonical 请求基线
 * @param errorState   RunState.llmErrorState（读 overlay）
 * @param model        命中的 LlmModelConfig（取 capabilities）
 * @param config       LlmRequestConfig（取 length.max_tokens_bump_strategy）
 * @param compressor   ContextEngine 实现（precompress=true 时调 compact）
 * @returns 应用 overlay 后的 CanonicalRequest；若应用了 prefill，返回 { req, appliedPrefill:true }
 *          供调用方在 attemptLoop 成功后清 errorState.prefillPartial。
 */
export function buildRequest(args: {
  baseReq: CanonicalRequest;
  errorState: LlmErrorState;
  model: LlmModelConfig;
  config: LlmRequestConfig;
  compressor?: ContextCompressor;
}): { req: CanonicalRequest; appliedPrefill: boolean } {
  const { baseReq, errorState, model, config, compressor } = args;
  const lengthInfo = resolveLengthModelInfo(model);
  const strategy: MaxTokensBumpStrategy = config.length.max_tokens_bump_strategy;
  void strategy; // strategy 留作 future prefill 决策入参；当前 prefill defer，buildRequest 内未直接消费
  let req = baseReq;
  let appliedPrefill = false;

  // 1. maxTokens 派生（spec §2.4）—— 按 recentErrors 中
  //    MAX_TOKENS_TOO_HIGH 次数 × 0.7 指数衰减（降级）。base 来自 caller 传入的 maxTokens。
  //    下限保底 MIN_MAX_TOKENS_LOWER_BOUND（防衰减到无意义）；上限不超过 model.capabilities.maxOutputTokens。
  //    无 maxTokensOverlay 字段——EXCEEDED bump 不走 overlay，
  //    由 llm_caller 在 attempt 内直接覆盖 built.req.params.maxTokens（one-shot ceiling，spec §2.2）。
  const baseMaxTokens = baseReq.params.maxTokens ?? lengthInfo.capabilities.maxOutputTokens;
  const lowerBound = Math.min(MIN_MAX_TOKENS_LOWER_BOUND, lengthInfo.capabilities.maxOutputTokens);
  let derivedMaxTokens = deriveMaxTokens(baseMaxTokens, errorState.recentErrors, lowerBound);
  // cap 到 model 硬上限（防派生值越界 model 能力）
  derivedMaxTokens = Math.min(derivedMaxTokens, lengthInfo.capabilities.maxOutputTokens);
  req = {
    ...req,
    params: { ...req.params, maxTokens: derivedMaxTokens },
  };

  // 2. precompress（粘性预压缩，调 compressor.compact 压到 0.8）
  if (errorState.precompress && compressor) {
    req = applyCompressOverlay(req, errorState, compressor);
  }

  // 3. prefillPartial（一次性；partial 作 messages 最后一条 assistant turn）
  //    prefill 未启用：decideMaxTokensAction 不返 'prefill'，故 errorState.prefillPartial
  //    实际不会被 applyMaxTokensOverlay 设置；此分支保留以兼容 future prefill 实现。
  if (errorState.prefillPartial !== undefined) {
    const partial = errorState.prefillPartial;
    // 仅当 supportsPrefill + salvageable 时应用；否则忽略（调用方应已判定，此处防御）
    if (lengthInfo.capabilities.supportsPrefill && isSalvageablePartial(partial)) {
      req = applyPrefillOverlay(req, partial, lengthInfo);
      appliedPrefill = true;
    }
  }

  return { req, appliedPrefill };
}

/** 判定 partial 是否可 salvage（转发 length_max_tokens 实现，纯函数无循环依赖）。 */
function isSalvageablePartial(partial: PartialMessage): boolean {
  return isSalvageable(partial);
}

/**
 * 触发 MAX_TOKENS_EXCEEDED 后更新 errorState（spec §2 + §2.2）。
 *
 * 决策顺序（decideMaxTokensAction，prefill 未启用）：
 *   - strategy='none' → throw（不处理）
 *   - currentMax < maxOutputTokens → **one-shot ceiling bump**：返 bumped maxTokens 值
 *     （model.capabilities.maxOutputTokens）。bumped 值由调用方（llm_caller）在 attempt 内
 *     直接覆盖 built.req.params.maxTokens，**不写 errorState**（spec §2.2：不进 recentErrors、
 *     不复合、不 ×0.7；EXCEEDED 与连续错误历史无关）。
 *   - currentMax ≥ maxOutputTokens → throw（已到硬上限，输出超 model 能力，§2.2 封顶）
 *
 * @returns { kind:'updated', maxTokens } 携 bumped 值（调用方写入本次 attempt 的 req.params）；
 *          若决策为 throw，返回 { kind:'throw' } 由调用方上抛。
 */
export function applyMaxTokensOverlay(
  errorState: LlmErrorState,
  partial: PartialMessage,
  model: LlmModelConfig,
  currentMaxTokens: number,
  config: LlmRequestConfig,
):
  | { kind: 'updated'; state: LlmErrorState; maxTokens: number }
  | { kind: 'throw' } {
  void errorState; // EXCEEDED bump 不写 errorState（spec §2.2：不进 recentErrors / 不复合）
  const lengthInfo = resolveLengthModelInfo(model);
  const action = decideMaxTokensAction(
    partial,
    lengthInfo,
    currentMaxTokens,
    config.length.max_tokens_bump_strategy,
  );
  if (action.action === 'throw') return { kind: 'throw' };
  // prefill 未启用：decideMaxTokensAction 不返 'prefill'（fallback 到 bump）。
  // 此处显式排除 'prefill' 分支以满足类型收窄；future 实现 prefill 后此分支应改写。
  if (action.action === 'prefill') return { kind: 'throw' };
  // bump：bumped 值直接返给调用方写入本次 attempt req.params（不进 errorState overlay）。
  return { kind: 'updated', state: errorState, maxTokens: action.newMax };
}

/**
 * 触发 CONTEXT_LENGTH_EXCEEDED 后更新 errorState（spec §3.2 粘性预压缩）。
 * 不瞎猜 context window（spec §3.3），只设 precompress 标记。
 */
export function applyContextLengthOverlay(errorState: LlmErrorState): LlmErrorState {
  return applyContextLengthEscalation(errorState);
}
