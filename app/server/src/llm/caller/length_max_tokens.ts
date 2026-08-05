/**
 * Length 处理 —— MAX_TOKENS_EXCEEDED 决策树 + prefill 续写
 * 参考: specs/tech/agent/llm_caller/[P0]length_handling.md §2（决策树）/ §2.1（prefill defer）/ §2.2（one-shot ceiling bump）/ §6（strategy）
 *
 * 设计要点：
 *   - MAX_TOKENS_EXCEEDED → **one-shot ceiling bump**（一步到 model.maxOutputTokens）。
 *   - prefill **未启用**：decideMaxTokensAction 不返 'prefill' 分支，即便 strategy='continue' +
 *     supportsPrefill + salvageable 也走 bump 路径（spec §2.1 / §7.1）。prefill 数据流函数
 *     （computePrefillRemainingBudget / applyPrefillOverlay / mergePrefillChunks）保留待 future 实现，
 *     decide 不触发。
 *   - 已到硬上限仍触顶 → throw（输出超 model 能力，无法兜底，§2.2 封顶）。
 *
 * 其他不变原则（hermes 教训）：
 *   - MAX_TOKENS 触顶 → 增或续写，绝不降低
 *   - STREAM_INCOMPLETE（流断 + tool args 未完成）严格不 bump（归 length_stream.ts）
 */

import type { CanonicalRequest } from '../protocol';
import type { Message, ContentBlock } from '../protocol-types';
import type {
  LengthModelInfo,
  MaxTokensBumpStrategy,
  MaxTokensAction,
  PartialMessage,
} from './length_types';
import {
  PREFILL_TOTAL_BUDGET_FACTOR,
} from './length_types';
import { LlmErrorCategory, type ClassifiedLlmError } from './error_types';

// ──────────────────────────────────────────────────────────────────────────
// §2 决策树：MAX_TOKENS_EXCEEDED 处理
// ──────────────────────────────────────────────────────────────────────────

/**
 * 判定 partial 是否可 salvage（§2 决策树 2a）。
 * 可 salvage = 所有 tool_call 的 arguments 已完整（非 null object），
 * 且至少有一个 TextBlock（非空 text）或完整 ToolCallBlock（即 partial 有可用内容可续写）。
 *
 * 不可 salvage（有未完成 tool_use）→ 调用方应走 STREAM_INCOMPLETE 路径（不 bump，§4）。
 *
 * 注：真正的流断判定在 parseStream 层（closing } 检测）；本函数作决策树的
 * 第二道防线 —— protocol-types 的 tool_call.arguments 是 Record<string,unknown>，
 * 流断时 parseStream 不会产出半截 tool_call（会延迟到闭合），故此处 arguments
 * 非 object 视为不可 salvage 主要为防御性编程 + 单测注入用。
 *
 * @param partial partial assistant message（含 content blocks）
 * @returns true=可续写；false=无可用内容或含未完成 tool_call
 */
export function isSalvageable(partial: PartialMessage | undefined): boolean {
  if (!partial?.content || partial.content.length === 0) return false;
  let hasUsable = false;
  for (const block of partial.content) {
    if (block.type === 'text') {
      if (block.text.length > 0) hasUsable = true;
    } else if (block.type === 'tool_call') {
      // arguments 必须是完整 object（流断时 parseStream 不产出半截 tool_call）
      if (typeof block.arguments !== 'object' || block.arguments === null) {
        return false;
      }
      hasUsable = true;
    }
    // thinking / reasoning / image / tool_result 不影响 salvageable 判定
  }
  return hasUsable;
}

/**
 * MAX_TOKENS_EXCEEDED 决策树（§2 + §6）。
 *
 * 决策顺序：
 *   1. strategy === 'none' → throw（不处理）
 *   2. strategy === 'continue' && salvageable && supportsPrefill → 理论上 prefill，但 prefill 未启用，
 *      fallback 到 bump 路径（§2.1 / §7.1）；future 实现后此处 return { action: 'prefill' }。
 *   3. currentMaxTokens < capabilities.maxOutputTokens → **one-shot ceiling bump**（§2.2）
 *   4. 已到硬上限 → throw（不无限重试，§2.2 封顶）
 *
 * 注：partial 不可 salvage 时不应进本函数 —— 调用方应先归 STREAM_INCOMPLETE（§4，不 bump）。
 * 但为防御，salvageable=false 时也不走 prefill（落到 bump 或 throw）。
 *
 * @param partial partial assistant message
 * @param model LengthModelInfo（取 capabilities）
 * @param currentMaxTokens 本次调用使用的 max_tokens
 * @param strategy bump 策略 config（默认 continue；continue 行为同 increase——prefill 未启用）
 */
