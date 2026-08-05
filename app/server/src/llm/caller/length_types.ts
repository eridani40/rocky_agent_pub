/**
 * Length 处理 —— 类型 + 常量
 * 参考: specs/tech/agent/llm_caller/[P0]length_handling.md §5（ModelCapability）
 *       specs/tech/agent/providers_and_models/[P0]llm_model_interface.md §3.5
 *
 * ModelCapability re-export 自 provider-types（权威源，LlmModelConfig.capabilities 字段类型）。
 * LengthErrorState 本地保留（LlmCaller 内部消费）。
 */

import type { Message } from '../protocol-types';
// ModelCapability 统一到 provider-types 权威源
export type { ModelCapability } from '../provider-types';
import type { ModelCapability } from '../provider-types';

/**
 * length 决策所需的最小 model 形状（capabilities 是 LlmModelConfig 的子集）。
 */
export interface LengthModelInfo {
  modelId: string;
  capabilities: ModelCapability;
}

// ──────────────────────────────────────────────────────────────────────────
// 跨 attempt / iteration 的粘性错误状态
// ──────────────────────────────────────────────────────────────────────────

/**
 * partial assistant message（含 usage，供 prefill 续写拼接）。
 * Message 类型不含 usage（protocol-types），此处扩展工作形状。
 */
export interface PartialMessage extends Message {
  /** partial 已生成部分的 token usage（续写时累加） */
  usage?: { output_total_tokens?: number; input_total_tokens?: number };
}

/**
 * Length 处理跨 iteration 粘性状态。
 * 参考: [P0]length_handling.md §3.2（粘性预压缩）/ §2.1（prefill defer）
 *       [P0]llm_request_config.md §2.3（跨 iteration 继承规则）
 *
 * 注：EXCEEDED bump 直接覆盖 built.req.params.maxTokens（one-shot ceiling，不进 errorState，spec §2.2 §2.4）。
 */
export interface LengthErrorState {
  /** 粘性预压缩标记（§3.2，达阈值后持续生效） */
  precompress?: boolean;
  /** prefill 续写的 partial assistant turn（应用后清，§2.1；prefill 未启用） */
  prefillPartial?: PartialMessage;
  /** 连续 CONTEXT_LENGTH_EXCEEDED 计数（§3.2 达阈值→precompress=true） */
  consecutiveContextLength?: number;
  /** 已用的 prefill 续写次数（递归限 1，§2.1 / §7.2；prefill 未启用） */
  prefillRecursionCount?: number;
}

// ──────────────────────────────────────────────────────────────────────────
// §6 max_tokens_bump_strategy config
// ──────────────────────────────────────────────────────────────────────────

/**
 * MAX_TOKENS 触顶时的处理策略（llm_request.length.max_tokens_bump_strategy，§6）。
 * - continue（默认）: 优先 prefill 续写（若 supportsPrefill），否则 increase
 * - increase: 直接 bump max_tokens（不试 prefill）
 * - none: 不处理，直接上抛用户
 */
export type MaxTokensBumpStrategy = 'continue' | 'increase' | 'none';

// ──────────────────────────────────────────────────────────────────────────
// 决策结果类型
// ──────────────────────────────────────────────────────────────────────────

/**
 * decideMaxTokensAction 的返回（discriminated union，§6 buildRequest 决策）。
 * - prefill: 把 partial 喂回续写（§2.1）
 * - bump: 翻倍 max_tokens 重跑（§2.2）
 * - throw: 已到硬上限或 strategy=none，上抛用户（不无限重试）
 */
export type MaxTokensAction =
  | { action: 'prefill' }
  | { action: 'bump'; newMax: number }
  | { action: 'throw' };

// ──────────────────────────────────────────────────────────────────────────
// 常量
// ──────────────────────────────────────────────────────────────────────────

/** prefill 续写递归上限（§2.1 / §7.2：最多 1 次，总预算 2*maxOutputTokens） */
export const MAX_PREFILL_RECURSION = 1;

/** prefill 总预算系数（§7.2：2 * maxOutputTokens 封顶） */
export const PREFILL_TOTAL_BUDGET_FACTOR = 2;

/** consecutiveContextLength 达此阈值 → 设 precompress=true（§3.2，默认 1） */
export const PRECOMPRESS_TRIGGER_THRESHOLD = 1;

/** 压缩目标比例（§3.2 applyCompressOverlay 压到 80%） */
export const COMPRESS_TARGET_RATIO = 0.8;