export function decideMaxTokensAction(
  partial: PartialMessage,
  model: LengthModelInfo,
  currentMaxTokens: number,
  strategy: MaxTokensBumpStrategy = 'continue',
): MaxTokensAction {
  // §6 strategy=none：不处理，上抛
  if (strategy === 'none') return { action: 'throw' };

  // prefill 未启用：即便 continue + salvageable + supportsPrefill，也不走 prefill 分支，
  // fallback 到 bump（§2.1 / §7.1）。future 实现后此处恢复：
  //   const salvageable = isSalvageable(partial);
  //   if (strategy === 'continue' && salvageable && model.capabilities.supportsPrefill) {
  //     return { action: 'prefill' };
  //   }
  // 当前 isSalvageable 的判定对 bump/throw 分支无影响，故不调用以省一次计算。

  // §2.2 one-shot ceiling bump：未到硬上限则一步到 model 上限
  if (currentMaxTokens < model.capabilities.maxOutputTokens) {
    return { action: 'bump', newMax: bumpMaxTokensToOneShotCeiling(currentMaxTokens, model) };
  }

  // §2 决策树末梢：已到硬上限，上抛（不无限重试，§2.2 封顶）
  return { action: 'throw' };
}

/**
 * max_tokens bump 算法（§2.2，one-shot ceiling）。
 *
 * **one-shot ceiling**：直接返 model.capabilities.maxOutputTokens（一步到上限）。
 * 理由（spec §2.2）：EXCEEDED 是「模型能说更多但被截断」，一次性给到 model 上限最省事。
 *
 * 若 current ≥ ceiling（已在上限）→ throw（输出超 model 能力，无法扩；调用方应转 STREAM_INCOMPLETE/NO_RETRY）。
 * 本函数不返特殊标记，直接 throw ClassifiedLlmError（MAX_TOKENS_EXCEEDED, retryable=false），
 * 调用方（applyMaxTokensOverlay）catch 后转 'throw' action 上抛。
 *
 * @param current 当前 max_tokens
 * @param model LengthModelInfo（取 capabilities.maxOutputTokens 作硬上限）
 * @returns model.capabilities.maxOutputTokens（one-shot ceiling）
 * @throws ClassifiedLlmError 当前已 ≥ ceiling（无法再 bump）
 */
export function bumpMaxTokensToOneShotCeiling(
  current: number,
  model: LengthModelInfo,
): number {
  const ceiling = model.capabilities.maxOutputTokens;
  if (current >= ceiling) {
    // 已到硬上限仍触顶 → 输出超 model 能力，无法兜底（§2.2 封顶）
    const err = new Error(
      `output hit max_tokens ceiling (${ceiling}) but still stop_reason=length — exceeds model capability`,
    ) as ClassifiedLlmError;
    err.category = LlmErrorCategory.MAX_TOKENS_EXCEEDED;
    err.hints = {
      retryable: false,
      shouldRotateKey: false,
      shouldFallbackProvider: false,
      shouldCompressContext: false,
      shouldBumpMaxTokens: false,
    };
    throw err;
  }
  return ceiling; // one-shot 直接到上限（非渐进 ×2）
}

// ──────────────────────────────────────────────────────────────────────────
// §2.1 prefill 续写数据流
// ──────────────────────────────────────────────────────────────────────────

/**
 * 计算 prefill 续写的剩余 token 预算（§2.1 + §7.2）。
 * 剩余 = 总预算(2*maxOutputTokens) - partial 已生成 output。
 * 下限保 1（避免 maxTokens=0 无意义请求）；不超过单次 maxOutputTokens（Anthropic 单次硬限）。
 *
 * @param model LengthModelInfo
 * @param partialOutputTokens partial 已生成的 output token 数
 */
export function computePrefillRemainingBudget(
  model: LengthModelInfo,
  partialOutputTokens: number,
): number {
  const totalBudget = model.capabilities.maxOutputTokens * PREFILL_TOTAL_BUDGET_FACTOR;
  const remaining = totalBudget - Math.max(0, partialOutputTokens);
  return Math.max(1, Math.min(remaining, model.capabilities.maxOutputTokens));
}

/**
 * 应用 prefill overlay 到 baseReq（§2.1 buildRequest）。
 * 把 partial 作 messages 数组最后一条 assistant turn + maxTokens 重置为剩余预算。
 *
 * 注意：本函数不判定递归次数（由调用方在写 errorState.prefillRecursionCount 时管，§7.2）。
 *
 * @param baseReq 原始 canonical 请求
 * @param partial partial assistant message（喂回续写）
 * @param model LengthModelInfo（算剩余预算）
 */
export function applyPrefillOverlay(
  baseReq: CanonicalRequest,
  partial: PartialMessage,
  model: LengthModelInfo,
): CanonicalRequest {
  const partialOutput = partial.usage?.output_total_tokens ?? 0;
  const remainingBudget = computePrefillRemainingBudget(model, partialOutput);
  // partial 喂回时 role 强制 assistant（protocol 要求）；剥离 usage（wire 不需要）
  const partialMsg: Message = {
    id: partial.id,
    role: 'assistant',
    content: partial.content,
  };
  return {
    ...baseReq,
    messages: [...baseReq.messages, partialMsg],
    params: {
      ...baseReq.params,
      maxTokens: remainingBudget,
    },
  };
}

/**
 * 拼接 prefill 续写流回 partial（§2.1 拼接规则，纯函数）。
 *
 * 规则：
 *   - text_delta: append 到 partial 最后一个 TextBlock；若无 TextBlock 则新建
 *   - tool_call_delta: partial 已有同 toolCallId 的 tool_call → 累积 argumentsDelta 字符串
 *     后解析回 object；新 toolCallId → 新建 tool_call block
 *   - usage: output 累加；input 取较大值（不重复计）
 *
 * 注：生产环境 tool_call_delta 的半 JSON 累积缓冲由 protocol-parse-stream 维护，
 * 本函数提供「拼接到既有 partial」的语义用于上层消息路由 + 单测。
 *
 * @param partial 原 partial
 * @param events 续写流的事件序列（已 collected）
 */
export function mergePrefillChunks(
  partial: PartialMessage,
  events: PrefillChunkEvent[],
): PartialMessage {
  const content: ContentBlock[] = partial.content.map((b) => ({ ...b })) as ContentBlock[];
  let outputTotal = partial.usage?.output_total_tokens ?? 0;
  let inputTotal = partial.usage?.input_total_tokens ?? 0;

  for (const evt of events) {
    if (evt.type === 'text_delta') {
      const lastText = [...content].reverse().find((b) => b.type === 'text');
      if (lastText && lastText.type === 'text') {
        lastText.text += evt.text;
      } else {
        content.push({ type: 'text', text: evt.text });
      }
    } else if (evt.type === 'tool_call_delta') {
      const existing = content.find(
        (b) => b.type === 'tool_call' && b.id === evt.toolCallId,
      );
      if (existing && existing.type === 'tool_call') {
        // 累积 argumentsDelta → 解析回 object（与 parseStream 约定一致）
        const parsed = tryParseArguments(evt.argumentsDelta ?? '');
        if (parsed !== undefined) existing.arguments = parsed;
      } else {
        // 新 toolCallId：新建 block（arguments 待后续 delta 补全）
        content.push({
          type: 'tool_call',
          id: evt.toolCallId,
          name: evt.name ?? '',
          arguments: tryParseArguments(evt.argumentsDelta ?? '') ?? {},
        });
      }
    } else if (evt.type === 'usage') {
      // output 累加；input 不重复计（取较大值）
      outputTotal += evt.usage.output_total_tokens ?? 0;
      inputTotal = Math.max(inputTotal, evt.usage.input_total_tokens ?? 0);
    }
    // finish 事件由调用方判定递归（§2.1 finish reason=max_tokens + 仍 salvageable → 递归）
  }

  return {
    ...partial,
    content,
    usage: { output_total_tokens: outputTotal, input_total_tokens: inputTotal },
  };
}

/** prefill 续写流事件（mergePrefillChunks 入参子集） */
export type PrefillChunkEvent =
  | { type: 'text_delta'; text: string }
  | {
      type: 'tool_call_delta';
      toolCallId: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: 'usage'; usage: { output_total_tokens?: number; input_total_tokens?: number } };

/** 尝试 JSON.parse，失败返回 undefined（不抛错） */
function tryParseArguments(s: string): Record<string, unknown> | undefined {
  if (!s) return undefined;
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
